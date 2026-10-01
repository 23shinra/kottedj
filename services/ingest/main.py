"""Приём и нормализация потока телеметрии.

simulator --WS--> ingest --Redis Streams--> planner, api

Обработка потока:
  * валидация (pydantic): битые сообщения уходят в dead-letter (поток ingest:dlq) и считаются в метриках;
  * дедупликация по seq (LRU-окно);
  * защита от переупорядочивания: снимок старее последнего принятого для мира отбрасывается;
  * сглаживание шума координат на подходе (EMA + монотонность: поезд не едет назад);
  * переподключение к источнику с экспоненциальным backoff и jitter, явный статус связи.
"""
from __future__ import annotations

import asyncio
import json
import os
import random
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from typing import Any

import websockets
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from pydantic import ValidationError

from dstation import bus
from dstation.models import EventMsg, TelemetryMsg
from dstation.obs import setup_logging

log = setup_logging("ingest")

SOURCE_URL = os.environ.get("SIMULATOR_WS", "ws://localhost:8001/stream")
EMA_ALPHA = float(os.environ.get("EMA_ALPHA", "0.35"))

RECEIVED = Counter("ingest_messages_total", "Принято сообщений", ["result"])
LINK_UP = Gauge("ingest_source_connected", "Связь с источником телеметрии (1 = есть)")
RECONNECTS = Counter("ingest_reconnects_total", "Переподключения к источнику")
LATENCY = Histogram("ingest_latency_seconds", "Задержка от генерации события до публикации в шину",
                    buckets=(.001, .005, .01, .025, .05, .1, .25, .5, 1))
RATE = Gauge("ingest_messages_per_second", "Входной поток, сообщений/с")


class Normalizer:
    def __init__(self, window: int = 5000) -> None:
        self.seen: OrderedDict[int, None] = OrderedDict()
        self.window = window
        self.last_seq: dict[str, int] = {}
        self.ema: dict[tuple[str, str], float] = {}

    def is_duplicate(self, seq: int) -> bool:
        if seq in self.seen:
            return True
        self.seen[seq] = None
        if len(self.seen) > self.window:
            self.seen.popitem(last=False)
        return False

    def is_stale(self, world: str, seq: int) -> bool:
        if seq <= self.last_seq.get(world, -1):
            return True
        self.last_seq[world] = seq
        return False

    def smooth(self, world: str, state: dict[str, Any]) -> None:
        alive = set()
        for tr in state["trains"]:
            key = (world, tr["id"])
            alive.add(key)
            if tr["status"] not in ("approaching", "held"):
                self.ema.pop(key, None)
                continue
            raw = float(tr["pos_m"])
            prev = self.ema.get(key)
            val = raw if prev is None else EMA_ALPHA * raw + (1 - EMA_ALPHA) * prev
            if prev is not None and tr["status"] == "approaching":
                val = min(val, prev)                    # поезд на подходе не едет назад
            self.ema[key] = val
            tr["pos_m"] = round(val)
        for k in [k for k in self.ema if k[0] == world and k not in alive]:
            del self.ema[k]


class Ingest:
    def __init__(self) -> None:
        self.r = bus.connect()
        self.norm = Normalizer()
        self.connected = False
        self.last_msg_at = 0.0
        self.attempt = 0
        self.stats = {"ok": 0, "duplicate": 0, "stale": 0, "invalid": 0}
        self._count = 0
        self._count_t = time.time()

    async def handle(self, raw: str) -> None:
        now = time.time()
        self.last_msg_at = now
        self._count += 1
        if now - self._count_t >= 1:
            RATE.set(self._count / (now - self._count_t))
            self._count, self._count_t = 0, now
        try:
            data = json.loads(raw)
            kind = data.get("type")
            if kind == "event":
                msg = EventMsg.model_validate(data)
                if self.norm.is_duplicate(msg.seq):
                    return self._count_result("duplicate")
                await bus.publish(self.r, "events", {**msg.event, "emitted_at": msg.emitted_at})
                return self._count_result("ok")
            msg = TelemetryMsg.model_validate(data)
        except (ValidationError, json.JSONDecodeError, TypeError) as e:
            self._count_result("invalid")
            await bus.publish(self.r, "ingest:dlq", {"error": str(e)[:500], "raw": raw[:2000], "at": now})
            return
        if self.norm.is_duplicate(msg.seq):
            return self._count_result("duplicate")
        if self.norm.is_stale(msg.world, msg.seq):
            return self._count_result("stale")
        state = data["state"]                          # исходный dict (с extra-полями), уже провалидирован
        self.norm.smooth(msg.world, state)
        out = {"world": msg.world, "seq": msg.seq, "emitted_at": msg.emitted_at,
               "ingested_at": int(now * 1000), "time_scale": msg.time_scale, "state": state}
        await bus.publish(self.r, f"state:{msg.world}", out, latest_key=f"latest:{msg.world}")
        LATENCY.observe(max(0.0, now - msg.emitted_at / 1000))
        self._count_result("ok")

    def _count_result(self, res: str) -> None:
        self.stats[res] += 1
        RECEIVED.labels(res).inc()

    async def run(self) -> None:
        backoff = 0.5
        while True:
            try:
                async with websockets.connect(SOURCE_URL, max_size=16 * 2 ** 20, ping_interval=5, ping_timeout=10) as ws:
                    self.connected, self.attempt, backoff = True, 0, 0.5
                    LINK_UP.set(1)
                    await self.r.set("link:simulator", json.dumps({"status": "up", "at": time.time()}))
                    log.info("source_connected", url=SOURCE_URL)
                    async for raw in ws:
                        await self.handle(raw)
            except (OSError, websockets.WebSocketException, asyncio.TimeoutError) as e:
                log.warning("source_disconnected", error=str(e), retry_in=round(backoff, 2), attempt=self.attempt)
            self.connected = False
            LINK_UP.set(0)
            RECONNECTS.inc()
            self.attempt += 1
            try:
                await self.r.set("link:simulator", json.dumps({"status": "down", "at": time.time(), "attempt": self.attempt}))
            except Exception:  # noqa: BLE001 — Redis тоже может быть недоступен
                pass
            await asyncio.sleep(backoff + random.uniform(0, backoff / 2))   # backoff + jitter
            backoff = min(backoff * 2, 30)


ing = Ingest()


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(ing.run())
    yield
    task.cancel()


app = FastAPI(title="Digital Station — Ingest", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    age = time.time() - ing.last_msg_at if ing.last_msg_at else None
    ok = ing.connected and age is not None and age < 5
    return {"status": "ok" if ok else "degraded", "source_connected": ing.connected,
            "last_message_age_s": round(age, 2) if age is not None else None,
            "reconnect_attempt": ing.attempt, "stats": ing.stats}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8002)
