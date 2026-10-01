"""ИИ-планировщик: строит и пересчитывает план работы станции (CP-SAT + эвристика).

Триггеры пересчёта:
  * по таймеру (replan_interval_s);
  * по нештатной ситуации из потока events (с debounce — всплеск сбоев склеивается в один пересчёт):
    тогда считаются 3 варианта плана, лучший применяется автоматически (auto_apply_best_variant),
    остальные доступны диспетчеру через api → planner:control.
"""
from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

from dstation import bus
from dstation.config import deep_merge, load_index_config, load_planner_config
from dstation.obs import setup_logging
from dstation.planner.core import make_plan, make_variants
from dstation.station import build_station

log = setup_logging("planner")

SOLVE = Histogram("planner_solve_seconds", "Время построения плана", ["kind"],
                  buckets=(.05, .1, .25, .5, 1, 1.5, 2, 3, 5, 8))
PLANS = Counter("planner_plans_total", "Построено планов", ["engine", "trigger"])
INDEX = Gauge("planner_projected_index", "Прогнозный индекс текущего плана")
TRAINS = Gauge("planner_trains_in_horizon", "Поездов в горизонте планирования")
FALLBACK = Counter("planner_fallback_total", "Переход на эвристику")

INCIDENT_TYPES = {"incident"}


class Planner:
    def __init__(self) -> None:
        self.station = build_station()
        self.r = bus.connect()
        self.plan: dict[str, Any] | None = None
        self.variants: list[dict[str, Any]] = []
        self.profile: dict[str, Any] | None = None       # активный профиль (выбранный вариант)
        self.version = 0
        self.trigger = asyncio.Event()
        self.trigger_reason: dict[str, Any] | None = None
        self.last_ok = 0.0
        self.busy = asyncio.Lock()

    async def configs(self) -> tuple[dict[str, Any], dict[str, Any]]:
        pc = deep_merge(load_planner_config(), await bus.get_json(self.r, "config:planner"))
        ic = deep_merge(load_index_config(), await bus.get_json(self.r, "config:index"))
        return pc, ic

    async def publish_plan(self, plan: dict[str, Any], trigger: str) -> None:
        self.version += 1
        plan["version"] = self.version
        plan["trigger"] = trigger
        self.plan = plan
        await bus.publish(self.r, "plan", plan, latest_key="latest:plan")
        PLANS.labels(plan["solver"]["engine"], trigger).inc()
        INDEX.set(plan["projected_index"]["value"])
        TRAINS.set(plan["trains_planned"])
        if plan["solver"]["engine"] != "cp-sat":
            FALLBACK.inc()
        self.last_ok = time.time()

    async def replan(self, incident: dict[str, Any] | None) -> None:
        snap_msg = await bus.get_json(self.r, "latest:ai")
        if not snap_msg:
            return
        snap = snap_msg["state"]
        pc, ic = await self.configs()
        t0 = time.perf_counter()
        if incident:
            variants = await asyncio.to_thread(make_variants, self.station, snap, pc, ic, self.plan)
            dt = time.perf_counter() - t0
            SOLVE.labels("variants").observe(dt)
            best = max(variants, key=lambda v: v["projected_index"]["value"])
            applied = best["variant"] if pc.get("auto_apply_best_variant", True) else (self.profile or {}).get("id", "balanced")
            self.variants = variants
            await bus.publish(self.r, "variants", {
                "incident": incident, "variants": variants, "applied": applied,
                "replan_ms": round(dt * 1000), "sim_time": snap["sim_time"], "created_at": time.time(),
            }, latest_key="latest:variants")
            chosen = next(v for v in variants if v["variant"] == applied)
            self.profile = next((p for p in pc.get("variants", []) if p["id"] == applied), None)
            await self.publish_plan(dict(chosen), "incident")
            log.info("replanned_incident", incident=incident.get("text"), applied=applied, ms=round(dt * 1000),
                     variants={v["variant"]: v["projected_index"]["value"] for v in variants})
        else:
            plan = await asyncio.to_thread(make_plan, self.station, snap, pc, ic, self.plan, self.profile)
            SOLVE.labels("regular").observe(time.perf_counter() - t0)
            await self.publish_plan(plan, "timer")

    async def apply_variant(self, vid: str) -> None:
        pc, _ = await self.configs()
        v = next((x for x in self.variants if x["variant"] == vid), None)
        self.profile = next((p for p in pc.get("variants", []) if p["id"] == vid), None)
        if v:
            await self.publish_plan(dict(v), "manual")
            latest = await bus.get_json(self.r, "latest:variants")
            if latest:
                latest["applied"] = vid
                await self.r.set("latest:variants", bus.dumps(latest))
            log.info("variant_applied", variant=vid)

    async def loop(self) -> None:
        while True:
            pc, _ = await self.configs()
            try:
                await asyncio.wait_for(self.trigger.wait(), timeout=float(pc.get("replan_interval_s", 2.0)))
                await asyncio.sleep(float(pc.get("incident_debounce_ms", 200)) / 1000)   # склейка всплеска
            except asyncio.TimeoutError:
                pass
            incident, self.trigger_reason = self.trigger_reason, None
            self.trigger.clear()
            try:
                async with self.busy:
                    await self.replan(incident)
            except Exception as e:  # noqa: BLE001 — планировщик не должен падать
                log.exception("replan_failed", error=str(e))
                await asyncio.sleep(1)

    async def listen(self) -> None:
        async for stream, msg in bus.subscribe(self.r, ["events", "planner:control"]):
            if stream == "events":
                if msg.get("type") in INCIDENT_TYPES and msg.get("world") == "ai":
                    if self.trigger_reason is None:
                        self.trigger_reason = msg
                    else:
                        self.trigger_reason = {**msg, "text": f"{self.trigger_reason['text']}; {msg['text']}"}
                    self.trigger.set()
                elif msg.get("type") == "action" and msg.get("world") == "ai":
                    self.trigger.set()
            elif msg.get("type") == "apply_variant":
                async with self.busy:
                    await self.apply_variant(msg["variant"])
            elif msg.get("type") == "replan":
                self.trigger.set()


planner = Planner()


@asynccontextmanager
async def lifespan(app: FastAPI):
    tasks = [asyncio.create_task(planner.loop()), asyncio.create_task(planner.listen())]
    log.info("planner_started")
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Digital Station — Planner", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    age = time.time() - planner.last_ok if planner.last_ok else None
    return {"status": "ok" if age is not None and age < 15 else "degraded",
            "last_plan_age_s": round(age, 1) if age is not None else None,
            "version": planner.version,
            "solver": (planner.plan or {}).get("solver"),
            "profile": (planner.profile or {}).get("id", "balanced")}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8003)
