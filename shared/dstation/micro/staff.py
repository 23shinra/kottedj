"""Персонал: ремонтные задачи с этапами и экспериментальный премиальный баланс с журналом причин."""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Any, Callable

from ..config import load_yaml
from .equipment import Equipment

PHASE_RU = {"queued": "ожидает исполнителя", "travel": "выход к месту", "work": "ремонт", "verify": "проверка",
            "blocked": "ожидает восстановления питания/управления", "done": "выполнено"}


@dataclass
class Worker:
    id: str
    name: str
    role: str
    specialty: str
    posts: list[str]
    task: str | None = None

    def view(self) -> dict[str, Any]:
        return {"id": self.id, "name": self.name, "role": self.role, "specialty": self.specialty,
                "posts": self.posts, "task": self.task, "busy": self.task is not None}


@dataclass
class RepairTask:
    id: str
    device: str
    object: str
    cause: str
    created_t: float
    duration_min: float
    phase: str = "queued"
    worker: str | None = None
    phase_end_t: float | None = None
    start_t: float | None = None
    work_done_t: float | None = None
    finished_t: float | None = None
    result: str = ""

    def view(self) -> dict[str, Any]:
        return {"id": self.id, "device": self.device, "object": self.object, "cause": self.cause,
                "created_t": self.created_t, "duration_min": self.duration_min, "phase": self.phase,
                "phase_ru": PHASE_RU[self.phase], "worker": self.worker, "phase_end_t": self.phase_end_t,
                "start_t": self.start_t, "finished_t": self.finished_t, "result": self.result}


Log = Callable[..., None]


class Staff:
    def __init__(self, equipment: Equipment, log: Log, raw: dict[str, Any] | None = None):
        raw = copy.deepcopy(raw or load_yaml("micro/staff.yaml"))
        self.eq = equipment
        self.log = log
        self.workers = {w["id"]: Worker(w["id"], w["name"], w["role"], w["specialty"], [str(p) for p in w["posts"]])
                        for w in raw["staff"]}
        self.spec_by_kind: dict[str, str] = raw["specialty_by_kind"]
        self.repair_cfg: dict[str, Any] = raw["repair"]
        self.tasks: dict[str, RepairTask] = {}
        self.seq = 0
        self.bonus = Bonus(self, raw["bonus"])

    def responsible(self, dev_id: str) -> str | None:
        d = self.eq.devices[dev_id]
        spec = self.spec_by_kind.get(d.kind)
        for w in self.workers.values():
            if w.specialty == spec and (d.post is None or d.post in w.posts):
                return w.id
        return None

    def open_task(self, dev_id: str) -> RepairTask | None:
        return next((t for t in self.tasks.values() if t.device == dev_id and t.phase != "done"), None)

    def create(self, t: float, dev_id: str, cause: str, obj: str, duration_min: float | None = None) -> RepairTask:
        existing = self.open_task(dev_id)
        if existing:
            return existing
        self.seq += 1
        dur = float(duration_min if duration_min is not None else self.repair_cfg["default_duration_min"])
        task = RepairTask(f"Р-{self.seq:03d}", dev_id, obj, cause, t, dur)
        self.tasks[task.id] = task
        self.log("repair", f"Создана ремонтная задача {task.id}: {self.eq.devices[dev_id].name} — {cause}; "
                 f"плановая длительность {dur:.0f} мин", objects=[dev_id], level="warn")
        self._assign(t)
        return task

    def _assign(self, t: float) -> None:
        if not self.repair_cfg.get("auto_assign", True):
            return
        for task in sorted(self.tasks.values(), key=lambda x: x.created_t):
            if task.phase != "queued":
                continue
            d = self.eq.devices[task.device]
            spec = self.spec_by_kind.get(d.kind)
            cand = [w for w in self.workers.values()
                    if w.task is None and w.specialty == spec and (d.post is None or d.post in w.posts)]
            if not cand:
                continue
            w = cand[0]
            w.task, task.worker = task.id, w.id
            task.phase, task.phase_end_t = "travel", t + self.repair_cfg["travel_min"] * 60
            self.log("repair", f"{task.id}: назначен {w.name} ({w.role}), выход к месту {self.repair_cfg['travel_min']} мин",
                     objects=[task.device])

    def step(self, t: float, on_work_start: Callable[[str], None], on_repaired: Callable[[str], None]) -> None:
        for task in list(self.tasks.values()):
            if task.phase in ("queued", "done"):
                continue
            if task.phase == "blocked":
                if self.eq.devices[task.device].operational:
                    self._finish(t, task, "восстановлено: питание/управление вернулось, проверка пройдена")
                continue
            if task.phase_end_t is None or t < task.phase_end_t:
                continue
            if task.phase == "travel":
                task.phase, task.start_t = "work", t
                task.phase_end_t = t + task.duration_min * 60
                on_work_start(task.device)
                self.log("repair", f"{task.id}: начат ремонт ({task.duration_min:.0f} мин)", objects=[task.device])
            elif task.phase == "work":
                task.phase, task.work_done_t = "verify", t
                task.phase_end_t = t + self.repair_cfg["verify_min"] * 60
                on_repaired(task.device)
                self.log("repair", f"{task.id}: ремонт выполнен, проверка {self.repair_cfg['verify_min']} мин", objects=[task.device])
            elif task.phase == "verify":
                d = self.eq.devices[task.device]
                w = self.workers.get(task.worker or "")
                if w:
                    w.task = None
                if d.operational:
                    self._finish(t, task, "проверка пройдена, устройство работоспособно")
                else:
                    task.phase, task.phase_end_t = "blocked", None
                    task.result = f"устройство исправно, но нет питания/управления (причина: {d.cause})"
                    self.log("repair", f"{task.id}: {task.result}", objects=[task.device, d.cause], level="warn")
        self._assign(t)

    def _finish(self, t: float, task: RepairTask, result: str) -> None:
        w = self.workers.get(task.worker or "")
        if w and w.task == task.id:
            w.task = None
        task.phase, task.finished_t, task.result, task.phase_end_t = "done", t, result, None
        self.log("repair", f"{task.id}: {result}", objects=[task.device])
        self.bonus.on_repair_done(t, task)

    def view(self) -> dict[str, Any]:
        return {"workers": [w.view() for w in self.workers.values()],
                "tasks": [x.view() for x in sorted(self.tasks.values(), key=lambda x: x.id, reverse=True)],
                "repair_cfg": self.repair_cfg}


