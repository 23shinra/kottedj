"""Обнаружение конфликтов, прогноз перегрузки, рекомендации диспетчеру, прогнозные KPI плана."""
from __future__ import annotations

from typing import Any

from ..station import Station
from .problem import Problem


def fmt_clock(t: int, start_clock: str = "06:00") -> str:
    h0, m0 = (int(x) for x in start_clock.split(":"))
    total = (h0 * 60 + m0) * 60 + int(t)
    total %= 24 * 3600
    return f"{total // 3600:02d}:{total % 3600 // 60:02d}"


def detect_conflicts(pb: Problem, window_s: int = 3600) -> list[dict[str, Any]]:
    """Конфликты «наивного» исполнения графика (все входят при прибытии на первый подходящий путь)."""
    st = pb.station
    clk = st.raw.get("start_clock", "06:00")
    now = pb.now
    out: list[dict[str, Any]] = []
    pending = sorted([p for p in pb.trains if p.pending and p.eta <= now + window_s], key=lambda p: p.eta)
    # 1. пересечения маршрутов: два поезда требуют одну стрелочную улицу почти одновременно
    for i, a in enumerate(pending):
        for b in pending[i + 1:]:
            if b.eta - a.eta >= st.throat_s:
                break
            if a.side_in != b.side_in or not a.compatible or not b.compatible:
                continue
            la = {st.ladder(t, a.side_in) for t in a.compatible}
            lb = {st.ladder(t, b.side_in) for t in b.compatible}
            if la & lb and (len(la) == 1 or len(lb) == 1):
                out.append({"type": "route_crossing", "severity": "medium", "trains": [a.id, b.id],
                            "at": a.eta, "text": f"Пересечение маршрутов №{a.id} и №{b.id} в горловине {a.side_in} ({fmt_clock(a.eta, clk)})"})
    # 2. занятость путей: спрос по паркам превышает число открытых путей
    occ: dict[str, list[tuple[int, int]]] = {}
    for p in pb.trains:
        if not p.pending:
            occ.setdefault(st.tracks[p.track].park, []).append((now, p.ready_min + st.throat_s))
    for p in pending:
        if not p.compatible:
            out.append({"type": "no_track", "severity": "high", "trains": [p.id], "at": p.eta,
                        "text": f"№{p.id}: нет открытого пути подходящей длины/типа"})
            continue
        park = st.tracks[p.compatible[0]].park
        occ.setdefault(park, []).append((p.eta, p.eta + 2 * st.throat_s + p.service_s))
    for park, ivs in occ.items():
        cap = sum(1 for t in st.tracks.values() if t.park == park and t.id not in pb.closed)
        for t in range(now, now + window_s, 600):
            demand = sum(1 for a, b in ivs if a <= t < b)
            if demand > cap:
                out.append({"type": "track_shortage", "severity": "high", "park": park, "at": t,
                            "text": f"Нехватка путей в парке {park} в {fmt_clock(t, clk)}: нужно {demand}, открыто {cap}"})
                break
    # 3. нехватка ресурсов
    need = sum(1 for p in pb.trains if p.needs_loco and (p.pending is False or p.eta <= now + window_s))
    have = sum(1 for r in pb.locos if r.avail <= now + window_s)
    if need > have:
        out.append({"type": "loco_shortage", "severity": "high", "at": now,
                    "text": f"Дефицит локомотивов на ближайший час: нужно {need}, доступно {have}"})
    needc = sum(1 for p in pb.trains if p.needs_crew and (p.pending is False or p.eta <= now + window_s))
    havec = sum(1 for r in pb.crews if r.avail <= now + window_s)
    if needc > havec:
        out.append({"type": "crew_shortage", "severity": "high", "at": now,
                    "text": f"Дефицит бригад на ближайший час: нужно {needc}, доступно {havec}"})
    return out


def projected_kpi(pb: Problem, assignments: dict[str, Any], window_s: int = 3600) -> dict[str, Any]:
    """KPI, которые получатся, если исполнить план (для сравнения вариантов)."""
    now = pb.now
    st = pb.station
    entry_waits, devs, res_waits = [], [], []
    deps_in_window, due = 0, 0
    missing = 0
    for p in pb.trains:
        a = assignments.get(p.id)
        if p.planned_dep <= now + window_s:
            due += 1
        if not a:
            if p.pending and p.eta <= now + window_s:
                missing += 1
            continue
        if a.get("loco_missing") or a.get("crew_missing"):
            missing += 1
        if p.pending and p.eta <= now + window_s:
            entry_waits.append((a["entry_at"] - p.eta) / 60)
        if a["dep_at"] <= now + window_s:
            deps_in_window += 1
        if p.planned_dep <= now + window_s or a["dep_at"] <= now + window_s:
            devs.append(max(0, a["dep_at"] - p.planned_dep) / 60)
        ready = (a.get("entry_at", now) + st.throat_s + p.service_s) if p.pending else p.ready_min
        res_waits.append(max(0, a["dep_at"] - max(ready, p.planned_dep if p.cat == "pass" else ready)) / 60)
    t_mid = now + 1800
    open_tracks = [t for t in st.tracks if t not in pb.closed]
    busy = 0
    for tid in open_tracks:
        for p in pb.trains:
            a = assignments.get(p.id)
            if a and a["track"] == tid and a.get("entry_at", now) <= t_mid < a["dep_at"] + st.throat_s:
                busy += 1
                break
    return {
        "throughput_ratio": round(min(1.0, deps_in_window / due), 3) if due else 1.0,
        "departed_1h": deps_in_window, "due_1h": due,
        "avg_deviation_min": round(sum(devs) / len(devs), 1) if devs else 0.0,
        "utilization": round(busy / max(1, len(open_tracks)), 3),
        "conflicts": missing,
        "avg_resource_wait_min": round(sum(res_waits) / len(res_waits), 1) if res_waits else 0.0,
        "avg_entry_wait_min": round(sum(entry_waits) / len(entry_waits), 1) if entry_waits else 0.0,
        "queue_len": sum(1 for w in entry_waits if w > 2),
    }


