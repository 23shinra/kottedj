// Время суток = start_clock + sim_time (модельные секунды)

let startOffsetS = 6 * 3600;

export function setStartClock(clock: string | undefined): void {
  if (!clock) return;
  const [h, m] = clock.split(':').map((x) => parseInt(x, 10));
  if (Number.isFinite(h) && Number.isFinite(m)) startOffsetS = h * 3600 + m * 60;
}

export function startOffset(): number {
  return startOffsetS;
}

const pad = (n: number) => (n < 10 ? '0' + n : String(n));

/** sim_time (с) → "HH:MM" */
export function clock(simS: number | null | undefined): string {
  if (simS == null || !Number.isFinite(simS)) return '—';
  const t = ((Math.floor(simS + startOffsetS) % 86400) + 86400) % 86400;
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}`;
}

/** sim_time (с) → "HH:MM:SS" */
export function clockSec(simS: number | null | undefined): string {
  if (simS == null || !Number.isFinite(simS)) return '—';
  const t = ((Math.floor(simS + startOffsetS) % 86400) + 86400) % 86400;
  return `${pad(Math.floor(t / 3600))}:${pad(Math.floor((t % 3600) / 60))}:${pad(t % 60)}`;
}

/** Реальное время (мс epoch) → "HH:MM:SS" */
export function wallClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Длительность в секундах → "12 мин" / "1 ч 05 мин" */
export function dur(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  const m = Math.round(Math.abs(s) / 60);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)} ч ${pad(m % 60)} мин`;
}

/** Минуты → "5,9 мин" */
export function fmtMin(m: number | null | undefined, digits = 1): string {
  if (m == null || !Number.isFinite(m)) return '—';
  return `${fmtNum(m, digits)} мин`;
}

export function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

export function fmtPct(ratio: number | null | undefined, digits = 0): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—';
  return `${fmtNum(ratio * 100, digits)}%`;
}
