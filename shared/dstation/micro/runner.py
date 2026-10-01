"""Обёртка микромодели: масштаб времени, пуск/пауза/сброс, выбор сценария."""
from __future__ import annotations

from typing import Any

from ..config import config_dir, load_yaml
from .catalog import load_catalog
from .infra import build_infra
from .world import World

SCALE_MIN, SCALE_MAX, SCALE_DEFAULT = 1.0, 600.0, 60.0
MAX_STEPS_PER_CALL = 2000


def list_scenarios() -> list[dict[str, Any]]:
    out = []
    for p in sorted((config_dir() / "micro" / "scenarios").glob("*.yaml")):
        d = load_yaml(f"micro/scenarios/{p.name}")
        out.append({"id": d["id"], "file": p.name, "order": d.get("order", 99), "name": d.get("name", d["id"]),
                    "description": " ".join(str(d.get("description", "")).split()), "duration_h": d.get("duration_h", 4)})
    return sorted(out, key=lambda x: x["order"])


def load_micro_scenario(sid: str) -> dict[str, Any]:
    for s in list_scenarios():
        if s["id"] == sid:
            return load_yaml(f"micro/scenarios/{s['file']}")
    raise KeyError(f"нет сценария {sid}")


class MicroSim:
    def __init__(self, scenario: str = "normal", scale: float = SCALE_DEFAULT, running: bool = False):
        self.infra_raw = load_yaml("micro/infrastructure.yaml")
        self.eq_raw = load_yaml("micro/equipment.yaml")
        self.staff_raw = load_yaml("micro/staff.yaml")
        self.catalog = load_catalog()
        self.scenarios = list_scenarios()
        self.scale = scale
        self.acc = 0.0
        self.version = 0
        self.reset(scenario)
        self.running = running

    def reset(self, scenario: str | None = None) -> None:
        sid = scenario or self.world.scn["id"]
        scn = load_micro_scenario(sid)
        self.infra = build_infra(self.infra_raw)
        self.world = World(self.infra, self.eq_raw, self.staff_raw, self.catalog, scn)
        self.duration_s = float(scn.get("duration_h", 4)) * 3600
        self.acc = 0.0
        self.running = False
        self.version += 1

    def advance_real(self, real_dt: float) -> int:
        """Продвигает модель на real_dt реальных секунд с текущим масштабом; шаг модели — 1 с."""
        if not self.running:
            return 0
        self.acc += real_dt * self.scale
        steps = 0
        while self.acc >= 1.0 and steps < MAX_STEPS_PER_CALL:
            self.world.step(1.0)
            self.acc -= 1.0
            steps += 1
            if self.world.t >= self.duration_s:
                self.running = False
                self.acc = 0.0
                self.world.log("system", f"Сценарий завершён: {self.duration_s / 3600:g} ч модельного времени, автопауза")
                break
        if self.acc > MAX_STEPS_PER_CALL:
            self.acc = 0.0
        return steps

    def run_for(self, sim_s: float) -> None:
        """Детерминированный прогон без реального времени (тесты, проверка сценариев)."""
        end = self.world.t + sim_s
        while self.world.t < end:
            self.world.step(1.0)

    def run_until(self, clock: str) -> None:
        h, m = clock.split(":")
        target = int(h) * 3600 + int(m) * 60 - self.world.start_s
        self.run_for(max(0.0, target - self.world.t))

    def command(self, cmd: dict[str, Any], source: str = "диспетчер") -> dict[str, Any]:
        kind = cmd.get("type")
        if kind == "run":
            if self.world.t >= self.duration_s:
                self.duration_s = self.world.t + 3600
            self.running = True
            self.world.log("command", "Пуск модели", source=source)
            return {"ok": True, "message": "пуск"}
        if kind == "pause":
            self.running = False
            self.world.log("command", "Пауза: движение, операции, ремонт и начисления остановлены", source=source)
            return {"ok": True, "message": "пауза"}
        if kind == "reset":
            sid = cmd.get("scenario") or self.world.scn["id"]
            if sid not in {s["id"] for s in self.scenarios}:
                return {"ok": False, "message": f"нет сценария {sid}"}
            self.reset(sid)
            return {"ok": True, "message": f"сброс, сценарий {sid}"}
        if kind == "set_scale":
            old = self.scale
            self.scale = max(SCALE_MIN, min(SCALE_MAX, float(cmd.get("scale", SCALE_DEFAULT))))
            self.world.log("command", f"Масштаб времени ×{old:g} → ×{self.scale:g} "
                           f"(1 мин реального = {self.scale:g} мин модельного)", source=source)
            return {"ok": True, "message": f"масштаб ×{self.scale:g}"}
        return self.world.command(cmd, source)

    def static(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "infra": self.infra.static(),
            "equipment": self.world.eq.static(),
            "catalog": self.catalog.static(),
            "staff": [w.view() for w in self.world.staff.workers.values()],
            "scenarios": self.scenarios,
            "scenario": self.world.scn["id"],
            "scale": {"min": SCALE_MIN, "max": SCALE_MAX, "default": SCALE_DEFAULT},
            "start_clock": self.infra_raw.get("start_clock", "08:00"),
            "events": self.world.events[-300:],
        }

    def frame(self, since_seq: int = 0) -> dict[str, Any]:
        f = self.world.frame(since_seq)
        f.update({"running": self.running, "scale": self.scale, "duration_s": self.duration_s, "version": self.version})
        return f
