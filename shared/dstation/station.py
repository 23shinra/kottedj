"""Цифровая модель инфраструктуры: пути, парки, горловины, стрелочные улицы, совместимость."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .config import load_station


@dataclass(frozen=True)
class Track:
    id: str
    park: str
    length_m: int
    platform: bool
    electrified: bool
    cargo: bool
    accepts: tuple[str, ...]
    ladders: dict[str, str]          # сторона горловины -> стрелочная улица
    reserve: bool = False


@dataclass(frozen=True)
class Category:
    id: str
    name: str
    priority: int
    length_m: tuple[int, int]
    service_min: tuple[int, int]
    needs_loco: bool
    needs_crew: bool
    electric: bool


@dataclass
class Station:
    raw: dict[str, Any]
    name: str
    tracks: dict[str, Track]
    categories: dict[str, Category]
    ladders: dict[str, list[str]]    # улица -> стрелки
    ladder_side: dict[str, str]      # улица -> горловина
    throat_s: int
    track_buffer_s: int
    loco_prep_s: int
    crew_prep_s: int
    loco_turnaround_s: int
    crew_rest_s: int
    n_locos: int
    n_crews: int
    approach_len: dict[str, int] = field(default_factory=dict)

    def compatible(self, category: str, length_m: int, closed: set[str] | frozenset[str] = frozenset(),
                   include_reserve: bool = True) -> list[str]:
        """Пути, на которые можно принять поезд: тип, длина, электрификация, открыт."""
        cat = self.categories[category]
        out = []
        for t in self.tracks.values():
            if t.id in closed:
                continue
            if t.reserve and not include_reserve:
                continue
            if category not in t.accepts:
                continue
            if t.length_m < length_m:
                continue
            if cat.electric and not t.electrified:
                continue
            out.append(t.id)
        return out

    def ladder(self, track_id: str, side: str) -> str:
        return self.tracks[track_id].ladders[side]

    def routes_conflict(self, a: tuple[str, str], b: tuple[str, str]) -> bool:
        """Два маршрута (путь, горловина) конфликтуют, если используют общие стрелки."""
        la, lb = self.ladder(*a), self.ladder(*b)
        return bool(set(self.ladders[la]) & set(self.ladders[lb]))

    def public(self) -> dict[str, Any]:
        """Описание станции для фронтенда (GET /station)."""
        return {
            "name": self.name,
            "parks": self.raw["parks"],
            "throats": self.raw["throats"],
            "approaches": self.raw["approaches"],
            "tracks": [
                {**t.__dict__, "accepts": list(t.accepts)} for t in self.tracks.values()
            ],
            "categories": {k: {**c.__dict__} for k, c in self.categories.items()},
            "start_clock": self.raw.get("start_clock", "06:00"),
            "resources": self.raw["resources"],
        }


def build_station(raw: dict[str, Any] | None = None) -> Station:
    raw = raw or load_station()
    tracks = {}
    for t in raw["tracks"]:
        tracks[str(t["id"])] = Track(
            id=str(t["id"]), park=t["park"], length_m=int(t["length_m"]),
            platform=bool(t.get("platform")), electrified=bool(t.get("electrified", True)),
            cargo=bool(t.get("cargo")), accepts=tuple(t["accepts"]),
            ladders=dict(t["ladders"]), reserve=bool(t.get("reserve", False)),
        )
    cats = {}
    for cid, c in raw["categories"].items():
        cats[cid] = Category(
            id=cid, name=c["name"], priority=int(c["priority"]),
            length_m=tuple(c["length_m"]), service_min=tuple(c["service_min"]),
            needs_loco=bool(c["needs_loco"]), needs_crew=bool(c["needs_crew"]),
            electric=bool(c.get("electric", False)),
        )
    ladders, ladder_side = {}, {}
    for th in raw["throats"]:
        for ld in th["ladders"]:
            ladders[ld["id"]] = list(ld["switches"])
            ladder_side[ld["id"]] = th["id"]
    res, tm = raw["resources"], raw["timing"]
    return Station(
        raw=raw, name=raw["name"], tracks=tracks, categories=cats,
        ladders=ladders, ladder_side=ladder_side,
        throat_s=int(tm["throat_min"] * 60), track_buffer_s=int(tm["track_buffer_min"] * 60),
        loco_prep_s=int(res["loco_prep_min"] * 60), crew_prep_s=int(res["crew_prep_min"] * 60),
        loco_turnaround_s=int(res["loco_turnaround_min"] * 60), crew_rest_s=int(res["crew_rest_min"] * 60),
        n_locos=int(res["locos"]), n_crews=int(res["crews"]),
        approach_len={a["id"]: int(a["length_m"]) for a in raw["approaches"]},
    )
