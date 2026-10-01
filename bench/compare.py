"""Офлайн-бенчмарк: реактивный FCFS-диспетчер против ИИ-планировщика на одном и том же потоке.

    python bench/compare.py --hours 8 --replan-min 1
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "shared"))

from dstation.config import load_index_config, load_planner_config, load_scenario  # noqa: E402
from dstation.planner.core import make_plan  # noqa: E402
from dstation.sim.runner import make_worlds  # noqa: E402
from dstation.station import build_station  # noqa: E402
from dstation import index as index_mod  # noqa: E402


def summarize(w) -> dict:
    trs = [t for t in w.trains.values()]
    done = [t for t in trs if t.departed_at is not None and t.spec.actual_arr >= 0]
    entry = [(t.entered_at - t.spec.actual_arr) / 60 for t in trs if t.entered_at is not None and t.spec.actual_arr >= 0]
    dev = [max(0, t.departed_at - t.spec.planned_dep) / 60 for t in done]
    dwell = [(t.departed_at - t.entered_at) / 60 for t in done if t.entered_at is not None]
    resw = [t.res_wait_s / 60 for t in done]
    stops = sum(1 for t in trs if t.stopped_at_signal and t.spec.actual_arr >= 0)
    pas = [max(0, t.departed_at - t.spec.planned_dep) / 60 for t in done if t.spec.cat == "pass"]
    return {
        "departed": len(done),
        "avg_entry_wait_min": round(statistics.mean(entry), 1) if entry else 0,
        "p90_entry_wait_min": round(sorted(entry)[int(len(entry) * 0.9)], 1) if entry else 0,
        "max_entry_wait_min": round(max(entry), 1) if entry else 0,
        "avg_dep_delay_min": round(statistics.mean(dev), 1) if dev else 0,
        "pass_avg_delay_min": round(statistics.mean(pas), 1) if pas else 0,
        "avg_dwell_min": round(statistics.mean(dwell), 1) if dwell else 0,
        "avg_resource_wait_min": round(statistics.mean(resw), 1) if resw else 0,
        "signal_stops": stops,
        "queue_now": sum(1 for t in trs if t.status in ("at_signal", "held", "approaching") and w.t > t.spec.actual_arr + 60),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=float, default=8)
    ap.add_argument("--replan-min", type=float, default=1.0)
    ap.add_argument("--time-limit", type=float, default=1.0)
    ap.add_argument("--json", type=str, default="")
    args = ap.parse_args()
    station = build_station()
    scn = load_scenario()
    pcfg = load_planner_config()
    icfg = load_index_config()
    worlds = make_worlds(station, scn)
    # в офлайн-прогоне трассы gc не нужны
    for w in worlds.values():
        w._gc = lambda: None
    total = int(args.hours * 3600)
    step = int(args.replan_min * 60)
    plan = None
    times, idx = [], {"baseline": [], "ai": []}
    t_start = time.time()
    while worlds["ai"].t < total:
        snap = worlds["ai"].snapshot()
        plan = make_plan(station, snap, pcfg, icfg, plan, time_limit_s=args.time_limit, with_analysis=False)
        times.append(plan["solver"]["time_ms"])
        worlds["ai"].plan = plan
        for w in worlds.values():
            w.advance(step)
            idx[w.name].append(index_mod.compute(w.kpi(), icfg)["value"])
        if worlds["ai"].t % 3600 < step:
            b, a = summarize(worlds["baseline"]), summarize(worlds["ai"])
            print(f"[{worlds['ai'].t // 3600:>2} ч] FCFS: ожидание {b['avg_entry_wait_min']:>5} мин, очередь {b['queue_now']:>2} | "
                  f"ИИ: ожидание {a['avg_entry_wait_min']:>5} мин, очередь {a['queue_now']:>2} | решатель {plan['solver']['engine']} {plan['solver']['time_ms']} мс",
                  flush=True)
    res = {"baseline": summarize(worlds["baseline"]), "ai": summarize(worlds["ai"])}
    res["baseline"]["avg_index"] = round(statistics.mean(idx["baseline"]), 1)
    res["ai"]["avg_index"] = round(statistics.mean(idx["ai"]), 1)
    res["solver_ms"] = {"avg": round(statistics.mean(times)), "p95": sorted(times)[int(len(times) * 0.95)], "max": max(times)}
    print()
    print(f"{'Показатель':<28}{'FCFS':>10}{'ИИ':>10}{'Δ':>10}")
    for k in res["baseline"]:
        b, a = res["baseline"][k], res["ai"][k]
        d = f"{(a - b) / b * 100:+.0f}%" if isinstance(b, (int, float)) and b else ""
        print(f"{k:<28}{b:>10}{a:>10}{d:>10}")
    print(f"\nРешатель: среднее {res['solver_ms']['avg']} мс, p95 {res['solver_ms']['p95']} мс, max {res['solver_ms']['max']} мс; "
          f"прогон {time.time() - t_start:.0f} с")
    if args.json:
        Path(args.json).write_text(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
