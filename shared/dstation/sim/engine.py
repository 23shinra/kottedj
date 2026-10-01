"""Дискретно-временная модель станции («цифровой двойник»).

Один и тот же входной поток (график + сбои) прогоняется в двух мирах:
  * baseline — реактивный диспетчер «первым пришёл — первым обслужен» (FCFS);
  * ai       — исполнитель плана ИИ-планировщика (слоты, назначения путей и ресурсов).
"""
from __future__ import annotations

import random
from collections import deque
from dataclasses import dataclass, field
from typing import Any

from ..station import Station
from .timetable import TrainSpec

MIN_SPEED_MS = 15 / 3.6          # минимальная рекомендуемая скорость на подходе
STEP_S = 5                        # шаг модели, sim-сек

# Статусы поезда
SCHEDULED, APPROACHING, HELD, AT_SIGNAL, ENTERING, ON_TRACK, DEPARTING, DEPARTED, REROUTED = (
    "scheduled", "approaching", "held", "at_signal", "entering", "on_track", "departing", "departed", "rerouted")

REASONS = {
    "no_track": "ждёт свободный путь",
    "ladder": "ждёт маршрут в горловине",
    "slot": "регулирование: вход по слоту",
    "service": "техобслуживание",
    "loco": "ждёт локомотив",
    "loco_prep": "подача локомотива",
    "crew": "ждёт бригаду",
    "crew_prep": "явка бригады",
    "schedule": "ожидает время по графику",
    "exit_ladder": "ждёт маршрут отправления",
    "incident": "задержка (сбой)",
    "hol": "за впереди стоящим поездом",
}


@dataclass
class Train:
    spec: TrainSpec
    status: str = SCHEDULED
    pos_m: float = 0.0               # расстояние до входного сигнала
    speed_ms: float = 0.0
    eta: int = 0                     # ожидаемое прибытие к сигналу при vmax
    track: str | None = None
    entered_at: int | None = None
    on_track_at: int | None = None
    service_done_at: int | None = None
    loco: str | None = None
    loco_ready_at: int | None = None
    crew: str | None = None
    crew_ready_at: int | None = None
    ready_at: int | None = None
    departed_at: int | None = None
    left_at: int | None = None
    signal_at: int | None = None
    hold_until: int = 0              # сбой: стоянка на перегоне до
    stopped_at_signal: bool = False
    regulated: bool = False
    advisory_kmh: float | None = None
    res_wait_s: int = 0
    reason: str | None = None
    loco_requested_at: int | None = None

    @property
    def id(self) -> str:
        return self.spec.id


@dataclass
class Loco:
    id: str
    status: str = "available"        # available | turnaround | moving | attached | failed
    train: str | None = None
    until: int = 0


@dataclass
class Crew:
    id: str
    status: str = "available"        # available | rest | boarding | assigned
    train: str | None = None
    until: int = 0


