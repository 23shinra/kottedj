"""Справочные модели подвижного состава, экземпляры и демонстрационный расчёт допустимой массы."""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

from ..config import load_yaml

G = 9.81
TYPE_RU = {"gondola": "полувагон", "tank": "цистерна", "passenger": "пассажирский"}
TRACTION_RU = {"diesel": "тепловоз", "electric_ac25": "электровоз ~25 кВ"}
# первая цифра 8-значного номера грузового вагона по роду вагона (без расчёта контрольной цифры)
NUMBER_PREFIX = {"gondola": "6", "tank": "7", "passenger": "0"}


@dataclass(frozen=True)
class LocoModel:
    id: str
    name: str
    purpose: str
    traction: str
    gauge: int
    power_kw: float
    mass_t: float
    vmax_kmh: float
    f_start_kn: float
    f_cont_kn: float
    v_cont_kmh: float
    length_m: float
    axles: int
    axle_formula: str
    sources: list[dict[str, str]]
    notes: str = ""

    @property
    def electric(self) -> bool:
        return self.traction.startswith("electric")


@dataclass(frozen=True)
class WagonModel:
    id: str
    name: str
    type: str
    gauge: int
    length_m: float
    tare_t: float
    capacity_t: float
    vmax_kmh: float
    axles: int
    cargo: list[str]
    sources: list[dict[str, str]]
    seats: int = 0
    dangerous_cargo: bool = False
    notes: str = ""


class Catalog:
    def __init__(self, raw: dict[str, Any]):
        self.raw = raw
        self.locos: dict[str, LocoModel] = {}
        for mid, d in raw["locomotives"].items():
            self.locos[mid] = LocoModel(id=mid, **{k: d[k] for k in LocoModel.__dataclass_fields__ if k in d and k != "id"})
        self.wagons: dict[str, WagonModel] = {}
        for mid, d in raw["wagons"].items():
            fields = {k: d[k] for k in WagonModel.__dataclass_fields__ if k in d and k != "id"}
            fields.setdefault("capacity_t", 0.0)
            self.wagons[mid] = WagonModel(id=mid, **fields)
        tc = raw.get("traction_calc", {})
        self.passenger_mass_t = float(tc.get("passenger_mass_t", 0.1))
        self.loco_w0 = tuple(tc.get("loco_w0", [1.9, 0.01, 0.0003]))

    def static(self) -> dict[str, Any]:
        return {
            "locomotives": [m.__dict__ | {"traction_ru": TRACTION_RU.get(m.traction, m.traction)} for m in self.locos.values()],
            "wagons": [m.__dict__ | {"type_ru": TYPE_RU.get(m.type, m.type)} for m in self.wagons.values()],
        }


def load_catalog() -> Catalog:
    return Catalog(load_yaml("micro/rolling_stock.yaml"))


@dataclass
class Locomotive:
    """Экземпляр локомотива: номер, пробег, износ, обслуживание."""
    id: str
    model: LocoModel
    mileage_km: int
    wear_pct: float
    last_service: str
    next_service_km: int
    state: str = "исправен"

    def card(self) -> dict[str, Any]:
        m = self.model
        return {
            "id": self.id, "model": m.id, "model_name": m.name, "state": self.state,
            "mileage_km": self.mileage_km, "wear_pct": self.wear_pct,
            "last_service": self.last_service, "next_service_km": self.next_service_km,
        }


@dataclass
class Wagon:
    """Экземпляр вагона: номер, загрузка, пробег, износ, ремонты."""
    number: str
    model: WagonModel
    load_t: float
    passengers: int
    mileage_km: int
    wear_pct: float
    last_repair: str
    next_repair: str
    state: str = "исправен"

    @property
    def gross_t(self) -> float:
        return self.model.tare_t + self.load_t

    def card(self) -> dict[str, Any]:
        m = self.model
        return {
            "number": self.number, "model": m.id, "model_name": m.name, "type": TYPE_RU.get(m.type, m.type),
            "state": self.state, "load_t": round(self.load_t, 1), "capacity_t": m.capacity_t,
            "passengers": self.passengers, "gross_t": round(self.gross_t, 1),
            "mileage_km": self.mileage_km, "wear_pct": self.wear_pct,
            "last_repair": self.last_repair, "next_repair": self.next_repair,
        }


