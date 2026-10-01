"""API-шлюз: REST (история, конфигурация, сбои, отчёты) + WebSocket онлайн-обновлений для дашборда."""
from __future__ import annotations

import asyncio
import os
import random
import time
from contextlib import asynccontextmanager
from typing import Any, Literal, Optional

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from prometheus_client import Counter, Gauge, Histogram, make_asgi_app
from pydantic import BaseModel, Field

from dstation import bus
from dstation import index as index_mod
from dstation.config import deep_merge, load_index_config, load_planner_config
from dstation.obs import setup_logging
from dstation.station import build_station

from . import auth, reports
from .store import Store

log = setup_logging("api")

WS_CLIENTS = Gauge("api_ws_clients", "Подключённые клиенты дашборда")
FRAMES = Counter("api_frames_broadcast_total", "Разослано кадров")
E2E = Histogram("api_event_to_broadcast_seconds", "Задержка: событие в симуляторе → рассылка клиентам",
                buckets=(.005, .01, .025, .05, .1, .25, .5, 1, 2))
DROPPED = Counter("api_frames_dropped_total", "Кадры, вытесненные более свежими (медленный клиент)")
INCIDENTS = Counter("api_incidents_total", "Внесённые нештатные ситуации", ["type"])
INDEX_G = Gauge("station_index", "Индекс эффективности станции", ["world"])


# ===================================================================== hub
COALESCED = ("frame", "micro")


