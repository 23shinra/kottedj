"""Путевой граф: узлы, участки, стрелки, сигналы и маршруты (генерируются обходом от сигналов)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..config import load_yaml

OPS_RU = {"through": "пропуск/техосмотр", "passenger": "посадка/высадка", "loading": "погрузка",
          "unloading": "выгрузка", "stabling": "отстой"}


@dataclass(frozen=True)
class Segment:
    id: str
    a: str
    b: str
    length_m: float
    vmax_kmh: float
    gauge: int
    kind: str
    name: str = ""
    park: str = ""
    ops: tuple[str, ...] = ()
    platform: bool = False
    restrictions: tuple[str, ...] = ()

    def entry(self, d: str) -> str:
        return self.a if d == "E" else self.b

    def exit(self, d: str) -> str:
        return self.b if d == "E" else self.a


@dataclass(frozen=True)
class SwitchDef:
    id: str
    node: str
    stem: str
    normal: str
    reverse: str
    stem_side: str  # "W": хвост стрелки (стрелочный перевод) смотрит на запад, ветви — на восток


@dataclass(frozen=True)
class SignalDef:
    id: str
    node: str
    dir: str
    kind: str
    name: str


@dataclass(frozen=True)
class Route:
    id: str
    signal: str
    dir: str
    kind: str              # entry | exit
    segments: tuple[str, ...]
    switches: tuple[tuple[str, str], ...]  # (стрелка, "+"/"-")
    dest: str              # путь назначения или ключ границы (W/E/EK)
    end: str               # signal | buffer | boundary

    @property
    def switch_map(self) -> dict[str, str]:
        return dict(self.switches)


@dataclass
class Infra:
    raw: dict[str, Any]
    nodes: dict[str, dict[str, Any]] = field(default_factory=dict)
    segments: dict[str, Segment] = field(default_factory=dict)
    switches: dict[str, SwitchDef] = field(default_factory=dict)
    switch_at: dict[str, str] = field(default_factory=dict)
    signals: dict[str, SignalDef] = field(default_factory=dict)
    signal_at: dict[tuple[str, str], str] = field(default_factory=dict)
    boundaries: dict[str, dict[str, Any]] = field(default_factory=dict)
    routes: dict[str, Route] = field(default_factory=dict)
    out_e: dict[str, list[str]] = field(default_factory=dict)
    out_w: dict[str, list[str]] = field(default_factory=dict)

    @property
    def tracks(self) -> list[Segment]:
        return [s for s in self.segments.values() if s.kind == "track"]

    def approach_of(self, boundary: str) -> str:
        node = self.boundaries[boundary]["node"]
        segs = self.out_e.get(node, []) + self.out_w.get(node, [])
        return segs[0]

    def boundary_dir_in(self, boundary: str) -> str:
        """Направление движения поезда, въезжающего со стороны границы."""
        node = self.boundaries[boundary]["node"]
        return "E" if self.out_e.get(node) else "W"

    def boundary_of_node(self, node: str) -> str | None:
        for k, b in self.boundaries.items():
            if b["node"] == node:
                return k
        return None

    def next_options(self, node: str, d: str, from_seg: str | None) -> list[tuple[str, tuple[str, str] | None]]:
        """Участки, в которые можно выйти из узла в направлении d, и требуемое положение стрелки."""
        sw_id = self.switch_at.get(node)
        if sw_id is None:
            return [(s, None) for s in (self.out_e if d == "E" else self.out_w).get(node, [])]
        sw = self.switches[sw_id]
        facing = (sw.stem_side == "W") == (d == "E")
        if facing:
            return [(sw.normal, (sw_id, "+")), (sw.reverse, (sw_id, "-"))]
        if from_seg == sw.normal:
            return [(sw.stem, (sw_id, "+"))]
        if from_seg == sw.reverse:
            return [(sw.stem, (sw_id, "-"))]
        return []

    def static(self) -> dict[str, Any]:
        return {
            "name": self.raw.get("name"), "demo": self.raw.get("demo", True),
            "electrified": bool(self.raw.get("electrified", False)),
            "nodes": [{"id": k, **v} for k, v in self.nodes.items()],
            "segments": [{
                "id": s.id, "a": s.a, "b": s.b, "length_m": s.length_m, "vmax_kmh": s.vmax_kmh, "gauge": s.gauge,
                "kind": s.kind, "name": s.name or s.id, "park": s.park, "ops": list(s.ops),
                "ops_ru": [OPS_RU.get(o, o) for o in s.ops], "platform": s.platform,
                "restrictions": list(s.restrictions),
            } for s in self.segments.values()],
            "switches": [{"id": s.id, "node": s.node, "stem": s.stem, "normal": s.normal, "reverse": s.reverse}
                         for s in self.switches.values()],
            "signals": [{"id": s.id, "node": s.node, "dir": s.dir, "kind": s.kind, "name": s.name}
                        for s in self.signals.values()],
            "boundaries": self.boundaries,
            "routes": [{"id": r.id, "signal": r.signal, "dir": r.dir, "kind": r.kind, "dest": r.dest,
                        "segments": list(r.segments), "switches": [list(x) for x in r.switches]}
                       for r in self.routes.values()],
            "switch_throw_s": self.raw.get("switch_throw_s", 6),
        }


class InfraError(ValueError):
    pass


def build_infra(raw: dict[str, Any] | None = None) -> Infra:
    raw = raw or load_yaml("micro/infrastructure.yaml")
    inf = Infra(raw=raw)
    for n in raw["nodes"]:
        inf.nodes[n["id"]] = {k: v for k, v in n.items() if k != "id"}
    for s in raw["segments"]:
        seg = Segment(
            id=str(s["id"]), a=s["a"], b=s["b"], length_m=float(s["length_m"]), vmax_kmh=float(s["vmax_kmh"]),
            gauge=int(s["gauge"]), kind=s["kind"], name=s.get("name", ""), park=s.get("park", ""),
            ops=tuple(s.get("ops", [])), platform=bool(s.get("platform", False)),
            restrictions=tuple(s.get("restrictions", [])),
        )
        for nid in (seg.a, seg.b):
            if nid not in inf.nodes:
                raise InfraError(f"участок {seg.id}: неизвестный узел {nid}")
        inf.segments[seg.id] = seg
        inf.out_e.setdefault(seg.a, []).append(seg.id)
        inf.out_w.setdefault(seg.b, []).append(seg.id)
    for nid, n in inf.nodes.items():
        if n["kind"] != "switch":
            continue
        sid = str(n["switch"])
        stem, normal, reverse = (inf.segments[n[k]] for k in ("stem", "normal", "reverse"))
        if stem.b == nid and normal.a == nid and reverse.a == nid:
            side = "W"
        elif stem.a == nid and normal.b == nid and reverse.b == nid:
            side = "E"
        else:
            raise InfraError(f"стрелка {sid}: участки ориентированы несогласованно с узлом {nid}")
        inf.switches[sid] = SwitchDef(sid, nid, stem.id, normal.id, reverse.id, side)
        inf.switch_at[nid] = sid
    for b_id, b in raw["boundaries"].items():
        inf.boundaries[b_id] = dict(b)
    for s in raw["signals"]:
        sig = SignalDef(id=str(s["id"]), node=s["node"], dir=s["dir"], kind=s["kind"], name=s.get("name") or f"Выходной {s['id']}")
        inf.signals[sig.id] = sig
        inf.signal_at[(sig.node, sig.dir)] = sig.id
    _gen_routes(inf)
    return inf


def _gen_routes(inf: Infra) -> None:
    """Маршрут — путь от сигнала до следующего попутного сигнала, упора или границы станции."""
    for sig in inf.signals.values():
        start = [(seg, req) for seg, req in inf.next_options(sig.node, sig.dir, None)]
        stack: list[tuple[list[str], list[tuple[str, str]]]] = [([s], [r] if r else []) for s, r in start]
        while stack:
            segs, sws = stack.pop()
            last = inf.segments[segs[-1]]
            node = last.exit(sig.dir)
            kind = inf.nodes[node]["kind"]
            if (node, sig.dir) in inf.signal_at or kind in ("buffer", "boundary"):
                end = "signal" if (node, sig.dir) in inf.signal_at and kind not in ("buffer", "boundary") else kind
                if kind == "boundary":
                    dest = inf.boundary_of_node(node) or node
                    rid = f"{sig.id}→{inf.approach_of(dest)}"
                else:
                    track = next((s for s in reversed(segs) if inf.segments[s].kind == "track"), segs[-1])
                    dest = track
                    rid = f"{sig.id}→{track}"
                route_kind = "entry" if sig.kind == "entry" else "exit"
                inf.routes[rid] = Route(rid, sig.id, sig.dir, route_kind, tuple(segs), tuple(sws), dest, end)
                continue
            for nseg, req in inf.next_options(node, sig.dir, last.id):
                if nseg in segs:
                    continue
                stack.append((segs + [nseg], sws + ([req] if req else [])))