@dataclass
class Consist:
    locos: list[Locomotive]
    wagons: list[Wagon] = field(default_factory=list)

    @property
    def gauge(self) -> int:
        return self.locos[0].model.gauge

    @property
    def length_m(self) -> float:
        return sum(lc.model.length_m for lc in self.locos) + sum(w.model.length_m for w in self.wagons)

    @property
    def wagons_mass_t(self) -> float:
        return sum(w.gross_t for w in self.wagons)

    @property
    def mass_t(self) -> float:
        return self.wagons_mass_t + sum(lc.model.mass_t for lc in self.locos)

    @property
    def load_t(self) -> float:
        return sum(w.load_t for w in self.wagons)

    @property
    def capacity_t(self) -> float:
        return sum(w.model.capacity_t for w in self.wagons)

    @property
    def vmax_kmh(self) -> float:
        return min([lc.model.vmax_kmh for lc in self.locos] + [w.model.vmax_kmh for w in self.wagons])

    @property
    def electric(self) -> bool:
        return any(lc.model.electric for lc in self.locos)

    @property
    def dangerous(self) -> bool:
        return any(w.model.dangerous_cargo and w.load_t > 0 for w in self.wagons)

    @property
    def axles(self) -> int:
        return sum(w.model.axles for w in self.wagons) + sum(lc.model.axles for lc in self.locos)

    def wagon_resistance(self, v: float) -> float:
        """Средневзвешенное по массе основное удельное сопротивление вагонов, Н/кН."""
        total, acc = 0.0, 0.0
        for w in self.wagons:
            m = w.gross_t
            if w.model.type == "passenger":
                r = 1.2 + 0.012 * v + 0.0002 * v * v
            else:
                q0 = m / max(1, w.model.axles)
                r = 0.7 + (3 + 0.1 * v + 0.0025 * v * v) / q0
            total += m
            acc += r * m
        return acc / total if total else 1.0

    def allowed_mass_t(self, grade_permille: float, w0: tuple[float, float, float]) -> float:
        """Допустимая масса вагонной части из условия равномерного движения на руководящем подъёме
        с расчётной скоростью длительного режима (демонстрационная формула по мотивам ПТР):
            Q = (n·Fк/g − P·(w0' + i)) / (w0'' + i)
        Fк — сила тяги длительного режима, кН; P — масса локомотивов, т; i — уклон, ‰."""
        if not self.locos:
            return 0.0
        v = min(lc.model.v_cont_kmh for lc in self.locos)
        f_kgf = sum(lc.model.f_cont_kn for lc in self.locos) * 1000 / G
        p = sum(lc.model.mass_t for lc in self.locos)
        a, b, c = w0
        w_loco = a + b * v + c * v * v
        q = (f_kgf - p * (w_loco + grade_permille)) / (self.wagon_resistance(v) + grade_permille)
        return max(0.0, q)

    def summary(self) -> dict[str, Any]:
        loco_names = " + ".join(lc.model.name for lc in self.locos)
        groups: dict[str, int] = {}
        for w in self.wagons:
            groups[w.model.name] = groups.get(w.model.name, 0) + 1
        return {
            "locos": loco_names, "loco_count": len(self.locos), "wagons": len(self.wagons),
            "groups": [{"model": k, "count": v} for k, v in groups.items()],
            "length_m": round(self.length_m, 1), "mass_t": round(self.mass_t),
            "wagons_mass_t": round(self.wagons_mass_t), "load_t": round(self.load_t),
            "capacity_t": round(self.capacity_t), "vmax_kmh": self.vmax_kmh, "gauge": self.gauge,
        }


def _date_back(rng: random.Random, today: date, max_days: int) -> date:
    return today - timedelta(days=rng.randint(20, max_days))


class Fleet:
    """Детерминированная генерация экземпляров (номера, пробег, износ) по seed сценария."""

    def __init__(self, catalog: Catalog, seed: int, today: date):
        self.cat = catalog
        self.rng = random.Random(seed)
        self.today = today
        self.used: set[str] = set()

    def _unique(self, make) -> str:
        while True:
            s = make()
            if s not in self.used:
                self.used.add(s)
                return s

    def loco(self, model_id: str) -> Locomotive:
        m = self.cat.locos[model_id]
        rng = self.rng
        lid = self._unique(lambda: f"{m.name.split()[0]}-{rng.randint(1, 350):04d}")
        mileage = rng.randint(80_000, 1_400_000)
        last = _date_back(rng, self.today, 30)
        return Locomotive(
            id=lid, model=m, mileage_km=mileage, wear_pct=round(min(85.0, mileage / 20_000 + rng.uniform(0, 10)), 1),
            last_service=f"ТО-2 {last.isoformat()}", next_service_km=rng.randint(2_000, 25_000),
        )

    def wagon(self, model_id: str, load: Any, passengers: int = 0) -> Wagon:
        m = self.cat.wagons[model_id]
        rng = self.rng
        if m.gauge == 1435:
            number = self._unique(lambda: f"{m.id} {rng.randint(1_500_000, 1_799_999)}")
        else:
            prefix = NUMBER_PREFIX.get(m.type, "5")
            number = self._unique(lambda: prefix + f"{rng.randint(0, 9_999_999):07d}")
        if load == "full":
            load_t = m.capacity_t
        elif load in (None, "empty"):
            load_t = 0.0
        else:
            load_t = min(float(load), m.capacity_t)
        if m.type == "passenger":
            load_t = passengers * self.cat.passenger_mass_t
        mileage = rng.randint(20_000, 600_000)
        last = _date_back(rng, self.today, 700)
        nxt = last + timedelta(days=730 if m.type != "passenger" else 365)
        return Wagon(
            number=number, model=m, load_t=load_t, passengers=passengers, mileage_km=mileage,
            wear_pct=round(min(90.0, mileage / 8_000 + rng.uniform(0, 8)), 1),
            last_repair=f"ДР {last.isoformat()}", next_repair=nxt.isoformat(),
        )
