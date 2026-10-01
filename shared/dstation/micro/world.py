"""Мир микромодели: централизация (маршруты, стрелки, сигналы), движение поездов, автодиспетчер,
отказы оборудования, ремонт, задержки и премирование — на общем модельном времени."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from .catalog import Catalog, Consist, Fleet, TYPE_RU
from .equipment import STATUS_RU, Equipment
from .infra import OPS_RU, Infra, Route, Segment
from .staff import Staff

LOOKAHEAD_M = 2500.0
SIGNAL_MARGIN_M = 15.0
BUFFER_MARGIN_M = 10.0
TRACK_FIT_MARGIN_M = 30.0
ENTRY_REQUEST_M = 1800.0
PRIORITY_LOOKAHEAD_S = 10 * 60
EMERGENCY_BRAKE = 1.0

SW_STATE_RU = {"ok": "положение подтверждено", "moving": "переводится", "unknown": "положение неизвестно (нет контроля)",
               "confirming": "восстановление контроля", "fault": "неисправна", "repairing": "в ремонте"}
STATUS_RU_TRAIN = {"scheduled": "по графику на подходе", "held": "удержан на соседней станции", "rejected": "отказ в приёме",
                   "inbound": "приём", "standing": "на пути, операция", "ready": "готов к отправлению",
                   "outbound": "отправление", "departed": "отправлен"}


def fmt_clock(start_s: float, t: float) -> str:
    s = int(start_s + t)
    return f"{(s // 3600) % 24:02d}:{(s % 3600) // 60:02d}"


def parse_clock(v: Any) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    h, m = str(v).split(":")[:2]
    return int(h) * 3600 + int(m) * 60


def blocker(key: str, text: str, *, objects: list[str] | None = None, trains: list[str] | None = None,
            waits: str = "", persistent: bool = False) -> dict[str, Any]:
    return {"key": key, "text": text, "objects": objects or [], "trains": trains or [], "waits": waits,
            "persistent": persistent}


@dataclass
class SwitchState:
    pos: str = "+"
    target: str = "+"
    state: str = "ok"
    done_at: float | None = None
    confirm_at: float | None = None
    locked_by: str | None = None
    throws: int = 0
    last_throw_t: float | None = None


@dataclass
class ActiveRoute:
    route: Route
    train: str | None
    t_set: float
    manual: bool
    state: str = "setting"   # setting → set (сигнал открыт) → passed (голова за сигналом)
    segs: set[str] = field(default_factory=set)
    sws: set[str] = field(default_factory=set)


@dataclass
class Train:
    id: str
    kind: str
    consist: Consist
    frm: str
    to: str
    op: str
    preferred: str | None
    planned_arrive_t: float | None
    dwell_s: float
    planned_depart_t: float
    spawn_t: float
    status: str = "scheduled"
    dest: str | None = None
    path: list[str] = field(default_factory=list)
    head_off: float = 0.0
    dir: str = "E"
    v: float = 0.0
    arrive_t: float | None = None
    op_done_t: float | None = None
    depart_t: float | None = None
    left_t: float | None = None
    spawned_t: float | None = None
    blockers: list[dict[str, Any]] = field(default_factory=list)
    block_sig: str = ""
    stop_reason: str | None = None
    delay: dict[str, float] = field(default_factory=dict)
    manual_hold: bool = False
    reject_reasons: list[str] = field(default_factory=list)
    reversed_n: int = 0
    unloaded_t: float = 0.0
    loaded_t: float = 0.0

    @property
    def priority(self) -> int:
        return 2 if self.kind == "passenger" else 1

    @property
    def head(self) -> str | None:
        return self.path[-1] if self.path else None

    @property
    def on_graph(self) -> bool:
        return self.status in ("inbound", "standing", "ready", "outbound")

    @property
    def depart_at(self) -> float | None:
        if self.op_done_t is None:
            return None
        return max(self.planned_depart_t, self.op_done_t)


class World:
    def __init__(self, infra: Infra, equipment_raw: dict[str, Any], staff_raw: dict[str, Any], catalog: Catalog,
                 scenario: dict[str, Any], *, repair_overrides: dict[str, Any] | None = None,
                 bonus_overrides: dict[str, Any] | None = None):
        self.inf = infra
        self.cat = catalog
        self.scn = scenario
        self.start_s = parse_clock(infra.raw.get("start_clock", "08:00"))
        self.date = date.fromisoformat(str(infra.raw.get("date", "2026-10-01")))
        self.t = 0.0
        self.events: list[dict[str, Any]] = []
        self.seq = 0
        self.eq = Equipment(infra, equipment_raw)
        self.staff = Staff(self.eq, self.log, staff_raw)
        if repair_overrides:
            self.staff.repair_cfg.update(repair_overrides)
        if bonus_overrides:
            self.staff.bonus.configure(bonus_overrides)
        self.throw_s = float(infra.raw.get("switch_throw_s", 6))
        self.tx_rate = float(infra.raw.get("transshipment_t_per_h", 1800))
        self.electrified = bool(infra.raw.get("electrified", False))
        self.sw = {s: SwitchState() for s in infra.switches}
        self.sig_open: dict[str, str | None] = {s: None for s in infra.signals}
        self.lamp_ok = {s: True for s in infra.signals}
        self.false_occ = {s: False for s in infra.segments}
        self.seg_lock: dict[str, str] = {}
        self.routes: dict[str, ActiveRoute] = {}
        self.occ: dict[str, str] = {}
        self.auto = True
        self.stock_t = float(scenario.get("initial_stock_t", 0))
        self.trains: dict[str, Train] = {}
        self.script = sorted(scenario.get("events", []), key=lambda e: parse_clock(e["at"]))
        self.script_i = 0
        self.violations: list[str] = []
        self.reactions: list[dict[str, Any]] = []
        self.pending_reactions: list[dict[str, Any]] = []
        self.counters = {"route_set": 0, "route_refused": 0, "manual_refused": 0, "manual_ok": 0, "throws": 0}
        self._build_trains(scenario)
        self.log("system", f"Сценарий «{scenario.get('name', scenario.get('id'))}» загружен: {len(self.trains)} поездов, "
                 f"{len(self.script)} запланированных событий", level="info")

    # ------------------------------------------------------------------ журнал
    def log(self, kind: str, text: str, *, level: str = "info", objects: list[str] | None = None,
            trains: list[str] | None = None, source: str = "") -> None:
        self.seq += 1
        self.events.append({"seq": self.seq, "t": round(self.t, 1), "clock": fmt_clock(self.start_s, self.t),
                            "kind": kind, "level": level, "text": text, "objects": objects or [],
                            "trains": trains or [], "source": source})
        if len(self.events) > 1500:
            del self.events[:500]

    def clock(self, t: float | None = None) -> str:
        return fmt_clock(self.start_s, self.t if t is None else t)

    # ------------------------------------------------------------------ поезда
    def _rel(self, v: Any) -> float:
        return parse_clock(v) - self.start_s

    def _build_trains(self, scn: dict[str, Any]) -> None:
        fleet = Fleet(self.cat, int(scn.get("seed", 1)), self.date)
        for d in scn.get("trains", []):
            locos = d["loco"] if isinstance(d["loco"], list) else [d["loco"]]
            consist = Consist([fleet.loco(m) for m in locos])
            for g in d.get("wagons", []):
                for _ in range(int(g["count"])):
                    consist.wagons.append(fleet.wagon(g["model"], g.get("load"), int(g.get("passengers", 0))))
            depart = self._rel(d["depart"])
            arrive = self._rel(d["arrive"]) if "arrive" in d else None
            tr = Train(id=str(d["id"]), kind=d.get("kind", "freight"), consist=consist, frm=d["from"], to=d["to"],
                       op=d.get("op", "through"), preferred=str(d["track"]) if d.get("track") else None,
                       planned_arrive_t=arrive, dwell_s=float(d.get("dwell_min", 0)) * 60,
                       planned_depart_t=depart, spawn_t=0.0)
            if d.get("start_on"):
                self._place_on_track(tr, str(d["start_on"]))
            else:
                tr.spawn_t = max(0.0, (arrive or 0.0) - self._est_inbound_s(tr))
            self.trains[tr.id] = tr

    def _est_inbound_s(self, tr: Train) -> float:
        app = self.inf.segments[self.inf.approach_of(tr.frm)]
        v = min(app.vmax_kmh, tr.consist.vmax_kmh) / 3.6
        return app.length_m / (v * 0.85) + 60

    def _place_on_track(self, tr: Train, track: str) -> None:
        seg = self.inf.segments[track]
        tr.dir = self._exit_dir(tr)
        tr.path, tr.head_off = [track], seg.length_m - SIGNAL_MARGIN_M
        tr.dest, tr.status, tr.op_done_t, tr.spawned_t = track, "ready", 0.0, 0.0
        tr.arrive_t = 0.0
        self._recompute_occ()

    def _exit_dir(self, tr: Train) -> str:
        return "W" if self.inf.boundary_dir_in(tr.to) == "E" else "E"

    def occ_list(self, tr: Train) -> list[tuple[str, float, float]]:
        """Занятые участки от головы к хвосту: (участок, от, до) в координатах a→b."""
        out, rem = [], tr.consist.length_m
        for i, sid in enumerate(reversed(tr.path)):
            seg = self.inf.segments[sid]
            if i == 0:
                covered = min(tr.head_off, seg.length_m)
                lo_dir, hi_dir = max(0.0, tr.head_off - rem), covered
            else:
                lo_dir, hi_dir = max(0.0, seg.length_m - rem), seg.length_m
            take = hi_dir - lo_dir
            if tr.dir == "E":
                out.append((sid, lo_dir, hi_dir))
            else:
                out.append((sid, seg.length_m - hi_dir, seg.length_m - lo_dir))
            rem -= take
            if rem <= 0.01:
                break
        return out

    def _prune_path(self, tr: Train) -> None:
        keep = [s for s, _, _ in self.occ_list(tr)]
        tr.path = list(reversed(keep))

    def _recompute_occ(self) -> None:
        self.occ = {}
        for tr in self.trains.values():
            if tr.on_graph:
                for sid, _, _ in self.occ_list(tr):
                    if sid in self.occ and self.occ[sid] != tr.id:
                        self._violation(f"участок {sid} занят одновременно поездами {self.occ[sid]} и {tr.id}")
                    self.occ[sid] = tr.id

    def _violation(self, text: str) -> None:
        self.violations.append(f"{self.clock()} {text}")
        self.log("safety", f"НАРУШЕНИЕ БЕЗОПАСНОСТИ: {text}", level="alarm")

    def switch_occupant(self, sw_id: str) -> str | None:
        node = self.inf.switches[sw_id].node
        for sid in (self.inf.switches[sw_id].stem, self.inf.switches[sw_id].normal, self.inf.switches[sw_id].reverse):
            seg = self.inf.segments[sid]
            if (seg.a == node or seg.b == node) and sid in self.occ:
                return self.occ[sid]
        return None

    # ------------------------------------------------------------------ правила приёма
    def acceptance(self, tr: Train, track: str) -> list[str]:
        seg = self.inf.segments[track]
        c = tr.consist
        out = []
        if seg.gauge != c.gauge:
            out.append(f"колея пути {track} {seg.gauge} мм ≠ колея состава {c.gauge} мм")
        if c.length_m + TRACK_FIT_MARGIN_M > seg.length_m:
            out.append(f"длина состава {c.length_m:.0f} м + {TRACK_FIT_MARGIN_M:.0f} м запаса > полезной длины пути {track} {seg.length_m:.0f} м")
        if tr.op not in seg.ops:
            out.append(f"путь {track} не предназначен для операции «{OPS_RU.get(tr.op, tr.op)}» (разрешено: {', '.join(OPS_RU.get(o, o) for o in seg.ops)})")
        if c.electric and not self.electrified:
            out.append(f"электровоз {c.locos[0].model.name}: пути станции не электрифицированы (допущение демо)")
        if c.dangerous and seg.platform:
            out.append(f"условное правило демо: цистерны с опасным грузом не принимаются к пассажирской платформе (путь {track})")
        return out

    def exit_mass_check(self, tr: Train) -> dict[str, Any] | None:
        grade = float(self.inf.boundaries[tr.to].get("grade_permille", 0))
        allowed = tr.consist.allowed_mass_t(grade, self.cat.loco_w0)
        actual = tr.consist.wagons_mass_t
        if actual > allowed:
            return blocker("mass", f"масса вагонной части {actual:.0f} т > допустимой {allowed:.0f} т для "
                           f"{tr.consist.summary()['locos']} на подъёме {grade:g} ‰ (демо-расчёт)",
                           trains=[tr.id], waits="прицепка дополнительного локомотива (кратная тяга) или отцепка вагонов",
                           persistent=True)
        return None

    def candidate_tracks(self, tr: Train) -> tuple[list[str], dict[str, list[str]]]:
        reasons = {s.id: self.acceptance(tr, s.id) for s in self.inf.tracks}
        ok = [s for s, r in reasons.items() if not r and self.entry_route(tr, s)]
        ok.sort(key=lambda s: (s != tr.preferred, self.inf.segments[s].length_m))
        return ok, reasons

    def entry_route(self, tr: Train, track: str) -> Route | None:
        app = self.inf.approach_of(tr.frm)
        node = self.inf.segments[app].exit(self.inf.boundary_dir_in(tr.frm))
        sig = self.inf.signal_at.get((node, self.inf.boundary_dir_in(tr.frm)))
        return self.inf.routes.get(f"{sig}→{track}") if sig else None

    def exit_route(self, tr: Train) -> Route | None:
        if not tr.head:
            return None
        seg = self.inf.segments[tr.head]
        sig = self.inf.signal_at.get((seg.exit(tr.dir), tr.dir))
        if not sig:
            return None
        return self.inf.routes.get(f"{sig}→{self.inf.approach_of(tr.to)}")

    def track_holder(self, track: str, exclude: str | None = None) -> str | None:
        for tr in self.trains.values():
            if tr.id != exclude and tr.dest == track and tr.status in ("inbound", "standing", "ready", "outbound"):
                if tr.status == "outbound" and track not in self.occ:
                    continue
                return tr.id
        return None

    # ------------------------------------------------------------------ централизация
    def _repair_wait(self, dev_id: str) -> str:
        d = self.eq.devices[dev_id]
        root = d.id if d.health != "ok" else (d.cause or d.id)
        task = self.staff.open_task(root)
        if not task:
            return f"восстановление {root}"
        eta = task.phase_end_t
        tail = f" (этап «{task.view()['phase_ru']}» до {self.clock(eta)})" if eta else f" ({task.view()['phase_ru']})"
        return f"ремонтная задача {task.id} по {root}{tail}"

    def switch_blocker(self, sw_id: str, want: str | None, route_id: str | None) -> dict[str, Any] | None:
        st = self.sw[sw_id]
        drive = f"СП-{sw_id}"
        if st.state in ("fault", "repairing"):
            return blocker(f"sw{sw_id}:{st.state}", f"стрелка {sw_id}: {SW_STATE_RU[st.state]}", objects=[sw_id, drive],
                           waits=self._repair_wait(drive), persistent=True)
        if st.state == "unknown":
            cause = self.eq.devices[drive].cause or drive
            return blocker(f"sw{sw_id}:unknown", f"стрелка {sw_id}: положение неизвестно — нет контроля (причина: {cause})",
                           objects=[sw_id, cause], waits=self._repair_wait(drive), persistent=True)
        if st.state == "confirming":
            return blocker(f"sw{sw_id}:confirming", f"стрелка {sw_id}: восстановление контроля положения",
                           objects=[sw_id], waits=f"подтверждение положения к {self.clock(st.confirm_at)}")
        if st.locked_by and st.locked_by != route_id:
            r = self.routes.get(st.locked_by)
            return blocker(f"sw{sw_id}:locked", f"стрелка {sw_id} замкнута в маршруте {st.locked_by}"
                           + (f" (поезд {r.train})" if r and r.train else ""), objects=[sw_id],
                           trains=[r.train] if r and r.train else [], waits=f"размыкание маршрута {st.locked_by}")
        if want is not None and want != st.pos:
            occ = self.switch_occupant(sw_id)
            if occ:
                return blocker(f"sw{sw_id}:under", f"стрелка {sw_id} под поездом {occ} — перевод запрещён",
                               objects=[sw_id], trains=[occ], waits=f"освобождение стрелки {sw_id} поездом {occ}")
            if st.state == "moving" and st.target != want:
                return blocker(f"sw{sw_id}:moving", f"стрелка {sw_id} переводится в другое положение", objects=[sw_id],
                               waits="окончание перевода")
        return None

    def segment_blocker(self, sid: str, tr: Train | None, route_id: str | None) -> dict[str, Any] | None:
        if self.false_occ[sid]:
            rc = f"РЦ-{sid}"
            return blocker(f"seg{sid}:false", f"участок {sid}: ложная занятость ({rc}: {STATUS_RU[self.eq.devices[rc].status]})",
                           objects=[sid, rc], waits=self._repair_wait(rc), persistent=True)
        occ = self.occ.get(sid)
        if occ and (tr is None or occ != tr.id):
            return blocker(f"seg{sid}:occ", f"участок {sid} занят поездом {occ}", objects=[sid], trains=[occ],
                           waits=f"освобождение участка {sid} после проследования поезда {occ}")
        lk = self.seg_lock.get(sid)
        if lk and lk != route_id:
            r = self.routes.get(lk)
            if not (r and tr and r.train == tr.id):
                return blocker(f"seg{sid}:locked", f"участок {sid} замкнут маршрутом {lk}" + (f" (поезд {r.train})" if r and r.train else ""),
                               objects=[sid], trains=[r.train] if r and r.train else [], waits=f"размыкание маршрута {lk}")
        return None

    def route_blockers(self, route: Route, tr: Train | None, *, persistent_only: bool = False) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        if route.id in self.routes:
            out.append(blocker(f"route{route.id}:active", f"маршрут {route.id} уже установлен", objects=[route.signal]))
        if not self.lamp_ok[route.signal]:
            dev = f"СВ-{route.signal}"
            out.append(blocker(f"sig{route.signal}:dark", f"светофор {route.signal} погашен ({dev}: {STATUS_RU[self.eq.devices[dev].status]})",
                               objects=[route.signal, dev], waits=self._repair_wait(dev), persistent=True))
        for sid in route.segments:
            seg = self.inf.segments[sid]
            if tr and seg.gauge != tr.consist.gauge:
                out.append(blocker(f"seg{sid}:gauge", f"участок {sid} колеи {seg.gauge} мм, состав {tr.consist.gauge} мм",
                                   objects=[sid], persistent=True))
            b = self.segment_blocker(sid, tr, route.id)
            if b:
                out.append(b)
        for sw_id, pos in route.switches:
            b = self.switch_blocker(sw_id, pos, route.id)
            if b:
                out.append(b)
        if tr is not None:
            if route.kind == "entry":
                for r in self.acceptance(tr, route.dest):
                    out.append(blocker(f"accept:{route.dest}", r, objects=[route.dest], trains=[tr.id], persistent=True))
                holder = self.track_holder(route.dest, exclude=tr.id)
                if holder:
                    out.append(blocker(f"track{route.dest}:held", f"путь {route.dest} занят/назначен поезду {holder}",
                                       objects=[route.dest], trains=[holder], waits=f"освобождение пути {route.dest} поездом {holder}"))
            else:
                mb = self.exit_mass_check(tr)
                if mb:
                    out.append(mb)
            if not self._train_at_route_start(tr, route):
                out.append(blocker("position", f"поезд {tr.id} не находится перед сигналом {route.signal}", trains=[tr.id],
                                   objects=[route.signal]))
        if persistent_only:
            out = [b for b in out if b["persistent"]]
        out.sort(key=lambda b: not b["persistent"])
        return out

    def _train_at_route_start(self, tr: Train, route: Route) -> bool:
        if tr.status in ("scheduled", "held"):
            return route.kind == "entry"
        if not tr.head or tr.dir != route.dir:
            return False
        return self.inf.segments[tr.head].exit(tr.dir) == self.inf.signals[route.signal].node

    def set_route(self, route: Route, tr: Train | None, *, manual: bool = False) -> list[dict[str, Any]]:
        bl = self.route_blockers(route, tr)
        if bl:
            return bl
        ar = ActiveRoute(route, tr.id if tr else None, self.t, manual)
        throws = []
        for sid in route.segments:
            self.seg_lock[sid] = route.id
            ar.segs.add(sid)
        for sw_id, pos in route.switches:
            st = self.sw[sw_id]
            st.locked_by = route.id
            ar.sws.add(sw_id)
            if st.pos != pos or st.state == "moving":
                self._start_throw(sw_id, pos)
                throws.append(f"{sw_id}({'+' if pos == '+' else '−'})")
        self.routes[route.id] = ar
        self.counters["route_set"] += 1
        who = f"поезда {tr.id}" if tr else "без поезда"
        src = "ручная команда" if manual else "автодиспетчер"
        self.log("route", f"Маршрут {route.id} {who}: замкнут ({src})" + (f", перевод стрелок {', '.join(throws)}" if throws else ""),
                 objects=[route.signal, *[s for s, _ in route.switches]], trains=[tr.id] if tr else [],
                 source=src)
        self._update_routes()
        return []

    def _start_throw(self, sw_id: str, pos: str) -> None:
        st = self.sw[sw_id]
        st.target, st.state, st.done_at = pos, "moving", self.t + self.throw_s
        st.throws += 1
        st.last_throw_t = self.t
        self.counters["throws"] += 1

    def release_route(self, rid: str, reason: str) -> None:
        ar = self.routes.pop(rid, None)
        if not ar:
            return
        for sid in ar.segs:
            if self.seg_lock.get(sid) == rid:
                del self.seg_lock[sid]
        for sw_id in ar.sws:
            if self.sw[sw_id].locked_by == rid:
                self.sw[sw_id].locked_by = None
        if self.sig_open.get(ar.route.signal) == rid:
            self.sig_open[ar.route.signal] = None
        self.log("route", f"Маршрут {rid} разомкнут: {reason}", objects=[ar.route.signal], trains=[ar.train] if ar.train else [])

    def _route_open_problem(self, ar: ActiveRoute) -> str | None:
        r = ar.route
        if not self.lamp_ok[r.signal]:
            return f"светофор {r.signal} погашен"
        for sw_id, pos in r.switches:
            if sw_id not in ar.sws:
                continue
            st = self.sw[sw_id]
            if st.state != "ok" or st.pos != pos:
                return f"стрелка {sw_id}: {SW_STATE_RU[st.state] if st.state != 'ok' else 'не в положении маршрута'}"
        for sid in r.segments:
            if sid in ar.segs and self.false_occ[sid]:
                return f"ложная занятость участка {sid}"
        return None

    def _update_routes(self) -> list[str]:
        """Открывает сигналы готовых маршрутов и перекрывает сигналы, условия которых нарушены."""
        closed = []
        for rid, ar in list(self.routes.items()):
            if ar.state == "passed":
                continue
            problem = self._route_open_problem(ar)
            if ar.state == "set" and problem:
                self.sig_open[ar.route.signal] = None
                ar.state = "setting"
                closed.append(ar.route.signal)
                self.log("signal", f"Сигнал {ar.route.signal} перекрыт на запрещающий: {problem}", level="alarm",
                         objects=[ar.route.signal], trains=[ar.train] if ar.train else [])
            elif ar.state == "setting" and not problem:
                ar.state = "set"
                self.sig_open[ar.route.signal] = rid
                self.log("signal", f"Открыт сигнал {ar.route.signal} по маршруту {rid}", objects=[ar.route.signal],
                         trains=[ar.train] if ar.train else [])
        return closed

    # ------------------------------------------------------------------ оборудование
    def apply_equipment(self) -> list[str]:
        """Пересчитывает работоспособность и переносит последствия на стрелки, сигналы и рельсовые цепи."""
        self.eq.evaluate()
        changes = []
        for sw_id, st in self.sw.items():
            d = self.eq.devices[f"СП-{sw_id}"]
            if d.health == "fault":
                new = "fault"
            elif d.health == "repair":
                new = "repairing"
            elif not d.operational:
                new = "unknown"
            elif st.state in ("fault", "repairing", "unknown"):
                new = "confirming"
                st.confirm_at = self.t + self.eq.control_confirm_s
            else:
                new = st.state
            if new != st.state:
                if st.state == "moving":
                    st.target = st.pos
                st.state = new
                if new != "confirming":
                    st.confirm_at = None
                changes.append(f"стрелка {sw_id} — {SW_STATE_RU[new]}")
        for sig in self.lamp_ok:
            ok = self.eq.devices[f"СВ-{sig}"].operational
            if ok != self.lamp_ok[sig]:
                self.lamp_ok[sig] = ok
                changes.append(f"светофор {sig} — {'горит' if ok else 'погашен'}")
        for sid in self.false_occ:
            bad = not self.eq.devices[f"РЦ-{sid}"].operational
            if bad != self.false_occ[sid]:
                self.false_occ[sid] = bad
                changes.append(f"участок {sid} — {'ложная занятость' if bad else 'контроль восстановлен'}")
        return changes

    def inject_fault(self, dev_id: str, note: str = "", repair_min: float | None = None, source: str = "") -> dict[str, Any]:
        d = self.eq.devices.get(dev_id)
        if not d:
            return {"ok": False, "message": f"неизвестное устройство {dev_id}"}
        if d.health != "ok":
            return {"ok": False, "message": f"{dev_id} уже {STATUS_RU[d.status]}"}
        note = note or (self.eq.fault_kinds.get(d.kind) or ["неисправность"])[0]
        was_degraded = {x.id for x in self.eq.devices.values() if x.degraded}
        d.health, d.fault_note, d.fault_t = "fault", note, self.t
        changes = self.apply_equipment()
        reserve = [x.id for x in self.eq.devices.values() if x.degraded and x.id not in was_degraded]
        closed = self._update_routes()
        affected = self._trains_affected(changes)
        self.log("fault", f"ОТКАЗ: {d.name} — {note}. Последствия: " + (_summarize(changes) if changes else
                 ("работа на резерве (" + ", ".join(reserve) + ")" if reserve else "без влияния на движение")),
                 level="alarm", objects=[dev_id], trains=affected, source=source)
        self.staff.create(self.t, dev_id, note, self._device_object(d), repair_min)
        rec = {"device": dev_id, "t_fault": self.t, "clock": self.clock(), "t_ban": self.t, "signals_closed": closed,
               "trains": affected, "checked": [], "ok": True}
        self.reactions.append(rec)
        if affected:
            self.pending_reactions.append(rec)
        return {"ok": True, "message": f"{dev_id}: отказ внесён", "changes": changes}

    def _device_object(self, d) -> str:
        if d.link:
            return {"switch": "стрелка", "signal": "светофор", "segment": "участок"}[d.link[0]] + f" {d.link[1]}"
        return d.name

    def _trains_affected(self, changes: list[str]) -> list[str]:
        objs = set()
        for c in changes:
            parts = c.split(" ")
            if len(parts) > 1:
                objs.add(parts[1])
        out = []
        for ar in self.routes.values():
            if ar.train and (objs & ar.sws or objs & ar.segs or ar.route.signal in objs):
                out.append(ar.train)
        return sorted(set(out))

    def _on_work_start(self, dev_id: str) -> None:
        d = self.eq.devices[dev_id]
        d.health = "repair"
        self.apply_equipment()
        self._update_routes()

    def _on_repaired(self, dev_id: str) -> None:
        d = self.eq.devices[dev_id]
        d.health, d.fault_note = "ok", ""
        changes = self.apply_equipment()
        self._update_routes()
        if changes:
            self.log("repair", f"После ремонта {dev_id}: " + _summarize(changes) + ". Перепланирование маршрутов.",
                     objects=[dev_id])

    # ------------------------------------------------------------------ шаг
    def step(self, dt: float = 1.0) -> None:
        self._run_script()
        self._switches()
        self.staff.step(self.t, self._on_work_start, self._on_repaired)
        self._update_routes()
        self._admit()
        if self.auto:
            self._dispatch()
        self._update_routes()
        for tr in sorted(self.trains.values(), key=lambda x: -x.priority):
            if tr.status in ("inbound", "outbound"):
                self._move(tr, dt)
        self._recompute_occ()
        self._operations(dt)
        self._account_delays(dt)
        self.staff.bonus.step(self.t + dt, dt)
        self.t += dt

    def _run_script(self) -> None:
        while self.script_i < len(self.script) and self._rel(self.script[self.script_i]["at"]) <= self.t:
            ev = self.script[self.script_i]
            self.script_i += 1
            res = self.command(dict(ev["cmd"]), source="сценарий")
            if not res.get("ok"):
                self.log("command", f"Сценарное событие не выполнено: {res.get('message')}", level="warn", source="сценарий")

    def _switches(self) -> None:
        for sw_id, st in self.sw.items():
            if st.state == "moving" and st.done_at is not None and self.t >= st.done_at:
                if st.target != st.pos and self.switch_occupant(sw_id):
                    self._violation(f"стрелка {sw_id} переведена под поездом {self.switch_occupant(sw_id)}")
                st.pos, st.state, st.done_at = st.target, "ok", None
            elif st.state == "confirming" and st.confirm_at is not None and self.t >= st.confirm_at:
                st.state, st.confirm_at = "ok", None
                self.log("switch", f"Стрелка {sw_id}: контроль восстановлен, положение {'плюсовое' if st.pos == '+' else 'минусовое'} подтверждено",
                         objects=[sw_id])

    # ------------------------------------------------------------------ приём с соседних станций
    def _admit(self) -> None:
        for tr in sorted(self.trains.values(), key=lambda x: (-x.priority, x.spawn_t)):
            if tr.status not in ("scheduled", "held") or self.t < tr.spawn_t:
                continue
            if tr.manual_hold:
                self._set_blockers(tr, [blocker("hold", "удержан диспетчером (ручная команда)", trains=[tr.id],
                                                waits="команда диспетчера «отпустить»")])
                tr.status = "held"
                continue
            cands, reasons = self.candidate_tracks(tr)
            if not cands:
                tr.status = "rejected"
                op_tracks = [s for s in reasons if tr.op in self.inf.segments[s].ops and self.inf.segments[s].gauge == tr.consist.gauge] \
                    or [s for s in reasons if tr.op in self.inf.segments[s].ops] or list(reasons)
                tr.reject_reasons = sorted({r for s in op_tracks for r in reasons[s]})
                self._set_blockers(tr, [blocker("reject", "отказ в приёме: " + "; ".join(tr.reject_reasons),
                                                trains=[tr.id], waits="изменение состава или назначение другой станции",
                                                persistent=True)], level="alarm")
                continue
            if tr.preferred and tr.preferred not in cands and not getattr(tr, "_pref_logged", False):
                tr._pref_logged = True  # type: ignore[attr-defined]
                self.log("dispatcher", f"Поезд {tr.id}: запрошенный путь {tr.preferred} не подходит — "
                         + "; ".join(reasons.get(tr.preferred, ["нет маршрута приёма"])), level="warn", trains=[tr.id],
                         objects=[tr.preferred])
            app = self.inf.approach_of(tr.frm)
            bl: list[dict[str, Any]] = []
            ab = self.segment_blocker(app, tr, None)
            if ab:
                bl.append(ab)
            free = [s for s in cands if s not in self.occ and not self.false_occ[s] and not self.track_holder(s, tr.id)]
            if not free:
                holders = sorted({h for s in cands if (h := self.occ.get(s) or self.track_holder(s, tr.id))})
                bl.append(blocker("notrack", "нет свободного пути приёма: " + ", ".join(
                    f"{s} — поезд {self.occ.get(s) or self.track_holder(s, tr.id)}" if (self.occ.get(s) or self.track_holder(s, tr.id))
                    else f"{s} — ложная занятость" for s in cands), objects=cands, trains=holders,
                    waits="освобождение пути приёма"))
            viable = []
            if free:
                for s in free:
                    r = self.entry_route(tr, s)
                    if r and not self.route_blockers(r, tr, persistent_only=True):
                        viable.append(s)
                if not viable:
                    r = self.entry_route(tr, free[0])
                    pb = self.route_blockers(r, tr, persistent_only=True) if r else []
                    for b in pb[:2]:
                        b = dict(b)
                        b["text"] = f"маршрут приёма {r.id} невозможен: {b['text']}"
                        bl.append(b)
            if bl:
                tr.status = "held"
                self._set_blockers(tr, bl)
                continue
            dest = viable[0]
            if tr.preferred and dest != tr.preferred and tr.preferred in cands:
                why = self.route_blockers(self.entry_route(tr, tr.preferred), tr, persistent_only=True) if tr.preferred in free else []
                self.log("dispatcher", f"Поезд {tr.id}: путь {tr.preferred} недоступен"
                         + (f" ({why[0]['text']})" if why else " (занят)") + f" — назначен путь {dest}", level="warn",
                         trains=[tr.id], objects=[tr.preferred, dest])
            self._spawn(tr, dest)

    def _spawn(self, tr: Train, dest: str) -> None:
        app = self.inf.approach_of(tr.frm)
        seg = self.inf.segments[app]
        tr.dir = self.inf.boundary_dir_in(tr.frm)
        tr.path, tr.head_off = [app], min(seg.length_m, tr.consist.length_m)
        tr.v = min(seg.vmax_kmh, tr.consist.vmax_kmh) / 3.6
        tr.dest, tr.status, tr.spawned_t = dest, "inbound", self.t
        self._set_blockers(tr, [])
        self.log("train", f"Поезд {tr.id} отправлен соседней станцией на перегон {app}, назначен путь {dest} "
                 f"({tr.consist.summary()['locos']}, {len(tr.consist.wagons)} ваг., {tr.consist.mass_t:.0f} т, "
                 f"{tr.consist.length_m:.0f} м)", trains=[tr.id], objects=[app, dest])
        self._recompute_occ()

    # ------------------------------------------------------------------ автодиспетчер
    def _dispatch(self) -> None:
        for tr in sorted(self.trains.values(), key=lambda x: (-x.priority, x.planned_depart_t)):
            if tr.status == "inbound" and not self._own_routes(tr):
                self._dispatch_entry(tr)
            elif tr.status == "ready":
                self._dispatch_exit(tr)

    def _own_routes(self, tr: Train) -> list[ActiveRoute]:
        return [ar for ar in self.routes.values() if ar.train == tr.id]

    def _dist_to_head_exit(self, tr: Train) -> float:
        return self.inf.segments[tr.head].length_m - tr.head_off

    def _dispatch_entry(self, tr: Train) -> None:
        seg = self.inf.segments[tr.head]
        if seg.kind != "approach" or self._dist_to_head_exit(tr) > ENTRY_REQUEST_M:
            return
        order = [tr.dest] + [s for s in self.candidate_tracks(tr)[0] if s != tr.dest]
        first_bl = None
        for track in order:
            r = self.entry_route(tr, track)
            if not r:
                continue
            bl = self.route_blockers(r, tr)
            if not bl:
                if track != tr.dest:
                    self.log("dispatcher", f"Поезд {tr.id}: путь {tr.dest} недоступен ({first_bl[0]['text'] if first_bl else 'занят'}) — "
                             f"объезд, назначен путь {track}", level="warn", trains=[tr.id], objects=[tr.dest, track])
                    tr.dest = track
                self.set_route(r, tr)
                self._set_blockers(tr, [])
                return
            if first_bl is None:
                first_bl = [dict(b, text=f"маршрут {r.id}: {b['text']}") for b in bl]
        self.counters["route_refused"] += 1 if first_bl and tr.block_sig != self._sig(first_bl) else 0
        self._set_blockers(tr, first_bl or [blocker("noroute", "нет маршрута приёма", trains=[tr.id])])

    def _dispatch_exit(self, tr: Train) -> None:
        if tr.depart_at is None or self.t < tr.depart_at:
            return
        if tr.manual_hold:
            self._set_blockers(tr, [blocker("hold", "удержан диспетчером (ручная команда)", trains=[tr.id],
                                            waits="команда диспетчера «отпустить»")])
            return
        r = self.exit_route(tr)
        if not r:
            self._set_blockers(tr, [blocker("noroute", "нет маршрута отправления с этого конца пути", trains=[tr.id], persistent=True)])
            return
        bl = self.route_blockers(r, tr)
        if not bl:
            yield_to = self._priority_conflict(tr, r)
            if yield_to:
                bl = [yield_to]
        if bl:
            if tr.block_sig != self._sig(bl):
                self.counters["route_refused"] += 1
            self._set_blockers(tr, [dict(b, text=f"маршрут {r.id}: {b['text']}") if b["key"] != "yield" else b for b in bl])
            return
        self.set_route(r, tr)
        self._set_blockers(tr, [])
        tr.status = "outbound"
        tr.depart_t = self.t
        late = (self.t - tr.planned_depart_t) / 60
        self.log("train", f"Поезд {tr.id} отправляется по маршруту {r.id}" + (f" (опоздание +{late:.0f} мин)" if late >= 1 else " (по графику)"),
                 trains=[tr.id], objects=[r.signal])

    def _priority_conflict(self, tr: Train, r: Route) -> dict[str, Any] | None:
        segs = set(r.segments)
        for other in self.trains.values():
            if other.id == tr.id or other.priority <= tr.priority:
                continue
            if other.status in ("scheduled", "held") and other.spawn_t <= self.t + PRIORITY_LOOKAHEAD_S:
                if self.inf.approach_of(other.frm) in segs:
                    return blocker("yield", f"пропуск приоритетного поезда {other.id} (пассажирский) — его приём через "
                                   f"{self.inf.approach_of(other.frm)} ожидается к {self.clock(max(self.t, other.spawn_t))}",
                                   trains=[other.id], waits=f"проследование поезда {other.id}")
            if other.status == "inbound" and not self._own_routes(other) and other.dest:
                er = self.entry_route(other, other.dest)
                if er and segs & set(er.segments):
                    return blocker("yield", f"пропуск приоритетного поезда {other.id} — маршрут его приёма {er.id} "
                                   f"пересекается с {r.id}", trains=[other.id], waits=f"приём поезда {other.id}")
        return None

    @staticmethod
    def _sig(bl: list[dict[str, Any]]) -> str:
        return bl[0]["key"] if bl else ""

    def _set_blockers(self, tr: Train, bl: list[dict[str, Any]], level: str = "warn") -> None:
        sig = self._sig(bl)
        tr.blockers = bl
        if sig != tr.block_sig:
            tr.block_sig = sig
            if bl:
                b = bl[0]
                more = f" (+{len(bl) - 1})" if len(bl) > 1 else ""
                verb = ":" if b["key"] == "reject" else " ожидает:"
                self.log("dispatcher", f"Поезд {tr.id}{verb} {b['text']}{more}" + (f". Ожидается: {b['waits']}" if b["waits"] else ""),
                         level=level, trains=[tr.id, *b["trains"]], objects=b["objects"])

    # ------------------------------------------------------------------ движение
    def _scan(self, tr: Train) -> tuple[float, list[tuple[float, float]], str | None]:
        cur = self.inf.segments[tr.head]
        d = tr.dir
        dist = cur.length_m - tr.head_off
        limits: list[tuple[float, float]] = []
        own = {rid for rid, ar in self.routes.items() if ar.train == tr.id}
        while dist < LOOKAHEAD_M:
            node = cur.exit(d)
            nk = self.inf.nodes[node]["kind"]
            if nk == "boundary":
                if tr.status == "outbound" and self.inf.boundary_of_node(node) == tr.to:
                    return dist + LOOKAHEAD_M, limits, None
                return max(0.0, dist - SIGNAL_MARGIN_M), limits, "граница станции"
            if nk == "buffer":
                return max(0.0, dist - BUFFER_MARGIN_M), limits, "упор тупика"
            sig = self.inf.signal_at.get((node, d))
            if sig and self.sig_open.get(sig) not in own:
                why = f"сигнал {sig} закрыт"
                waiting = [ar for ar in self.routes.values() if ar.route.signal == sig and ar.train == tr.id]
                if waiting:
                    p = self._route_open_problem(waiting[0])
                    why += f": маршрут {waiting[0].route.id} устанавливается" + (f" — {p}" if p else "")
                return max(0.0, dist - SIGNAL_MARGIN_M), limits, why
            sw_id = self.inf.switch_at.get(node)
            opts = self.inf.next_options(node, d, cur.id)
            nxt = None
            if sw_id:
                st = self.sw[sw_id]
                if st.state != "ok":
                    return max(0.0, dist - SIGNAL_MARGIN_M), limits, f"стрелка {sw_id}: {SW_STATE_RU[st.state]}"
                nxt = next((s for s, req in opts if req and req[1] == st.pos), None)
                if nxt is None:
                    return max(0.0, dist - SIGNAL_MARGIN_M), limits, f"стрелка {sw_id} не в положении для проследования"
            elif opts:
                nxt = opts[0][0]
            if nxt is None:
                return max(0.0, dist - SIGNAL_MARGIN_M), limits, "нет пути"
            if self.seg_lock.get(nxt) not in own:
                return max(0.0, dist - SIGNAL_MARGIN_M), limits, f"участок {nxt} не входит в маршрут поезда"
            if self.false_occ[nxt]:
                return max(0.0, dist - SIGNAL_MARGIN_M), limits, f"ложная занятость участка {nxt}"
            o = self.occ.get(nxt)
            if o and o != tr.id:
                return max(0.0, dist - SIGNAL_MARGIN_M), limits, f"участок {nxt} занят поездом {o}"
            nseg = self.inf.segments[nxt]
            limits.append((dist, nseg.vmax_kmh / 3.6))
            dist += nseg.length_m
            cur = nseg
        return dist, limits, None

    def _move(self, tr: Train, dt: float) -> None:
        stop_d, limits, reason = self._scan(tr)
        self._check_reaction(tr, stop_d, reason)
        freight = tr.kind != "passenger"
        acc, brk = (0.15, 0.35) if freight else (0.3, 0.5)
        vmax = tr.consist.vmax_kmh / 3.6
        for sid, _, _ in self.occ_list(tr):
            vmax = min(vmax, self.inf.segments[sid].vmax_kmh / 3.6)
        v_allow = vmax
        for d0, vl in limits:
            v_allow = min(v_allow, math.sqrt(vl * vl + 2 * brk * max(0.0, d0)))
        v_allow = min(v_allow, math.sqrt(2 * brk * max(0.0, stop_d)))
        if v_allow >= tr.v:
            v_new = min(v_allow, tr.v + acc * dt)
        else:
            v_new = max(v_allow, tr.v - EMERGENCY_BRAKE * dt)
        step = min((tr.v + v_new) / 2 * dt, stop_d)
        if stop_d - step < 0.5 and v_allow < 1.0:
            v_new = 0.0
        tr.v = v_new
        tr.stop_reason = reason if tr.v == 0 else None
        if step > 0:
            self._advance(tr, step)

    def _check_reaction(self, tr: Train, stop_d: float, reason: str | None) -> None:
        for rec in self.pending_reactions:
            if tr.id in rec["trains"] and tr.id not in [c["train"] for c in rec["checked"]]:
                brk_d = tr.v * tr.v / (2 * EMERGENCY_BRAKE)
                ok = brk_d <= stop_d + 0.5
                rec["checked"].append({"train": tr.id, "t": self.t, "stop_m": round(stop_d, 1), "v_kmh": round(tr.v * 3.6, 1),
                                       "brake_m": round(brk_d, 1), "reason": reason, "ok": ok})
                rec["ok"] = rec["ok"] and ok
                if not ok:
                    self.log("safety", f"Поезд {tr.id} не успевает остановиться перед {reason} (тормозной путь {brk_d:.0f} м > {stop_d:.0f} м)",
                             level="alarm", trains=[tr.id])
        self.pending_reactions = [r for r in self.pending_reactions if len(r["checked"]) < len(r["trains"])]

    def _advance(self, tr: Train, s: float) -> None:
        before = {sid for sid, _, _ in self.occ_list(tr)}
        tr.head_off += s
        while True:
            seg = self.inf.segments[tr.head]
            if tr.head_off <= seg.length_m + 1e-6:
                break
            node = seg.exit(tr.dir)
            if self.inf.nodes[node]["kind"] == "boundary":
                self._depart(tr)
                return
            over = tr.head_off - seg.length_m
            sw_id = self.inf.switch_at.get(node)
            opts = self.inf.next_options(node, tr.dir, seg.id)
            if sw_id:
                if self.sw[sw_id].state != "ok":
                    self._violation(f"поезд {tr.id} прошёл стрелку {sw_id} в состоянии «{SW_STATE_RU[self.sw[sw_id].state]}»")
                nxt = next(s2 for s2, req in opts if req and req[1] == self.sw[sw_id].pos)
            else:
                nxt = opts[0][0]
            tr.path.append(nxt)
            tr.head_off = over
            sig = self.inf.signal_at.get((node, tr.dir))
            if sig and self.sig_open.get(sig):
                rid = self.sig_open[sig]
                self.sig_open[sig] = None
                if rid in self.routes:
                    self.routes[rid].state = "passed"
        self._prune_path(tr)
        after = {sid for sid, _, _ in self.occ_list(tr)}
        for sid in before - after:
            self._release_segment(tr, sid)

    def _release_segment(self, tr: Train, sid: str) -> None:
        rid = self.seg_lock.get(sid)
        if not rid or rid not in self.routes or self.routes[rid].train != tr.id:
            return
        ar = self.routes[rid]
        del self.seg_lock[sid]
        ar.segs.discard(sid)
        for sw_id in list(ar.sws):
            sw = self.inf.switches[sw_id]
            adj = [x for x in (sw.stem, sw.normal, sw.reverse) if x in ar.route.segments]
            if not any(x in ar.segs for x in adj):
                ar.sws.discard(sw_id)
                if self.sw[sw_id].locked_by == rid:
                    self.sw[sw_id].locked_by = None
        if not ar.segs:
            self.release_route(rid, f"поезд {tr.id} проследовал (посекционное размыкание)")

    def _depart(self, tr: Train) -> None:
        for sid in list(self.seg_lock):
            rid = self.seg_lock[sid]
            if rid in self.routes and self.routes[rid].train == tr.id:
                del self.seg_lock[sid]
        for rid in [r for r, ar in self.routes.items() if ar.train == tr.id]:
            ar = self.routes[rid]
            ar.segs.clear()
            for sw_id in ar.sws:
                if self.sw[sw_id].locked_by == rid:
                    self.sw[sw_id].locked_by = None
            self.release_route(rid, f"поезд {tr.id} ушёл на перегон")
        tr.status, tr.left_t, tr.path, tr.v = "departed", self.t, [], 0.0
        tr.blockers, tr.block_sig = [], ""
        late = (tr.depart_t - tr.planned_depart_t) / 60 if tr.depart_t is not None else 0
        self.log("train", f"Поезд {tr.id} отправлен со станции на {self.inf.approach_of(tr.to)}; "
                 f"отклонение отправления {late:+.0f} мин", trains=[tr.id])

    # ------------------------------------------------------------------ операции на путях
    def _operations(self, dt: float) -> None:
        for tr in self.trains.values():
            if tr.status == "inbound" and tr.v == 0 and tr.head == tr.dest:
                occ = [s for s, _, _ in self.occ_list(tr)]
                if occ == [tr.dest]:
                    self._arrive(tr)
            if tr.status == "standing":
                self._do_op(tr, dt)

    def _arrive(self, tr: Train) -> None:
        tr.status, tr.arrive_t = "standing", self.t
        for ar in self._own_routes(tr):
            for sid in list(ar.segs):
                if self.seg_lock.get(sid) == ar.route.id:
                    del self.seg_lock[sid]
            ar.segs.clear()
            for sw_id in ar.sws:
                if self.sw[sw_id].locked_by == ar.route.id:
                    self.sw[sw_id].locked_by = None
            ar.sws.clear()
            self.release_route(ar.route.id, f"поезд {tr.id} прибыл на путь {tr.dest}")
        late = (self.t - tr.planned_arrive_t) / 60 if tr.planned_arrive_t is not None else 0
        self.log("train", f"Поезд {tr.id} прибыл на путь {tr.dest}" + (f" (опоздание +{late:.0f} мин)" if late >= 1 else " (по графику)")
                 + f"; операция: {OPS_RU.get(tr.op, tr.op)}", trains=[tr.id], objects=[tr.dest])
        if self._exit_dir(tr) != tr.dir:
            self._reverse(tr)

    def _reverse(self, tr: Train) -> None:
        seg = self.inf.segments[tr.path[0]]
        tail = tr.head_off - tr.consist.length_m if len(tr.path) == 1 else None
        if tail is None:
            return
        tr.path = list(reversed(tr.path))
        tr.dir = "W" if tr.dir == "E" else "E"
        tr.head_off = seg.length_m - tail
        tr.reversed_n += 1
        self.log("train", f"Поезд {tr.id}: смена направления на пути {tr.dest} (перецепка локомотива — упрощение)",
                 trains=[tr.id], objects=[tr.dest])

    def _do_op(self, tr: Train, dt: float) -> None:
        done = False
        if tr.op == "unloading":
            amount = self.tx_rate * dt / 3600
            for w in tr.consist.wagons:
                if amount <= 0:
                    break
                take = min(w.load_t, amount)
                w.load_t -= take
                amount -= take
                self.stock_t += take
                tr.unloaded_t += take
            done = tr.consist.load_t <= 0.01
        elif tr.op == "loading":
            amount = min(self.tx_rate * dt / 3600, self.stock_t)
            for w in tr.consist.wagons:
                if amount <= 0:
                    break
                put = min(w.model.capacity_t - w.load_t, amount)
                w.load_t += put
                amount -= put
                self.stock_t -= put
                tr.loaded_t += put
            done = tr.consist.capacity_t - tr.consist.load_t <= 0.01
            if not done:
                self._set_blockers(tr, self._cargo_blockers(tr) if self.stock_t < 1 else [])
        else:
            done = self.t >= (tr.arrive_t or 0) + tr.dwell_s
        if done:
            tr.status, tr.op_done_t = "ready", self.t
            self._set_blockers(tr, [])
            extra = {"unloading": f" (выгружено {tr.unloaded_t:.0f} т, запас склада {self.stock_t:.0f} т)",
                     "loading": f" (погружено {tr.loaded_t:.0f} т, масса состава {tr.consist.mass_t:.0f} т)"}.get(tr.op, "")
            self.log("train", f"Поезд {tr.id}: операция «{OPS_RU.get(tr.op, tr.op)}» завершена{extra}; "
                     f"отправление не ранее {self.clock(tr.depart_at)}", trains=[tr.id], objects=[tr.dest or ""])

    def _cargo_blockers(self, tr: Train) -> list[dict[str, Any]]:
        unl = [o for o in self.trains.values() if o.op == "unloading" and o.status == "standing"]
        if unl:
            return [blocker("cargo", f"ожидание груза: запас склада исчерпан, идёт выгрузка поезда {unl[0].id}",
                            trains=[o.id for o in unl], waits=f"выгрузка поезда {unl[0].id}")]
        nxt = [o for o in self.trains.values() if o.op == "unloading" and o.status in ("scheduled", "held", "inbound")]
        if nxt:
            o = min(nxt, key=lambda x: x.spawn_t)
            return [blocker("cargo", f"ожидание груза: поезд {o.id} под выгрузку ещё не прибыл ({STATUS_RU_TRAIN[o.status]})",
                            trains=[o.id], waits=f"прибытие и выгрузка поезда {o.id}")]
        return [blocker("cargo", "ожидание груза: поездов под выгрузку нет", trains=[], waits="поступление груза")]

    def _account_delays(self, dt: float) -> None:
        for tr in self.trains.values():
            key = None
            if tr.status == "held" and self.t >= tr.spawn_t:
                key = tr.blockers[0]["key"] if tr.blockers else "held"
                txt = tr.blockers[0]["text"] if tr.blockers else "удержание"
            elif tr.status in ("inbound", "outbound") and tr.v == 0:
                txt = tr.stop_reason or (tr.blockers[0]["text"] if tr.blockers else "остановка")
                key = (tr.blockers[0]["key"] if tr.blockers else txt)
            elif tr.status in ("standing", "ready") and self.t >= tr.planned_depart_t:
                if tr.blockers:
                    key, txt = tr.blockers[0]["key"], tr.blockers[0]["text"]
                elif tr.status == "standing":
                    key = txt = f"операция «{OPS_RU.get(tr.op, tr.op)}» не завершена"
                else:
                    key = txt = "ожидание маршрута отправления"
            if key:
                label = _delay_label(key, txt)
                tr.delay[label] = tr.delay.get(label, 0.0) + dt

    # ------------------------------------------------------------------ команды
    def command(self, cmd: dict[str, Any], source: str = "диспетчер") -> dict[str, Any]:
        kind = cmd.get("type")
        try:
            handler = getattr(self, f"_cmd_{kind}")
        except AttributeError:
            return {"ok": False, "message": f"неизвестная команда {kind}"}
        res = handler(cmd, source)
        manual = source != "сценарий" and kind in ("set_route", "throw_switch", "cancel_route")
        if manual:
            self.counters["manual_ok" if res.get("ok") else "manual_refused"] += 1
        if not res.get("ok") and res.get("blockers"):
            self.log("command", f"Команда отклонена ({source}): {res['message']} — " + "; ".join(b["text"] for b in res["blockers"]),
                     level="warn", source=source, objects=[o for b in res["blockers"] for o in b["objects"]],
                     trains=[x for b in res["blockers"] for x in b["trains"]])
        return res

    def _cmd_fault(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        return self.inject_fault(str(cmd["device"]), cmd.get("note", ""), cmd.get("repair_min"), source)

    def _cmd_delay(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        tr = self.trains.get(str(cmd["train"]))
        if not tr or tr.status not in ("scheduled", "held"):
            return {"ok": False, "message": "задержать можно только поезд, ещё не принятый на станцию"}
        mins = float(cmd["minutes"])
        tr.spawn_t += mins * 60
        label = cmd.get("note") or "задержка на подходе"
        tr.delay[label] = tr.delay.get(label, 0.0) + mins * 60
        self.log("train", f"Поезд {tr.id}: {label} +{mins:.0f} мин, ожидаемое прибытие сдвинуто", level="warn",
                 trains=[tr.id], source=source)
        return {"ok": True, "message": f"поезд {tr.id} задержан на {mins:.0f} мин"}

    def _cmd_add_loco(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        tr = self.trains.get(str(cmd["train"]))
        if not tr:
            return {"ok": False, "message": "нет такого поезда"}
        model = cmd.get("model", tr.consist.locos[0].model.id)
        fleet = Fleet(self.cat, hash(tr.id) % 10_000 + len(tr.consist.locos), self.date)
        tr.consist.locos.append(fleet.loco(model))
        grade = float(self.inf.boundaries[tr.to].get("grade_permille", 0))
        allowed = tr.consist.allowed_mass_t(grade, self.cat.loco_w0)
        self.log("train", f"Поезд {tr.id}: {cmd.get('note', 'прицеплен дополнительный локомотив')} — "
                 f"{tr.consist.summary()['locos']}, допустимая масса {allowed:.0f} т при фактической {tr.consist.wagons_mass_t:.0f} т",
                 trains=[tr.id], source=source)
        return {"ok": True, "message": "локомотив добавлен"}

    def _cmd_set_route(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        r = self.inf.routes.get(str(cmd.get("route")))
        if not r:
            return {"ok": False, "message": f"нет маршрута {cmd.get('route')}"}
        tr = self.trains.get(str(cmd["train"])) if cmd.get("train") else self._train_before(r)
        bl = self.set_route(r, tr, manual=True)
        if bl:
            return {"ok": False, "message": f"маршрут {r.id} не может быть установлен", "blockers": bl}
        if tr and tr.status == "ready" and r.kind == "exit":
            tr.status, tr.depart_t = "outbound", self.t
        return {"ok": True, "message": f"маршрут {r.id} установлен" + (f" для поезда {tr.id}" if tr else "")}

    def _train_before(self, r: Route) -> Train | None:
        for tr in self.trains.values():
            if tr.on_graph and self._train_at_route_start(tr, r):
                return tr
        return None

    def _cmd_cancel_route(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        rid = str(cmd.get("route"))
        ar = self.routes.get(rid)
        if not ar:
            return {"ok": False, "message": f"маршрут {rid} не установлен"}
        if ar.state == "passed":
            return {"ok": False, "message": f"маршрут {rid} нельзя отменить", "blockers": [
                blocker("passed", f"поезд {ar.train} уже проследовал сигнал {ar.route.signal}", trains=[ar.train or ""],
                        waits="посекционное размыкание после проследования")]}
        self.release_route(rid, f"отменён ({source})")
        tr = self.trains.get(ar.train or "")
        if tr and tr.status == "outbound" and tr.head and self.inf.segments[tr.head].kind == "track":
            tr.status, tr.depart_t = "ready", None
        return {"ok": True, "message": f"маршрут {rid} отменён"}

    def _cmd_throw_switch(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        sw_id = str(cmd.get("switch"))
        if sw_id not in self.sw:
            return {"ok": False, "message": f"нет стрелки {sw_id}"}
        st = self.sw[sw_id]
        want = cmd.get("pos") or ("-" if st.pos == "+" else "+")
        want = "+" if want in ("+", "plus", "normal") else "-"
        b = self.switch_blocker(sw_id, want, None)
        if b is None and st.locked_by:
            b = blocker(f"sw{sw_id}:locked", f"стрелка {sw_id} замкнута в маршруте {st.locked_by}", objects=[sw_id])
        if b is None and want == st.pos and st.state == "ok":
            return {"ok": True, "message": f"стрелка {sw_id} уже в положении {want}"}
        if b:
            return {"ok": False, "message": f"перевод стрелки {sw_id} запрещён", "blockers": [b]}
        self._start_throw(sw_id, want)
        self.log("switch", f"Стрелка {sw_id}: перевод в {'плюсовое' if want == '+' else 'минусовое'} положение ({source})",
                 objects=[sw_id], source=source)
        return {"ok": True, "message": f"стрелка {sw_id} переводится"}

    def _cmd_hold(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        tr = self.trains.get(str(cmd.get("train")))
        if not tr:
            return {"ok": False, "message": "нет такого поезда"}
        tr.manual_hold = bool(cmd.get("on", True))
        self.log("command", f"Поезд {tr.id}: {'удержание' if tr.manual_hold else 'удержание снято'} ({source})",
                 trains=[tr.id], source=source)
        if not tr.manual_hold:
            self._set_blockers(tr, [])
        return {"ok": True, "message": "ок"}

    def _cmd_restore(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        """Мгновенное восстановление (для отладки сценариев); обычный путь — ремонтная задача."""
        dev = str(cmd.get("device"))
        if dev not in self.eq.devices:
            return {"ok": False, "message": f"неизвестное устройство {dev}"}
        task = self.staff.open_task(dev)
        self._on_repaired(dev)
        if task:
            w = self.staff.workers.get(task.worker or "")
            if w and w.task == task.id:
                w.task = None
            task.phase, task.finished_t, task.result = "done", self.t, f"восстановлено командой ({source})"
        return {"ok": True, "message": f"{dev} восстановлено"}

    def _cmd_auto(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        self.auto = bool(cmd.get("on", True))
        self.log("command", f"Автодиспетчер {'включён' if self.auto else 'выключен — маршруты задаёт диспетчер вручную'}", source=source)
        return {"ok": True, "message": "ок"}

    def _cmd_bonus_config(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        changed = self.staff.bonus.configure(cmd.get("cfg", {}))
        if changed:
            self.log("bonus", "Изменены параметры премирования: " + "; ".join(changed), source=source)
        return {"ok": True, "message": "; ".join(changed) or "без изменений"}

    def _cmd_repair_config(self, cmd: dict[str, Any], source: str) -> dict[str, Any]:
        cfg = self.staff.repair_cfg
        changed = []
        for k in ("default_duration_min", "travel_min", "verify_min"):
            if k in cmd.get("cfg", {}):
                old, cfg[k] = cfg[k], float(cmd["cfg"][k])
                changed.append(f"{k}: {old} → {cfg[k]}")
        if changed:
            self.log("repair", "Изменены параметры ремонта: " + "; ".join(changed), source=source)
        return {"ok": True, "message": "; ".join(changed) or "без изменений"}

    # ------------------------------------------------------------------ представления
    def train_view(self, tr: Train) -> dict[str, Any]:
        s = tr.consist.summary()
        arr_delay = ((tr.arrive_t - tr.planned_arrive_t) / 60) if (tr.arrive_t is not None and tr.planned_arrive_t is not None) else None
        dep_delay = ((tr.depart_t - tr.planned_depart_t) / 60) if tr.depart_t is not None else None
        exp_dep = tr.depart_at
        waiting_for = sorted({x for b in tr.blockers for x in b["trains"] if x != tr.id})
        return {
            "id": tr.id, "kind": tr.kind, "status": tr.status, "status_ru": STATUS_RU_TRAIN[tr.status],
            "frm": tr.frm, "to": tr.to, "op": tr.op, "op_ru": OPS_RU.get(tr.op, tr.op), "dest": tr.dest,
            "preferred": tr.preferred, "dir": tr.dir, "v_kmh": round(tr.v * 3.6, 1),
            "occ": [[s_, round(a, 1), round(b, 1)] for s_, a, b in self.occ_list(tr)] if tr.on_graph else [],
            "head": tr.head, "head_off": round(tr.head_off, 1),
            "plan": {"arrive": self.clock(tr.planned_arrive_t) if tr.planned_arrive_t is not None else None,
                     "depart": self.clock(tr.planned_depart_t), "dwell_min": tr.dwell_s / 60},
            "actual": {"spawned": self.clock(tr.spawned_t) if tr.spawned_t is not None else None,
                       "arrive": self.clock(tr.arrive_t) if tr.arrive_t is not None and tr.planned_arrive_t is not None else None,
                       "depart": self.clock(tr.depart_t) if tr.depart_t is not None else None,
                       "expected_depart": self.clock(exp_dep) if exp_dep is not None and tr.depart_t is None else None},
            "arr_delay_min": round(arr_delay, 1) if arr_delay is not None else None,
            "dep_delay_min": round(dep_delay, 1) if dep_delay is not None else None,
            "delay_reasons": [{"reason": k, "min": round(v / 60, 1)} for k, v in sorted(tr.delay.items(), key=lambda kv: -kv[1]) if v >= 30],
            "blockers": tr.blockers, "stop_reason": tr.stop_reason, "waiting_for": waiting_for,
            "consist": s, "manual_hold": tr.manual_hold, "reject_reasons": tr.reject_reasons,
            "load_pct": round(100 * tr.consist.load_t / tr.consist.capacity_t, 0) if tr.consist.capacity_t else None,
            "routes": [ar.route.id for ar in self._own_routes(tr)],
        }

    def frame(self, since_seq: int = 0) -> dict[str, Any]:
        return {
            "t": round(self.t, 1), "clock": self.clock(), "date": self.date.isoformat(), "scenario": self.scn.get("id"),
            "auto": self.auto, "stock_t": round(self.stock_t, 1),
            "trains": [self.train_view(tr) for tr in self.trains.values()],
            "switches": {k: {"pos": v.pos, "target": v.target, "state": v.state, "state_ru": SW_STATE_RU[v.state],
                             "locked_by": v.locked_by, "occupied": self.switch_occupant(k)} for k, v in self.sw.items()},
            "signals": {k: {"open": bool(self.sig_open[k]), "route": self.sig_open[k], "dark": not self.lamp_ok[k]}
                        for k in self.sig_open},
            "segments": {sid: {"occ": self.occ.get(sid), "lock": self.seg_lock.get(sid), "false": self.false_occ[sid]}
                         for sid in self.inf.segments
                         if sid in self.occ or sid in self.seg_lock or self.false_occ[sid]},
            "routes": [{"id": rid, "train": ar.train, "state": ar.state, "manual": ar.manual, "segs": sorted(ar.segs),
                        "problem": self._route_open_problem(ar) if ar.state == "setting" else None}
                       for rid, ar in self.routes.items()],
            "devices": self.eq.state(),
            "staff": self.staff.view(),
            "bonus": self.staff.bonus.view(),
            "kpi": self.kpi(),
            "reactions": self.reactions[-10:],
            "events": [e for e in self.events if e["seq"] > since_seq][-200:],
            "seq": self.seq,
        }

    def kpi(self) -> dict[str, Any]:
        trs = list(self.trains.values())
        departed = [t for t in trs if t.status == "departed"]
        arrived = [t for t in trs if t.arrive_t is not None and t.planned_arrive_t is not None]
        dep_delays = [max(0.0, (t.depart_t - t.planned_depart_t) / 60) for t in trs if t.depart_t is not None]
        arr_delays = [max(0.0, (t.arrive_t - t.planned_arrive_t) / 60) for t in arrived]
        done = [x for x in self.staff.tasks.values() if x.phase == "done" and x.finished_t is not None]
        devs = list(self.eq.devices.values())
        return {
            "trains": len(trs), "departed": len(departed),
            "in_station": sum(1 for t in trs if t.on_graph), "held": sum(1 for t in trs if t.status == "held"),
            "rejected": sum(1 for t in trs if t.status == "rejected"),
            "avg_arr_delay_min": round(sum(arr_delays) / len(arr_delays), 1) if arr_delays else 0.0,
            "avg_dep_delay_min": round(sum(dep_delays) / len(dep_delays), 1) if dep_delays else 0.0,
            "wait_min": round(sum(sum(t.delay.values()) for t in trs) / 60, 1),
            "routes_set": self.counters["route_set"], "route_refusals": self.counters["route_refused"],
            "manual_ok": self.counters["manual_ok"], "manual_refused": self.counters["manual_refused"],
            "throws": self.counters["throws"],
            "unloaded_t": round(sum(t.unloaded_t for t in trs)), "loaded_t": round(sum(t.loaded_t for t in trs)),
            "active_faults": sum(1 for d in devs if d.health != "ok"),
            "open_tasks": sum(1 for x in self.staff.tasks.values() if x.phase != "done"),
            "mttr_min": round(sum((x.finished_t - x.created_t) / 60 for x in done) / len(done), 1) if done else None,
            "availability_pct": round(100 * sum(1 for d in devs if d.operational) / len(devs), 1),
            "safety_violations": len(self.violations),
            "reaction_ok": all(r["ok"] for r in self.reactions),
            "reaction_max_s": max((r["t_ban"] - r["t_fault"] for r in self.reactions), default=0.0),
        }

    def card(self, kind: str, oid: str) -> dict[str, Any] | None:
        if kind == "train" and oid in self.trains:
            tr = self.trains[oid]
            c = tr.consist
            grade = float(self.inf.boundaries[tr.to].get("grade_permille", 0))
            return self.train_view(tr) | {
                "locos": [lc.card() | {"model_card": self._model_card("loco", lc.model.id)} for lc in c.locos],
                "wagons": [w.card() for w in c.wagons],
                "mass_check": {"grade_permille": grade, "allowed_t": round(c.allowed_mass_t(grade, self.cat.loco_w0)),
                               "actual_t": round(c.wagons_mass_t),
                               "formula": "Q = (n·Fк/g − P·(w0' + i)) / (w0'' + i), демо по мотивам ПТР"},
                "acceptance": {s.id: self.acceptance(tr, s.id) for s in self.inf.tracks},
            }
        if kind == "segment" and oid in self.inf.segments:
            seg = self.inf.segments[oid]
            return {"kind": "segment", "id": oid, "static": _seg_static(seg), "occ": self.occ.get(oid),
                    "lock": self.seg_lock.get(oid), "false": self.false_occ[oid],
                    "equipment": self._chain_view(("segment", oid)),
                    "routes": [r.id for r in self.inf.routes.values() if oid in r.segments]}
        if kind == "switch" and oid in self.sw:
            st = self.sw[oid]
            sd = self.inf.switches[oid]
            return {"kind": "switch", "id": oid, "node": sd.node, "stem": sd.stem, "normal": sd.normal, "reverse": sd.reverse,
                    "pos": st.pos if st.state in ("ok", "moving") else None, "commanded": st.target, "state": st.state,
                    "state_ru": SW_STATE_RU[st.state], "locked_by": st.locked_by, "occupied": self.switch_occupant(oid),
                    "throw_s": self.throw_s, "throws": st.throws,
                    "last_throw": self.clock(st.last_throw_t) if st.last_throw_t is not None else None,
                    "equipment": self._chain_view(("switch", oid)),
                    "routes": [r.id for r in self.inf.routes.values() if oid in r.switch_map]}
        if kind == "signal" and oid in self.sig_open:
            sd = self.inf.signals[oid]
            return {"kind": "signal", "id": oid, "name": sd.name, "node": sd.node, "dir": sd.dir, "type": sd.kind,
                    "open": bool(self.sig_open[oid]), "route": self.sig_open[oid], "dark": not self.lamp_ok[oid],
                    "equipment": self._chain_view(("signal", oid)),
                    "routes": [r.id for r in self.inf.routes.values() if r.signal == oid]}
        if kind == "device" and oid in self.eq.devices:
            d = self.eq.devices[oid]
            task = self.staff.open_task(oid)
            return {"kind": "device", **d.static(), "status": d.status, "status_ru": STATUS_RU[d.status],
                    "health": d.health, "note": d.fault_note, "cause": d.cause, "dependents": self.eq.dependents(oid),
                    "responsible": self.staff.responsible(oid), "task": task.view() if task else None,
                    "history": [x.view() for x in self.staff.tasks.values() if x.device == oid]}
        if kind == "worker" and oid in self.staff.workers:
            w = self.staff.workers[oid]
            acc = self.staff.bonus.accounts[oid]
            return {"kind": "worker", **w.view(), "devices": acc.devices, "balance": round(acc.balance, 2),
                    "ledger": [e for e in self.staff.bonus.ledger if e["worker"] == oid][-50:][::-1],
                    "tasks": [x.view() for x in self.staff.tasks.values() if x.worker == oid]}
        if kind in ("loco", "wagon"):
            return self._model_card(kind, oid)
        return None

    def _model_card(self, kind: str, mid: str) -> dict[str, Any] | None:
        m = (self.cat.locos if kind == "loco" else self.cat.wagons).get(mid)
        if not m:
            return None
        out = dict(m.__dict__)
        if kind == "wagon":
            out["type_ru"] = TYPE_RU.get(m.type, m.type)
        return out

    def _chain_view(self, link: tuple[str, str]) -> list[dict[str, Any]]:
        return [{"id": i, "name": self.eq.devices[i].name, "kind": self.eq.devices[i].kind,
                 "status": self.eq.devices[i].status, "status_ru": STATUS_RU[self.eq.devices[i].status]}
                for i in self.eq.chain(link)]


def _seg_static(seg: Segment) -> dict[str, Any]:
    return {"name": seg.name or seg.id, "kind": seg.kind, "length_m": seg.length_m, "vmax_kmh": seg.vmax_kmh,
            "gauge": seg.gauge, "ops_ru": [OPS_RU.get(o, o) for o in seg.ops], "platform": seg.platform,
            "restrictions": list(seg.restrictions), "park": seg.park}


def _summarize(changes: list[str]) -> str:
    """«стрелка 2 — X; стрелка 4 — X» → «стрелки 2, 4 — X»."""
    plural = {"стрелка": "стрелки", "светофор": "светофоры", "участок": "участки"}
    groups: dict[tuple[str, str], list[str]] = {}
    for c in changes:
        head, _, what = c.partition(" — ")
        noun, _, oid = head.partition(" ")
        groups.setdefault((noun, what), []).append(oid)
    parts = []
    for (noun, what), ids in groups.items():
        name = plural.get(noun, noun) if len(ids) > 1 else noun
        parts.append(f"{name} {', '.join(ids)} — {what}")
    return "; ".join(parts)


def _delay_label(key: str, text: str) -> str:
    """Стабильная подпись причины задержки (без меняющихся чисел)."""
    if key == "cargo":
        return "ожидание груза (зависимость от выгрузки 1435)"
    if key == "yield":
        return "пропуск приоритетного поезда"
    if key == "notrack":
        return "нет свободного пути приёма"
    if key == "mass":
        return "превышение допустимой массы — ожидание кратной тяги"
    if key == "hold":
        return "удержание диспетчером"
    if key == "reject":
        return "отказ в приёме"
    if ":" in key and key.startswith("sw"):
        sw, st = key[2:].split(":", 1)
        return {"unknown": f"стрелка {sw}: нет контроля", "fault": f"стрелка {sw}: неисправность",
                "repairing": f"стрелка {sw}: ремонт", "confirming": f"стрелка {sw}: восстановление контроля",
                "locked": f"стрелка {sw} занята другим маршрутом", "under": f"стрелка {sw} под поездом",
                "moving": f"стрелка {sw}: перевод"}.get(st, text)
    if key.startswith("seg"):
        sid, st = key[3:].split(":", 1)
        return {"false": f"ложная занятость {sid}", "occ": f"участок {sid} занят", "locked": f"участок {sid} в другом маршруте",
                "gauge": f"колея участка {sid}"}.get(st, text)
    if key.startswith("sig"):
        return f"погашен светофор {key[3:].split(':')[0]}"
    if key.startswith("track"):
        return f"путь {key[5:].split(':')[0]} занят"
    return text.split(":")[0][:80]
