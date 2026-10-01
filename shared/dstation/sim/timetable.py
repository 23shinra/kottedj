"""Генерация графика прибытия по сценарию (неоднородный пуассоновский поток с пиками)."""
from __future__ import annotations

import random
from dataclasses import dataclass
from typing import Any

from ..station import Station

VMAX_KMH = {"pass": 100.0, "freight_transit": 70.0, "freight_local": 60.0}


@dataclass
class TrainSpec:
    id: str
    cat: str
    length_m: int
    side_in: str
    side_out: str
    planned_arr: int        # по графику, sim-сек
    planned_dep: int
    actual_arr: int         # фактическое прибытие к входному сигналу при движении без ограничений
    service_s: int          # фактическая длительность технологических операций
    vmax_ms: float


def _rate(scn: dict[str, Any], cat: str, t_h: float) -> float:
    r = scn["base_rate_per_h"][cat]
    for p in scn.get("peaks", []):
        if p["start_h"] <= t_h < p["end_h"]:
            r *= p["factor"]
    return r


def _peak_factor_max(scn: dict[str, Any]) -> float:
    return max([1.0] + [p["factor"] for p in scn.get("peaks", [])])


def generate(station: Station, scn: dict[str, Any], start_s: int = 0) -> list[TrainSpec]:
    rnd = random.Random(scn.get("seed", 42))
    duration_s = int(scn.get("duration_h", 24) * 3600)
    jmin, jmax = scn.get("arrival_jitter_min", [-3, 10])
    counters = {"pass": 101, "freight_transit": 2001, "freight_local": 3501}
    specs: list[TrainSpec] = []
    fmax = _peak_factor_max(scn)
    for cat, base in scn["base_rate_per_h"].items():
        lam_max = base * fmax / 3600.0
        t = float(start_s)
        while True:
            t += rnd.expovariate(lam_max)
            if t >= start_s + duration_s:
                break
            if rnd.random() > _rate(scn, cat, (t - start_s) / 3600.0) / (base * fmax):
                continue  # thinning
            c = station.categories[cat]
            length = int(rnd.uniform(*c.length_m) // 10 * 10)
            side_in = rnd.choice(["W", "E"])
            side_out = ("E" if side_in == "W" else "W") if cat != "freight_local" else rnd.choice(["W", "E"])
            service_s = int(rnd.uniform(*c.service_min) * 60)
            nominal = c.service_min[1] * 60 + (15 * 60 if c.needs_loco else 0) + 2 * station.throat_s
            planned_arr = int(t // 60 * 60)
            planned_dep = planned_arr + int(nominal // 60 * 60)
            actual_arr = planned_arr + int(rnd.uniform(jmin, jmax) * 60)
            specs.append(TrainSpec(
                id=str(counters[cat]), cat=cat, length_m=length, side_in=side_in, side_out=side_out,
                planned_arr=planned_arr, planned_dep=planned_dep, actual_arr=actual_arr,
                service_s=service_s, vmax_ms=VMAX_KMH[cat] / 3.6,
            ))
            counters[cat] += 2 if cat == "pass" else 1
    specs.sort(key=lambda s: s.actual_arr)
    return specs
