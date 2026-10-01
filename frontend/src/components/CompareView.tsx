/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useMemo } from 'react';
import { Bot, Scale, User } from 'lucide-react';
import { useStore, useViewFrame, type HistPoint } from '../store';
import type { Kpi, TimelinePoint } from '../types';
import { api } from '../api/rest';
import { axisCommon, tooltipBase, FONT } from '../utils/echarts';
import { SEMANTIC } from '../utils/theme';
import { fmtNum, wallClock, clock } from '../utils/time';
import { EChart } from './charts/EChart';
import { Delta } from './common';
import { IndexGauge } from './TopBar';

const AI_COLOR = SEMANTIC.accent;
const BASE_COLOR = '#a3adbd';

export function timelineToHist(points: TimelinePoint[]): HistPoint[] {
  return points.map((p) => ({
    ts: p.ts,
    sim: p.sim_time,
    ai: { queue_len: p.queue_ai } as Kpi,
    base: { queue_len: p.queue_baseline } as Kpi,
    idxAi: p.index_ai,
    idxBase: p.index_baseline,
  }));
}

interface Row {
  name: string;
  get: (k: Kpi) => number;
  fmt: (v: number) => string;
  better: 'lower' | 'higher';
  digits?: number;
}
const ROWS: Row[] = [
  { name: 'Среднее ожидание приёма', get: (k) => k.avg_entry_wait_min, fmt: (v) => `${fmtNum(v, 1)} мин`, better: 'lower' },
  { name: 'Очередь на подходе', get: (k) => k.queue_len, fmt: (v) => `${fmtNum(v, 0)}`, better: 'lower', digits: 0 },
  { name: 'Остановки у входного сигнала, 1 ч', get: (k) => k.signal_stops_1h ?? NaN, fmt: (v) => fmtNum(v, 0), better: 'lower', digits: 0 },
  { name: 'Отклонение от графика', get: (k) => k.avg_deviation_min, fmt: (v) => `${fmtNum(v, 1)} мин`, better: 'lower' },
  { name: 'Отправлено за час', get: (k) => k.departed_1h, fmt: (v) => fmtNum(v, 0), better: 'higher', digits: 0 },
  { name: 'Неразрешённые конфликты', get: (k) => k.conflicts, fmt: (v) => fmtNum(v, 0), better: 'lower', digits: 0 },
  { name: 'Ожидание локомотива/бригады', get: (k) => k.avg_resource_wait_min, fmt: (v) => `${fmtNum(v, 1)} мин`, better: 'lower' },
];

function lineOption(hist: HistPoint[], pick: (h: HistPoint) => [number, number], title: string, yName: string, yMin?: number, yMax?: number) {
  const ai = hist.map((h) => [h.ts, pick(h)[0]]);
  const base = hist.map((h) => [h.ts, pick(h)[1]]);
  const simAt = new Map(hist.map((h) => [h.ts, h.sim]));
  const endLabel = (name: string, color: string) => ({
    show: true,
    formatter: (p: any) => `${name} ${fmtNum(p.value[1], 0)}`,
    color,
    fontSize: 11,
    fontWeight: 600,
    fontFamily: FONT,
  });
  return {
    animation: false,
    title: { text: title, left: 4, top: 0, textStyle: { color: SEMANTIC.text, fontSize: 12, fontWeight: 600, fontFamily: FONT } },
    grid: { left: 42, right: 78, top: 30, bottom: 26 },
    legend: { top: 0, right: 8, itemWidth: 14, itemHeight: 3, textStyle: { color: SEMANTIC.text2, fontSize: 11, fontFamily: FONT }, data: ['С ИИ', 'Без ИИ (FCFS)'] },
    tooltip: {
      ...tooltipBase,
      trigger: 'axis',
      axisPointer: { type: 'line', lineStyle: { color: '#3a4a6a' } },
      formatter: (ps: any[]) => {
        if (!ps.length) return '';
        const ts = ps[0].value[0];
        const sim = simAt.get(ts);
        return `<div style="color:${SEMANTIC.muted}">${wallClock(ts)}${sim != null ? ` · модель ${clock(sim)}` : ''}</div>${ps
          .map((p) => `<div><span style="display:inline-block;width:10px;height:2px;background:${p.color};margin-right:6px;vertical-align:middle"></span>${p.seriesName}: <b>${fmtNum(p.value[1], 1)}</b></div>`)
          .join('')}`;
      },
    },
    xAxis: { type: 'time', ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => wallClock(v).slice(0, 5) }, splitLine: { show: false } },
    yAxis: { type: 'value', name: yName, min: yMin, max: yMax, nameTextStyle: { color: SEMANTIC.muted, fontSize: 10 }, ...axisCommon },
    series: [
      { id: 'ai', name: 'С ИИ', type: 'line', showSymbol: false, data: ai, lineStyle: { width: 2, color: AI_COLOR }, itemStyle: { color: AI_COLOR }, endLabel: endLabel('ИИ', AI_COLOR), areaStyle: { color: 'rgba(139,156,255,0.08)' } },
      { id: 'base', name: 'Без ИИ (FCFS)', type: 'line', showSymbol: false, data: base, lineStyle: { width: 2, color: BASE_COLOR, type: 'dashed' }, itemStyle: { color: BASE_COLOR }, endLabel: endLabel('FCFS', BASE_COLOR) },
    ],
  };
}

