/**
 * Демо-режим без сервера: маленький локальный «симулятор» поверх реальных payload-ов из docs/samples.
 * Отдаёт те же сообщения (hello/frame/plan/variants/events) через тот же обработчик, что и WebSocket,
 * и отвечает на REST-вызовы. Поэтому весь UI работает идентично онлайн-режиму.
 */
import helloJson from '../mock/hello.json';
import frameJson from '../mock/frame.json';
import planJson from '../mock/plan.json';
import variantsJson from '../mock/variants.json';
import eventsJson from '../mock/events.json';
import type {
  Assignment,
  Frame,
  HelloMsg,
  IndexConfig,
  IndexFactor,
  IndexValue,
  Kpi,
  Plan,
  PlannerConfig,
  ServerMsg,
  SimEvent,
  TimelinePoint,
  Train,
  TrainCat,
  UpcomingTrain,
  VariantsMsg,
  WorldState,
  Incident,
  RecommendationAction,
} from '../types';
import { clock } from '../utils/time';

type Emit = (m: ServerMsg) => void;
type StatusCb = (s: { status: 'connecting' | 'online' | 'reconnecting' | 'offline'; attempt: number; retryAt: number | null }) => void;

const clone = <T>(x: T): T => (typeof structuredClone === 'function' ? structuredClone(x) : JSON.parse(JSON.stringify(x)));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

const APPROACH_M = 15000;
const ENTER_S = 120;
const DEPART_S = 120;
const THROAT_S = 180;

class MockServer {
  private emit: Emit | null = null;
  private onStatus: StatusCb | null = null;
  private timer: number | null = null;
  private dropTimer: number | null = null;
  private dropped = false;

  private hello: HelloMsg = clone(helloJson as unknown as HelloMsg);
  private indexCfg: IndexConfig = clone(this.hello.index_config);
  private plannerCfg: PlannerConfig = clone(this.hello.planner_config);
  private state: WorldState = clone((frameJson as unknown as Frame).state);
  private plan: Plan = clone((planJson as unknown as { plan: Plan }).plan);
  private variants: VariantsMsg | null = null;
  private seq = 1000;
  private timeScale = 20;
  private stressUntil = 0;
  private lastPlanAt = 0;
  private noise = { wait: 0, dev: 0 };
  private extraDeparted = 11;
  private nextId = 4000;
  private frames: { ts: number; frame: Frame; plan: Plan }[] = [];
  private synthetic: TimelinePoint[] = [];
  private lastFrame: Frame | null = null;

  /* ---------------- lifecycle ---------------- */
  start(emit: Emit, onStatus: StatusCb) {
    this.emit = emit;
    this.onStatus = onStatus;
    if (!this.synthetic.length) this.buildSynthetic();
    // перед стартом «прогоняем» мини-симуляцию на 40 с, чтобы в истории/спарклайнах были данные
    this.connect();
  }

  stop() {
    if (this.timer != null) window.clearTimeout(this.timer);
    if (this.dropTimer != null) window.clearTimeout(this.dropTimer);
    this.timer = this.dropTimer = null;
    this.emit = null;
  }

  reconnectNow() {
    if (this.dropped) this.endDrop();
  }

