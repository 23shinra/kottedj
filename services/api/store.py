"""Хранилище истории: TimescaleDB (asyncpg) + кольцевой буфер в памяти как fallback и кэш перемотки."""
from __future__ import annotations

import asyncio
import bisect
import json
import os
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncpg

INIT_SQL = Path(os.environ.get("DB_INIT_SQL", Path(__file__).resolve().parents[2] / "infra" / "db" / "init.sql"))
RING_SECONDS = 20 * 60


def _ts(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


class Store:
    def __init__(self, log) -> None:
        self.log = log
        self.pool: asyncpg.Pool | None = None
        self.frames: deque[tuple[int, dict[str, Any]]] = deque()       # (ts_ms, frame) — последние 20 мин
        self.kpis: deque[dict[str, Any]] = deque(maxlen=72 * 3600)
        self.events: deque[dict[str, Any]] = deque(maxlen=20000)
        self.plans: deque[tuple[int, dict[str, Any]]] = deque(maxlen=600)
        self.config_mem: dict[str, Any] = {}

    @property
    def db_ok(self) -> bool:
        return self.pool is not None

    async def connect(self) -> None:
        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            self.log.warning("db_disabled", reason="DATABASE_URL not set, in-memory history only")
            return
        for attempt in range(30):
            try:
                self.pool = await asyncpg.create_pool(dsn, min_size=1, max_size=5,
                                                      init=lambda c: c.set_type_codec(
                                                          "jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog"))
                async with self.pool.acquire() as c:
                    await c.execute(INIT_SQL.read_text())
                self.log.info("db_connected")
                return
            except (OSError, asyncpg.PostgresError) as e:
                self.log.warning("db_connect_retry", attempt=attempt, error=str(e))
                await asyncio.sleep(min(5, 0.5 * 2 ** attempt))
        self.log.error("db_unavailable", hint="history falls back to memory")

    async def _exec(self, sql: str, *args: Any) -> None:
        if not self.pool:
            return
        try:
            await self.pool.execute(sql, *args)
        except (OSError, asyncpg.PostgresError) as e:
            self.log.warning("db_write_failed", error=str(e))

    # ---------------------------------------------------------------- writes
    async def save_frame(self, frame: dict[str, Any]) -> None:
        ts = int(frame.get("emitted_at") or time.time() * 1000)
        self.frames.append((ts, frame))
        while self.frames and self.frames[0][0] < ts - RING_SECONDS * 1000:
            self.frames.popleft()
        await self._exec("INSERT INTO frames (ts, sim_time, plan_version, frame) VALUES ($1, $2, $3, $4)",
                         _ts(ts), frame["state"]["sim_time"], frame.get("plan_version"), frame)
        rows = []
        for world, c in frame["compare"].items():
            k, ix = c["kpi"], c["index"]
            row = {"ts": ts, "world": world, "sim_time": frame["state"]["sim_time"], "index": ix["value"],
                   "category": ix["category"]["id"], **{f: k.get(f) for f in (
                       "queue_len", "avg_entry_wait_min", "avg_deviation_min", "throughput_ratio", "utilization",
                       "conflicts", "avg_resource_wait_min", "departed_1h")}}
            self.kpis.append(row)
            rows.append(row)
        if self.pool:
            try:
                await self.pool.executemany(
                    "INSERT INTO kpi (ts, world, sim_time, index_value, category, queue_len, avg_entry_wait_min, "
                    "avg_deviation_min, throughput_ratio, utilization, conflicts, avg_resource_wait_min, departed_1h) "
                    "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
                    [(_ts(r["ts"]), r["world"], r["sim_time"], r["index"], r["category"], r["queue_len"],
                      r["avg_entry_wait_min"], r["avg_deviation_min"], r["throughput_ratio"], r["utilization"],
                      r["conflicts"], r["avg_resource_wait_min"], r["departed_1h"]) for r in rows])
            except (OSError, asyncpg.PostgresError) as e:
                self.log.warning("db_write_failed", error=str(e))

    async def save_event(self, ev: dict[str, Any]) -> None:
        ts = int(ev.get("emitted_at") or time.time() * 1000)
        self.events.append({**ev, "ts": ts})
        await self._exec("INSERT INTO events (ts, world, sim_time, type, text, payload) VALUES ($1,$2,$3,$4,$5,$6)",
                         _ts(ts), ev.get("world"), ev.get("t"), ev.get("type"), ev.get("text"), ev)

    async def save_plan(self, plan: dict[str, Any]) -> None:
        ts = int(plan.get("created_at", time.time()) * 1000)
        self.plans.append((ts, plan))
        await self._exec("INSERT INTO plans (ts, version, sim_time, trigger, engine, solve_ms, projected_index, plan) "
                         "VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
                         _ts(ts), plan.get("version", 0), plan.get("sim_time"), plan.get("trigger"),
                         plan["solver"]["engine"], plan["solver"].get("time_ms"),
                         plan["projected_index"]["value"], plan)

    # ---------------------------------------------------------------- reads
    async def timeline(self, minutes: float) -> list[dict[str, Any]]:
        since = time.time() * 1000 - minutes * 60_000
        rows: list[dict[str, Any]] = []
        if self.pool:
            try:
                recs = await self.pool.fetch(
                    "SELECT ts, world, sim_time, index_value, queue_len, avg_entry_wait_min, avg_deviation_min "
                    "FROM kpi WHERE ts >= $1 ORDER BY ts", _ts(since))
                rows = [{"ts": int(r["ts"].timestamp() * 1000), "world": r["world"], "sim_time": r["sim_time"],
                         "index": r["index_value"], "queue_len": r["queue_len"],
                         "avg_entry_wait_min": r["avg_entry_wait_min"], "avg_deviation_min": r["avg_deviation_min"]}
                        for r in recs]
            except (OSError, asyncpg.PostgresError) as e:
                self.log.warning("db_read_failed", error=str(e))
        if not rows:
            rows = [r for r in self.kpis if r["ts"] >= since]
        merged: dict[int, dict[str, Any]] = {}
        for r in rows:
            p = merged.setdefault(r["ts"], {"ts": r["ts"], "sim_time": r["sim_time"]})
            w = r["world"]
            p[f"index_{w}"] = r["index"]
            p[f"queue_{w}"] = r["queue_len"]
            p[f"wait_{w}"] = r["avg_entry_wait_min"]
            p[f"deviation_{w}"] = r["avg_deviation_min"]
        pts = sorted(merged.values(), key=lambda p: p["ts"])
        step = max(1, len(pts) // 900)          # не больше ~900 точек
        return pts[::step]

    async def kpi_rows(self, minutes: float) -> list[dict[str, Any]]:
        since = time.time() * 1000 - minutes * 60_000
        if self.pool:
            try:
                recs = await self.pool.fetch("SELECT * FROM kpi WHERE ts >= $1 ORDER BY ts", _ts(since))
                if recs:
                    return [{**dict(r), "ts": int(r["ts"].timestamp() * 1000), "index": r["index_value"]} for r in recs]
            except (OSError, asyncpg.PostgresError) as e:
                self.log.warning("db_read_failed", error=str(e))
        return [r for r in self.kpis if r["ts"] >= since]

    def _plan_at(self, ts: int) -> dict[str, Any] | None:
        best = None
        for pts, p in self.plans:
            if pts <= ts:
                best = p
        return best

    async def frame_at(self, ts: int) -> dict[str, Any] | None:
        if self.frames and self.frames[0][0] <= ts:
            keys = [f[0] for f in self.frames]
            i = min(len(keys) - 1, bisect.bisect_left(keys, ts))
            return {**self.frames[i][1], "plan": self._plan_at(self.frames[i][0])}
        if self.pool:
            try:
                r = await self.pool.fetchrow("SELECT frame FROM frames WHERE ts <= $1 ORDER BY ts DESC LIMIT 1", _ts(ts))
                p = await self.pool.fetchrow("SELECT plan FROM plans WHERE ts <= $1 ORDER BY ts DESC LIMIT 1", _ts(ts))
                if r:
                    return {**r["frame"], "plan": p["plan"] if p else None}
            except (OSError, asyncpg.PostgresError) as e:
                self.log.warning("db_read_failed", error=str(e))
        return self.frames[0][1] if self.frames else None

    async def events_since(self, minutes: float) -> list[dict[str, Any]]:
        since = time.time() * 1000 - minutes * 60_000
        if self.pool:
            try:
                recs = await self.pool.fetch(
                    "SELECT payload FROM events WHERE ts >= $1 AND world = 'ai' ORDER BY ts", _ts(since))
                return [r["payload"] for r in recs]
            except (OSError, asyncpg.PostgresError):
                pass
        return [e for e in self.events if e["ts"] >= since and e.get("world") == "ai"]

    async def plans_since(self, minutes: float) -> list[dict[str, Any]]:
        since = time.time() * 1000 - minutes * 60_000
        return [{"ts": ts, "version": p.get("version"), "trigger": p.get("trigger"), "engine": p["solver"]["engine"],
                 "time_ms": p["solver"].get("time_ms"), "index": p["projected_index"]["value"]}
                for ts, p in self.plans if ts >= since]

    # ---------------------------------------------------------------- config
    async def get_config(self, key: str) -> dict[str, Any] | None:
        if self.pool:
            try:
                r = await self.pool.fetchrow("SELECT value FROM config WHERE key = $1", key)
                return r["value"] if r else None
            except (OSError, asyncpg.PostgresError):
                pass
        return self.config_mem.get(key)

    async def put_config(self, key: str, value: dict[str, Any], user: str) -> None:
        self.config_mem[key] = value
        await self._exec("INSERT INTO config (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now()) "
                         "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, "
                         "updated_at = now()", key, value, user)

