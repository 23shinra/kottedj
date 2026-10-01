"""Проверки допустимости плана: пути, горловины, длины, закрытые пути, лимит времени, fallback."""
import copy

from dstation.planner import cpsat, greedy
from dstation.planner.core import make_plan, make_variants
from dstation.planner.problem import build_problem


def _intervals(station, pb, a):
    th, buf = station.throat_s, station.track_buffer_s
    occ, lad = {}, {}
    for p in pb.trains:
        x = a.get(p.id)
        if not x:
            continue
        start = x.get("entry_at", pb.now)
        occ.setdefault(x["track"], []).append((start, x["dep_at"] + th + buf, p.id))
        if p.pending:
            lad.setdefault(station.ladder(x["track"], p.side_in), []).append((x["entry_at"], x["entry_at"] + th, p.id))
        lad.setdefault(station.ladder(x["track"], p.side_out), []).append((x["dep_at"], x["dep_at"] + th, p.id))
    return occ, lad


def _no_overlap(groups):
    for key, ivs in groups.items():
        ivs = sorted(ivs)
        for (a1, b1, t1), (a2, b2, t2) in zip(ivs, ivs[1:]):
            assert a2 >= b1, f"пересечение на {key}: №{t1} [{a1},{b1}) и №{t2} [{a2},{b2})"


def check_plan(station, pb, a):
    trains = {p.id: p for p in pb.trains}
    for tid, x in a.items():
        p = trains[tid]
        track = station.tracks[x["track"]]
        if p.pending:
            assert x["track"] in p.compatible
            assert track.length_m >= p.length_m, "состав длиннее пути"
            assert p.cat in track.accepts
            assert x["track"] not in pb.closed, "использован закрытый путь"
            assert x["entry_at"] >= p.eta, "приём раньше прибытия"
            assert x["dep_at"] >= x["entry_at"] + station.throat_s + p.service_s, "отправление раньше окончания обслуживания"
        if p.cat == "pass":
            assert x["dep_at"] >= p.planned_dep, "пассажирский отправлен раньше графика"
    occ, lad = _intervals(station, pb, a)
    _no_overlap(occ)
    _no_overlap(lad)


def test_cpsat_plan_is_feasible(station, cfg, busy_snapshot):
    pb = build_problem(station, busy_snapshot, cfg)
    res = cpsat.solve(pb, cfg, time_limit_s=1.0)
    assert res is not None
    assert res["solver"]["status"] in ("OPTIMAL", "FEASIBLE")
    assert len(res["assignments"]) >= len([p for p in pb.trains if p.compatible or not p.pending]) * 0.9
    check_plan(station, pb, res["assignments"])


def test_greedy_plan_is_feasible(station, cfg, busy_snapshot):
    pb = build_problem(station, busy_snapshot, cfg)
    res = greedy.solve(pb, cfg)
    check_plan(station, pb, res["assignments"])
    assert res["solver"]["time_ms"] < 200


def test_closed_track_is_not_used(station, cfg, busy_snapshot):
    snap = copy.deepcopy(busy_snapshot)
    for t in snap["tracks"]:
        if t["id"] in ("7", "8"):
            t["status"] = "closed"
    pb = build_problem(station, snap, cfg)
    res = cpsat.solve(pb, cfg, time_limit_s=1.0)
    for tid, x in res["assignments"].items():
        p = next(p for p in pb.trains if p.id == tid)
        if p.pending:
            assert x["track"] not in ("7", "8")


def test_resource_counts_respected(station, cfg, busy_snapshot):
    pb = build_problem(station, busy_snapshot, cfg)
    res = cpsat.solve(pb, cfg, time_limit_s=1.0)
    used = [x["loco"] for x in res["assignments"].values() if x.get("loco")]
    assert len(used) == len(set(used)), "один локомотив назначен двум поездам"
    real = {r.id for r in pb.locos if not r.virtual}
    assert set(used) <= real


def test_plan_within_time_budget(station, cfg, icfg, busy_snapshot):
    plan = make_plan(station, busy_snapshot, cfg, icfg, time_limit_s=1.5)
    assert plan["total_ms"] < 5000, "перепланирование должно укладываться в 5 с"
    assert 0 <= plan["projected_index"]["value"] <= 100


def test_variants_under_5s(station, cfg, icfg, busy_snapshot):
    import time
    t0 = time.perf_counter()
    vs = make_variants(station, busy_snapshot, cfg, icfg)
    assert time.perf_counter() - t0 < 5.0
    assert {v["variant"] for v in vs} == {"balanced", "passenger_first", "throughput"}
    for v in vs:
        assert v["recommendations"] is not None


def test_fallback_when_solver_fails(station, cfg, icfg, busy_snapshot, monkeypatch):
    from dstation.planner import core
    monkeypatch.setattr(core.cpsat, "solve", lambda *a, **k: None)
    plan = make_plan(station, busy_snapshot, cfg, icfg)
    assert plan["solver"]["engine"] == "greedy"
    assert plan["assignments"]


def test_passenger_priority(station, cfg, busy_snapshot):
    pb = build_problem(station, busy_snapshot, cfg)
    res = cpsat.solve(pb, cfg, time_limit_s=1.0)
    a = res["assignments"]
    pas = [a[p.id]["entry_at"] - p.eta for p in pb.trains if p.pending and p.cat == "pass" and p.id in a]
    frt = [a[p.id]["entry_at"] - p.eta for p in pb.trains if p.pending and p.cat != "pass" and p.id in a]
    assert sum(pas) / max(1, len(pas)) <= sum(frt) / max(1, len(frt))
