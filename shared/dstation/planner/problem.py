"""Построение задачи планирования из снимка состояния станции."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..station import Station

PENDING = {"scheduled", "approaching", "held", "at_signal"}
PRESENT = {"entering", "on_track"}


@dataclass
class PTrain:
    id: str
    cat: str
    length_m: int
    side_in: str
    side_out: str
    priority: float
    eta: int                  # самое раннее время входа
    planned_arr: int
    planned_dep: int
    service_s: int
    pending: bool             # ещё не принят
    track: str | None = None  # для принятых: путь фиксирован
    ready_min: int = 0        # для принятых: самое раннее окончание обслуживания
    needs_loco: bool = False
    needs_crew: bool = False
    loco_ready_at: int | None = None
    crew_ready_at: int | None = None
    compatible: list[str] = field(default_factory=list)
    prev_track: str | None = None
    status: str = ""


@dataclass
class Resource:
    id: str
    avail: int
    virtual: bool = False


@dataclass
class Problem:
    now: int
    horizon_end: int
    trains: list[PTrain]
    locos: list[Resource]
    crews: list[Resource]
    fixed_track: dict[str, list[tuple[int, int]]]      # путь -> занятые интервалы (уходящие поезда, окна)
    fixed_ladder: dict[str, list[tuple[int, int]]]
    closed: set[str]
    station: Station


def build_problem(station: Station, snap: dict[str, Any], planner_cfg: dict[str, Any],
                  prev_plan: dict[str, Any] | None = None,
                  priority_scale: dict[str, float] | None = None) -> Problem:
    now = int(snap["sim_time"])
    horizon = int(planner_cfg.get("horizon_min", 150) * 60)
    horizon_end = now + horizon
    th = station.throat_s
    closed = {t["id"] for t in snap["tracks"] if t["status"] in ("closed", "reserve")}
    prev = (prev_plan or {}).get("assignments", {})
    scale = priority_scale or {}

    trains: list[PTrain] = []
    fixed_track: dict[str, list[tuple[int, int]]] = {}
    fixed_ladder: dict[str, list[tuple[int, int]]] = {}
    locos: list[Resource] = []
    crews: list[Resource] = []

    for lad in snap.get("ladders", []):
        if lad["busy_until"] > now:
            fixed_ladder.setdefault(lad["id"], []).append((now, int(lad["busy_until"])))

    all_trains = list(snap["trains"]) + list(snap.get("upcoming", []))
    for tr in all_trains:
        cat = station.categories[tr["cat"]]
        st = tr["status"]
        prio = cat.priority * float(scale.get(tr["cat"], 1.0))
        if st in PENDING:
            eta = max(now, int(tr.get("eta") or tr["planned_arr"]))
            if tr.get("hold_until") and tr["hold_until"] > now:
                eta = max(eta, int(tr["hold_until"]))
            if eta > horizon_end:
                continue
            comp = station.compatible(tr["cat"], tr["length_m"], closed)
            p = PTrain(
                id=tr["id"], cat=tr["cat"], length_m=tr["length_m"], side_in=tr["side_in"], side_out=tr["side_out"],
                priority=prio, eta=eta, planned_arr=tr["planned_arr"], planned_dep=tr["planned_dep"],
                service_s=int(tr["service_s"]), pending=True, needs_loco=cat.needs_loco, needs_crew=cat.needs_crew,
                compatible=comp, prev_track=(prev.get(tr["id"]) or {}).get("track"), status=st,
            )
            trains.append(p)
            # прибывший грузовой привезёт локомотив и бригаду: виртуальный ресурс
            if cat.needs_loco:
                locos.append(Resource(id=f"~{tr['id']}", avail=eta + th + station.loco_turnaround_s, virtual=True))
            if cat.needs_crew:
                crews.append(Resource(id=f"~{tr['id']}", avail=eta + th + station.crew_rest_s, virtual=True))
        elif st in PRESENT:
            ready = max(now, int(tr.get("service_done_at") or now))
            p = PTrain(
                id=tr["id"], cat=tr["cat"], length_m=tr["length_m"], side_in=tr["side_in"], side_out=tr["side_out"],
                priority=prio, eta=int(tr.get("entered_at") or now), planned_arr=tr["planned_arr"],
                planned_dep=tr["planned_dep"], service_s=int(tr["service_s"]), pending=False, track=tr["track"],
                ready_min=ready, status=st,
                needs_loco=cat.needs_loco and not tr.get("loco"),
                needs_crew=cat.needs_crew and not tr.get("crew"),
                loco_ready_at=tr.get("loco_ready_at") if tr.get("loco") else None,
                crew_ready_at=tr.get("crew_ready_at") if tr.get("crew") else None,
            )
            if p.loco_ready_at:
                p.ready_min = max(p.ready_min, int(p.loco_ready_at))
            if p.crew_ready_at:
                p.ready_min = max(p.ready_min, int(p.crew_ready_at))
            if tr.get("ready_at"):
                p.ready_min = now
            trains.append(p)
        elif st == "departing" and tr.get("track"):
            end = int(tr.get("departed_at") or now) + th + station.track_buffer_s
            fixed_track.setdefault(tr["track"], []).append((now, max(now + 1, end)))

    for lc in snap["locos"]:
        if lc["status"] == "available":
            locos.append(Resource(id=lc["id"], avail=now))
        elif lc["status"] in ("turnaround", "failed"):
            locos.append(Resource(id=lc["id"], avail=max(now, int(lc["until"]))))
    for cr in snap["crews"]:
        if cr["status"] == "available":
            crews.append(Resource(id=cr["id"], avail=now))
        elif cr["status"] == "rest":
            crews.append(Resource(id=cr["id"], avail=max(now, int(cr["until"]))))

    trains.sort(key=lambda p: (p.pending, p.eta))
    return Problem(now=now, horizon_end=horizon_end, trains=trains, locos=locos, crews=crews,
                   fixed_track=fixed_track, fixed_ladder=fixed_ladder, closed=closed, station=station)
