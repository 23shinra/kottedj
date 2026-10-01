"""Цифровой двойник: инварианты модели и выигрыш ИИ над FCFS на коротком прогоне."""
from dstation.planner.core import make_plan


def test_no_two_trains_on_one_track(worlds):
    w = worlds["baseline"]
    for _ in range(120):
        w.advance(60)
        occ = {}
        for tr in w.trains.values():
            if tr.status in ("entering", "on_track", "departing"):
                assert tr.track not in occ, f"путь {tr.track}: №{occ.get(tr.track)} и №{tr.id}"
                occ[tr.track] = tr.id


def test_closed_track_receives_no_trains(worlds):
    w = worlds["baseline"]
    w.apply_command({"type": "close_track", "track": "5"})
    occupant = w.track_occupant("5")
    for _ in range(90):
        w.advance(60)
        for tr in w.trains.values():
            if tr.track == "5" and tr.entered_at and tr.entered_at > 0:
                assert occupant is not None and tr.id == occupant.id


def test_incidents_apply(worlds):
    w = worlds["ai"]
    w.advance(600)
    assert w.apply_command({"type": "loco_failure"}) == "ok"
    assert any(lc.status == "failed" for lc in w.locos.values())
    approaching = [t for t in w.trains.values() if t.status == "approaching"]
    if approaching:
        assert w.apply_command({"type": "delay", "train": approaching[0].id, "minutes": 10}) == "ok"
    assert w.apply_command({"type": "add_loco"}) == "ok"


def test_ai_beats_fcfs_short_run(station, cfg, icfg, worlds):
    plan = None
    for _ in range(150):
        snap = worlds["ai"].snapshot()
        plan = make_plan(station, snap, cfg, icfg, plan, time_limit_s=0.3, with_analysis=False)
        worlds["ai"].plan = plan
        for w in worlds.values():
            w.advance(120)

    def wait(w):
        xs = [(t.entered_at - t.spec.actual_arr) for t in w.trains.values()
              if t.entered_at is not None and t.spec.actual_arr >= 0]
        return sum(xs) / len(xs)
    assert wait(worlds["ai"]) < wait(worlds["baseline"])
