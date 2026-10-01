"""Микромодель: инварианты безопасности и ожидаемое поведение в 8 сценариях задания (+ резерв УВК)."""
import pytest

from dstation.micro import MicroSim, list_scenarios
from dstation.micro.infra import build_infra

SCENARIOS = [s["id"] for s in list_scenarios()]


def sim(sid: str) -> MicroSim:
    return MicroSim(sid)


def until(m: MicroSim, clock: str) -> None:
    m.run_until(clock)


def wait_for(m: MicroSim, pred, limit_s: float = 4 * 3600) -> None:
    end = m.world.t + limit_s
    while not pred(m.world):
        assert m.world.t < end, "условие не наступило"
        m.world.step(1.0)


def t_of(m: MicroSim, clock: str) -> float:
    h, mm = clock.split(":")
    return int(h) * 3600 + int(mm) * 60 - m.world.start_s


def events(m: MicroSim, kind: str | None = None, contains: str = "") -> list[dict]:
    return [e for e in m.world.events if (kind is None or e["kind"] == kind) and contains in e["text"]]


# ---------------------------------------------------------------- модель данных
def test_infra_routes_and_orientation():
    inf = build_infra()
    assert len(inf.routes) >= 30
    assert inf.routes["Н→7П"].switch_map == {"1": "-", "5": "-", "7": "-", "9": "-", "11": "-"}
    assert inf.routes["Ч3→ЗП"].segments[-1] == "ЗП"
    for r in inf.routes.values():
        for a, b in zip(r.segments, r.segments[1:]):
            sa, sb = inf.segments[a], inf.segments[b]
            assert sa.exit(r.dir) == sb.entry(r.dir), f"{r.id}: {a}→{b} разрывен"


def test_catalog_has_sources_and_three_plus_models():
    m = sim("normal")
    cat = m.catalog
    assert len(cat.locos) >= 3 and len(cat.wagons) >= 3
    for model in [*cat.locos.values(), *cat.wagons.values()]:
        assert model.sources and all(s["url"].startswith("http") for s in model.sources)


def test_model_and_instance_are_separate():
    m = sim("normal")
    tr = m.world.trains["2001"]
    w1, w2 = tr.consist.wagons[:2]
    assert w1.model is w2.model and w1.number != w2.number
    card = m.world.card("train", "2001")
    assert card["locos"][0]["model_card"]["f_cont_kn"] == 427
    assert len(card["wagons"]) == 40 and card["wagons"][0]["number"].startswith("6")


def test_allowed_mass_formula_te33a():
    m = sim("consist_limits")
    c = m.world.trains["3105"].consist
    q9 = c.allowed_mass_t(9, m.catalog.loco_w0)
    assert 4000 < q9 < 4400
    assert c.wagons_mass_t > q9


# ---------------------------------------------------------------- инварианты на всех сценариях
@pytest.mark.parametrize("sid", SCENARIOS)
def test_safety_invariants(sid):
    m = sim(sid)
    w = m.world
    prev_pos = {k: v.pos for k, v in w.sw.items()}
    while w.t < m.duration_s:
        before_occ = {k: w.switch_occupant(k) for k in w.sw}
        w.step(1.0)
        for k, st in w.sw.items():
            if st.pos != prev_pos[k]:
                assert before_occ[k] is None, f"{sid}: стрелка {k} переведена под поездом"
                prev_pos[k] = st.pos
        for tr in w.trains.values():
            if tr.status in ("standing", "ready") and tr.dest:
                assert tr.consist.length_m <= w.inf.segments[tr.dest].length_m
    assert w.violations == [], w.violations
    assert w.kpi()["reaction_ok"]


# ---------------------------------------------------------------- 1. исправная станция
def test_normal_station_no_delays():
    m = sim("normal")
    m.run_for(m.duration_s)
    k = m.world.kpi()
    assert k["departed"] == 6 and k["avg_dep_delay_min"] == 0 and k["rejected"] == 0
    assert k["unloaded_t"] == 2800 and k["loaded_t"] >= 2700


