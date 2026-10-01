from dstation import index as index_mod
from dstation.config import deep_merge

GOOD = {"throughput_ratio": 1.0, "avg_deviation_min": 0, "utilization": 0.7, "conflicts": 0,
        "avg_resource_wait_min": 0, "avg_entry_wait_min": 0, "queue_len": 0, "departed_1h": 10, "due_1h": 10}
BAD = {"throughput_ratio": 0.4, "avg_deviation_min": 50, "utilization": 1.0, "conflicts": 12,
       "avg_resource_wait_min": 40, "avg_entry_wait_min": 60, "queue_len": 15, "departed_1h": 4, "due_1h": 10}


def test_perfect_station_is_100(icfg):
    ix = index_mod.compute(GOOD, icfg)
    assert ix["value"] == 100
    assert ix["category"]["id"] == "norm" and ix["grade"] == "A"


def test_bad_station_is_critical(icfg):
    ix = index_mod.compute(BAD, icfg)
    assert ix["value"] < 50
    assert ix["category"]["id"] == "critical"
    assert len(ix["top"]) == 5


def test_losses_sum_to_gap(icfg):
    for kpi in (GOOD, BAD, {**GOOD, "conflicts": 3, "utilization": 0.2}):
        ix = index_mod.compute(kpi, icfg)
        assert abs(sum(f["loss"] for f in ix["factors"]) - (100 - ix["value"])) < 0.6
        assert abs(sum(f["weight"] for f in ix["factors"]) - 1) < 1e-3


def test_weights_override_without_recompile(icfg):
    cfg = deep_merge(icfg, {"factors": {"queue": {"weight": 0}, "conflicts": {"weight": 0}}})
    kpi = {**GOOD, "avg_entry_wait_min": 90, "conflicts": 20}
    assert index_mod.compute(kpi, cfg)["value"] == 100
    assert index_mod.compute(kpi, icfg)["value"] < 75


def test_utilization_bell(icfg):
    lo = index_mod.compute({**GOOD, "utilization": 0.1}, icfg)
    mid = index_mod.compute({**GOOD, "utilization": 0.7}, icfg)
    hi = index_mod.compute({**GOOD, "utilization": 1.0}, icfg)
    assert mid["value"] > lo["value"] and mid["value"] > hi["value"]
