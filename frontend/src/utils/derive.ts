import type { Assignment, Plan, Train, UpcomingTrain, WorldState } from '../types';

export interface QueueRow {
  id: string;
  cat: Train['cat'];
  side: Train['side_in'];
  status: Train['status'] | 'scheduled';
  eta: number;
  planned_arr: number;
  slot: number | null;
  track: string | null;
  advisory: number | null;
  speed: number | null;
  reason: string | null;
  pos_m: number | null;
  delay_s: number;
  hold_until: number;
  train?: Train;
  upcoming?: UpcomingTrain;
}

const PENDING = new Set(['approaching', 'held', 'at_signal']);

/** Виртуальная очередь: поезда на подходе/удержанные/у сигнала + график на 60 мин вперёд. */
export function buildQueue(state: WorldState, plan: Plan | null, horizonS = 3600): QueueRow[] {
  const now = state.sim_time;
  const asg = plan?.assignments ?? {};
  const rows: QueueRow[] = [];
  for (const t of state.trains) {
    if (!PENDING.has(t.status)) continue;
    const a: Assignment | undefined = asg[t.id];
    const held = t.status === 'held' || (t.hold_until ?? 0) > now;
    rows.push({
      id: t.id,
      cat: t.cat,
      side: t.side_in,
      status: held && t.status !== 'at_signal' ? 'held' : t.status,
      eta: t.eta,
      planned_arr: t.planned_arr,
      slot: a?.entry_at ?? null,
      track: a?.track ?? t.track,
      advisory: t.advisory_kmh,
      speed: t.speed_kmh,
      reason: t.reason_text,
      pos_m: t.pos_m,
      delay_s: t.delay_s,
      hold_until: t.hold_until ?? 0,
      train: t,
    });
  }
  for (const u of state.upcoming) {
    if (u.eta > now + horizonS) continue;
    const a = asg[u.id];
    rows.push({
      id: u.id,
      cat: u.cat,
      side: u.side_in,
      status: 'scheduled',
      eta: u.eta,
      planned_arr: u.planned_arr,
      slot: a?.entry_at ?? null,
      track: a?.track ?? null,
      advisory: null,
      speed: null,
      reason: a?.entry_at && a.entry_at - u.eta > 120 ? 'слот позже прибытия — регулирование' : 'по графику',
      pos_m: null,
      delay_s: Math.max(0, (a?.entry_at ?? u.eta) - u.planned_arr),
      hold_until: 0,
      upcoming: u,
    });
  }
  const rank = (r: QueueRow) => (r.status === 'at_signal' ? 0 : r.status === 'scheduled' ? 2 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || (a.slot ?? a.eta) - (b.slot ?? b.eta));
  return rows;
}

export function trainMap(state: WorldState | null | undefined): Map<string, Train> {
  const m = new Map<string, Train>();
  state?.trains.forEach((t) => m.set(t.id, t));
  return m;
}

export function pctDelta(ai: number, base: number): number | null {
  if (!Number.isFinite(ai) || !Number.isFinite(base) || base === 0) return null;
  return ((ai - base) / Math.abs(base)) * 100;
}

/** Прогресс обслуживания поезда на пути, 0..1 */
export function serviceProgress(t: Train, now: number): number | null {
  if (t.entered_at == null) return null;
  const end = t.service_done_at ?? (t.service_s ? t.entered_at + t.service_s : null);
  if (end == null || end <= t.entered_at) return null;
  return Math.max(0, Math.min(1, (now - t.entered_at) / (end - t.entered_at)));
}