# ---------------------------------------------------------------- 2. конфликт маршрутов
def test_route_conflict_priority_and_reason():
    m = sim("route_conflict")
    until(m, "08:04")
    tr = m.world.trains["3102"]
    assert tr.status == "ready" and tr.blockers and tr.blockers[0]["key"] == "yield"
    assert "053" in tr.blockers[0]["trains"]
    m.run_for(3600)
    w = m.world
    p, f = w.trains["053"], w.trains["3102"]
    assert p.arrive_t <= p.planned_arrive_t + 60
    assert f.depart_t > p.spawned_t
    assert any("пропуск приоритетного" in r for r in f.delay)


def test_conflicting_manual_route_is_refused_with_reason():
    m = sim("normal")
    wait_for(m, lambda w: "Н→7П" in w.routes)
    res = m.command({"type": "set_route", "route": "Ч3→ЗП"})
    assert not res["ok"]
    texts = " ".join(b["text"] for b in res["blockers"])
    assert "замкнут" in texts or "занят" in texts


# ---------------------------------------------------------------- 3. неизвестное положение стрелки
def test_unknown_switch_bans_routes_and_reroutes():
    m = sim("unknown_switch")
    w = m.world
    routes_via_5 = []
    while w.t < t_of(m, "09:34"):
        w.step(1.0)
        if w.t > t_of(m, "08:30"):
            routes_via_5 += [rid for rid, ar in w.routes.items() if "5" in ar.route.switch_map and ar.t_set > t_of(m, "08:30")]
    assert w.sw["5"].state in ("unknown", "repairing")
    assert not routes_via_5
    assert w.trains["3101"].dest == "I"
    t2001 = w.trains["2001"]
    assert t2001.status == "held" and "стрелка 5" in t2001.blockers[0]["text"]
    assert "Р-001" in t2001.blockers[0]["waits"]
    m.run_for(3600)
    assert t2001.arrive_t is not None


def test_manual_throw_refused_when_no_control_or_under_train():
    m = sim("unknown_switch")
    until(m, "08:31")
    res = m.command({"type": "throw_switch", "switch": "5"})
    assert not res["ok"] and "положение неизвестно" in res["blockers"][0]["text"]
    m2 = sim("normal")
    tr = m2.world.trains["2001"]
    wait_for(m2, lambda w: any(w.switch_occupant(s) == "2001" for s in w.sw))
    sw_under = next(s for s in m2.world.sw if m2.world.switch_occupant(s) == tr.id)
    res2 = m2.command({"type": "throw_switch", "switch": sw_under})
    assert not res2["ok"]


# ---------------------------------------------------------------- 4. ремонт
def test_repair_task_lifecycle_and_route_restored():
    m = sim("repair")
    m.run_for(m.duration_s)
    w = m.world
    task = w.staff.tasks["Р-001"]
    assert task.phase == "done" and task.worker == "W1"
    assert task.work_done_t - task.start_t == 60 * 60
    p = w.trains["053"]
    route_set = [e for e in events(m, "route", "Маршрут Н→2 поезда 053")]
    assert route_set and route_set[0]["t"] >= task.work_done_t
    assert p.arrive_t > p.planned_arrive_t and any("стрелка 3" in r for r in p.delay)


def test_repair_duration_configurable():
    m = sim("repair")
    m.command({"type": "repair_config", "cfg": {"default_duration_min": 20}})
    m.run_for(m.duration_s)
    task = m.world.staff.tasks["Р-001"]
    assert task.work_done_t - task.start_t == 20 * 60
    assert m.world.trains["053"].arrive_t < t_of(m, "09:15")


# ---------------------------------------------------------------- 5. цепочка задержек
def test_delay_chain_propagates_with_reasons():
    m = sim("delay_chain")
    m.run_for(m.duration_s)
    w = m.world
    t2001, t2002, t1003 = w.trains["2001"], w.trains["2002"], w.trains["1003"]
    assert t2001.depart_t - t2001.planned_depart_t > 20 * 60
    assert any("ожидание груза" in r for r in t2001.delay)
    assert any("нет свободного пути" in r for r in t2002.delay)
    assert any("нет свободного пути" in r for r in t1003.delay)
    assert t2002.depart_t > t2002.planned_depart_t


