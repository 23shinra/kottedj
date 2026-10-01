"""Симулятор движения и ресурсов станции.

Гоняет два цифровых двойника (baseline = FCFS, ai = исполнение плана) на одном потоке поездов,
отдаёт телеметрию по WebSocket /stream с частотой tick_hz (в режиме стресса ×10).
Канал намеренно «грязный»: шум координат, дубли, битые сообщения — чтобы показать обработку в ingest.
"""
from __future__ import annotations

import asyncio
import copy
import os
import random
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

from dstation import bus
from dstation.config import load_scenario
from dstation.micro import MicroSim
from dstation.obs import setup_logging
from dstation.sim.runner import make_worlds
from dstation.sim.timetable import generate
from dstation.station import build_station

log = setup_logging("simulator")

MSG_SENT = Counter("sim_messages_sent_total", "Отправлено сообщений телеметрии", ["kind"])
TICK_SECONDS = Histogram("sim_tick_seconds", "Длительность тика модели", buckets=(.001, .005, .01, .025, .05, .1, .25))
SIM_TIME = Gauge("sim_time_seconds", "Модельное время")
CLIENTS = Gauge("sim_ws_clients", "Подключённые потребители телеметрии")
STRESS = Gauge("sim_stress_active", "Режим стресса активен")
TRAINS = Gauge("sim_trains_present", "Поездов на станции и подходе", ["world"])