@dataclass
class World:
    name: str
    station: Station
    specs: list[TrainSpec]
    policy: str = "fcfs"             # fcfs | plan
    t: int = 0
    trains: dict[str, Train] = field(default_factory=dict)
    locos: dict[str, Loco] = field(default_factory=dict)
    crews: dict[str, Crew] = field(default_factory=dict)
    closed: dict[str, int | None] = field(default_factory=dict)      # путь -> до (None = бессрочно)
    opened_reserve: set[str] = field(default_factory=set)
    ladder_busy: dict[str, tuple[int, str]] = field(default_factory=dict)
    plan: dict[str, Any] | None = None
    events: list[dict[str, Any]] = field(default_factory=list)
    ladder_conflicts: deque = field(default_factory=lambda: deque(maxlen=500))
    _spec_idx: int = 0
    _loco_seq: int = 0
    _crew_seq: int = 0
    _signal_queue: dict[str, list[str]] = field(default_factory=lambda: {"W": [], "E": []})
    _res_queue: list[str] = field(default_factory=list)

    # ------------------------------------------------------------------ setup
    def __post_init__(self) -> None:
        st = self.station
        for _ in range(st.n_locos):
            self._new_loco()
        for _ in range(st.n_crews):
            self._new_crew()

    def _new_loco(self, status: str = "available", until: int = 0) -> Loco:
        self._loco_seq += 1
        lc = Loco(id=f"Л{self._loco_seq}", status=status, until=until)
        self.locos[lc.id] = lc
        return lc

    def _new_crew(self, status: str = "available", until: int = 0) -> Crew:
        self._crew_seq += 1
        cr = Crew(id=f"Б{self._crew_seq}", status=status, until=until)
        self.crews[cr.id] = cr
        return cr

    def seed_initial(self, n: int, rnd: random.Random) -> None:
        """Стартовая занятость: несколько поездов уже стоят на путях."""
        st = self.station
        cats = ["freight_transit", "freight_transit", "freight_local", "pass"]
        used: set[str] = set()
        for i in range(n):
            cat = cats[i % len(cats)]
            c = st.categories[cat]
            length = int(c.length_m[0] + 40)
            cands = [tid for tid in st.compatible(cat, length, include_reserve=False) if tid not in used]
            if not cands:
                continue
            tid = cands[0]
            used.add(tid)
            arr = -int(rnd.uniform(5, c.service_min[0]) * 60)
            service = int(rnd.uniform(*c.service_min) * 60)
            nominal = c.service_min[1] * 60 + (15 * 60 if c.needs_loco else 0) + 2 * st.throat_s
            spec = TrainSpec(
                id=str(901 + i * 2) if cat == "pass" else str(1901 + i), cat=cat, length_m=length,
                side_in="W", side_out="E", planned_arr=arr, planned_dep=arr + nominal, actual_arr=arr,
                service_s=service, vmax_ms=60 / 3.6,
            )
            tr = Train(spec=spec, status=ON_TRACK, track=tid, entered_at=arr, on_track_at=arr,
                       service_done_at=arr + service, eta=arr, signal_at=arr)
            self.trains[tr.id] = tr

    # ------------------------------------------------------------------ helpers
    def log(self, kind: str, text: str, **kw: Any) -> None:
        self.events.append({"t": self.t, "type": kind, "text": text, "world": self.name, **kw})

    def is_closed(self, tid: str) -> bool:
        if tid in self.closed:
            until = self.closed[tid]
            if until is None or until > self.t:
                return True
            del self.closed[tid]
            self.log("track_open", f"Путь {tid} открыт после окна", track=tid)
        return False

    def closed_set(self) -> set[str]:
        out = {tid for tid in list(self.closed) if self.is_closed(tid)}
        for t in self.station.tracks.values():
            if t.reserve and t.id not in self.opened_reserve:
                out.add(t.id)
        return out

    def track_occupant(self, tid: str) -> Train | None:
        for tr in self.trains.values():
            if tr.track == tid and tr.status in (ENTERING, ON_TRACK, DEPARTING):
                return tr
            if tr.track == tid and tr.status == DEPARTED and tr.left_at and tr.left_at + self.station.track_buffer_s > self.t:
                return tr
        return None

    def track_free(self, tid: str) -> bool:
        return not self.is_closed(tid) and tid not in self.closed_set() and self.track_occupant(tid) is None

    def ladder_free(self, ladder: str) -> bool:
        b = self.ladder_busy.get(ladder)
        return b is None or b[0] <= self.t

    def plan_for(self, tid: str) -> dict[str, Any] | None:
        if self.policy != "plan" or not self.plan:
            return None
        return self.plan.get("assignments", {}).get(tid)

    # ------------------------------------------------------------------ incidents / actions
    def apply_command(self, cmd: dict[str, Any]) -> str:
        kind = cmd.get("type")
        if kind == "close_track":
            tid = str(cmd["track"])
            dur = cmd.get("duration_min")
            self.closed[tid] = self.t + int(dur * 60) if dur else None
            self.log("incident", f"Путь {tid} закрыт" + (f" на {dur} мин" if dur else ""), track=tid, severity="high")
            return "ok"
        if kind == "open_track":
            tid = str(cmd["track"])
            self.closed.pop(tid, None)
            if self.station.tracks[tid].reserve:
                self.opened_reserve.add(tid)
            self.log("action", f"Путь {tid} открыт для приёма", track=tid)
            return "ok"
        if kind == "delay":
            tr = self.trains.get(str(cmd["train"]))
            minutes = int(cmd.get("minutes", 15))
            if tr is None:
                for s in self.specs[self._spec_idx:]:
                    if s.id == str(cmd["train"]):
                        s.actual_arr += minutes * 60
                        self.log("incident", f"Поезд №{s.id}: опоздание +{minutes} мин", train=s.id, severity="medium")
                        return "ok"
                return "not_found"
            if tr.status in (APPROACHING, HELD, SCHEDULED):
                tr.hold_until = max(tr.hold_until, self.t) + minutes * 60
            elif tr.status == ON_TRACK and tr.service_done_at is not None:
                tr.service_done_at = max(tr.service_done_at, self.t) + minutes * 60
            self.log("incident", f"Поезд №{tr.id}: задержка +{minutes} мин", train=tr.id, severity="medium")
            return "ok"
        if kind == "loco_failure":
            lid = cmd.get("loco")
            cands = [lc for lc in self.locos.values() if lc.status != "failed" and (lid is None or lc.id == lid)]
            pref = [lc for lc in cands if lc.status in ("moving", "attached")] or cands
            if not pref:
                return "not_found"
            lc = pref[0]
            if lc.train and lc.train in self.trains:
                tr = self.trains[lc.train]
                tr.loco, tr.loco_ready_at, tr.ready_at = None, None, None
            lc.status, lc.train, lc.until = "failed", None, self.t + int(cmd.get("duration_min", 90)) * 60
            self.log("incident", f"Отказ локомотива {lc.id}", loco=lc.id, severity="high")
            return "ok"
        if kind == "add_loco":
            lc = self._new_loco()
            self.log("action", f"Резервный локомотив {lc.id} выведен из депо", loco=lc.id)
            return "ok"
        if kind == "add_crew":
            cr = self._new_crew()
            self.log("action", f"Вызвана резервная бригада {cr.id}", crew=cr.id)
            return "ok"
        if kind == "reroute":
            tr = self.trains.get(str(cmd["train"]))
            if tr and tr.status in (SCHEDULED, APPROACHING, HELD, AT_SIGNAL):
                for q in self._signal_queue.values():
                    if tr.id in q:
                        q.remove(tr.id)
                tr.status = REROUTED
                tr.left_at = self.t
                self.log("action", f"Поезд №{tr.id} направлен по обходу", train=tr.id)
                return "ok"
            return "not_found"
        return "unknown"

    # ------------------------------------------------------------------ main loop
    def advance(self, dt: int) -> None:
        end = self.t + dt
        while self.t < end:
            self.t += STEP_S
            self._step()

    def _step(self) -> None:
        st = self.station
        t = self.t
        # 1. появление поездов на подходе
        while self._spec_idx < len(self.specs):
            s = self.specs[self._spec_idx]
            travel = st.approach_len[s.side_in] / s.vmax_ms
            if s.actual_arr - travel > t:
                break
            self._spec_idx += 1
            tr = Train(spec=s, status=APPROACHING, pos_m=float(st.approach_len[s.side_in]))
            self.trains[s.id] = tr
            self.log("spawn", f"Поезд №{s.id} на подходе ({s.side_in})", train=s.id)
        # 2. ресурсы: таймеры
        for lc in self.locos.values():
            if lc.status in ("turnaround", "failed") and lc.until <= t:
                if lc.status == "failed":
                    self.log("action", f"Локомотив {lc.id} восстановлен", loco=lc.id)
                lc.status = "available"
            elif lc.status == "moving" and lc.until <= t:
                lc.status = "attached"
        for cr in self.crews.values():
            if cr.status == "rest" and cr.until <= t:
                cr.status = "available"
            elif cr.status == "boarding" and cr.until <= t:
                cr.status = "assigned"
        # 3. движение на подходе
        for tr in self.trains.values():
            if tr.status in (APPROACHING, HELD):
                self._move(tr)
        # 4. приём на станцию
        self._admit()
        # 5. на путях: окончание приёма, обслуживание, ресурсы
        for tr in self.trains.values():
            if tr.status == ENTERING and tr.on_track_at is not None and tr.on_track_at <= t:
                tr.status = ON_TRACK
                self._detach_incoming(tr)
        self._resources()
        for tr in self.trains.values():
            if tr.status == ON_TRACK:
                self._update_ready(tr)
        # 6. отправление
        self._depart()
        for tr in self.trains.values():
            if tr.status == DEPARTING and tr.left_at is not None and tr.left_at <= t:
                tr.status = DEPARTED
        self._gc()

    # ------------------------------------------------------------------ approach
    def _move(self, tr: Train) -> None:
        t = self.t
        s = tr.spec
        if tr.hold_until > t:
            tr.speed_ms = 0.0
            tr.reason = "incident"
            tr.status = HELD if tr.pos_m >= self.station.approach_len[s.side_in] - 1 else APPROACHING
            tr.eta = int(tr.hold_until + tr.pos_m / s.vmax_ms)
            return
        speed = s.vmax_ms
        tr.regulated, tr.advisory_kmh, tr.reason = False, None, None
        tr.status = APPROACHING
        pa = self.plan_for(tr.id)
        if pa is not None:
            slot = int(pa["entry_at"])
            free_eta = t + tr.pos_m / s.vmax_ms
            if slot > free_eta + 30:
                need = tr.pos_m / max(1.0, slot - t)
                if need < MIN_SPEED_MS:
                    if tr.pos_m >= self.station.approach_len[s.side_in] - 1:
                        speed = 0.0       # удержание на предыдущей станции
                        tr.status = HELD
                    else:
                        speed = MIN_SPEED_MS
                else:
                    speed = need
                tr.regulated = True
                tr.reason = "slot"
                tr.advisory_kmh = round(speed * 3.6, 1)
        tr.speed_ms = speed
        tr.pos_m = max(0.0, tr.pos_m - speed * STEP_S)
        tr.eta = int(t + tr.pos_m / s.vmax_ms)
        if tr.pos_m <= 0:
            tr.status = AT_SIGNAL
            tr.speed_ms = 0.0
            tr.signal_at = t
            self._signal_queue[s.side_in].append(tr.id)

    # ------------------------------------------------------------------ admission
    def _best_fit(self, tr: Train) -> str | None:
        closed = self.closed_set()
        cands = [tid for tid in self.station.compatible(tr.spec.cat, tr.spec.length_m, closed) if self.track_free(tid)]
        if not cands:
            return None
        if self.policy == "fcfs":
            return cands[0]                       # первый подходящий
        return min(cands, key=lambda tid: self.station.tracks[tid].length_m)   # best-fit

    def _try_enter(self, tr: Train, tid: str) -> bool:
        ladder = self.station.ladder(tid, tr.spec.side_in)
        if not self.ladder_free(ladder):
            tr.reason = "ladder"
            self.ladder_conflicts.append(self.t)
            return False
        st = self.station
        self.ladder_busy[ladder] = (self.t + st.throat_s, tr.id)
        tr.status, tr.track, tr.entered_at = ENTERING, tid, self.t
        tr.on_track_at = self.t + st.throat_s
        tr.service_done_at = tr.on_track_at + tr.spec.service_s
        tr.reason = None
        self._signal_queue[tr.spec.side_in].remove(tr.id)
        wait = (self.t - (tr.signal_at or self.t)) // 60
        self.log("enter", f"Поезд №{tr.id} принят на путь {tid}" + (f" (ожидание {wait} мин)" if wait > 0 else ""),
                 train=tr.id, track=tid)
        return True

    def _admit(self) -> None:
        for side, q in self._signal_queue.items():
            if not q:
                continue
            if self.policy == "fcfs":
                head = self.trains[q[0]]
                track = self._best_fit(head)
                if track is None:
                    head.reason = "no_track"
                else:
                    self._try_enter(head, track)
                for tid in q[1:]:
                    self.trains[tid].reason = "hol"
            else:
                order = sorted(q, key=lambda x: (self.plan_for(x) or {}).get("entry_at", 10 ** 9))
                for tid in order:
                    tr = self.trains[tid]
                    pa = self.plan_for(tid)
                    track = None
                    if pa and pa.get("track") and self.track_free(pa["track"]) and \
                            pa["track"] in self.station.compatible(tr.spec.cat, tr.spec.length_m, self.closed_set()):
                        early = self.t < pa["entry_at"] - 30
                        if early and self._track_reserved_before(pa["track"], tid, pa["entry_at"]):
                            tr.reason = "slot"
                            continue
                        track = pa["track"]
                    if track is None:
                        stale = pa is None or self.t > pa["entry_at"] + 60
                        if not stale:
                            tr.reason = "slot" if pa and self.t < pa["entry_at"] else "no_track"
                            continue
                        track = self._best_fit(tr)
                    if track is None:
                        tr.reason = "no_track"
                        continue
                    self._try_enter(tr, track)
            for tid in q:                         # стоит у сигнала дольше минуты — остановка
                tr = self.trains[tid]
                if self.t - (tr.signal_at or self.t) >= 60:
                    tr.stopped_at_signal = True

    def _track_reserved_before(self, track: str, tid: str, entry_at: int) -> bool:
        for oid, a in (self.plan or {}).get("assignments", {}).items():
            if oid != tid and a.get("track") == track and a.get("entry_at", 0) <= entry_at:
                o = self.trains.get(oid)
                if o and o.status in (SCHEDULED, APPROACHING, HELD, AT_SIGNAL):
                    return True
        return False

    def _detach_incoming(self, tr: Train) -> None:
        """Прибывший грузовой: свой локомотив уходит на экипировку, бригада на отдых."""
        c = self.station.categories[tr.spec.cat]
        if c.needs_loco:
            self._new_loco("turnaround", self.t + self.station.loco_turnaround_s)
        if c.needs_crew:
            self._new_crew("rest", self.t + self.station.crew_rest_s)

    # ------------------------------------------------------------------ resources
    def _available_loco(self, prefer: str | None = None) -> Loco | None:
        if prefer and prefer in self.locos and self.locos[prefer].status == "available":
            return self.locos[prefer]
        av = [lc for lc in self.locos.values() if lc.status == "available"]
        return av[0] if av else None

    def _available_crew(self, prefer: str | None = None) -> Crew | None:
        if prefer and prefer in self.crews and self.crews[prefer].status == "available":
            return self.crews[prefer]
        av = [cr for cr in self.crews.values() if cr.status == "available"]
        return av[0] if av else None

    def _attach_loco(self, tr: Train, lc: Loco) -> None:
        lc.status, lc.train, lc.until = "moving", tr.id, self.t + self.station.loco_prep_s
        tr.loco, tr.loco_ready_at = lc.id, lc.until
        self.log("resource", f"Локомотив {lc.id} подаётся к поезду №{tr.id} (путь {tr.track})", train=tr.id, loco=lc.id)

    def _board_crew(self, tr: Train, cr: Crew) -> None:
        cr.status, cr.train, cr.until = "boarding", tr.id, self.t + self.station.crew_prep_s
        tr.crew, tr.crew_ready_at = cr.id, cr.until

    def _resources(self) -> None:
        t = self.t
        st = self.station
        present = [tr for tr in self.trains.values() if tr.status in (ON_TRACK, ENTERING)]
        if self.policy == "fcfs":
            # реактивно: локомотив запрашивается на середине обслуживания, бригада — после прицепки
            for tr in present:
                c = st.categories[tr.spec.cat]
                if c.needs_loco and tr.loco is None and tr.status == ON_TRACK and tr.service_done_at is not None:
                    half = tr.service_done_at - tr.spec.service_s // 2
                    if t >= half and tr.id not in self._res_queue:
                        self._res_queue.append(tr.id)
            for tid in list(self._res_queue):
                tr = self.trains[tid]
                if tr.loco is not None or tr.status != ON_TRACK:
                    self._res_queue.remove(tid)
                    continue
                lc = self._available_loco()
                if lc is None:
                    break
                self._attach_loco(tr, lc)
                self._res_queue.remove(tid)
            for tr in present:
                c = st.categories[tr.spec.cat]
                if c.needs_crew and tr.crew is None and tr.status == ON_TRACK:
                    loco_ok = not c.needs_loco or (tr.loco is not None and self.locos[tr.loco].status == "attached")
                    if loco_ok:
                        cr = self._available_crew()
                        if cr:
                            self._board_crew(tr, cr)
        else:
            # по плану: подача заранее, чтобы ресурс был готов к окончанию обслуживания
            ordered = sorted(present, key=lambda x: (self.plan_for(x.id) or {}).get("dep_at", x.service_done_at or 0))
            for tr in ordered:
                c = st.categories[tr.spec.cat]
                pa = self.plan_for(tr.id) or {}
                if c.needs_loco and tr.loco is None:
                    due = pa.get("loco_at", (tr.service_done_at or t) - st.loco_prep_s)
                    if t >= due:
                        lc = self._available_loco(pa.get("loco"))
                        if lc:
                            self._attach_loco(tr, lc)
                if c.needs_crew and tr.crew is None:
                    due = pa.get("crew_at", (tr.service_done_at or t) - st.crew_prep_s)
                    if t >= due:
                        cr = self._available_crew(pa.get("crew"))
                        if cr:
                            self._board_crew(tr, cr)

    def _update_ready(self, tr: Train) -> None:
        t = self.t
        c = self.station.categories[tr.spec.cat]
        if tr.service_done_at is None or t < tr.service_done_at:
            tr.reason = "service"
            return
        if c.needs_loco and (tr.loco is None or self.locos[tr.loco].status != "attached"):
            tr.reason = "loco" if tr.loco is None else "loco_prep"
            tr.res_wait_s += STEP_S
            return
        if c.needs_crew and (tr.crew is None or self.crews[tr.crew].status != "assigned"):
            tr.reason = "crew" if tr.crew is None else "crew_prep"
            tr.res_wait_s += STEP_S
            return
        if tr.ready_at is None:
            tr.ready_at = t
        tr.reason = None

    # ------------------------------------------------------------------ departure
    def _depart(self) -> None:
        t = self.t
        st = self.station
        ready = [tr for tr in self.trains.values() if tr.status == ON_TRACK and tr.ready_at is not None]
        ready.sort(key=lambda x: x.ready_at or 0)
        for tr in ready:
            if tr.spec.cat == "pass" and t < tr.spec.planned_dep:
                tr.reason = "schedule"
                continue
            pa = self.plan_for(tr.id)
            ladder = st.ladder(tr.track, tr.spec.side_out)
            if pa and t < pa.get("dep_at", 0) - 30 and self._ladder_planned_soon(ladder, tr.id):
                tr.reason = "exit_ladder"
                continue
            if not self.ladder_free(ladder):
                tr.reason = "exit_ladder"
                self.ladder_conflicts.append(t)
                continue
            self.ladder_busy[ladder] = (t + st.throat_s, tr.id)
            tr.status, tr.departed_at, tr.left_at = DEPARTING, t, t + st.throat_s
            tr.reason = None
            for lid in (tr.loco,):
                if lid and lid in self.locos:
                    del self.locos[lid]
            if tr.crew and tr.crew in self.crews:
                del self.crews[tr.crew]
            delay = (t - tr.spec.planned_dep) // 60
            self.log("depart", f"Поезд №{tr.id} отправлен с пути {tr.track}" + (f", опоздание {delay} мин" if delay > 0 else ""),
                     train=tr.id, track=tr.track)

    def _ladder_planned_soon(self, ladder: str, tid: str) -> bool:
        """Не занимать горловину, если по плану через неё скоро принимается другой поезд."""
        st = self.station
        for oid, a in (self.plan or {}).get("assignments", {}).items():
            if oid == tid or not a.get("track"):
                continue
            o = self.trains.get(oid)
            if not o or o.status not in (AT_SIGNAL, APPROACHING):
                continue
            if st.ladder(a["track"], o.spec.side_in) == ladder and 0 <= a["entry_at"] - self.t < st.throat_s:
                return True
        return False

    def _gc(self) -> None:
        """Ушедшие поезда держим 3 часа для KPI и истории."""
        cutoff = self.t - 3 * 3600
        for tid in [k for k, tr in self.trains.items() if tr.status in (DEPARTED, REROUTED) and (tr.left_at or 0) < cutoff]:
            del self.trains[tid]

    # ------------------------------------------------------------------ KPI
    def kpi(self) -> dict[str, Any]:
        t = self.t
        hour = t - 3600
        trs = list(self.trains.values())
        departed = [x for x in trs if x.status in (DEPARTED, DEPARTING) and (x.departed_at or 0) >= hour]
        due = [x for x in trs if hour <= x.spec.planned_dep <= t and x.status != REROUTED]
        deviations = [max(0, (x.departed_at or t) - x.spec.planned_dep) / 60 for x in departed]
        overdue = [max(0, t - x.spec.planned_dep) / 60 for x in trs if x.status == ON_TRACK and t > x.spec.planned_dep]
        dev_all = deviations + overdue
        waiting = [x for x in trs if x.status in (AT_SIGNAL, HELD, APPROACHING) and t > x.spec.actual_arr + 60]
        entry_waits = [(x.entered_at - x.spec.actual_arr) / 60 for x in trs
                       if x.entered_at is not None and x.entered_at >= hour and x.spec.actual_arr >= 0]
        entry_waits += [(t - x.spec.actual_arr) / 60 for x in waiting]
        closed = self.closed_set()
        open_tracks = [tid for tid in self.station.tracks if tid not in closed]
        occupied = [tid for tid in open_tracks if self.track_occupant(tid) is not None]
        res_waits = [x.res_wait_s / 60 for x in departed] + \
                    [x.res_wait_s / 60 for x in trs if x.status == ON_TRACK and x.res_wait_s > 0]
        blocked_now = sum(1 for x in trs if x.reason in ("no_track", "ladder", "exit_ladder", "loco", "crew", "hol"))
        ladder_recent = sum(1 for ts in self.ladder_conflicts if ts >= t - 1800)
        stops = sum(1 for x in trs if x.stopped_at_signal and (x.entered_at or t) >= hour)
        locos_idle = sum(1 for lc in self.locos.values() if lc.status == "available")
        return {
            "sim_time": t,
            "departed_1h": len(departed),
            "due_1h": len(due),
            "throughput_ratio": round(min(1.0, len(departed) / len(due)) if due else 1.0, 3),
            "avg_deviation_min": round(sum(dev_all) / len(dev_all), 1) if dev_all else 0.0,
            "utilization": round(len(occupied) / max(1, len(open_tracks)), 3),
            "occupied_tracks": len(occupied),
            "open_tracks": len(open_tracks),
            "conflicts": blocked_now + min(10, ladder_recent // 3),
            "blocked_now": blocked_now,
            "ladder_conflicts_30m": ladder_recent,
            "avg_resource_wait_min": round(sum(res_waits) / len(res_waits), 1) if res_waits else 0.0,
            "locos_idle": locos_idle,
            "locos_total": len(self.locos),
            "crews_idle": sum(1 for c in self.crews.values() if c.status == "available"),
            "queue_len": len(waiting) + sum(1 for x in trs if x.status == AT_SIGNAL and t <= x.spec.actual_arr + 60),
            "avg_entry_wait_min": round(sum(entry_waits) / len(entry_waits), 1) if entry_waits else 0.0,
            "signal_stops_1h": stops,
            "total_departed": sum(1 for x in trs if x.status in (DEPARTED, DEPARTING)),
        }

    # ------------------------------------------------------------------ snapshot
    def snapshot(self) -> dict[str, Any]:
        t = self.t
        st = self.station
        closed = self.closed_set()
        trains = []
        for tr in self.trains.values():
            if tr.status in (DEPARTED, REROUTED) and (tr.left_at or 0) < t - 900:
                continue
            s = tr.spec
            trains.append({
                "id": s.id, "cat": s.cat, "length_m": s.length_m, "side_in": s.side_in, "side_out": s.side_out,
                "status": tr.status, "reason": tr.reason, "reason_text": REASONS.get(tr.reason or "", None),
                "track": tr.track, "pos_m": round(tr.pos_m), "speed_kmh": round(tr.speed_ms * 3.6, 1),
                "planned_arr": s.planned_arr, "planned_dep": s.planned_dep, "eta": tr.eta or s.actual_arr,
                "entered_at": tr.entered_at, "service_done_at": tr.service_done_at, "service_s": s.service_s,
                "ready_at": tr.ready_at, "departed_at": tr.departed_at, "loco": tr.loco, "crew": tr.crew,
                "loco_ready_at": tr.loco_ready_at, "crew_ready_at": tr.crew_ready_at,
                "regulated": tr.regulated, "advisory_kmh": tr.advisory_kmh, "hold_until": tr.hold_until,
                "stopped_at_signal": tr.stopped_at_signal, "res_wait_s": tr.res_wait_s,
                "delay_s": self._delay(tr),
            })
        # будущие поезда графика в горизонте планирования (ещё не на подходе)
        upcoming = []
        for s in self.specs[self._spec_idx:]:
            if s.planned_arr > t + 3 * 3600:
                break
            upcoming.append({"id": s.id, "cat": s.cat, "length_m": s.length_m, "side_in": s.side_in,
                             "side_out": s.side_out, "status": SCHEDULED, "planned_arr": s.planned_arr,
                             "planned_dep": s.planned_dep, "eta": s.actual_arr, "service_s": s.service_s})
        tracks = []
        for tid, tk in st.tracks.items():
            occ = self.track_occupant(tid)
            status = "closed" if tid in closed else ("occupied" if occ else "free")
            if tk.reserve and tid not in self.opened_reserve and tid not in self.closed:
                status = "reserve"
            tracks.append({"id": tid, "status": status, "train": occ.id if occ else None,
                           "closed_until": self.closed.get(tid)})
        return {
            "world": self.name,
            "sim_time": t,
            "trains": trains,
            "upcoming": upcoming,
            "tracks": tracks,
            "ladders": [{"id": lid, "busy_until": b[0], "train": b[1]} for lid, b in self.ladder_busy.items() if b[0] > t],
            "locos": [{"id": lc.id, "status": lc.status, "train": lc.train, "until": lc.until} for lc in self.locos.values()],
            "crews": [{"id": c.id, "status": c.status, "train": c.train, "until": c.until} for c in self.crews.values()],
            "kpi": self.kpi(),
            "plan_version": (self.plan or {}).get("version"),
        }

    def _delay(self, tr: Train) -> int:
        """Текущее отклонение от графика, сек: для принятых — по отправлению, для остальных — по прибытию."""
        s = tr.spec
        if tr.status in (DEPARTING, DEPARTED):
            return max(0, (tr.departed_at or self.t) - s.planned_dep)
        if tr.status in (ON_TRACK, ENTERING):
            return max(0, self.t - s.planned_dep)
        return max(0, (tr.eta or s.actual_arr) - s.planned_arr)

    def drain_events(self) -> list[dict[str, Any]]:
        ev, self.events = self.events, []
        return ev