class Client:
    def __init__(self, ws: WebSocket, user: dict[str, Any]) -> None:
        self.ws, self.user = ws, user
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=400)
        self.slots: dict[str, dict[str, Any]] = {}   # слоты последних кадров: старые кадры не копятся
        self.wake = asyncio.Event()

    def push(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind in COALESCED:
            if kind in self.slots:
                DROPPED.inc()
            self.slots[kind] = msg
        else:
            if self.queue.full():
                self.queue.get_nowait()
            self.queue.put_nowait(msg)
        self.wake.set()

    async def sender(self) -> None:
        while True:
            await self.wake.wait()
            self.wake.clear()
            while not self.queue.empty():
                await self.ws.send_text(bus.dumps(self.queue.get_nowait()))
            for kind in COALESCED:
                f = self.slots.pop(kind, None)
                if f is not None:
                    await self.ws.send_text(bus.dumps(f))


class Hub:
    def __init__(self) -> None:
        self.station = build_station()
        self.r = bus.connect()
        self.store = Store(log)
        self.clients: set[Client] = set()
        self.latest: dict[str, dict[str, Any]] = {}
        self.frame: dict[str, Any] | None = None
        self.plan: dict[str, Any] | None = None
        self.variants: dict[str, Any] | None = None
        self.events: list[dict[str, Any]] = []
        self.index_cfg = load_index_config()
        self.planner_cfg = load_planner_config()
        self.last_saved = 0.0
        self.last_plan_at = 0.0
        self.link: dict[str, Any] = {}
        self.micro: dict[str, Any] | None = None
        self.sim_url = os.environ.get("SIMULATOR_URL", "http://localhost:8001")

    def broadcast(self, msg: dict[str, Any]) -> None:
        for c in list(self.clients):
            c.push(msg)

    def build_frame(self, ai: dict[str, Any]) -> dict[str, Any]:
        base = self.latest.get("baseline")
        ai_ix = index_mod.compute(ai["state"]["kpi"], self.index_cfg)
        compare = {"ai": {"kpi": ai["state"]["kpi"], "index": ai_ix}}
        if base:
            compare["baseline"] = {"kpi": base["state"]["kpi"], "index": index_mod.compute(base["state"]["kpi"], self.index_cfg)}
            INDEX_G.labels("baseline").set(compare["baseline"]["index"]["value"])
        INDEX_G.labels("ai").set(ai_ix["value"])
        return {"type": "frame", "seq": ai["seq"], "emitted_at": ai["emitted_at"], "received_at": ai.get("ingested_at"),
                "time_scale": ai.get("time_scale"), "state": ai["state"], "index": ai_ix, "compare": compare,
                "plan_version": (self.plan or {}).get("version"), "link": self.link_status()}

    def link_status(self) -> dict[str, Any]:
        now = time.time()
        ai = self.latest.get("ai")
        age = now - ai["emitted_at"] / 1000 if ai else None
        return {
            "simulator": self.link.get("simulator", "unknown"),
            "ingest": "up" if age is not None and age < 3 else "down",
            "planner": "up" if self.last_plan_at and now - self.last_plan_at < 15 else "down",
            "db": "up" if self.store.db_ok else "memory",
            "last_event_ms": ai["emitted_at"] if ai else None,
        }

    def hello(self, user: dict[str, Any]) -> dict[str, Any]:
        return {"type": "hello", "station": self.station.public(), "index_config": self.index_cfg,
                "planner_config": self.planner_cfg, "time_scale": (self.latest.get("ai") or {}).get("time_scale"),
                "user": {"username": user.get("sub"), "role": user.get("role")}}

    # ------------------------------------------------------------- consumers
    async def consume(self) -> None:
        for key, slot in (("latest:plan", "plan"), ("latest:variants", "variants")):
            setattr(self, slot, await bus.get_json(self.r, key))
        if self.plan:
            self.last_plan_at = time.time()
        self.micro = await bus.get_json(self.r, "latest:micro")
        if self.micro:
            self.micro.pop("events", None)
        async for stream, msg in bus.subscribe(self.r, ["state:ai", "state:baseline", "plan", "variants", "events", "micro:state"]):
            if stream == "micro:state":
                evs = msg.pop("events", [])
                if evs:
                    self.broadcast({"type": "micro_events", "version": msg.get("version"), "events": evs})
                self.micro = {"type": "micro", **msg}
                self.broadcast(self.micro)
            elif stream.startswith("state:"):
                world = stream.split(":", 1)[1]
                self.latest[world] = msg
                if world == "ai":
                    frame = self.build_frame(msg)
                    self.frame = frame
                    self.broadcast(frame)
                    FRAMES.inc()
                    E2E.observe(max(0.0, time.time() - msg["emitted_at"] / 1000))
                    if time.time() - self.last_saved >= 1.0:
                        self.last_saved = time.time()
                        asyncio.create_task(self.store.save_frame(frame))
            elif stream == "plan":
                self.plan, self.last_plan_at = msg, time.time()
                self.broadcast({"type": "plan", "plan": msg})
                asyncio.create_task(self.store.save_plan(msg))
            elif stream == "variants":
                self.variants = msg
                self.broadcast({"type": "variants", **msg})
            elif stream == "events":
                if msg.get("world") == "ai" and msg.get("type") != "spawn":
                    self.events = (self.events + [msg])[-200:]
                    self.broadcast({"type": "events", "events": [msg]})
                if msg.get("type") != "spawn":
                    asyncio.create_task(self.store.save_event(msg))

    async def watch_link(self) -> None:
        while True:
            try:
                st = await bus.get_json(self.r, "link:simulator")
                self.link["simulator"] = (st or {}).get("status", "unknown")
            except Exception:  # noqa: BLE001
                self.link["simulator"] = "unknown"
            self.broadcast({"type": "ping", "t": time.time()})
            await asyncio.sleep(5)

    async def load_config(self) -> None:
        ov = await self.store.get_config("index")
        if ov:
            self.index_cfg = deep_merge(load_index_config(), ov)
            await self.r.set("config:index", bus.dumps(ov))
        ovp = await self.store.get_config("planner")
        if ovp:
            self.planner_cfg = deep_merge(load_planner_config(), ovp)
            await self.r.set("config:planner", bus.dumps(ovp))

    async def command(self, cmd: dict[str, Any]) -> None:
        await bus.publish(self.r, "commands", cmd)

    async def sim_request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        try:
            async with httpx.AsyncClient(base_url=self.sim_url, timeout=5) as http:
                resp = await http.request(method, path, json=body)
        except httpx.HTTPError as e:
            log.warning("simulator_unreachable", path=path, error=str(e))
            raise HTTPException(503, "Симулятор недоступен") from e
        if resp.status_code == 404:
            raise HTTPException(404, resp.json().get("detail", "не найдено"))
        resp.raise_for_status()
        return resp.json()


hub = Hub()


@asynccontextmanager
async def lifespan(app: FastAPI):
    async def init_db() -> None:              # БД подключается в фоне: API работает и без неё (история в памяти)
        await hub.store.connect()
        await hub.load_config()

    tasks = [asyncio.create_task(init_db()), asyncio.create_task(hub.consume()), asyncio.create_task(hub.watch_link())]
    log.info("api_started")
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(
    title="Цифровая станция — API",
    description="REST для истории, конфигурации, сбоев и отчётов; WebSocket `/ws/live` для онлайн-обновлений. "
                "Авторизация: `POST /api/auth/login` → Bearer JWT.",
    version="1.0.0",
    lifespan=lifespan,
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/metrics", make_asgi_app())


# ===================================================================== models
class LoginIn(BaseModel):
    username: str
    password: str


class IncidentIn(BaseModel):
    type: Literal["close_track", "delay", "loco_failure"]
    track: Optional[str] = None
    train: Optional[str] = None
    minutes: Optional[int] = Field(default=None, ge=1, le=240)
    duration_min: Optional[int] = Field(default=None, ge=1, le=600)
    loco: Optional[str] = None


class ActionIn(BaseModel):
    type: Literal["open_track", "reroute", "add_loco", "add_crew"]
    track: Optional[str] = None
    train: Optional[str] = None


class ApplyIn(BaseModel):
    variant: str


class SpeedIn(BaseModel):
    time_scale: float = Field(ge=1, le=120)


MICRO_ADMIN_COMMANDS = {"bonus_config", "repair_config", "restore"}


class MicroCommandIn(BaseModel):
    model_config = {"extra": "allow"}
    type: Literal["run", "pause", "reset", "set_scale", "auto", "set_route", "cancel_route", "throw_switch",
                  "hold", "fault", "delay", "add_loco", "restore", "bonus_config", "repair_config"]


# ===================================================================== REST
@app.post("/api/auth/login", tags=["auth"])
async def login(body: LoginIn) -> dict[str, Any]:
    res = auth.login(body.username, body.password)
    if not res:
        log.warning("login_failed", username=body.username)
        raise HTTPException(401, "Неверный логин или пароль")
    log.info("login", username=body.username, role=res["role"])
    return res


@app.get("/api/station", tags=["state"])
async def station(_: dict = Depends(auth.require())) -> dict[str, Any]:
    return hub.station.public()


@app.get("/api/state", tags=["state"])
async def state(_: dict = Depends(auth.require())) -> dict[str, Any]:
    if not hub.frame:
        raise HTTPException(503, "Нет данных от симулятора")
    return hub.frame


@app.get("/api/index", tags=["state"])
async def get_index(_: dict = Depends(auth.require())) -> dict[str, Any]:
    if not hub.frame:
        raise HTTPException(503, "Нет данных")
    return hub.frame["index"]


@app.get("/api/compare", tags=["state"])
async def compare(_: dict = Depends(auth.require())) -> dict[str, Any]:
    if not hub.frame:
        raise HTTPException(503, "Нет данных")
    return hub.frame["compare"]


@app.get("/api/plan", tags=["plan"])
async def get_plan(_: dict = Depends(auth.require())) -> dict[str, Any]:
    if not hub.plan:
        raise HTTPException(503, "План ещё не построен")
    return hub.plan


@app.get("/api/plan/variants", tags=["plan"])
async def get_variants(_: dict = Depends(auth.require())) -> dict[str, Any]:
    return hub.variants or {"variants": []}


@app.post("/api/plan/apply", tags=["plan"])
async def apply_variant(body: ApplyIn, user: dict = Depends(auth.require("dispatcher"))) -> dict[str, str]:
    await bus.publish(hub.r, "planner:control", {"type": "apply_variant", "variant": body.variant})
    log.info("variant_apply_requested", variant=body.variant, user=user["sub"])
    return {"status": "accepted"}


@app.post("/api/plan/replan", tags=["plan"])
async def replan(_: dict = Depends(auth.require("dispatcher"))) -> dict[str, str]:
    await bus.publish(hub.r, "planner:control", {"type": "replan"})
    return {"status": "accepted"}


@app.post("/api/incidents", tags=["incidents"])
async def incident(body: IncidentIn, user: dict = Depends(auth.require("dispatcher"))) -> dict[str, Any]:
    cmd = body.model_dump(exclude_none=True)
    if body.type == "close_track" and body.track not in hub.station.tracks:
        raise HTTPException(422, "Неизвестный путь")
    if body.type == "delay" and not body.train:
        raise HTTPException(422, "Укажите поезд")
    cmd["scope"] = "both"                       # сбой одинаково действует на оба двойника
    await hub.command(cmd)
    INCIDENTS.labels(body.type).inc()
    log.info("incident", cmd=cmd, user=user["sub"])
    return {"status": "accepted", "command": cmd}


@app.post("/api/incidents/stress", tags=["incidents"])
async def stress(user: dict = Depends(auth.require("dispatcher"))) -> dict[str, Any]:
    """Нагрузочный сценарий: несколько одновременных сбоев + поток телеметрии ×10 на 30 секунд."""
    st = (hub.latest.get("ai") or {}).get("state")
    if not st:
        raise HTTPException(503, "Нет данных")
    rnd = random.Random()
    cmds: list[dict[str, Any]] = [{"type": "stress", "seconds": 30}]
    free = [t["id"] for t in st["tracks"] if t["status"] in ("free", "occupied")]
    for tid in rnd.sample(free, k=min(2, len(free))):
        cmds.append({"type": "close_track", "track": tid, "duration_min": rnd.choice([30, 45, 60]), "scope": "both"})
    moving = [t["id"] for t in st["trains"] if t["status"] in ("approaching", "held")]
    for tid in rnd.sample(moving, k=min(3, len(moving))):
        cmds.append({"type": "delay", "train": tid, "minutes": rnd.choice([10, 15, 20, 30]), "scope": "both"})
    cmds.append({"type": "loco_failure", "duration_min": 60, "scope": "both"})
    for c in cmds:
        await hub.command(c)
    INCIDENTS.labels("stress").inc()
    log.warning("stress_injected", commands=len(cmds), user=user["sub"])
    return {"status": "accepted", "commands": cmds}


@app.post("/api/actions", tags=["incidents"])
async def action(body: ActionIn, user: dict = Depends(auth.require("dispatcher"))) -> dict[str, Any]:
    """Принять рекомендацию ИИ (действует только на мир с ИИ)."""
    cmd = {**body.model_dump(exclude_none=True), "scope": "ai"}
    await hub.command(cmd)
    log.info("action", cmd=cmd, user=user["sub"])
    return {"status": "accepted", "command": cmd}


@app.post("/api/sim/speed", tags=["config"])
async def sim_speed(body: SpeedIn, user: dict = Depends(auth.require("admin"))) -> dict[str, Any]:
    await hub.command({"type": "set_speed", "time_scale": body.time_scale})
    log.info("sim_speed", time_scale=body.time_scale, user=user["sub"])
    return {"status": "accepted", "time_scale": body.time_scale}


@app.get("/api/micro/static", tags=["micro"])
async def micro_static(_: dict = Depends(auth.require())) -> dict[str, Any]:
    """Путевая схема, оборудование, справочник подвижного состава, персонал, сценарии, журнал."""
    return await hub.sim_request("GET", "/micro/static")


@app.get("/api/micro/state", tags=["micro"])
async def micro_state(_: dict = Depends(auth.require())) -> dict[str, Any]:
    return await hub.sim_request("GET", "/micro/frame")


@app.get("/api/micro/card/{kind}/{oid}", tags=["micro"])
async def micro_card(kind: Literal["train", "segment", "switch", "signal", "device", "worker", "loco", "wagon"],
                     oid: str, _: dict = Depends(auth.require())) -> dict[str, Any]:
    """Карточка объекта: справочная модель + состояние конкретного экземпляра."""
    return await hub.sim_request("GET", f"/micro/card/{kind}/{oid}")


@app.post("/api/micro/command", tags=["micro"])
async def micro_command(body: MicroCommandIn, user: dict = Depends(auth.require("dispatcher"))) -> dict[str, Any]:
    """Команда микромодели. Ручные маршруты и переводы стрелок проходят те же проверки, что и автодиспетчер;
    при отказе возвращаются конкретные причины (blockers)."""
    if body.type in MICRO_ADMIN_COMMANDS and auth.ROLES.get(user.get("role"), 0) < auth.ROLES["admin"]:
        raise HTTPException(403, "Команда доступна только администратору")
    cmd = body.model_dump()
    cmd["source"] = f"{'администратор' if user.get('role') == 'admin' else 'диспетчер'} {user['sub']}"
    res = await hub.sim_request("POST", "/micro/command", cmd)
    log.info("micro_command", cmd=cmd, ok=res.get("ok"), user=user["sub"])
    return res


@app.get("/api/history/timeline", tags=["history"])
async def timeline(minutes: float = Query(15, ge=1, le=72 * 60), _: dict = Depends(auth.require())) -> dict[str, Any]:
    return {"points": await hub.store.timeline(minutes)}


@app.get("/api/history/frame", tags=["history"])
async def history_frame(ts: int = Query(..., description="unix ms"), _: dict = Depends(auth.require())) -> dict[str, Any]:
    f = await hub.store.frame_at(ts)
    if not f:
        raise HTTPException(404, "Нет истории за этот момент")
    return f


@app.get("/api/history/events", tags=["history"])
async def history_events(minutes: float = Query(15, ge=1, le=72 * 60), _: dict = Depends(auth.require())) -> dict[str, Any]:
    return {"events": await hub.store.events_since(minutes)}


@app.get("/api/config/index", tags=["config"])
async def get_index_cfg(_: dict = Depends(auth.require())) -> dict[str, Any]:
    return hub.index_cfg


@app.put("/api/config/index", tags=["config"])
async def put_index_cfg(body: dict[str, Any], user: dict = Depends(auth.require("admin"))) -> dict[str, Any]:
    merged = deep_merge(load_index_config(), body)
    for k, f in merged["factors"].items():
        if float(f.get("weight", 0)) < 0:
            raise HTTPException(422, f"Вес фактора {k} не может быть отрицательным")
    if sum(float(f.get("weight", 0)) for f in merged["factors"].values()) <= 0:
        raise HTTPException(422, "Сумма весов должна быть больше 0")
    merged["categories"] = sorted(merged["categories"], key=lambda c: -float(c["min"]))
    hub.index_cfg = merged
    await hub.store.put_config("index", body, user["sub"])
    await hub.r.set("config:index", bus.dumps(body))
    hub.broadcast({"type": "config", "index_config": merged})
    log.info("config_index_updated", user=user["sub"])
    return merged


@app.get("/api/config/planner", tags=["config"])
async def get_planner_cfg(_: dict = Depends(auth.require())) -> dict[str, Any]:
    return hub.planner_cfg


@app.put("/api/config/planner", tags=["config"])
async def put_planner_cfg(body: dict[str, Any], user: dict = Depends(auth.require("admin"))) -> dict[str, Any]:
    merged = deep_merge(load_planner_config(), body)
    tl = float(merged["solver"]["time_limit_s"])
    if not 0.1 <= tl <= 5:
        raise HTTPException(422, "Лимит решателя должен быть в диапазоне 0.1–5 с")
    hub.planner_cfg = merged
    await hub.store.put_config("planner", body, user["sub"])
    await hub.r.set("config:planner", bus.dumps(body))
    hub.broadcast({"type": "config", "planner_config": merged})
    log.info("config_planner_updated", user=user["sub"])
    return merged


@app.get("/api/reports/summary.csv", tags=["reports"])
async def report_csv(minutes: float = Query(60, ge=1, le=72 * 60), _: dict = Depends(auth.require())) -> Response:
    data = reports.to_csv(await hub.store.kpi_rows(minutes), await hub.store.events_since(minutes),
                          hub.station.raw.get("start_clock", "06:00"), minutes)
    return Response(data, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="digital-station-report.csv"'})


@app.get("/api/reports/summary.pdf", tags=["reports"])
async def report_pdf(minutes: float = Query(60, ge=1, le=72 * 60), _: dict = Depends(auth.require())) -> Response:
    data = await asyncio.to_thread(
        reports.to_pdf, await hub.store.kpi_rows(minutes), await hub.store.events_since(minutes), hub.frame,
        await hub.store.plans_since(minutes),
        hub.station.raw.get("start_clock", "06:00"), minutes)
    return Response(data, media_type="application/pdf",
                    headers={"Content-Disposition": 'attachment; filename="digital-station-report.pdf"'})


@app.get("/api/health", tags=["ops"])
async def health() -> dict[str, Any]:
    try:
        redis_ok = bool(await hub.r.ping())
    except Exception:  # noqa: BLE001
        redis_ok = False
    link = hub.link_status()
    ok = redis_ok and link["ingest"] == "up"
    return {"status": "ok" if ok else "degraded", "redis": redis_ok, "ws_clients": len(hub.clients), **link}


# ===================================================================== WebSocket
@app.websocket("/ws/live")
async def ws_live(ws: WebSocket, token: str = Query("")) -> None:
    user = auth.decode(token)
    if not user:
        await ws.close(code=4401)
        return
    await ws.accept()
    client = Client(ws, user)
    hub.clients.add(client)
    WS_CLIENTS.set(len(hub.clients))
    client.push(hub.hello(user))
    if hub.plan:
        client.push({"type": "plan", "plan": hub.plan})
    if hub.variants:
        client.push({"type": "variants", **hub.variants})
    if hub.events:
        client.push({"type": "events", "events": hub.events[-50:]})
    if hub.frame:
        client.push(hub.frame)
    if hub.micro:
        client.push(hub.micro)
    sender = asyncio.create_task(client.sender())
    try:
        while True:
            await ws.receive_text()                 # pong и прочие сообщения клиента
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sender.cancel()
        hub.clients.discard(client)
        WS_CLIENTS.set(len(hub.clients))