export function CompareView() {
  const frame = useViewFrame();
  const hist = useStore((s) => s.hist);
  const mergeTimeline = useStore((s) => s.mergeTimeline);

  useEffect(() => {
    api
      .timeline(15)
      .then((r) => mergeTimeline(timelineToHist(r.points ?? [])))
      .catch(() => undefined);
  }, [mergeTimeline]);

  const recent = useMemo(() => hist.filter((h) => h.ts >= Date.now() - 15 * 60000), [hist]);
  const idxOpt = useMemo(() => lineOption(recent, (h) => [h.idxAi, h.idxBase], 'Индекс состояния станции', 'баллы', 0, 100), [recent]);
  const qOpt = useMemo(() => lineOption(recent, (h) => [h.ai.queue_len, h.base.queue_len], 'Очередь на подходе', 'поездов', 0), [recent]);

  if (!frame) return <div className="panel compare skeleton">Нет данных</div>;
  const ai = frame.compare.ai.kpi;
  const base = frame.compare.baseline.kpi;
  const waitCut = base.avg_entry_wait_min > 0 ? Math.round(((base.avg_entry_wait_min - ai.avg_entry_wait_min) / base.avg_entry_wait_min) * 100) : 0;
  const stopsCut = (base.signal_stops_1h ?? 0) > 0 ? Math.round((((base.signal_stops_1h ?? 0) - (ai.signal_stops_1h ?? 0)) / (base.signal_stops_1h ?? 1)) * 100) : null;
  const idxDiff = frame.compare.ai.index.value - frame.compare.baseline.index.value;

  return (
    <section className="panel compare" aria-labelledby="cmp-h">
      <header className="panel-h">
        <h2 id="cmp-h">
          <Scale size={15} /> Сравнение двух цифровых двойников на одном входном потоке
        </h2>
        <span className="h-sub">одинаковый график и инциденты · разный способ управления</span>
      </header>
      <div className="compare-body">
        <div className="headline" role="status">
          {waitCut > 0 ? (
            <>
              ИИ сокращает ожидание приёма на <b className="num">{waitCut}%</b>
            </>
          ) : waitCut < 0 ? (
            <>
              Сейчас ожидание приёма с ИИ выше на <b className="num">{-waitCut}%</b> — проверьте рекомендации
            </>
          ) : (
            <>Ожидание приёма одинаково</>
          )}
          {stopsCut != null && stopsCut > 0 && (
            <span className="headline-sub">
              и убирает <b className="num">{stopsCut}%</b> остановок у входного сигнала
            </span>
          )}
        </div>

        <div className="vs">
          <div className="vs-col vs-base">
            <div className="vs-h">
              <User size={16} /> Без ИИ (FCFS)
              <span className="muted small">реактивный диспетчер «первым пришёл — первым принят»</span>
            </div>
            <IndexGauge index={frame.compare.baseline.index} label="Индекс · FCFS" />
          </div>
          <div className="vs-mid">
            <span className={`vs-diff num ${idxDiff >= 0 ? 'pos' : 'neg'}`}>
              {idxDiff >= 0 ? '+' : '−'}
              {fmtNum(Math.abs(idxDiff), 1)}
            </span>
            <span className="muted small">баллов индекса</span>
          </div>
          <div className="vs-col vs-ai">
            <div className="vs-h">
              <Bot size={16} /> С ИИ
              <span className="muted small">CP-SAT: слоты, пути, ресурсы, виртуальная очередь</span>
            </div>
            <IndexGauge index={frame.compare.ai.index} label="Индекс · ИИ" />
          </div>
        </div>

        <table className="vs-table">
          <thead>
            <tr>
              <th scope="col">Показатель</th>
              <th scope="col">Без ИИ (FCFS)</th>
              <th scope="col">С ИИ</th>
              <th scope="col">Разница</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const a = r.get(ai);
              const b = r.get(base);
              return (
                <tr key={r.name}>
                  <th scope="row">{r.name}</th>
                  <td className="num vs-b">{Number.isFinite(b) ? r.fmt(b) : '—'}</td>
                  <td className="num vs-a">{Number.isFinite(a) ? r.fmt(a) : '—'}</td>
                  <td>
                    <Delta ai={a} base={b} better={r.better} digits={r.digits ?? 1} pct />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="compare-charts">
          <EChart option={idxOpt} ariaLabel="График индекса состояния станции для двух двойников за 15 минут" />
          <EChart option={qOpt} ariaLabel="График длины очереди на подходе для двух двойников за 15 минут" />
        </div>
      </div>
    </section>
  );
}