class Simulator:
    def __init__(self) -> None:
        self.station = build_station()
        self.scn = load_scenario()
        self.worlds = make_worlds(self.station, self.scn)
        self.time_scale = float(self.scn.get("time_scale", 20))
        self.tick_hz = float(self.scn.get("tick_hz", 2))
        self.noise = self.scn.get("noise", {})
        self.rnd = random.Random(7)
        self.seq = 0
        self.clients: set[asyncio.Queue] = set()
        self.stress_until = 0.0
        self.paused = False
        self._acc = 0.0
        self.day = 0

    # ---------------------------------------------------------------- broadcast
    def _emit(self, msg: dict[str, Any]) -> None:
        raw = bus.dumps(msg)
        for q in list(self.clients):
            if q.full():
                try:
                    q.get_nowait()          # отстающий клиент: выбрасываем самое старое
                except asyncio.QueueEmpty:
                    pass
            q.put_nowait(raw)

    def _noisy(self, msg: dict[str, Any]) -> dict[str, Any]:
        sigma = float(self.noise.get("position_sigma_m", 0))
        if sigma:
            for tr in msg["state"]["trains"]:
                if tr["status"] in ("approaching", "held") and tr["pos_m"] > 0:
                    tr["pos_m"] = round(max(0.0, tr["pos_m"] + self.rnd.gauss(0, sigma)))
        return msg

    def _extend_timetable(self) -> None:
        """Бесшовно продлеваем график на следующие сутки, чтобы стенд мог работать сколько угодно."""
        ai = self.worlds["ai"]
        if not ai.specs or ai.specs[-1].actual_arr - ai.t > 4 * 3600:
            return
        self.day += 1
        scn = {**self.scn, "seed": int(self.scn.get("seed", 42)) + self.day}
        new = generate(self.station, scn, start_s=self.day * int(self.scn.get("duration_h", 24) * 3600))
        for w in self.worlds.values():
            w.specs.extend(copy.deepcopy(new))
        log.info("timetable_extended", day=self.day, trains=len(new))

    def tick(self, dt_sim: int) -> None:
        t0 = time.perf_counter()
        self._extend_timetable()
        for w in self.worlds.values():
            w.advance(dt_sim)
        now_ms = int(time.time() * 1000)
        for name, w in self.worlds.items():
            self.seq += 1
            snap = w.snapshot()
            msg = {"type": "telemetry", "world": name, "seq": self.seq, "emitted_at": now_ms,
                   "time_scale": self.time_scale, "state": snap}
            msg = self._noisy(msg)
            r = self.rnd.random()
            if r < float(self.noise.get("malformed_prob", 0)):
                bad = copy.deepcopy(msg)
                bad["state"].pop("tracks", None)       # битое сообщение → ingest отправит в dead-letter
                self._emit(bad)
                MSG_SENT.labels("malformed").inc()
            self._emit(msg)
            MSG_SENT.labels("telemetry").inc()
            if self.rnd.random() < float(self.noise.get("duplicate_prob", 0)):
                self._emit(msg)                         # дубль → ingest отбросит по seq
                MSG_SENT.labels("duplicate").inc()
            for ev in w.drain_events():
                self.seq += 1
                self._emit({"type": "event", "seq": self.seq, "emitted_at": now_ms, "event": ev})
                MSG_SENT.labels("event").inc()
            TRAINS.labels(name).set(sum(1 for t in snap["trains"] if t["status"] not in ("departed", "rerouted")))
        SIM_TIME.set(self.worlds["ai"].t)
        TICK_SECONDS.observe(time.perf_counter() - t0)

    # ---------------------------------------------------------------- commands
    def command(self, cmd: dict[str, Any]) -> None:
        kind = cmd.get("type")
        if kind == "set_speed":
            self.time_scale = max(1.0, min(120.0, float(cmd.get("time_scale", 20))))
            log.info("speed_changed", time_scale=self.time_scale)
            return
        if kind == "pause":
            self.paused = bool(cmd.get("value", True))
            return
        if kind == "stress":
            self.stress_until = time.time() + float(cmd.get("seconds", 30))
            log.warning("stress_started", seconds=cmd.get("seconds", 30))
            return
        targets = ["ai"] if cmd.get("scope") == "ai" else ["ai", "baseline"]
        for name in targets:
            res = self.worlds[name].apply_command(cmd)
            log.info("command_applied", world=name, cmd=cmd, result=res)

    def set_plan(self, plan: dict[str, Any]) -> None:
        self.worlds["ai"].plan = plan

    # ---------------------------------------------------------------- loops
    async def run(self) -> None:
        next_t = time.perf_counter()
        while True:
            stress = time.time() < self.stress_until
            STRESS.set(1 if stress else 0)
            hz = self.tick_hz * (10 if stress else 1)
            dt_real = 1.0 / hz
            if not self.paused:
                # модельное время копим дробно: при стрессе тики чаще, но скорость модели та же
                self._acc += self.time_scale * dt_real
                dt_sim = int(self._acc // 5) * 5
                self._acc -= dt_sim
                self.tick(dt_sim)
            next_t += dt_real
            await asyncio.sleep(max(0.0, next_t - time.perf_counter()))
            if time.perf_counter() - next_t > 1.0:
                next_t = time.perf_counter()   # не догоняем после долгой паузы

    async def consume_bus(self) -> None:
        r = bus.connect()
        plan = await bus.get_json(r, "latest:plan")
        if plan:
            self.set_plan(plan)
        async for stream, msg in bus.subscribe(r, ["commands", "plan"]):
            if stream == "plan":
                self.set_plan(msg)
            else:
                self.command(msg)


class MicroRunner:
    """Микромодель станции: свой масштаб времени (по умолчанию 1 мин реального = 1 ч модельного),
    пуск/пауза/сброс. Кадры публикуются в поток micro:state, команды применяются синхронно по HTTP."""

    TICK_HZ = 10.0
    PUBLISH_S = 0.5

    def __init__(self) -> None:
        self.m = MicroSim(os.environ.get("MICRO_SCENARIO", "normal"),
                          running=os.environ.get("MICRO_AUTOSTART", "1") == "1")
        self.pub_seq = 0
        self.pub_version = self.m.version
        self.dirty = True

    def command(self, cmd: dict[str, Any]) -> dict[str, Any]:
        source = str(cmd.pop("source", "диспетчер"))
        res = self.m.command(cmd, source=source)
        self.dirty = True
        log.info("micro_command", cmd=cmd, ok=res.get("ok"), message=res.get("message"))
        return res

    def next_frame(self) -> dict[str, Any]:
        if self.m.version != self.pub_version:
            self.pub_version, self.pub_seq = self.m.version, 0
        f = self.m.frame(self.pub_seq)
        self.pub_seq = f["seq"]
        f["emitted_at"] = int(time.time() * 1000)
        return f

    async def run(self) -> None:
        r = bus.connect()
        dt = 1.0 / self.TICK_HZ
        next_t = time.perf_counter()
        last_pub = 0.0
        while True:
            self.m.advance_real(dt)
            now = time.perf_counter()
            if self.dirty or now - last_pub >= self.PUBLISH_S:
                self.dirty, last_pub = False, now
                try:
                    await bus.publish(r, "micro:state", self.next_frame(), latest_key="latest:micro")
                except Exception as e:  # noqa: BLE001 — Redis недоступен: модель продолжает работать
                    log.warning("micro_publish_failed", error=str(e))
            next_t += dt
            await asyncio.sleep(max(0.0, next_t - time.perf_counter()))
            if time.perf_counter() - next_t > 1.0:
                next_t = time.perf_counter()


sim = Simulator()
micro = MicroRunner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [asyncio.create_task(sim.run()), asyncio.create_task(sim.consume_bus()), asyncio.create_task(micro.run())]
    log.info("simulator_started", scenario=sim.scn.get("name"), time_scale=sim.time_scale, tick_hz=sim.tick_hz)
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Digital Station — Simulator", lifespan=lifespan)


@app.websocket("/stream")
async def stream(ws: WebSocket) -> None:
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=200)
    sim.clients.add(q)
    CLIENTS.set(len(sim.clients))
    log.info("consumer_connected", clients=len(sim.clients))
    try:
        while True:
            await ws.send_text(await q.get())
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sim.clients.discard(q)
        CLIENTS.set(len(sim.clients))
        log.info("consumer_disconnected", clients=len(sim.clients))


@app.post("/command")
async def post_command(cmd: dict[str, Any]) -> dict[str, str]:
    """Прямая инъекция команды (для отладки; в штатном режиме команды идут через шину)."""
    sim.command(cmd)
    return {"status": "ok"}


@app.get("/micro/static")
async def micro_static() -> dict[str, Any]:
    return micro.m.static()


@app.get("/micro/frame")
async def micro_frame() -> dict[str, Any]:
    return micro.m.frame(0)


@app.get("/micro/card/{kind}/{oid}")
async def micro_card(kind: str, oid: str) -> dict[str, Any]:
    card = micro.m.world.card(kind, oid)
    if card is None:
        raise HTTPException(404, f"нет объекта {kind}/{oid}")
    return card


@app.post("/micro/command")
async def micro_command(cmd: dict[str, Any]) -> dict[str, Any]:
    return micro.command(cmd)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"status": "ok", "sim_time": sim.worlds["ai"].t, "time_scale": sim.time_scale,
            "clients": len(sim.clients), "stress": time.time() < sim.stress_until,
            "micro": {"scenario": micro.m.world.scn["id"], "t": micro.m.world.t, "running": micro.m.running,
                      "scale": micro.m.scale}}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8001)
