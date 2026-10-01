"""Интегральный индекс эффективности станции (0–100, A–E) с объяснением вклада факторов.

I = 100 · Σ w_k · s_k / Σ w_k, s_k ∈ [0, 1].
Потерянные баллы фактора: loss_k = 100 · w_k · (1 − s_k) / Σ w_k; сумма потерь = 100 − I.
"""
from __future__ import annotations

from typing import Any


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


def _scores(kpi: dict[str, Any], f: dict[str, Any]) -> dict[str, tuple[float, str]]:
    out: dict[str, tuple[float, str]] = {}
    if "throughput" in f:
        r = float(kpi.get("throughput_ratio", 1.0))
        out["throughput"] = (_clamp(r), f"отправлено {kpi.get('departed_1h', 0)} из {kpi.get('due_1h', 0)} по графику за час")
    if "deviation" in f:
        d = float(kpi.get("avg_deviation_min", 0))
        out["deviation"] = (_clamp(1 - d / f["deviation"].get("worst_min", 40)), f"среднее отклонение {d:.0f} мин")
    if "utilization" in f:
        u = float(kpi.get("utilization", 0))
        lo, hi = f["utilization"].get("optimal", [0.55, 0.85])
        if u < lo:
            s = _clamp(0.5 + 0.5 * u / lo)
            why = f"пути недогружены ({u:.0%})"
        elif u > hi:
            s = _clamp(1 - (u - hi) / max(1e-6, 1 - hi))
            why = f"пути переполнены ({u:.0%}), нет резерва"
        else:
            s, why = 1.0, f"загрузка в норме ({u:.0%})"
        out["utilization"] = (s, why)
    if "conflicts" in f:
        c = float(kpi.get("conflicts", 0))
        out["conflicts"] = (_clamp(1 - c / f["conflicts"].get("worst_count", 8)), f"{c:.0f} неразрешённых конфликтов")
    if "resource_idle" in f:
        r = float(kpi.get("avg_resource_wait_min", 0))
        idle = kpi.get("locos_idle")
        extra = f", свободно локомотивов: {idle}" if idle is not None else ""
        out["resource_idle"] = (_clamp(1 - r / f["resource_idle"].get("worst_min", 30)),
                                f"ожидание локомотива/бригады {r:.0f} мин{extra}")
    if "queue" in f:
        q = float(kpi.get("avg_entry_wait_min", 0))
        n = kpi.get("queue_len", 0)
        out["queue"] = (_clamp(1 - q / f["queue"].get("worst_min", 45)), f"в очереди {n} поездов, ожидание {q:.0f} мин")
    return out


def compute(kpi: dict[str, Any], cfg: dict[str, Any]) -> dict[str, Any]:
    f = cfg["factors"]
    sc = _scores(kpi, f)
    wsum = sum(float(f[k]["weight"]) for k in sc) or 1.0
    factors = []
    total = 0.0
    for k, (s, why) in sc.items():
        w = float(f[k]["weight"]) / wsum
        total += 100 * w * s
        factors.append({
            "id": k, "name": f[k]["name"], "weight": round(w, 3), "score": round(s, 3),
            "points": round(100 * w * s, 1), "loss": round(100 * w * (1 - s), 1), "why": why,
            "description": f[k].get("description", ""),
        })
    value = round(total, 1)
    cat = next((c for c in cfg["categories"] if value >= c["min"]), cfg["categories"][-1])
    grade = next((g["grade"] for g in cfg["grades"] if value >= g["min"]), "E")
    top = sorted(factors, key=lambda x: -x["loss"])[:5]
    return {
        "value": value,
        "grade": grade,
        "category": {"id": cat["id"], "name": cat["name"], "color": cat.get("color"), "reason": cat.get("reason")},
        "factors": factors,
        "top": top,
    }
