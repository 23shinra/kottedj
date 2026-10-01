import { memo, useMemo } from 'react';
import { Activity, AlarmClock, CalendarClock, GitMerge, Hand, Layers, ListOrdered, TrainTrack } from 'lucide-react';
import { useStore, useViewFrame, type HistPoint } from '../store';
import type { Kpi } from '../types';
import { Delta, Sparkline } from './common';
import { fmtNum } from '../utils/time';

type Better = 'lower' | 'higher' | 'band';

interface KpiDef {
  id: string;
  title: string;
  icon: JSX.Element;
  value: (k: Kpi) => number;
  display: (k: Kpi) => string;
  unit?: string;
  better: Better;
  digits?: number;
  hint: string;
  sub?: (k: Kpi) => string;
}

const BAND: [number, number] = [0.55, 0.85];
const bandDist = (u: number) => (u < BAND[0] ? BAND[0] - u : u > BAND[1] ? u - BAND[1] : 0);

const DEFS: KpiDef[] = [
  {
    id: 'queue',
    title: 'Очередь на подходе',
    icon: <ListOrdered size={14} />,
    value: (k) => k.queue_len,
    display: (k) => fmtNum(k.queue_len, 0),
    unit: 'поездов',
    better: 'lower',
    digits: 0,
    hint: 'Поезда на подходе, удержанные и стоящие у входного сигнала',
    sub: (k) => (k.blocked_now != null ? `у сигнала: ${k.blocked_now}` : ''),
  },
  {
    id: 'wait',
    title: 'Ожидание приёма',
    icon: <AlarmClock size={14} />,
    value: (k) => k.avg_entry_wait_min,
    display: (k) => fmtNum(k.avg_entry_wait_min, 1),
    unit: 'мин',
    better: 'lower',
    hint: 'Среднее ожидание приёма поездами на подходе и у входного сигнала',
  },
  {
    id: 'stops',
    title: 'Остановки у сигнала',
    icon: <Hand size={14} />,
    value: (k) => k.signal_stops_1h ?? NaN,
    display: (k) => fmtNum(k.signal_stops_1h ?? NaN, 0),
    unit: 'за 1 ч',
    better: 'lower',
    digits: 0,
    hint: 'Число остановок поездов у входного сигнала за последний час. ИИ заменяет их регулированием скорости и удержанием на предыдущей станции',
  },
  {
    id: 'dev',
    title: 'Отклонение от графика',
    icon: <CalendarClock size={14} />,
    value: (k) => k.avg_deviation_min,
    display: (k) => fmtNum(k.avg_deviation_min, 1),
    unit: 'мин',
    better: 'lower',
    hint: 'Среднее отклонение фактического отправления от графика',
  },
  {
    id: 'thr',
    title: 'Пропускная',
    icon: <Activity size={14} />,
    value: (k) => k.throughput_ratio * 100,
    display: (k) => `${k.departed_1h} / ${k.due_1h}`,
    unit: 'за 1 ч',
    better: 'higher',
    digits: 0,
    hint: 'Отправлено за последний час / должно было уйти по графику',
    sub: (k) => `${Math.round(k.throughput_ratio * 100)}% графика`,
  },
  {
    id: 'util',
    title: 'Загрузка путей',
    icon: <TrainTrack size={14} />,
    value: (k) => k.utilization * 100,
    display: (k) => `${Math.round(k.utilization * 100)}%`,
    better: 'band',
    digits: 0,
    hint: 'Доля занятых открытых путей. Оптимум 55–85%: и простой, и переполнение снижают индекс',
    sub: (k) => (k.occupied_tracks != null ? `${k.occupied_tracks} из ${k.open_tracks} открытых` : ''),
  },
  {
    id: 'conf',
    title: 'Конфликты',
    icon: <GitMerge size={14} />,
    value: (k) => k.conflicts,
    display: (k) => fmtNum(k.conflicts, 0),
    unit: 'неразреш.',
    better: 'lower',
    digits: 0,
    hint: 'Неразрешённые конфликты: пересечения маршрутов, занятые пути, нехватка ресурсов',
  },
  {
    id: 'res',
    title: 'Свободно лок. / бригад',
    icon: <Layers size={14} />,
    value: (k) => k.locos_idle ?? NaN,
    display: (k) => `${k.locos_idle ?? '—'} / ${k.crews_idle ?? '—'}`,
    better: 'higher',
    digits: 0,
    hint: 'Свободные поездные локомотивы / локомотивные бригады',
    sub: (k) => `ожид. ресурса ${fmtNum(k.avg_resource_wait_min, 1)} мин`,
  },
];

