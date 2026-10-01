import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "shared"))
sys.path.insert(0, str(ROOT / "services"))
sys.path.insert(0, str(ROOT / "services" / "ingest"))

import pytest  # noqa: E402

from dstation.config import load_index_config, load_planner_config, load_scenario  # noqa: E402
from dstation.sim.runner import make_worlds  # noqa: E402
from dstation.station import build_station  # noqa: E402


@pytest.fixture(scope="session")
def station():
    return build_station()


@pytest.fixture(scope="session")
def cfg():
    return load_planner_config()


@pytest.fixture(scope="session")
def icfg():
    return load_index_config()


@pytest.fixture()
def worlds(station):
    return make_worlds(station, load_scenario())


@pytest.fixture(scope="session")
def busy_snapshot(station):
    """Снимок в час пик (очередь на подходе, занятые пути)."""
    ws = make_worlds(station, load_scenario())
    w = ws["ai"]
    w.advance(100 * 60)
    return w.snapshot()