def recommendations(pb: Problem, assignments: dict[str, Any], snap: dict[str, Any],
                    cfg: dict[str, Any]) -> list[dict[str, Any]]:
    st: Station = pb.station
    clk = st.raw.get("start_clock", "06:00")
    now = pb.now
    fc = cfg.get("forecast", {})
    window = int(fc.get("window_min", 60) * 60)
    recs: list[dict[str, Any]] = []
    pending = [p for p in pb.trains if p.pending and p.id in assignments]

    # 1. резервный путь при дефиците в ПО-парке
    late_freight = [p for p in pending if p.cat == "freight_transit" and p.eta <= now + window
                    and assignments[p.id]["entry_at"] - p.eta > 10 * 60]
    reserve = [t for t in snap["tracks"] if t["status"] == "reserve"]
    if late_freight and reserve:
        tid = reserve[0]["id"]
        recs.append({"id": f"open_{tid}", "severity": "high", "kind": "open_reserve",
                     "title": f"Открыть резервный путь {tid}",
                     "text": f"Через {max(1, (late_freight[0].eta - now) // 60)} мин дефицит путей ПО-парка: "
                             f"{len(late_freight)} грузовых будут ждать > 10 мин",
                     "action": {"type": "open_track", "track": tid}})
    # 2. обход для сильно задерживаемых грузовых
    thr = int(fc.get("reroute_delay_min", 35) * 60)
    for p in sorted(pending, key=lambda p: -(assignments[p.id]["entry_at"] - p.eta)):
        d = assignments[p.id]["entry_at"] - p.eta
        if p.cat.startswith("freight") and d > thr:
            recs.append({"id": f"reroute_{p.id}", "severity": "high", "kind": "reroute",
                         "title": f"Направить №{p.id} по обходу",
                         "text": f"Прогноз ожидания приёма {d // 60} мин; перенаправление разгрузит станцию",
                         "action": {"type": "reroute", "train": p.id}})
            if sum(1 for r in recs if r["kind"] == "reroute") >= 2:
                break
    # 3. нехватка локомотивов/бригад
    miss_l = [pid for pid, a in assignments.items() if a.get("loco_missing")]
    miss_c = [pid for pid, a in assignments.items() if a.get("crew_missing")]
    if miss_l:
        recs.append({"id": "add_loco", "severity": "critical" if len(miss_l) > 1 else "high", "kind": "resource",
                     "title": "Вывести резервный локомотив",
                     "text": f"На горизонте не хватает локомотивов для: " + ", ".join(f"№{x}" for x in miss_l[:4]),
                     "action": {"type": "add_loco"}})
    if miss_c:
        recs.append({"id": "add_crew", "severity": "high", "kind": "resource",
                     "title": "Вызвать резервную бригаду",
                     "text": f"Не хватает бригад для: " + ", ".join(f"№{x}" for x in miss_c[:4]),
                     "action": {"type": "add_crew"}})
    # 4. регулирование скорости (виртуальная очередь вместо стоянки у сигнала)
    trains = {t["id"]: t for t in snap["trains"]}
    regs = []
    for p in pending:
        a = assignments[p.id]
        d = a["entry_at"] - p.eta
        t = trains.get(p.id)
        if d >= 180 and t and t["status"] in ("approaching", "held"):
            dist = t.get("pos_m", 0)
            v = dist / max(1, a["entry_at"] - now) * 3.6
            regs.append((d, p, a, v, t["status"]))
    for d, p, a, v, status in sorted(regs, key=lambda x: -x[0])[:3]:
        txt = (f"Удержать на предыдущей станции, отправить к {fmt_clock(a['entry_at'] - 600, clk)}" if v < 15
               else f"Снизить скорость до {v:.0f} км/ч")
        recs.append({"id": f"slot_{p.id}", "severity": "info", "kind": "slot",
                     "title": f"№{p.id}: вход в {fmt_clock(a['entry_at'], clk)} на путь {a['track']}",
                     "text": f"{txt}: без остановки у входного сигнала (−{d // 60} мин стоянки)", "action": None})
    # 5. пассажирские с прогнозом опоздания
    for p in pb.trains:
        a = assignments.get(p.id)
        if a and p.cat == "pass" and a["dep_at"] - p.planned_dep > 5 * 60:
            recs.append({"id": f"pass_{p.id}", "severity": "medium", "kind": "warning",
                         "title": f"Пассажирский №{p.id}: опоздание {(a['dep_at'] - p.planned_dep) // 60} мин",
                         "text": "Проверьте приоритет маршрута и занятость платформ", "action": None})
    # 6. ресурсы: подача заранее (объясняет, что делает ИИ)
    subs = sorted([(a["loco_at"], pid, a) for pid, a in assignments.items() if a.get("loco") and a.get("loco_at")
                   and now <= a["loco_at"] <= now + 1200])[:2]
    for t, pid, a in subs:
        recs.append({"id": f"loco_{pid}", "severity": "info", "kind": "resource_plan",
                     "title": f"Подать {a['loco']} к пути {a['track']} в {fmt_clock(t, clk)}",
                     "text": f"Локомотив будет готов к отправлению №{pid} без ожидания", "action": None})
    order = {"critical": 0, "high": 1, "medium": 2, "info": 3}
    recs.sort(key=lambda r: order.get(r["severity"], 9))
    return recs