const KpiCard = memo(function KpiCard({ def, kpi, other, otherLabel, series, otherSeries }: {
  def: KpiDef;
  kpi: Kpi;
  other: Kpi | null;
  otherLabel: string;
  series: number[];
  otherSeries: number[];
}) {
  const v = def.value(kpi);
  const ov = other ? def.value(other) : NaN;
  let deltaEl: JSX.Element | null = null;
  if (other && Number.isFinite(v) && Number.isFinite(ov)) {
    if (def.better === 'band') {
      const good = bandDist(v / 100) < bandDist(ov / 100);
      const same = Math.abs(bandDist(v / 100) - bandDist(ov / 100)) < 0.005;
      deltaEl = (
        <span className={`delta ${same ? 'delta-eq' : good ? 'delta-good' : 'delta-bad'}`} title="Ближе к оптимуму 55–85% — лучше">
          {same ? '≈' : good ? '✓ ближе к норме' : '✗ дальше от нормы'}
        </span>
      );
    } else {
      deltaEl = <Delta ai={v} base={ov} better={def.better} digits={def.digits ?? 1} />;
    }
  }
  return (
    <div className="kpi" title={def.hint} tabIndex={0} aria-label={`${def.title}: ${def.display(kpi)} ${def.unit ?? ''}. ${otherLabel}: ${other ? def.display(other) : 'нет данных'}`}>
      <div className="kpi-h">
        {def.icon}
        <span>{def.title}</span>
      </div>
      <div className="kpi-main">
        <span className="kpi-v num">{def.display(kpi)}</span>
        {def.unit && <span className="kpi-u">{def.unit}</span>}
        <Sparkline values={series} compare={otherSeries} width={72} height={24} label={`${def.title}: тренд за 5 минут`} />
      </div>
      <div className="kpi-cmp">
        <span className="kpi-other">
          {otherLabel}: <b className="num">{other ? def.display(other) : '—'}</b>
        </span>
        {deltaEl}
      </div>
      {def.sub && <div className="kpi-sub">{def.sub(kpi)}</div>}
    </div>
  );
});

const SPARK_N = 300; // ~5 минут при 1 точке/с

export function KpiStrip() {
  const frame = useViewFrame();
  const hist = useStore((s) => s.hist);
  const mode = useStore((s) => s.mode);
  const baselinePrimary = mode === 'baseline';

  const recent = useMemo(() => hist.slice(-SPARK_N), [hist]);
  const seriesFor = useMemo(() => {
    const pick = (getter: (h: HistPoint) => Kpi | undefined, def: KpiDef) =>
      recent.map((h) => {
        const k = getter(h);
        return k ? def.value(k) : NaN;
      });
    return DEFS.map((d) => ({
      ai: pick((h) => h.ai, d),
      base: pick((h) => h.base, d),
    }));
  }, [recent]);

  if (!frame) return <div className="kpis kpis-empty" aria-busy="true" />;
  const ai = frame.compare?.ai?.kpi ?? frame.state.kpi;
  const base = frame.compare?.baseline?.kpi ?? null;
  const primary = baselinePrimary && base ? base : ai;
  const other = baselinePrimary ? ai : base;

  return (
    <div className={`kpis ${baselinePrimary ? 'kpis-baseline' : ''}`} role="region" aria-label="Ключевые показатели">
      {DEFS.map((d, i) => (
        <KpiCard
          key={d.id}
          def={d}
          kpi={primary}
          other={other}
          otherLabel={baselinePrimary ? 'С ИИ' : 'FCFS'}
          series={baselinePrimary ? seriesFor[i].base : seriesFor[i].ai}
          otherSeries={baselinePrimary ? seriesFor[i].ai : seriesFor[i].base}
        />
      ))}
    </div>
  );
}