@dataclass
class Account:
    worker: str
    balance: float
    devices: list[str] = field(default_factory=list)
    # накопления текущего часа: (вид, устройство) → величина
    acc_ok_dev_s: float = 0.0
    pen: dict[str, float] = field(default_factory=dict)
    nopen: dict[str, float] = field(default_factory=dict)


class Bonus:
    """ЭКСПЕРИМЕНТАЛЬНЫЙ премиальный баланс (гипотеза). Каждое изменение записывается с причиной."""

    def __init__(self, staff: Staff, cfg: dict[str, Any]):
        self.staff = staff
        self.cfg = dict(cfg)
        self.accounts: dict[str, Account] = {w: Account(w, float(cfg["initial_balance"])) for w in staff.workers}
        for dev in staff.eq.devices:
            r = staff.responsible(dev)
            if r:
                self.accounts[r].devices.append(dev)
        self.ledger: list[dict[str, Any]] = []
        self.hour_start = 0.0

    def configure(self, patch: dict[str, Any]) -> list[str]:
        changed = []
        for k, v in patch.items():
            if k in self.cfg and k != "initial_balance":
                old = self.cfg[k]
                self.cfg[k] = type(old)(v) if not isinstance(old, bool) else bool(v)
                changed.append(f"{k}: {old} → {self.cfg[k]}")
        return changed

    def _entry(self, t: float, worker: str, delta: float, reason: str, kind: str, device: str | None = None) -> None:
        a = self.accounts[worker]
        new = a.balance + delta
        floor = float(self.cfg["min_balance"])
        note = ""
        if new < floor:
            note = f" (ограничено минимумом {floor:g})"
            delta, new = floor - a.balance, floor
        a.balance = new
        self.ledger.append({"t": t, "worker": worker, "delta": round(delta, 2), "balance": round(new, 2),
                            "reason": reason + note, "kind": kind, "device": device})

    def step(self, t: float, dt: float) -> None:
        eq = self.staff.eq.devices
        rate_stop = self.cfg["stop_accrual_on_downtime"]
        for a in self.accounts.values():
            for dev_id in a.devices:
                d = eq[dev_id]
                if d.operational:
                    a.acc_ok_dev_s += dt
                    continue
                if not rate_stop:
                    a.acc_ok_dev_s += dt
                own = d.health != "ok"
                if own or self.cfg["penalize_upstream"]:
                    a.pen[dev_id] = a.pen.get(dev_id, 0.0) + dt
                else:
                    a.nopen[dev_id] = a.nopen.get(dev_id, 0.0) + dt
        if t - self.hour_start >= 3600:
            self.flush(t)

    def flush(self, t: float) -> None:
        span = (t - self.hour_start) / 60
        for a in self.accounts.values():
            if a.acc_ok_dev_s > 0:
                dev_h = a.acc_ok_dev_s / 3600
                self._entry(t, a.worker, dev_h * self.cfg["accrual_per_device_hour"],
                            f"Начисление за исправную работу: {dev_h:.1f} устройство·ч за {span:.0f} мин "
                            f"× {self.cfg['accrual_per_device_hour']:g} у.е.", "accrual")
            for dev_id, s in a.pen.items():
                h = s / 3600
                self._entry(t, a.worker, -h * self.cfg["downtime_penalty_per_hour"],
                            f"Штраф за простой {dev_id}: {h * 60:.0f} мин × {self.cfg['downtime_penalty_per_hour']:g} у.е./ч",
                            "penalty", dev_id)
            for dev_id, s in a.nopen.items():
                self._entry(t, a.worker, 0.0,
                            f"Простой {dev_id} {s / 60:.0f} мин из-за отказа вышестоящего оборудования — без начисления и без штрафа",
                            "info", dev_id)
            a.acc_ok_dev_s, a.pen, a.nopen = 0.0, {}, {}
        self.hour_start = t

    def on_repair_done(self, t: float, task: RepairTask) -> None:
        worker = self.staff.responsible(task.device)
        if not worker:
            return
        took = (t - task.created_t) / 60
        cost = float(self.cfg["repair_cost"])
        reason = f"Стоимость ремонта {task.id} ({task.device}), восстановлено за {took:.0f} мин"
        if took <= self.cfg["fast_recovery_min"]:
            cost *= 1 - float(self.cfg["fast_recovery_discount"])
            reason += f" — быстрее {self.cfg['fast_recovery_min']} мин, скидка {self.cfg['fast_recovery_discount'] * 100:.0f}%"
        self._entry(t, worker, -cost, reason, "repair", task.device)

    def view(self, tail: int = 80) -> dict[str, Any]:
        return {
            "experimental": True, "cfg": self.cfg,
            "accounts": [{"worker": a.worker, "balance": round(a.balance, 2), "devices": len(a.devices),
                          "pending_ok_dev_h": round(a.acc_ok_dev_s / 3600, 2),
                          "pending_penalty_min": round(sum(a.pen.values()) / 60, 1)}
                         for a in self.accounts.values()],
            "ledger": self.ledger[-tail:][::-1],
        }
