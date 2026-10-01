"""Техническое оборудование централизации: граф зависимостей «питание → УВК → модуль → полевое устройство»."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..config import load_yaml
from .infra import Infra

KIND_RU = {
    "feeder": "Фидер питания", "power_panel": "Панель питания поста", "uvk": "Комплект УВК",
    "lan_switch": "Коммутатор ЛВС", "ec_module": "Модуль ЭЦ-ТМ2", "coupling": "Кабельная муфта (допущение)",
    "switch_drive": "Стрелочный электропривод", "signal_unit": "Светофорный блок", "track_circuit": "Рельсовая цепь",
}
HEALTH_RU = {"ok": "исправно", "fault": "неисправно", "repair": "в ремонте"}


@dataclass
class Device:
    id: str
    name: str
    kind: str
    post: str | None
    module: str | None = None
    link: tuple[str, str] | None = None     # ("switch"|"signal"|"segment", id)
    requires: list[list[str]] = field(default_factory=list)
    health: str = "ok"
    fault_note: str = ""
    fault_t: float | None = None
    # вычисляемое
    operational: bool = True
    degraded: bool = False
    cause: str = ""

    @property
    def status(self) -> str:
        if self.health != "ok":
            return self.health
        if not self.operational:
            return "no_supply"
        return "reserve" if self.degraded else "ok"

    def static(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "kind": self.kind, "kind_ru": KIND_RU.get(self.kind, self.kind),
                "post": self.post, "module": self.module, "link": list(self.link) if self.link else None,
                "requires": self.requires}


STATUS_RU = {"ok": "исправно", "reserve": "работа на резерве", "fault": "неисправно",
             "repair": "в ремонте", "no_supply": "нет питания/управления"}


class Equipment:
    def __init__(self, infra: Infra, raw: dict[str, Any] | None = None):
        raw = raw or load_yaml("micro/equipment.yaml")
        self.raw = raw
        self.devices: dict[str, Device] = {}
        self.by_link: dict[tuple[str, str], list[str]] = {}
        self.posts = []
        self.control_confirm_s = float(raw.get("control_confirm_s", 10))
        self.fault_kinds: dict[str, list[str]] = raw.get("fault_kinds", {})
        feeders = [f["id"] for f in raw["feeders"]]
        for f in raw["feeders"]:
            self._add(Device(f["id"], f["name"], "feeder", None))
        for p in raw["posts"]:
            k = str(p["id"])
            pp, lan, uvk = f"ПП-{k}", f"ЛВС-{k}", [f"УВК-{k}.1", f"УВК-{k}.2"]
            self._add(Device(pp, f"Панель питания поста ЭЦ-{k}", "power_panel", k, requires=[feeders]))
            for u in uvk:
                self._add(Device(u, f"Комплект УВК {u[4:]} (горячий резерв)", "uvk", k, requires=[[pp]]))
            self._add(Device(lan, f"Коммутатор ЛВС поста ЭЦ-{k}", "lan_switch", k, requires=[[pp]]))
            mods = []
            for m in p["modules"]:
                mid = m["id"]
                self._add(Device(mid, m["name"], "ec_module", k, requires=[uvk, [lan], [pp]]))
                mods.append(mid)
                for sw in m.get("switches", []):
                    sw = str(sw)
                    if sw not in infra.switches:
                        raise ValueError(f"оборудование: неизвестная стрелка {sw}")
                    self._add(Device(f"СМ-{sw}", f"Кабельная муфта стрелки {sw}", "coupling", k, mid, ("switch", sw), [[mid]]))
                    self._add(Device(f"СП-{sw}", f"Электропривод стрелки {sw}", "switch_drive", k, mid, ("switch", sw), [[f"СМ-{sw}"]]))
                for sg in m.get("signals", []):
                    if sg not in infra.signals:
                        raise ValueError(f"оборудование: неизвестный сигнал {sg}")
                    self._add(Device(f"СМ-{sg}", f"Кабельная муфта светофора {sg}", "coupling", k, mid, ("signal", sg), [[mid]]))
                    self._add(Device(f"СВ-{sg}", f"Светофорный блок {sg}", "signal_unit", k, mid, ("signal", sg), [[f"СМ-{sg}"]]))
                for seg in m.get("track_circuits", []):
                    if seg not in infra.segments:
                        raise ValueError(f"оборудование: неизвестный участок {seg}")
                    self._add(Device(f"РЦ-{seg}", f"Рельсовая цепь {seg}", "track_circuit", k, mid, ("segment", seg), [[mid]]))
            self.posts.append({"id": k, "name": p["name"], "power": pp, "lan": lan, "uvk": uvk, "modules": mods})
        self._check_coverage(infra)
        self.order = self._topo_order()
        self.evaluate()

    def _add(self, d: Device) -> None:
        if d.id in self.devices:
            raise ValueError(f"оборудование: дубликат {d.id}")
        self.devices[d.id] = d
        if d.link:
            self.by_link.setdefault(d.link, []).append(d.id)

    def _check_coverage(self, infra: Infra) -> None:
        missing = [f"стрелка {s}" for s in infra.switches if ("switch", s) not in self.by_link]
        missing += [f"сигнал {s}" for s in infra.signals if ("signal", s) not in self.by_link]
        missing += [f"участок {s}" for s in infra.segments if ("segment", s) not in self.by_link]
        if missing:
            raise ValueError("оборудование не покрывает: " + ", ".join(missing))

    def _topo_order(self) -> list[str]:
        order, seen = [], set()

        def visit(i: str) -> None:
            if i in seen:
                return
            seen.add(i)
            for grp in self.devices[i].requires:
                for r in grp:
                    visit(r)
            order.append(i)
        for i in self.devices:
            visit(i)
        return order

    def evaluate(self) -> None:
        """Устройство работоспособно, если само исправно и в каждой группе требований есть работоспособный член."""
        for i in self.order:
            d = self.devices[i]
            ok, degraded, cause = d.health == "ok", False, ""
            for grp in d.requires:
                alive = [r for r in grp if self.devices[r].operational]
                if not alive:
                    ok = False
                    root = self.devices[grp[0]]
                    cause = cause or (root.cause or root.id)
                elif len(alive) < len(grp):
                    degraded = True
            if d.health != "ok":
                cause = d.id
            d.operational, d.degraded, d.cause = ok, degraded and ok, cause if not ok else ""

    def dependents(self, dev_id: str) -> list[str]:
        return [d.id for d in self.devices.values() if any(dev_id in g for g in d.requires)]

    def chain(self, link: tuple[str, str]) -> list[str]:
        """Цепочка от полевого устройства вверх до фидеров (для карточки объекта)."""
        out: list[str] = []
        stack = list(self.by_link.get(link, []))
        while stack:
            i = stack.pop()
            if i in out:
                continue
            out.append(i)
            for g in self.devices[i].requires:
                stack.extend(g)
        return out

    def static(self) -> dict[str, Any]:
        return {"posts": self.posts, "devices": [d.static() for d in self.devices.values()],
                "fault_kinds": self.fault_kinds, "status_ru": STATUS_RU, "kind_ru": KIND_RU}

    def state(self) -> dict[str, dict[str, Any]]:
        out = {}
        for d in self.devices.values():
            if d.status != "ok":
                out[d.id] = {"status": d.status, "note": d.fault_note, "cause": d.cause}
        return out
