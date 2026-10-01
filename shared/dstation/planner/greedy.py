"""Жадная эвристика (list scheduling). Используется как fallback, если CP-SAT не уложился в лимит,
и как стартовое решение. Работает за миллисекунды."""
from __future__ import annotations

import time
from typing import Any

from .problem import Problem


def _earliest(busy: list[tuple[int, int]], t: int, dur: int) -> int:
    for a, b in sorted(busy):
        if t + dur <= a:
            return t
        if t < b:
            t = b
    return t


def solve(pb: Problem, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    t0 = time.perf_counter()
    st = pb.station
    th, buf = st.throat_s, st.track_buffer_s
    track_busy: dict[str, list[tuple[int, int]]] = {tid: list(v) for tid, v in pb.fixed_track.items()}
    ladder_busy: dict[str, list[tuple[int, int]]] = {lid: list(v) for lid, v in pb.fixed_ladder.items()}
    loco_free = sorted((r.avail, r.id) for r in pb.locos if not r.virtual)
    crew_free = sorted((r.avail, r.id) for r in pb.crews if not r.virtual)
    out: dict[str, Any] = {}

    def take(pool: list[tuple[int, str]], need_at: int) -> tuple[int, str] | None:
        if not pool:
            return None
        pool.sort()
        return pool.pop(0)

    present = [p for p in pb.trains if not p.pending]
    pending = sorted([p for p in pb.trains if p.pending], key=lambda p: p.eta - p.priority * 120)
    for p in present + pending:
        if p.pending:
            best = None
            for tid in p.compatible:
                t = p.eta
                for _ in range(20):
                    t1 = _earliest(track_busy.get(tid, []), t, th + p.service_s + th + buf)
                    t2 = _earliest(ladder_busy.get(st.ladder(tid, p.side_in), []), t1, th)
                    if t2 == t1:
                        break
                    t = t2
                key = (t1, st.tracks[tid].length_m)
                if best is None or key < best[0]:
                    best = (key, tid, t1)
            if best is None:
                continue
            _, tid, entry = best
            ready = entry + th + p.service_s
        else:
            tid, entry, ready = p.track, None, p.ready_min
        dep = max(ready, p.planned_dep) if p.cat == "pass" else ready
        a: dict[str, Any] = {"track": tid}
        if p.needs_loco:
            r = take(loco_free, dep)
            if r:
                dep = max(dep, r[0] + st.loco_prep_s)
                a["loco"] = r[1]
            else:
                a["loco"], a["loco_missing"] = None, True
        if p.needs_crew:
            r = take(crew_free, dep)
            if r:
                dep = max(dep, r[0] + st.crew_prep_s)
                a["crew"] = r[1]
            else:
                a["crew"], a["crew_missing"] = None, True
        exit_l = st.ladder(tid, p.side_out)
        dep = _earliest(ladder_busy.get(exit_l, []), dep, th)
        if "loco" in a:
            a["loco_at"] = dep - st.loco_prep_s - 60
        if "crew" in a:
            a["crew_at"] = dep - st.crew_prep_s - 60
        start = entry if entry is not None else pb.now
        track_busy.setdefault(tid, []).append((start, dep + th + buf))
        ladder_busy.setdefault(exit_l, []).append((dep, dep + th))
        if entry is not None:
            ladder_busy.setdefault(st.ladder(tid, p.side_in), []).append((entry, entry + th))
            a["entry_at"] = entry
        a["dep_at"] = dep
        out[p.id] = a
    return {
        "assignments": out,
        "solver": {"engine": "greedy", "status": "HEURISTIC", "objective": None,
                   "time_ms": round((time.perf_counter() - t0) * 1000)},
    }
