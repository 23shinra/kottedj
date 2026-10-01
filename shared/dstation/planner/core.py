"""Точка входа планировщика: план, варианты при сбое, прогноз и рекомендации."""
from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from .. import index as index_mod
from ..station import Station
from . import cpsat, greedy
from .analysis import detect_conflicts, projected_kpi, recommendations
from .problem import build_problem


def make_plan(station: Station, snap: dict[str, Any], cfg: dict[str, Any], index_cfg: dict[str, Any],
              prev_plan: dict[str, Any] | None = None, variant: dict[str, Any] | None = None,
              time_limit_s: float | None = None, with_analysis: bool = True) -> dict[str, Any]:
    t0 = time.perf_counter()
    pb = build_problem(station, snap, cfg, prev_plan, (variant or {}).get("priority_scale"))
    weights = None
    if variant:
        weights = {k: variant[k] for k in ("entry_delay", "departure_delay") if k in variant}
    # warm start: решение жадной эвристики как подсказка для CP-SAT
    seed = greedy.solve(pb, cfg)
    hints = seed["assignments"]
    res = None
    try:
        res = cpsat.solve(pb, cfg, weights, time_limit_s, hints)
    except Exception as e:  # noqa: BLE001 — решатель не должен ронять сервис
        res = None
        err = repr(e)
    else:
        err = None
    if res is None:
        res = seed
        res["solver"]["fallback_reason"] = err or "cp-sat: нет решения в лимите времени"
    a = res["assignments"]
    kpi = projected_kpi(pb, a)
    plan: dict[str, Any] = {
        "sim_time": pb.now,
        "created_at": time.time(),
        "variant": (variant or {}).get("id", "balanced"),
        "variant_name": (variant or {}).get("name", "Сбалансированный"),
        "assignments": a,
        "solver": res["solver"],
        "projected_kpi": kpi,
        "projected_index": index_mod.compute(kpi, index_cfg),
        "trains_planned": len(a),
    }
    if with_analysis:
        plan["conflicts"] = _mark_resolved(detect_conflicts(pb), a)
        plan["recommendations"] = recommendations(pb, a, snap, cfg)
    plan["total_ms"] = round((time.perf_counter() - t0) * 1000)
    return plan


def _mark_resolved(conflicts: list[dict[str, Any]], a: dict[str, Any]) -> list[dict[str, Any]]:
    for c in conflicts:
        if c["type"] == "route_crossing":
            x, y = (a.get(t) for t in c["trains"])
            c["resolved"] = bool(x and y)
            if c["resolved"]:
                first, second = sorted(c["trains"], key=lambda t: a[t]["entry_at"])
                gap = (a[second]["entry_at"] - a[first]["entry_at"]) // 60
                c["resolution"] = f"№{first} пропускается первым, №{second} через {gap} мин (путь {a[second]['track']})"
        elif c["type"] in ("loco_shortage", "crew_shortage"):
            key = "loco_missing" if c["type"] == "loco_shortage" else "crew_missing"
            c["resolved"] = not any(v.get(key) for v in a.values())
            c["resolution"] = "ресурсы перераспределены по времени готовности" if c["resolved"] else "нужен резерв"
        elif c["type"] == "track_shortage":
            c["resolved"] = True
            c["resolution"] = "очередь переведена в слоты на подходе"
        else:
            c["resolved"] = False
    return conflicts


def make_variants(station: Station, snap: dict[str, Any], cfg: dict[str, Any], index_cfg: dict[str, Any],
                  prev_plan: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Три варианта плана считаются параллельно (CP-SAT отпускает GIL), ядра делятся между ними."""
    tl = float(cfg.get("solver", {}).get("variant_time_limit_s", 1.0))
    profiles = cfg.get("variants", [])
    workers = max(2, int(cfg.get("solver", {}).get("workers", 8)) // max(1, len(profiles)))
    vcfg = {**cfg, "solver": {**cfg.get("solver", {}), "workers": workers}}
    with ThreadPoolExecutor(max_workers=max(1, len(profiles))) as ex:
        futs = [ex.submit(make_plan, station, snap, vcfg, index_cfg, prev_plan, v, tl, v["id"] == "balanced")
                for v in profiles]
        out = [f.result() for f in futs]
    for p, v in zip(out, profiles):
        p["description"] = v.get("description", "")
    # анализ (конфликты/рекомендации) общий — берём из сбалансированного
    base = next((p for p in out if p["variant"] == "balanced"), out[0] if out else None)
    for p in out:
        if base and "conflicts" not in p:
            p["conflicts"] = base.get("conflicts", [])
            p["recommendations"] = base.get("recommendations", [])
    return out