  /** Демонстрация обрыва связи: сообщения перестают приходить на `ms`. */
  simulateDrop(ms = 14000) {
    if (this.dropped || !this.emit) return;
    this.dropped = true;
    const started = Date.now();
    let attempt = 0;
    const step = () => {
      if (!this.dropped) return;
      const elapsed = Date.now() - started;
      if (elapsed >= ms) {
        this.endDrop();
        return;
      }
      if (elapsed < 6000) {
        this.dropTimer = window.setTimeout(step, 6000 - elapsed);
        return;
      }
      attempt += 1;
      const delay = Math.min(30000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
      this.onStatus?.({ status: attempt > 6 ? 'offline' : 'reconnecting', attempt, retryAt: Date.now() + delay });
      this.dropTimer = window.setTimeout(step, delay);
    };
    this.dropTimer = window.setTimeout(step, 100);
  }

  private endDrop() {
    if (this.dropTimer != null) window.clearTimeout(this.dropTimer);
    this.dropTimer = null;
    this.dropped = false;
    this.connect();
  }

  private connect() {
    this.onStatus?.({ status: 'connecting', attempt: 0, retryAt: null });
    window.setTimeout(() => {
      if (!this.emit) return;
      this.onStatus?.({ status: 'online', attempt: 0, retryAt: null });
      this.send({ ...this.hello, index_config: this.indexCfg, planner_config: this.plannerCfg, time_scale: this.timeScale });
      this.send({ type: 'plan', plan: this.plan });
      if (this.variants) this.send(this.variants);
      if (!this.lastFrame) this.send(clone(eventsJson as unknown as ServerMsg));
      this.send(this.makeFrame());
      if (this.timer == null) this.loop();
    }, 350);
  }

  private send(m: ServerMsg) {
    if (!this.dropped && this.emit) this.emit(m);
  }

  private loop = () => {
    const stress = Date.now() < this.stressUntil;
    const intervalMs = stress ? 100 : 500;
    this.tick((intervalMs / 1000) * this.timeScale, stress);
    this.timer = window.setTimeout(this.loop, intervalMs);
  };

  /* ---------------- симуляция ---------------- */
  private tick(dt: number, stress: boolean) {
    const s = this.state;
    s.sim_time += dt;
    const now = s.sim_time;
    const events: SimEvent[] = [];
    const ev = (type: string, text: string, extra: Partial<SimEvent> = {}) =>
      events.push({ t: Math.round(now), type, text, world: 'ai', ...extra });

    // спавн поездов графика на подход
    const spawnLead = APPROACH_M / (60 / 3.6);
    for (const u of [...s.upcoming]) {
      if (now >= u.eta - spawnLead) {
        s.upcoming = s.upcoming.filter((x) => x.id !== u.id);
        const a = this.ensureAssignment(u);
        const t = this.trainFromUpcoming(u, a);
        s.trains.push(t);
        ev('spawn', `Поезд №${t.id} на подходе (${t.side_in})`, { train: t.id });
      }
    }
    if (s.upcoming.length < 12) this.generateUpcoming();

    // открытие закрытых путей по истечении срока
    for (const tr of s.tracks) {
      if (tr.status === 'closed' && tr.closed_until != null && now >= tr.closed_until) {
        tr.status = tr.train ? 'occupied' : 'free';
        tr.closed_until = null;
        ev('incident_end', `Путь ${tr.id} открыт после закрытия`, { track: tr.id });
      }
    }

    const trackOf = (id: string | null) => s.tracks.find((t) => t.id === id);
    for (const t of s.trains) {
      const a = this.plan.assignments[t.id];
      switch (t.status) {
        case 'held':
        case 'approaching': {
          if ((t.hold_until ?? 0) > now) {
            t.status = 'held';
            t.speed_kmh = 0;
            t.reason = 'hold';
            t.reason_text = 'удержан на предыдущей станции до слота';
            break;
          }
          if (t.status === 'held') t.status = 'approaching';
          if (a?.entry_at != null && a.entry_at > now + 30) {
            const need = (t.pos_m / Math.max(30, a.entry_at - now)) * 3.6;
            const v = clamp(need, 15, 80);
            t.regulated = v < 59;
            t.advisory_kmh = t.regulated ? round1(v) : null;
            t.speed_kmh = round1(v);
            t.reason = t.regulated ? 'slot' : null;
            t.reason_text = t.regulated ? 'регулирование: вход по слоту' : null;
            t.eta = Math.round(now + (t.pos_m / v) * 3.6);
          } else if (!t.speed_kmh) {
            t.speed_kmh = 60;
          }
          t.pos_m = Math.max(0, t.pos_m - (t.speed_kmh / 3.6) * dt);
          if (t.pos_m <= 0) this.tryEnter(t, now, ev, true);
          break;
        }
        case 'at_signal':
          this.tryEnter(t, now, ev, false);
          break;
        case 'entering':
          if (t.entered_at != null && now - t.entered_at >= ENTER_S) {
            t.status = 'on_track';
            t.reason = 'service';
            t.reason_text = 'техобслуживание';
          }
          break;
        case 'on_track': {
          const done = t.service_done_at ?? (t.entered_at ?? now) + (t.service_s ?? 900);
          const dep = Math.max(done, a?.dep_at ?? t.planned_dep, (t.entered_at ?? now) + 300);
          if (now < done) {
            t.reason = 'service';
            t.reason_text = 'техобслуживание';
          } else if (now < dep) {
            t.reason = 'schedule';
            t.reason_text = t.cat === 'pass' ? 'ожидает время по графику' : 'ожидает локомотив/бригаду';
            t.ready_at = t.ready_at ?? Math.round(done);
          } else {
            t.status = 'departing';
            t.departed_at = Math.round(now);
            t.reason = null;
            t.reason_text = null;
            const ladderId = this.ladderFor(t.track, t.side_out);
            if (ladderId) this.busyLadder(ladderId, now + THROAT_S, t.id);
          }
          break;
        }
        case 'departing':
          if (t.departed_at != null && now - t.departed_at >= DEPART_S) {
            t.status = 'departed';
            const tr = trackOf(t.track);
            if (tr && tr.train === t.id) {
              tr.train = null;
              if (tr.status === 'occupied') tr.status = 'free';
            }
            this.extraDeparted += 0;
            const dev = Math.max(0, Math.round(((t.departed_at ?? now) - t.planned_dep) / 60));
            ev('depart', `Поезд №${t.id} отправлен с пути ${t.track}${dev > 2 ? ` (откл. ${dev} мин)` : ''}`, {
              train: t.id,
              track: t.track ?? undefined,
            });
          }
          break;
        default:
          break;
      }
    }
    // убираем давно ушедшие поезда
    s.trains = s.trains.filter((t) => !(t.status === 'departed' && (t.departed_at ?? 0) < now - 2400) && t.status !== 'rerouted');
    s.ladders = s.ladders.filter((l) => l.busy_until > now);
    for (const r of [...s.locos, ...s.crews]) {
      if (r.until != null && r.until <= now && r.status !== 'available' && r.status !== 'failed') {
        r.status = 'available';
        r.train = null;
      }
    }

    if (stress) {
      const ids = s.trains.map((t) => t.id);
      for (let i = 0; i < 3; i++) {
        const id = ids[Math.floor(Math.random() * ids.length)];
        ev('telemetry', `Телеметрия: обновлена позиция поезда №${id}`, { train: id });
      }
    }
    if (Math.random() < 0.04) {
      const atSignal = Math.floor(rnd(1, 4));
      events.push({
        t: Math.round(now),
        type: 'signal_stop',
        world: 'baseline',
        text: `FCFS: у входного сигнала стоят ${atSignal} поезд${atSignal > 1 ? 'а' : ''}`,
        severity: 'medium',
      });
    }

    this.computeKpi();
    if (events.length) this.send({ type: 'events', events });

    // периодический перерасчёт плана
    if (Date.now() - this.lastPlanAt > 4000) {
      this.lastPlanAt = Date.now();
      this.replan();
    }
    const f = this.makeFrame();
    this.send(f);
    this.recordHistory(f);
  }

  private tryEnter(t: Train, now: number, ev: (type: string, text: string, extra?: Partial<SimEvent>) => void, first: boolean) {
    const s = this.state;
    const a = this.plan.assignments[t.id];
    let trackId: string | null = a?.track ?? null;
    let tr = s.tracks.find((x) => x.id === trackId);
    if (!tr || tr.status !== 'free') {
      // ищем любой свободный подходящий путь
      const def = this.hello.station.tracks.find((d) => {
        const st = s.tracks.find((x) => x.id === d.id);
        return st?.status === 'free' && d.accepts.includes(t.cat) && d.length_m >= t.length_m;
      });
      tr = def ? s.tracks.find((x) => x.id === def.id) : undefined;
      trackId = tr?.id ?? null;
    }
    const ladderId = this.ladderFor(trackId, t.side_in);
    const ladderBusy = ladderId ? s.ladders.some((l) => l.id === ladderId && l.busy_until > now) : false;
    if (tr && trackId && !ladderBusy) {
      tr.status = 'occupied';
      tr.train = t.id;
      t.track = trackId;
      t.status = 'entering';
      t.entered_at = Math.round(now);
      t.service_done_at = Math.round(now + ENTER_S + (t.service_s ?? 900));
      t.pos_m = 0;
      t.speed_kmh = 0;
      t.regulated = false;
      t.advisory_kmh = null;
      const waited = t.stopped_at_signal;
      t.stopped_at_signal = false;
      t.reason = null;
      t.reason_text = null;
      if (ladderId) this.busyLadder(ladderId, now + THROAT_S, t.id);
      if (a) a.track = trackId;
      ev('enter', `Поезд №${t.id} принят на путь ${trackId}${waited ? ' (после стоянки у сигнала)' : ''}`, {
        train: t.id,
        track: trackId,
      });
    } else if (first || t.status !== 'at_signal') {
      t.status = 'at_signal';
      t.stopped_at_signal = true;
      t.speed_kmh = 0;
      t.pos_m = 0;
      t.reason = ladderBusy ? 'ladder_busy' : 'track_busy';
      t.reason_text = ladderBusy ? 'горловина занята другим маршрутом' : 'нет свободного пути';
      ev('signal_stop', `Поезд №${t.id} остановлен у входного сигнала: ${t.reason_text}`, { train: t.id, severity: 'medium' });
    }
  }

  private ladderFor(trackId: string | null, side: 'W' | 'E'): string | null {
    const def = this.hello.station.tracks.find((d) => d.id === trackId);
    return def ? def.ladders[side] : null;
  }

  private busyLadder(id: string, until: number, train: string) {
    const s = this.state;
    s.ladders = s.ladders.filter((l) => l.id !== id);
    s.ladders.push({ id, busy_until: Math.round(until), train });
  }

  private trainFromUpcoming(u: UpcomingTrain, a: Assignment): Train {
    const now = this.state.sim_time;
    const hold = a.entry_at != null && a.entry_at - u.eta > 25 * 60 ? Math.round(a.entry_at - spawnLeadFor()) : 0;
    return {
      id: u.id,
      cat: u.cat,
      length_m: u.length_m,
      side_in: u.side_in,
      side_out: u.side_out,
      status: hold > now ? 'held' : 'approaching',
      reason: null,
      reason_text: null,
      track: null,
      pos_m: APPROACH_M,
      speed_kmh: 60,
      planned_arr: u.planned_arr,
      planned_dep: u.planned_dep,
      eta: u.eta,
      entered_at: null,
      service_done_at: null,
      service_s: u.service_s,
      ready_at: null,
      departed_at: null,
      loco: null,
      crew: null,
      regulated: false,
      advisory_kmh: null,
      hold_until: hold,
      stopped_at_signal: false,
      res_wait_s: 0,
      delay_s: Math.max(0, Math.round((a.entry_at ?? u.eta) - u.planned_arr)),
    };
  }

  /** Простейший жадный «планировщик» для новых поездов, чтобы демо было бесконечным. */
  private ensureAssignment(u: { id: string; cat: TrainCat; length_m: number; eta: number; service_s?: number; planned_dep: number }): Assignment {
    const existing = this.plan.assignments[u.id];
    if (existing) return existing;
    const now = this.state.sim_time;
    let best: { track: string; at: number } | null = null;
    for (const d of this.hello.station.tracks) {
      if (!d.accepts.includes(u.cat) || d.length_m < u.length_m) continue;
      const st = this.state.tracks.find((x) => x.id === d.id);
      if (st?.status === 'reserve') continue;
      let free = now;
      if (st?.status === 'closed' && st.closed_until) free = Math.max(free, st.closed_until);
      for (const [tid, a] of Object.entries(this.plan.assignments)) {
        if (a.track !== d.id) continue;
        const tr = this.state.trains.find((x) => x.id === tid);
        if (tr?.status === 'departed') continue;
        free = Math.max(free, a.dep_at + 180);
      }
      const at = Math.max(u.eta, free);
      if (!best || at < best.at) best = { track: d.id, at };
    }
    const entry = best?.at ?? u.eta;
    const a: Assignment = {
      track: best?.track ?? '8',
      entry_at: Math.round(entry),
      dep_at: Math.round(Math.max(u.planned_dep, entry + (u.service_s ?? 900) + 300)),
    };
    this.plan.assignments[u.id] = a;
    return a;
  }

  private generateUpcoming() {
    const s = this.state;
    let last = s.upcoming.reduce((m, u) => Math.max(m, u.eta), s.sim_time + 1800);
    for (let i = 0; i < 6; i++) {
      const r = Math.random();
      const cat: TrainCat = r < 0.3 ? 'pass' : r < 0.8 ? 'freight_transit' : 'freight_local';
      const def = this.hello.station.categories[cat];
      last += rnd(240, 720);
      const side_in = Math.random() < 0.5 ? 'W' : 'E';
      const service = rnd(def.service_min[0], def.service_min[1]) * 60;
      const id = cat === 'pass' ? String(this.nextId++ % 200 + 137) : cat === 'freight_transit' ? String(2035 + (this.nextId++ % 900)) : String(3510 + (this.nextId++ % 400));
      if (s.trains.some((t) => t.id === id) || s.upcoming.some((u) => u.id === id)) continue;
      const arr = Math.round(last - rnd(0, 400));
      s.upcoming.push({
        id,
        cat,
        length_m: Math.round(rnd(def.length_m[0], def.length_m[1]) / 10) * 10,
        side_in,
        side_out: cat === 'freight_local' ? side_in : side_in === 'W' ? 'E' : 'W',
        status: 'scheduled',
        planned_arr: arr,
        planned_dep: Math.round(arr + service + 600),
        eta: Math.round(last),
        service_s: Math.round(service),
      });
    }
  }

  private replan() {
    const p = this.plan;
    for (const u of this.state.upcoming.slice(0, 20)) this.ensureAssignment(u);
    // чистим назначения ушедших поездов
    for (const id of Object.keys(p.assignments)) {
      const t = this.state.trains.find((x) => x.id === id);
      const up = this.state.upcoming.find((x) => x.id === id);
      if (!t && !up) delete p.assignments[id];
    }
    p.version = (p.version ?? 0) + 1;
    p.sim_time = Math.round(this.state.sim_time);
    p.created_at = Date.now() / 1000;
    const ms = Math.round(rnd(380, 1150));
    p.solver = { ...p.solver, time_ms: ms, status: Math.random() < 0.85 ? 'OPTIMAL' : 'FEASIBLE' };
    p.total_ms = ms + Math.round(rnd(8, 40));
    // слот-рекомендации по текущим регулируемым поездам
    const slotRecs = this.state.trains
      .filter((t) => (t.status === 'approaching' || t.status === 'held') && t.regulated && p.assignments[t.id]?.entry_at)
      .slice(0, 4)
      .map((t) => {
        const a = p.assignments[t.id];
        return {
          id: `slot_${t.id}`,
          severity: 'info' as const,
          kind: 'slot',
          title: `№${t.id}: вход в ${clock(a.entry_at)} на путь ${a.track}`,
          text:
            t.status === 'held'
              ? `Удержать на предыдущей станции до ${clock(t.hold_until)}: без остановки у входного сигнала`
              : `Снизить скорость до ${Math.round(t.advisory_kmh ?? t.speed_kmh)} км/ч: без остановки у входного сигнала`,
          action: null,
        };
      });
    p.recommendations = [...p.recommendations.filter((r) => r.kind !== 'slot'), ...slotRecs];
    this.send({ type: 'plan', plan: clone(p) });
  }

  /* ---------------- KPI и индекс ---------------- */
  private computeKpi() {
    const s = this.state;
    const now = s.sim_time;
    const open = s.tracks.filter((t) => t.status !== 'closed' && t.status !== 'reserve');
    const occ = open.filter((t) => t.train).length;
    const queue = s.trains.filter((t) => ['approaching', 'held', 'at_signal'].includes(t.status));
    const atSig = queue.filter((t) => t.status === 'at_signal').length;
    this.noise.wait = clamp(this.noise.wait + rnd(-0.25, 0.25), -1.5, 1.5);
    this.noise.dev = clamp(this.noise.dev + rnd(-0.15, 0.15), -1, 1);
    const departed1h = s.trains.filter((t) => t.departed_at != null && t.departed_at > now - 3600 && t.status === 'departed').length;
    const due = Math.max(departed1h + 1, 13 + Math.round(this.noise.dev));
    const unresolved = this.plan.conflicts.filter((c) => !c.resolved).length;
    const locosIdle = s.locos.filter((l) => l.status === 'available').length;
    const crewsIdle = s.crews.filter((l) => l.status === 'available').length;
    const avgWait = clamp(3.2 + atSig * 2.5 + queue.length * 0.25 + this.noise.wait, 0.5, 60);
    const ai: Kpi = {
      sim_time: Math.round(now),
      departed_1h: Math.min(due, departed1h + 10),
      due_1h: due,
      throughput_ratio: 0,
      avg_deviation_min: round1(clamp(1.8 + this.noise.dev * 1.5 + atSig, 0, 60)),
      utilization: open.length ? occ / open.length : 0,
      occupied_tracks: occ,
      open_tracks: open.length,
      conflicts: unresolved + atSig,
      blocked_now: atSig,
      ladder_conflicts_30m: 30 + Math.round(this.noise.wait * 3),
      avg_resource_wait_min: round1(clamp(5 + this.noise.wait, 0, 60)),
      locos_idle: locosIdle,
      locos_total: s.locos.length,
      crews_idle: crewsIdle,
      queue_len: queue.length,
      avg_entry_wait_min: round1(avgWait),
      signal_stops_1h: atSig + 1,
      total_departed: 20 + s.trains.filter((t) => t.status === 'departed').length,
    };
    ai.throughput_ratio = Math.round((ai.departed_1h / ai.due_1h) * 1000) / 1000;
    s.kpi = ai;
  }

  private baselineKpi(ai: Kpi): Kpi {
    const n = this.noise;
    const base: Kpi = {
      ...ai,
      departed_1h: Math.max(0, ai.departed_1h - 2),
      avg_deviation_min: round1(ai.avg_deviation_min * 2.6 + 7 + n.dev * 2),
      utilization: Math.min(1, ai.utilization + 0.06),
      conflicts: ai.conflicts + 6 + Math.round(Math.abs(n.wait) * 2),
      blocked_now: (ai.blocked_now ?? 0) + 4,
      avg_resource_wait_min: round1(ai.avg_resource_wait_min + 3.5),
      locos_idle: Math.max(0, (ai.locos_idle ?? 0) - 1),
      queue_len: ai.queue_len + 3,
      avg_entry_wait_min: round1(ai.avg_entry_wait_min * 2.45 + 4 + n.wait),
      signal_stops_1h: 13 + Math.round(Math.abs(n.wait) * 3),
      ladder_conflicts_30m: 128 + Math.round(n.wait * 6),
    };
    base.throughput_ratio = Math.round((base.departed_1h / base.due_1h) * 1000) / 1000;
    return base;
  }

  computeIndex(k: Kpi): IndexValue {
    const cfg = this.indexCfg;
    const f = cfg.factors;
    const total = Object.values(f).reduce((a, x) => a + x.weight, 0) || 1;
    const util = (u: number) => {
      const [lo, hi] = f.utilization?.optimal ?? [0.55, 0.85];
      if (u < lo) return u / lo;
      if (u > hi) return Math.max(0, 1 - (u - hi) / (1 - hi));
      return 1;
    };
    const lin = (v: number, worst: number) => clamp(1 - v / worst, 0, 1);
    const scoreWhy: Record<string, [number, string]> = {
      throughput: [Math.min(1, k.throughput_ratio), `отправлено ${k.departed_1h} из ${k.due_1h} по графику за час`],
      deviation: [lin(k.avg_deviation_min, f.deviation?.worst_min ?? 40), `среднее отклонение ${Math.round(k.avg_deviation_min)} мин`],
      utilization: [
        util(k.utilization),
        k.utilization > 0.85
          ? `пути переполнены (${Math.round(k.utilization * 100)}%), нет резерва`
          : k.utilization < 0.55
            ? `пути простаивают (${Math.round(k.utilization * 100)}%)`
            : `загрузка в норме (${Math.round(k.utilization * 100)}%)`,
      ],
      conflicts: [lin(k.conflicts, f.conflicts?.worst_count ?? 8), `${k.conflicts} неразрешённых конфликтов`],
      resource_idle: [
        lin(k.avg_resource_wait_min, f.resource_idle?.worst_min ?? 30),
        `ожидание локомотива/бригады ${Math.round(k.avg_resource_wait_min)} мин, свободно локомотивов: ${k.locos_idle ?? 0}`,
      ],
      queue: [lin(k.avg_entry_wait_min, f.queue?.worst_min ?? 45), `в очереди ${k.queue_len} поездов, ожидание ${Math.round(k.avg_entry_wait_min)} мин`],
    };
    const factors: IndexFactor[] = Object.entries(f).map(([id, def]) => {
      const w = def.weight / total;
      const [score, why] = scoreWhy[id] ?? [1, ''];
      const points = round1(100 * w * score);
      return {
        id,
        name: def.name,
        weight: Math.round(w * 1000) / 1000,
        score: Math.round(score * 1000) / 1000,
        points,
        loss: round1(100 * w - points),
        why,
        description: def.description,
      };
    });
    const value = round1(factors.reduce((a, x) => a + x.points, 0));
    const cats = [...cfg.categories].sort((a, b) => b.min - a.min);
    const cat = cats.find((c) => value >= c.min) ?? cats[cats.length - 1];
    const grades = [...cfg.grades].sort((a, b) => b.min - a.min);
    const grade = grades.find((g) => value >= g.min)?.grade ?? 'E';
    return {
      value,
      grade,
      category: { id: cat.id, name: cat.name, color: cat.color, reason: cat.reason },
      factors,
      top: [...factors].sort((a, b) => b.loss - a.loss).slice(0, 5),
    };
  }

  private makeFrame(): Frame {
    const ai = this.state.kpi;
    const base = this.baselineKpi(ai);
    const idxAi = this.computeIndex(ai);
    const idxBase = this.computeIndex(base);
    const now = Date.now();
    const f: Frame = {
      type: 'frame',
      seq: ++this.seq,
      emitted_at: now - Math.round(rnd(15, 70)), // имитация сетевой/серверной задержки
      state: clone({ ...this.state, plan_version: this.plan.version ?? null }),
      index: idxAi,
      compare: { baseline: { kpi: base, index: idxBase }, ai: { kpi: ai, index: idxAi } },
      link: { simulator: 'up', ingest: 'up', planner: 'up', last_event_ms: now },
    };
    this.lastFrame = f;
    return f;
  }

  private recordHistory(f: Frame) {
    const last = this.frames[this.frames.length - 1];
    if (last && f.emitted_at - last.ts < 1000) return;
    this.frames.push({ ts: f.emitted_at, frame: f, plan: clone(this.plan) });
    if (this.frames.length > 960) this.frames.shift();
  }

  private buildSynthetic() {
    // синтетическая предыстория для графиков «Сравнение» (4 мин реального времени до старта)
    const now = Date.now();
    const sim0 = this.state.sim_time;
    let qa = 4,
      qb = 6,
      ia = 80,
      ib = 66;
    for (let i = 240; i > 0; i -= 2) {
      qa = clamp(qa + rnd(-0.6, 0.6), 2, 7);
      qb = clamp(qb + rnd(-0.6, 0.75), 5, 12);
      ia = clamp(ia + rnd(-1.2, 1.2), 70, 88);
      ib = clamp(ib + rnd(-1.4, 1.2), 52, 72);
      this.synthetic.push({
        ts: now - i * 1000,
        sim_time: Math.round(sim0 - i * this.timeScale),
        index_ai: round1(ia),
        index_baseline: round1(ib),
        queue_ai: Math.round(qa),
        queue_baseline: Math.round(qb),
      });
    }
  }

  /* ---------------- инциденты ---------------- */
  private incident(body: Incident) {
    const s = this.state;
    const now = s.sim_time;
    const events: SimEvent[] = [];
    if (body.type === 'close_track' && body.track) {
      const tr = s.tracks.find((t) => t.id === body.track);
      if (tr) {
        tr.status = 'closed';
        tr.closed_until = Math.round(now + (body.duration_min ?? 40) * 60);
        events.push({ t: Math.round(now), type: 'incident', text: `Путь ${tr.id} закрыт на ${body.duration_min ?? 40} мин`, world: 'ai', track: tr.id, severity: 'high' });
      }
    } else if (body.type === 'delay' && body.train) {
      const t = s.trains.find((x) => x.id === body.train);
      const u = s.upcoming.find((x) => x.id === body.train);
      const add = (body.minutes ?? 15) * 60;
      if (t) {
        t.delay_s += add;
        t.eta += add;
        t.hold_until = Math.max(t.hold_until ?? 0, now + add);
      }
      if (u) u.eta += add;
      events.push({ t: Math.round(now), type: 'incident', text: `Поезд №${body.train} задержан на ${body.minutes ?? 15} мин`, world: 'ai', train: body.train, severity: 'high' });
    } else if (body.type === 'loco_failure') {
      const l = s.locos.find((x) => x.id === body.loco) ?? s.locos.find((x) => x.status === 'available') ?? s.locos[0];
      if (l) {
        l.status = 'failed';
        l.train = null;
        l.until = Math.round(now + 3600);
        events.push({ t: Math.round(now), type: 'incident', text: `Отказ локомотива ${l.id}`, world: 'ai', loco: l.id, severity: 'high' });
      }
    }
    this.send({ type: 'events', events });
    this.computeKpi();
    this.send(this.makeFrame());
    window.setTimeout(() => this.emitVariants(body), rnd(450, 900));
  }

  private emitVariants(incident: Incident) {
    const base = clone(variantsJson as unknown as VariantsMsg);
    const nowS = Date.now() / 1000;
    const k = this.state.kpi;
    const variants = base.variants.map((v, i) => {
      const p = clone(this.plan);
      const ms = Math.round(rnd(320, 980));
      p.variant = v.variant;
      p.variant_name = v.variant_name;
      p.description = v.description;
      p.created_at = nowS + i * 0.001;
      p.sim_time = Math.round(this.state.sim_time);
      p.solver = { ...v.solver, time_ms: ms };
      p.total_ms = ms + Math.round(rnd(5, 30));
      const mul = [1, 1.08, 0.92][i] ?? 1;
      p.projected_kpi = {
        ...v.projected_kpi,
        avg_entry_wait_min: round1(k.avg_entry_wait_min * mul + rnd(0.5, 3)),
        avg_deviation_min: round1(k.avg_deviation_min * [1.1, 0.8, 1.25][i] + rnd(0.5, 2)),
        conflicts: v.projected_kpi.conflicts,
      };
      const projected = this.computeIndex({ ...k, ...p.projected_kpi } as Kpi);
      projected.value = round1(projected.value + [1.5, 0.5, 2.5][i]);
      p.projected_index = projected;
      return p;
    });
    const best = variants.reduce((a, b) => (b.projected_index.value > a.projected_index.value ? b : a));
    const auto = this.plannerCfg.auto_apply_best_variant;
    const applied = auto ? best.variant : this.plan.variant;
    if (auto) this.applyPlan(best);
    this.variants = { type: 'variants', incident, variants, applied };
    this.send(this.variants);
  }

  private applyPlan(v: Plan) {
    const keep = this.plan.assignments;
    this.plan = clone(v);
    this.plan.assignments = { ...keep, ...v.assignments };
    this.plan.version = (this.plan.version ?? 0) + 1;
    this.send({ type: 'plan', plan: clone(this.plan) });
  }

  private stress() {
    this.stressUntil = Date.now() + 30000;
    const free = this.state.tracks.filter((t) => t.status === 'free' || t.status === 'occupied');
    const tr = free[Math.floor(Math.random() * free.length)];
    const delayed = this.state.trains.filter((t) => t.status === 'approaching').slice(0, 2);
    this.send({ type: 'events', events: [{ t: Math.round(this.state.sim_time), type: 'incident', text: 'Стресс-тест: каскад сбоев, поток событий ×10 на 30 с', world: 'ai', severity: 'critical' }] });
    if (tr) {
      tr.status = 'closed';
      tr.closed_until = Math.round(this.state.sim_time + 1800);
    }
    for (const t of delayed) {
      t.delay_s += 900;
      t.hold_until = this.state.sim_time + 900;
    }
    const l = this.state.locos.find((x) => x.status === 'available');
    if (l) {
      l.status = 'failed';
      l.until = Math.round(this.state.sim_time + 3600);
    }
    window.setTimeout(() => this.emitVariants({ type: 'stress', track: tr?.id }), 700);
  }

  private action(a: RecommendationAction) {
    const s = this.state;
    const now = Math.round(s.sim_time);
    let text = 'Действие выполнено';
    if (a.type === 'open_track' && a.track) {
      const tr = s.tracks.find((t) => t.id === a.track);
      if (tr) {
        tr.status = tr.train ? 'occupied' : 'free';
        tr.closed_until = null;
      }
      text = `Открыт путь ${a.track}`;
      this.plan.recommendations = this.plan.recommendations.filter((r) => !(r.action?.type === 'open_track' && r.action.track === a.track));
    } else if (a.type === 'reroute' && a.train) {
      s.upcoming = s.upcoming.filter((u) => u.id !== a.train);
      const t = s.trains.find((x) => x.id === a.train);
      if (t) t.status = 'rerouted';
      delete this.plan.assignments[a.train];
      text = `Поезд №${a.train} направлен по обходу`;
      this.plan.recommendations = this.plan.recommendations.filter((r) => !(r.action?.type === 'reroute' && r.action.train === a.train));
    } else if (a.type === 'add_loco') {
      const id = `Л${30 + s.locos.length}`;
      s.locos.push({ id, status: 'available', train: null, until: null });
      text = `Выведен резервный локомотив ${id}`;
      this.plan.recommendations = this.plan.recommendations.filter((r) => r.action?.type !== 'add_loco');
      this.plan.conflicts = this.plan.conflicts.map((c) => (c.type === 'loco_shortage' ? { ...c, resolved: true, resolution: `выведен резерв ${id}` } : c));
    } else if (a.type === 'add_crew') {
      const id = `Б${30 + s.crews.length}`;
      s.crews.push({ id, status: 'available', train: null, until: null });
      text = `Вызвана резервная бригада ${id}`;
      this.plan.recommendations = this.plan.recommendations.filter((r) => r.action?.type !== 'add_crew');
    }
    this.send({ type: 'events', events: [{ t: now, type: 'action', text: `Диспетчер: ${text}`, world: 'ai' }] });
    this.replan();
    return { ok: true, text };
  }

  /* ---------------- REST ---------------- */
  async rest<T>(method: string, path: string, body?: unknown): Promise<T> {
    await new Promise((r) => setTimeout(r, rnd(60, 180)));
    const url = new URL(path, 'http://mock');
    const p = url.pathname;
    const ok = (x: unknown) => x as T;
    const fail = (status: number, msg: string) => {
      const e = new Error(msg) as Error & { status: number };
      e.status = status;
      throw e;
    };
    if (method === 'POST' && p === '/api/auth/login') {
      const b = body as { username: string };
      return ok({ token: 'mock-token', role: b.username === 'dispatcher' ? 'dispatcher' : 'admin', username: b.username });
    }
    if (method === 'POST' && p === '/api/incidents') {
      this.incident(body as Incident);
      return ok({ ok: true });
    }
    if (method === 'POST' && p === '/api/incidents/stress') {
      this.stress();
      return ok({ ok: true });
    }
    if (method === 'POST' && p === '/api/actions') return ok(this.action(body as RecommendationAction));
    if (method === 'POST' && p === '/api/plan/apply') {
      const id = (body as { variant: string }).variant;
      const v = this.variants?.variants.find((x) => x.variant === id);
      if (!v || !this.variants) return fail(404, 'Вариант не найден');
      this.applyPlan(v);
      this.variants = { ...this.variants, applied: id };
      this.send({ type: 'events', events: [{ t: Math.round(this.state.sim_time), type: 'action', text: `Диспетчер применил вариант «${v.variant_name}»`, world: 'ai' }] });
      return ok({ ok: true });
    }
    if (method === 'GET' && p === '/api/history/timeline') {
      const minutes = Number(url.searchParams.get('minutes') ?? 15);
      const from = Date.now() - minutes * 60000;
      const real: TimelinePoint[] = this.frames.map((x) => ({
        ts: x.ts,
        sim_time: x.frame.state.sim_time,
        index_ai: x.frame.compare.ai.index.value,
        index_baseline: x.frame.compare.baseline.index.value,
        queue_ai: x.frame.compare.ai.kpi.queue_len,
        queue_baseline: x.frame.compare.baseline.kpi.queue_len,
      }));
      return ok({ points: [...this.synthetic, ...real].filter((x) => x.ts >= from) });
    }
    if (method === 'GET' && p === '/api/history/frame') {
      const ts = Number(url.searchParams.get('ts'));
      if (!this.frames.length) return fail(404, 'История пуста');
      let best = this.frames[0];
      for (const x of this.frames) if (Math.abs(x.ts - ts) < Math.abs(best.ts - ts)) best = x;
      return ok({ frame: best.frame, plan: best.plan });
    }
    if (p === '/api/config/index') {
      if (method === 'PUT') {
        this.indexCfg = clone(body as IndexConfig);
        this.send({ ...this.hello, index_config: this.indexCfg, planner_config: this.plannerCfg, time_scale: this.timeScale });
      }
      return ok(this.indexCfg);
    }
    if (p === '/api/config/planner') {
      if (method === 'PUT') {
        this.plannerCfg = clone(body as PlannerConfig);
        this.send({ ...this.hello, index_config: this.indexCfg, planner_config: this.plannerCfg, time_scale: this.timeScale });
      }
      return ok(this.plannerCfg);
    }
    if (method === 'POST' && p === '/api/sim/speed') {
      this.timeScale = clamp(Number((body as { time_scale: number }).time_scale) || 20, 1, 120);
      this.send({ ...this.hello, index_config: this.indexCfg, planner_config: this.plannerCfg, time_scale: this.timeScale });
      return ok({ time_scale: this.timeScale });
    }
    if (method === 'GET' && p.startsWith('/api/reports/summary.')) {
      if (p.endsWith('.pdf')) return fail(501, 'PDF-отчёт формирует сервер — недоступно в демо-режиме');
      const rows = ['ts;sim_clock;index_ai;index_fcfs;queue_ai;queue_fcfs;wait_ai_min;wait_fcfs_min'];
      for (const x of this.frames) {
        const c = x.frame.compare;
        rows.push(
          [new Date(x.ts).toISOString(), clock(x.frame.state.sim_time), c.ai.index.value, c.baseline.index.value, c.ai.kpi.queue_len, c.baseline.kpi.queue_len, c.ai.kpi.avg_entry_wait_min, c.baseline.kpi.avg_entry_wait_min].join(';'),
        );
      }
      return ok(new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' }));
    }
    if (method === 'GET' && p === '/api/state') return ok(this.lastFrame);
    if (method === 'GET' && p === '/api/plan') return ok(this.plan);
    return fail(404, `Нет mock-обработчика для ${method} ${p}`);
  }
}

function spawnLeadFor(): number {
  return APPROACH_M / (60 / 3.6);
}

export const mockServer = new MockServer();
