"""CP-SAT модель: назначение путей, слоты приёма, маршруты в горловинах, локомотивы и бригады.

Решение задачи календарного планирования с ограничениями (constraint-based scheduling):
  * NoOverlap на каждом пути: поезд занимает путь от начала приёма до конца отправления + интервал;
  * NoOverlap на каждой стрелочной улице: маршруты, использующие общие стрелки, не пересекаются;
  * назначение локомотивов и бригад, каждый ресурс не более одного поезда на горизонте;
  * минимизация взвешенной по приоритетам задержки приёма и отправления.
"""
from __future__ import annotations

import time
from typing import Any

from ortools.sat.python import cp_model

from .problem import Problem


def solve(pb: Problem, cfg: dict[str, Any], weights: dict[str, float] | None = None,
          time_limit_s: float | None = None, hints: dict[str, Any] | None = None) -> dict[str, Any] | None:
    t0 = time.perf_counter()
    st = pb.station
    th, buf = st.throat_s, st.track_buffer_s
    obj_cfg = {**cfg.get("objective", {}), **(weights or {})}
    w_entry = float(obj_cfg.get("entry_delay", 1.0))
    w_dep = float(obj_cfg.get("departure_delay", 1.5))
    w_change = int(obj_cfg.get("track_change", 30))
    w_unassigned = int(obj_cfg.get("unassigned_resource", 5000))
    w_starve = int(obj_cfg.get("starvation_weight", 8))
    w_starve_after = int(obj_cfg.get("starvation_after_min", 30) * 60)
    now = pb.now
    hmax = pb.horizon_end + 4 * 3600          # запас домена, чтобы задача всегда была разрешима
    freeze = int(cfg.get("freeze_min", 2) * 60)

    m = cp_model.CpModel()
    track_iv: dict[str, list[Any]] = {tid: [] for tid in st.tracks}
    ladder_iv: dict[str, list[Any]] = {lid: [] for lid in st.ladders}
    for tid, ivs in pb.fixed_track.items():
        for a, b in ivs:
            track_iv[tid].append(m.NewIntervalVar(a, b - a, b, f"fix_{tid}_{a}"))
    for lid, ivs in pb.fixed_ladder.items():
        for a, b in ivs:
            ladder_iv[lid].append(m.NewIntervalVar(a, b - a, b, f"fixl_{lid}_{a}"))

    V: dict[str, dict[str, Any]] = {}
    obj = []
    hints = hints or {}
    for p in pb.trains:
        v: dict[str, Any] = {}
        if p.pending:
            if not p.compatible:
                continue                        # некуда принять (все подходящие пути закрыты)
            lo = p.eta
            prev = hints.get(p.id)
            if prev and prev.get("entry_at") is not None and prev["entry_at"] - now < freeze and prev["entry_at"] >= lo:
                lo = int(prev["entry_at"])      # не дёргаем поезд, который вот-вот входит
            entry = m.NewIntVar(lo, hmax, f"en_{p.id}")
            ready = entry + th + p.service_s
            v["entry"] = entry
            v["x"] = {}
            for tid in p.compatible:
                v["x"][tid] = m.NewBoolVar(f"x_{p.id}_{tid}")
            m.AddExactlyOne(v["x"].values())
        else:
            entry = None
            ready = p.ready_min
        dep_lo = p.ready_min if not p.pending else p.eta + th + p.service_s
        if p.cat == "pass":
            dep_lo = max(dep_lo, p.planned_dep)
        dep = m.NewIntVar(max(now, dep_lo), hmax, f"dep_{p.id}")
        if p.pending:
            m.Add(dep >= ready)
        end = m.NewIntVar(now, hmax + th + buf, f"end_{p.id}")
        m.Add(end == dep + th + buf)
        v["dep"], v["end"] = dep, end
        if (h := hints.get(p.id)) and h.get("dep_at") is not None:
            m.AddHint(dep, max(now, dep_lo, int(h["dep_at"])))

        # занятие пути
        if p.pending:
            size = m.NewIntVar(0, hmax + th + buf - p.eta, f"sz_{p.id}")
            m.Add(size == end - entry)
            for tid, x in v["x"].items():
                track_iv[tid].append(m.NewOptionalIntervalVar(entry, size, end, x, f"occ_{p.id}_{tid}"))
            # маршруты приёма и отправления через стрелочные улицы
            by_ladder_in: dict[str, list[Any]] = {}
            by_ladder_out: dict[str, list[Any]] = {}
            for tid, x in v["x"].items():
                by_ladder_in.setdefault(st.ladder(tid, p.side_in), []).append(x)
                by_ladder_out.setdefault(st.ladder(tid, p.side_out), []).append(x)
            for lid, xs in by_ladder_in.items():
                pres = m.NewBoolVar(f"li_{p.id}_{lid}")
                m.Add(sum(xs) == pres)
                ladder_iv[lid].append(m.NewOptionalIntervalVar(entry, th, entry + th, pres, f"rin_{p.id}_{lid}"))
            for lid, xs in by_ladder_out.items():
                pres = m.NewBoolVar(f"lo_{p.id}_{lid}")
                m.Add(sum(xs) == pres)
                ladder_iv[lid].append(m.NewOptionalIntervalVar(dep, th, dep + th, pres, f"rout_{p.id}_{lid}"))
            # стабильность: штраф за смену пути относительно предыдущего плана
            if p.prev_track and p.prev_track in v["x"]:
                obj.append(w_change * (1 - v["x"][p.prev_track]))
            if (h := hints.get(p.id)) and h.get("entry_at") is not None:
                m.AddHint(entry, max(lo, int(h["entry_at"])))
                if h.get("track") in v["x"]:
                    for tid, x in v["x"].items():
                        m.AddHint(x, int(tid == h["track"]))
            obj.append(int(round(p.priority * w_entry)) * (entry - p.eta))
            # защита от «голодания» низкоприоритетных: ожидание сверх порога штрафуется сильнее
            starve = m.NewIntVar(0, hmax, f"starve_{p.id}")
            m.Add(starve >= entry - p.eta - w_starve_after)
            obj.append(w_starve * starve)
        else:
            size = m.NewIntVar(0, hmax + th + buf - now, f"sz_{p.id}")
            m.Add(size == end - now)
            track_iv[p.track].append(m.NewIntervalVar(now, size, end, f"occ_{p.id}_{p.track}"))
            lid = st.ladder(p.track, p.side_out)
            ladder_iv[lid].append(m.NewIntervalVar(dep, th, dep + th, f"rout_{p.id}"))

        # опоздание отправления и «лишняя» стоянка (освобождать пути раньше)
        late = m.NewIntVar(0, hmax, f"late_{p.id}")
        m.Add(late >= dep - p.planned_dep)
        obj.append(int(round(p.priority * w_dep)) * late)
        obj.append(dep - max(now, dep_lo))
        V[p.id] = v

    for tid, ivs in track_iv.items():
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)
    for lid, ivs in ladder_iv.items():
        if len(ivs) > 1:
            m.AddNoOverlap(ivs)

    # ресурсы: локомотивы и бригады — cumulative без симметрии.
    # Пул = ёмкость; ресурс, который ещё не освободился, «занят» фиксированным интервалом [now, avail);
    # поезд забирает ресурс с момента подачи (dep − prep) до конца горизонта.
    cum_end = hmax + 12 * 3600
    res_vars: dict[str, dict[str, Any]] = {"loco": {}, "crew": {}}

    def resource(kind: str, pool: list[Any], prep: int, extra: int) -> None:
        users = [p for p in pb.trains if p.id in V and getattr(p, f"needs_{kind}")]
        if not users:
            return
        ivs, demands, cap = [], [], 0
        for r in pool:
            if r.virtual:
                src = V.get(r.id[1:])
                if not src or "entry" not in src:
                    continue
                cap += 1
                busy_end = m.NewIntVar(now, hmax + th + extra, f"{kind}_v_{r.id}")
                m.Add(busy_end == src["entry"] + th + extra)
                sz = m.NewIntVar(0, hmax + th + extra - now, f"{kind}_vs_{r.id}")
                m.Add(sz == busy_end - now)
                ivs.append(m.NewIntervalVar(now, sz, busy_end, f"{kind}_vi_{r.id}"))
                demands.append(1)
            else:
                cap += 1
                if r.avail > now:
                    ivs.append(m.NewIntervalVar(now, r.avail - now, r.avail, f"{kind}_b_{r.id}"))
                    demands.append(1)
        for p in users:
            v = V[p.id]
            has = m.NewBoolVar(f"{kind}_has_{p.id}")
            start = m.NewIntVar(now - prep, hmax, f"{kind}_st_{p.id}")
            m.Add(start == v["dep"] - prep)
            m.Add(start >= now).OnlyEnforceIf(has)
            if "entry" in v:
                m.Add(start >= v["entry"] + th).OnlyEnforceIf(has)
            sz = m.NewIntVar(0, cum_end - now + prep, f"{kind}_sz_{p.id}")
            m.Add(sz == cum_end - start)
            ivs.append(m.NewOptionalIntervalVar(start, sz, cum_end, has, f"{kind}_u_{p.id}"))
            demands.append(1)
            m.Add(v["dep"] >= pb.horizon_end).OnlyEnforceIf(has.Not())
            obj.append(w_unassigned * has.Not())
            res_vars[kind][p.id] = has
        m.AddCumulative(ivs, demands, cap)

    resource("loco", pb.locos, st.loco_prep_s, st.loco_turnaround_s)
    resource("crew", pb.crews, st.crew_prep_s, st.crew_rest_s)

    m.Minimize(sum(obj))
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_s or cfg.get("solver", {}).get("time_limit_s", 1.5))
    solver.parameters.num_search_workers = int(cfg.get("solver", {}).get("workers", 8))
    status = solver.Solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return None

    out: dict[str, Any] = {}
    for p in pb.trains:
        v = V.get(p.id)
        if v is None:
            continue
        a: dict[str, Any] = {"dep_at": solver.Value(v["dep"])}
        if p.pending:
            a["entry_at"] = solver.Value(v["entry"])
            a["track"] = next(tid for tid, x in v["x"].items() if solver.Value(x))
        else:
            a["track"] = p.track
        out[p.id] = a

    # конкретные номера ресурсов: сопоставление по времени (раньше освободился — раньше подан)
    for kind, pool, prep, extra in (("loco", pb.locos, st.loco_prep_s, st.loco_turnaround_s),
                                    ("crew", pb.crews, st.crew_prep_s, st.crew_rest_s)):
        avail = []
        for r in pool:
            if r.virtual:
                src = out.get(r.id[1:])
                if src and "entry_at" in src:
                    avail.append([src["entry_at"] + th + extra, None, r.id[1:]])
            else:
                avail.append([r.avail, r.id, None])
        avail.sort(key=lambda x: (x[0], x[1] is None))
        users = sorted((pid for pid, has in res_vars[kind].items()), key=lambda pid: out[pid]["dep_at"])
        for pid in users:
            a = out[pid]
            if not solver.Value(res_vars[kind][pid]):
                a[kind], a[f"{kind}_missing"] = None, True
                continue
            need = a["dep_at"] - prep
            pick = next((r for r in avail if r[0] <= need and r[2] != pid), None)
            if pick is None:
                pick = next((r for r in avail if r[2] != pid), None)
            if pick is not None:
                avail.remove(pick)
                a[kind] = pick[1]
                if pick[2]:
                    a[f"{kind}_from"] = pick[2]
            else:
                a[kind] = None
            a[f"{kind}_at"] = need - 60
    return {
        "assignments": out,
        "solver": {
            "engine": "cp-sat",
            "status": solver.StatusName(status),
            "objective": solver.ObjectiveValue(),
            "bound": solver.BestObjectiveBound(),
            "time_ms": round((time.perf_counter() - t0) * 1000),
            "vars": len(m.Proto().variables),
            "constraints": len(m.Proto().constraints),
        },
    }
