"""Обработка потока: валидация, дедупликация, отбрасывание устаревших, сглаживание."""
import pytest
from pydantic import ValidationError

from dstation.models import TelemetryMsg


def _msg(snapshot, seq=1):
    return {"type": "telemetry", "world": "ai", "seq": seq, "emitted_at": 1, "time_scale": 20, "state": snapshot}


def test_valid_snapshot_passes(busy_snapshot):
    TelemetryMsg.model_validate(_msg(busy_snapshot))


def test_malformed_rejected(busy_snapshot):
    bad = _msg({k: v for k, v in busy_snapshot.items() if k != "tracks"})
    with pytest.raises(ValidationError):
        TelemetryMsg.model_validate(bad)
    with pytest.raises(ValidationError):
        TelemetryMsg.model_validate({**_msg(busy_snapshot), "world": "mars"})


def test_dedup_and_stale():
    from main import Normalizer
    n = Normalizer(window=3)
    assert not n.is_duplicate(1)
    assert n.is_duplicate(1)
    assert not n.is_stale("ai", 5)
    assert n.is_stale("ai", 4), "снимок старее последнего должен отбрасываться"
    assert not n.is_stale("baseline", 4)


def test_smoothing_is_monotonic():
    from main import Normalizer
    n = Normalizer()
    st = {"trains": [{"id": "1", "status": "approaching", "pos_m": 10000}]}
    n.smooth("ai", st)
    st = {"trains": [{"id": "1", "status": "approaching", "pos_m": 10400}]}   # шум «назад»
    n.smooth("ai", st)
    assert st["trains"][0]["pos_m"] <= 10000
    st = {"trains": [{"id": "1", "status": "approaching", "pos_m": 9000}]}
    n.smooth("ai", st)
    assert 9000 < st["trains"][0]["pos_m"] < 10000
