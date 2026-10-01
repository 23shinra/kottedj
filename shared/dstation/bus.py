"""Шина событий на Redis Streams.

Потоки:
  state:ai, state:baseline — нормализованные снимки состояния (ingest → planner, api)
  events                   — дискретные события: прибытия, отправления, сбои (ingest → api, planner)
  commands                 — команды симулятору: сбои, действия диспетчера, скорость (api → simulator)
  plan                     — применённый план (planner → simulator, api)
  variants                 — варианты плана при сбое (planner → api)
  planner:control          — управление планировщиком: применить вариант (api → planner)
  micro:state              — кадры микромодели станции (simulator → api), события внутри кадра
Ключи:
  latest:{world}, latest:plan, latest:variants — последние значения для быстрого старта
  config:index, config:planner                  — переопределения конфигурации (без перекомпиляции)
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Any, AsyncIterator

import redis.asyncio as aioredis

STREAM_MAXLEN = {"state:ai": 200, "state:baseline": 200, "events": 5000, "commands": 1000,
                 "plan": 200, "variants": 50, "planner:control": 100, "micro:state": 100}


def redis_url() -> str:
    return os.environ.get("REDIS_URL", "redis://localhost:6379/0")


def connect() -> aioredis.Redis:
    return aioredis.from_url(redis_url(), decode_responses=True, health_check_interval=10)


def dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


async def publish(r: aioredis.Redis, stream: str, payload: dict[str, Any], latest_key: str | None = None) -> None:
    data = dumps(payload)
    pipe = r.pipeline(transaction=False)
    pipe.xadd(stream, {"data": data}, maxlen=STREAM_MAXLEN.get(stream, 1000), approximate=True)
    if latest_key:
        pipe.set(latest_key, data)
    await pipe.execute()


async def get_json(r: aioredis.Redis, key: str) -> Any:
    raw = await r.get(key)
    return json.loads(raw) if raw else None


async def subscribe(r: aioredis.Redis, streams: list[str], start: str = "$",
                    block_ms: int = 1000) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Бесконечное чтение нескольких потоков (с автоматическим переподключением)."""
    last = {s: start for s in streams}
    backoff = 0.5
    while True:
        try:
            resp = await r.xread(last, block=block_ms, count=100)
            backoff = 0.5
        except (aioredis.ConnectionError, aioredis.TimeoutError, OSError):
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 10)
            continue
        for stream, entries in resp or []:
            for eid, fields in entries:
                last[stream] = eid
                try:
                    yield stream, json.loads(fields["data"])
                except (KeyError, json.JSONDecodeError):
                    continue
