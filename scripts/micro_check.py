"""Офлайн-проверка микромодели: детерминированный прогон всех сценариев без сервера.

Для каждого сценария печатает поезда, задержки, отказы, MTTR, нарушения безопасности
и порог реакции (время от отказа до запрета движения и проверка тормозного пути
каждого затронутого поезда на следующем шаге). Код выхода 1 — если найдено нарушение.

    python scripts/micro_check.py [--markdown]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "shared"))

from dstation.micro import MicroSim, list_scenarios  # noqa: E402


def check_scale() -> str:
    m = MicroSim("normal", scale=60, running=True)
    steps = m.advance_real(1.0)
    m.command({"type": "pause"})
    paused = m.advance_real(1.0)
    return f"×60: 1 с реального = {steps} с модельного; на паузе продвинуто {paused} с"


def reaction_probe() -> tuple[int, int, int, float | None, int]:
    """Отказ муфты первой стрелки маршрута в момент, когда по нему идёт поезд (по каждому маршруту исправного сценария).

    Возвращает (проб, проб с проверенными поездами, из них в движении, мин. запас торможения движущихся, м, нарушений)."""
    base = MicroSim("normal")
    seen: dict[str, float] = {}
    while base.world.t < base.duration_s:
        base.world.step(1.0)
        for rid, r in base.world.routes.items():
            if rid not in seen and r.train and base.infra.routes[rid].switch_map:
                seen[rid] = base.world.t
    probes = checked = moving = bad = 0
    margin: float | None = None
    for rid, t in seen.items():
        for offset in (5.0, 60.0):
            m = MicroSim("normal")
            m.run_for(t + offset)
            w = m.world
            if rid not in w.routes:
                continue
            sw = next(iter(m.infra.routes[rid].switch_map))
            if not m.command({"type": "fault", "device": f"СМ-{sw}"})["ok"]:
                continue
            probes += 1
            rec = w.reactions[-1]
            m.run_for(900)
            checked += bool(rec["checked"])
            bad += (rec["t_ban"] != rec["t_fault"]) + (not rec["ok"]) + len(w.violations)
            for c in rec["checked"]:
                if c["v_kmh"] <= 0:
                    continue
                moving += 1
                d = c["stop_m"] - c["brake_m"]
                margin = d if margin is None else min(margin, d)
    return probes, checked, moving, margin, bad


def run(markdown: bool) -> int:
    rows = []
    bad = 0
    for s in list_scenarios():
        m = MicroSim(s["id"])
        t0 = time.perf_counter()
        m.run_for(m.duration_s)
        wall = time.perf_counter() - t0
        k = m.world.kpi()
        reactions = m.world.reactions
        checked = [c for r in reactions for c in r["checked"]]
        min_margin = min((c["stop_m"] - c["brake_m"] for c in checked), default=None)
        ok = k["safety_violations"] == 0 and k["reaction_ok"]
        bad += not ok
        rows.append({
            "id": s["id"], "name": s["name"], "h": s["duration_h"], "wall": wall, "trains": f"{k['departed']}/{k['trains']}",
            "arr": k["avg_arr_delay_min"], "dep": k["avg_dep_delay_min"], "refusals": k["route_refusals"],
            "faults": len(reactions), "mttr": k["mttr_min"], "react_s": k["reaction_max_s"],
            "checked": len(checked), "margin": min_margin, "safety": k["safety_violations"], "ok": ok,
        })

    if markdown:
        print("| Сценарий | Отправлено | Ср. задержка приб./отпр., мин | Отказов маршрута | Отказов оборуд. | MTTR, мин | Реакция, с | Поездов проверено (мин. запас, м) | Нарушений | Прогон |")
        print("|---|---|---|---|---|---|---|---|---|---|")
        for r in rows:
            margin = f"{r['checked']} ({r['margin']:.0f})" if r["margin"] is not None else "—"
            print(f"| {r['name']} | {r['trains']} | {r['arr']} / {r['dep']} | {r['refusals']} | {r['faults']} | {r['mttr'] if r['mttr'] is not None else '—'} "
                  f"| {r['react_s']:g} | {margin} | {r['safety']} | {r['h']} ч за {r['wall']:.2f} с |")
    else:
        for r in rows:
            margin = f", мин. запас торможения {r['margin']:.0f} м по {r['checked']} поездам" if r["margin"] is not None else ""
            print(f"{'OK ' if r['ok'] else 'FAIL'} {r['name']}: отправлено {r['trains']}, задержка {r['arr']}/{r['dep']} мин, "
                  f"отказов оборудования {r['faults']}, MTTR {r['mttr']}, реакция {r['react_s']:g} с{margin}, нарушений {r['safety']} "
                  f"({r['h']} ч модели за {r['wall']:.2f} с)")
    print(check_scale())
    probes, checked, moving, margin, probe_bad = reaction_probe()
    print(f"Порог реакции: {probes} отказов стрелки под поездом, у {checked} поезд проверен на следующем шаге "
          f"({moving} в движении); запрет — в тот же шаг модели; мин. запас торможения движущегося поезда {margin:.0f} м; "
          f"нарушений {probe_bad}"
          if margin is not None else f"Порог реакции: {probes} проб, поезда не затронуты; нарушений {probe_bad}")
    return 1 if bad or probe_bad else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--markdown", action="store_true", help="таблица для README")
    sys.exit(run(ap.parse_args().markdown))
