import type { Severity, TrainCat, TrainStatus } from '../types';

/**
 * Цвета категорий поездов. Тройка проверена валидатором палитры (dataviz):
 * тёмная поверхность #111a2b, все пары — CVD ΔE ≥ 9.4, normal ΔE ≥ 20.9, контраст ≥ 3:1.
 * Цвет всегда дублируется иконкой/подписью категории.
 */
export const CAT_COLOR: Record<TrainCat, string> = {
  pass: '#3987e5',
  freight_transit: '#d95926',
  freight_local: '#199e70',
};

export const CAT_NAME: Record<TrainCat, string> = {
  pass: 'Пассажирский',
  freight_transit: 'Грузовой транзитный',
  freight_local: 'Грузовой местный',
};

export const CAT_SHORT: Record<TrainCat, string> = {
  pass: 'Пасс.',
  freight_transit: 'Транзит',
  freight_local: 'Местный',
};

export const STATUS_NAME: Record<TrainStatus, string> = {
  scheduled: 'по графику',
  approaching: 'на подходе',
  held: 'удержан на пред. станции',
  at_signal: 'стоит у входного сигнала',
  entering: 'приём на станцию',
  on_track: 'на пути',
  departing: 'отправляется',
  departed: 'отправлен',
  rerouted: 'направлен по обходу',
};

export const SEMANTIC = {
  ok: '#2fbf71',
  warn: '#f5a524',
  crit: '#f04438',
  info: '#5b9cf5',
  accent: '#8b9cff',
  muted: '#8a9bb5',
  text: '#e6edf7',
  text2: '#b4c0d3',
  grid: '#1f2b42',
  surface: '#111a2b',
  surface2: '#0e1625',
};

export const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: SEMANTIC.crit,
  high: SEMANTIC.warn,
  medium: '#e3c25b',
  low: SEMANTIC.info,
  info: SEMANTIC.info,
};

export const SEVERITY_NAME: Record<Severity, string> = {
  critical: 'Критично',
  high: 'Важно',
  medium: 'Внимание',
  low: 'Инфо',
  info: 'Инфо',
};

export const PARK_SHORT: Record<string, string> = { P: 'П', PO: 'ПО', G: 'Г' };

export function catColor(cat: string | undefined | null): string {
  return (cat && CAT_COLOR[cat as TrainCat]) || SEMANTIC.muted;
}
