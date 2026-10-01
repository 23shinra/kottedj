"""Создание пары миров (baseline/ai) из сценария — общий код для симулятора, бенчмарка и тестов."""
from __future__ import annotations

import copy
import random
from typing import Any

from ..station import Station
from .engine import World
from .timetable import generate


def make_worlds(station: Station, scn: dict[str, Any]) -> dict[str, World]:
    specs = generate(station, scn)
    worlds = {}
    for name, policy in (("baseline", "fcfs"), ("ai", "plan")):
        w = World(name=name, station=station, specs=copy.deepcopy(specs), policy=policy)
        w.seed_initial(int(scn.get("initial_occupied", 4)), random.Random(scn.get("seed", 42)))
        worlds[name] = w
    return worlds