# ---------------------------------------------------------------- 6. ограничения состава
def test_consist_limits():
    m = sim("consist_limits")
    until(m, "09:15")
    w = m.world
    assert w.trains["2101"].status == "rejected" and any("длина" in r for r in w.trains["2101"].reject_reasons)
    assert w.trains["3201"].status == "rejected" and any("электрифиц" in r for r in w.trains["3201"].reject_reasons)
    assert w.trains["1005"].dest in ("1К", "2К")
    assert w.trains["3106"].dest != "2"
    t3105 = w.trains["3105"]
    assert t3105.status == "ready" and t3105.blockers[0]["key"] == "mass"
    m.run_for(30 * 60)
    assert t3105.depart_t is not None and t3105.depart_t >= t_of(m, "09:20")


# ---------------------------------------------------------------- 7. масштаб времени
def test_time_scale_pause_and_reset():
    m = sim("time_scale")
    m.command({"type": "run"})
    assert m.advance_real(1.0) == 60
    m.command({"type": "set_scale", "scale": 120})
    m.advance_real(0.5)
    assert m.world.t == 120
    m.command({"type": "pause"})
    assert m.advance_real(10.0) == 0 and m.world.t == 120
    m.command({"type": "reset"})
    assert m.world.t == 0 and not m.running
    m.run_for(m.duration_s)
    tr = m.world.trains["053"]
    assert tr.op_done_t - tr.arrive_t == 3600


def test_autostart_survives_initial_reset():
    m = MicroSim("normal", running=True)
    assert m.running and m.advance_real(1.0) == 60


# ---------------------------------------------------------------- 8. премирование
def test_bonus_ledger_reasons():
    m = sim("bonus")
    m.run_for(m.duration_s)
    b = m.world.staff.bonus
    led = b.ledger
    assert any(e["kind"] == "accrual" for e in led)
    pen = [e for e in led if e["kind"] == "penalty"]
    assert any(e["device"] == "СМ-12" and e["worker"] == "W3" for e in pen)
    rep = [e for e in led if e["kind"] == "repair"]
    fast = next(e for e in rep if e["device"] == "РЦ-4")
    slow = next(e for e in rep if e["device"] == "СМ-12")
    assert "скидка" in fast["reason"] and "скидка" not in slow["reason"]
    assert abs(fast["delta"]) < abs(slow["delta"])
    assert all(e["reason"] for e in led)


def test_bonus_floor_and_no_upstream_penalty():
    m = sim("redundancy")
    m.command({"type": "bonus_config", "cfg": {"downtime_penalty_per_hour": 500, "min_balance": 0}})
    m.run_for(m.duration_s)
    b = m.world.staff.bonus
    assert all(a.balance >= 0 for a in b.accounts.values())
    w2_pen = [e for e in b.ledger if e["worker"] == "W2" and e["kind"] == "penalty"]
    assert not w2_pen, "SCB поста 2 не должен штрафоваться за отказ УВК"
    assert any(e["worker"] == "W2" and "вышестоящего" in e["reason"] for e in b.ledger)


# ---------------------------------------------------------------- порог реакции
def test_reaction_ban_before_next_train_step():
    m = sim("normal")
    wait_for(m, lambda w: "Н→7П" in w.routes)
    w = m.world
    assert w.trains["2001"].status == "inbound"
    t_fault = w.t
    res = m.command({"type": "fault", "device": "СМ-5"})
    assert res["ok"]
    rec = w.reactions[-1]
    assert rec["t_ban"] == t_fault and "2001" in rec["trains"]
    assert not w.sig_open["Н"] or w.routes["Н→7П"].state == "passed"
    w.step(1.0)
    assert rec["checked"] and rec["checked"][0]["t"] == t_fault and rec["ok"]
    for _ in range(600):
        w.step(1.0)
    assert w.violations == []


# ---------------------------------------------------------------- резерв УВК
def test_hot_standby_uvk():
    m = sim("redundancy")
    until(m, "08:31")
    w = m.world
    assert all(w.sw[s].state == "ok" for s in ("2", "4", "6", "8", "10"))
    assert w.eq.devices["М2.1"].status == "reserve"
    until(m, "08:51")
    assert all(w.sw[s].state == "unknown" for s in ("2", "4", "6", "8", "10"))
    assert w.false_occ["ВП"]
