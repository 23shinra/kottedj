/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo } from 'react';
import { useStore, useViewFrame, useViewPlan } from '../../store';
import type { TrainCat } from '../../types';
import { echarts, axisCommon, tooltipBase, FONT } from '../../utils/echarts';
import { CAT_COLOR, CAT_NAME, PARK_SHORT, SEMANTIC, STATUS_NAME } from '../../utils/theme';
import { clock, startOffset } from '../../utils/time';
import { EChart } from './EChart';

const BEFORE = 30 * 60;
const AFTER = 120 * 60;
const DEP_TAIL = 180; // dep_at + 3 мин — освобождение пути

interface BarMeta {
  id: string;
  cat: TrainCat;
  kind: 'actual' | 'plan';
  track: string;
  start: number;
  end: number;
  status: string;
  reason: string | null;
  missing: boolean;
  slot?: number;
}

export function GanttChart() {
  const station = useStore((s) => s.station);
  const frame = useViewFrame();
  const plan = useViewPlan();
  const select = useStore((s) => s.select);
  const state = frame?.state;
  const now = state?.sim_time ?? 0;

  const option = useMemo(() => {
    if (!station || !state) return {};
    const tracks = station.tracks;
    const idx = new Map(tracks.map((t, i) => [t.id, i]));
    const parkOf = new Map(tracks.map((t) => [t.id, t.park]));
    const x0 = now - BEFORE;
    const x1 = now + AFTER;
    // метки времени — по ровным получасам суток
    const off = startOffset();
    const ticks: number[] = [];
    for (let t = Math.ceil((x0 + off) / 1800) * 1800 - off; t <= x1; t += 1800) ticks.push(t);
    const bars: BarMeta[] = [];
    const trainsById = new Map(state.trains.map((t) => [t.id, t]));
    const upcomingById = new Map(state.upcoming.map((u) => [u.id, u]));

    // фактическая занятость
    for (const t of state.trains) {
      if (t.entered_at == null || !t.track) continue;
      const end = t.departed_at != null && t.status === 'departed' ? t.departed_at + 60 : now;
      if (end < x0) continue;
      bars.push({ id: t.id, cat: t.cat, kind: 'actual', track: t.track, start: t.entered_at, end, status: t.status, reason: t.reason_text, missing: false });
    }
    // план
    for (const [id, a] of Object.entries(plan?.assignments ?? {})) {
      const t = trainsById.get(id);
      const u = upcomingById.get(id);
      const cat = t?.cat ?? u?.cat;
      if (!cat) continue;
      if (t && (t.status === 'departed' || t.status === 'rerouted')) continue;
      const started = t?.entered_at != null;
      const start = started ? Math.max(now, t!.entered_at!) : a.entry_at ?? null;
      if (start == null) continue;
      const end = a.dep_at + DEP_TAIL;
      if (end <= start || start > x1) continue;
      bars.push({
        id,
        cat,
        kind: 'plan',
        track: started ? t!.track ?? a.track : a.track,
        start,
        end,
        status: t?.status ?? 'scheduled',
        reason: t?.reason_text ?? null,
        missing: !!(a.loco_missing || a.crew_missing),
        slot: a.entry_at,
      });
    }

    const closed = state.tracks
      .filter((t) => t.status === 'closed')
      .map((t) => ({ value: [idx.get(t.id) ?? 0, x0, t.closed_until ?? x1] }));
    const reserve = state.tracks.filter((t) => t.status === 'reserve').map((t) => ({ value: [idx.get(t.id) ?? 0, x0, x1] }));

    const bandData = tracks.map((t, i) => ({ value: [i], park: t.park, first: i === 0 || tracks[i - 1].park !== t.park }));

    const barData = bars
      .filter((b) => idx.has(b.track))
      .map((b) => ({ value: [idx.get(b.track)!, b.start, b.end], meta: b }));

    const renderBand = (params: any, api: any) => {
      const i = api.value(0);
      const cs = params.coordSys;
      const y = api.coord([cs.x, i])[1];
      const h = api.size([0, 1])[1];
      const item = bandData[params.dataIndex];
      const children: any[] = [
        {
          type: 'rect',
          shape: { x: cs.x, y: y - h / 2, width: cs.width, height: h },
          style: { fill: item.park === 'P' ? 'rgba(57,135,229,0.035)' : item.park === 'G' ? 'rgba(25,158,112,0.035)' : 'rgba(217,89,38,0.03)' },
        },
      ];
      if (item.first && params.dataIndex > 0) {
        children.push({ type: 'line', shape: { x1: cs.x - 46, y1: y - h / 2, x2: cs.x + cs.width, y2: y - h / 2 }, style: { stroke: '#2b3a57', lineWidth: 1 } });
      }
      return { type: 'group', children, silent: true };
    };

    const renderSpan = (kind: 'closed' | 'reserve') => (params: any, api: any) => {
      const i = api.value(0);
      const s = api.coord([api.value(1), i]);
      const e = api.coord([api.value(2), i]);
      const h = api.size([0, 1])[1] * 0.8;
      const rect = echarts.graphic.clipRectByRect(
        { x: s[0], y: s[1] - h / 2, width: e[0] - s[0], height: h },
        { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
      );
      if (!rect) return null;
      return {
        type: 'group',
        children: [
          {
            type: 'rect',
            shape: { ...rect, r: 3 },
            style:
              kind === 'closed'
                ? { fill: 'rgba(240,68,56,0.16)', stroke: 'rgba(240,68,56,0.7)', lineWidth: 1, lineDash: [4, 3] }
                : { fill: 'rgba(138,155,181,0.05)', stroke: 'rgba(138,155,181,0.45)', lineWidth: 1, lineDash: [3, 3] },
          },
          {
            type: 'text',
            style: {
              x: rect.x + rect.width - 6,
              y: rect.y + rect.height / 2,
              text: kind === 'closed' ? `закрыт до ${clock(api.value(2))}` : 'резерв',
              fill: kind === 'closed' ? '#ff8a80' : SEMANTIC.muted,
              font: `600 10px ${FONT}`,
              align: 'right',
              verticalAlign: 'middle',
            },
          },
        ],
      };
    };

    const renderBar = (params: any, api: any) => {
      const i = api.value(0);
      const s = api.coord([api.value(1), i]);
      const e = api.coord([api.value(2), i]);
      const meta: BarMeta = barData[params.dataIndex].meta;
      const plan = meta.kind === 'plan';
      const h = api.size([0, 1])[1] * (plan ? 0.5 : 0.62);
      const rect = echarts.graphic.clipRectByRect(
        { x: s[0], y: s[1] - h / 2, width: Math.max(2, e[0] - s[0] - 2), height: h },
        { x: params.coordSys.x, y: params.coordSys.y, width: params.coordSys.width, height: params.coordSys.height },
      );
      if (!rect) return null;
      const c = CAT_COLOR[meta.cat];
      const children: any[] = [
        {
          type: 'rect',
          shape: { ...rect, r: 3 },
          style: plan
            ? { fill: echarts.color.modifyAlpha(c, 0.22), stroke: meta.missing ? SEMANTIC.crit : c, lineWidth: meta.missing ? 1.5 : 1, lineDash: [4, 2] }
            : { fill: echarts.color.modifyAlpha(c, 0.88), stroke: 'rgba(11,18,32,0.9)', lineWidth: 1 },
        },
      ];
      if (rect.width > 34) {
        children.push({
          type: 'text',
          style: {
            x: rect.x + 5,
            y: rect.y + rect.height / 2,
            text: `${meta.missing ? '⚠ ' : ''}${meta.id}`,
            fill: plan ? '#d7e0ee' : '#fff',
            font: `${plan ? 500 : 600} 10px ${FONT}`,
            verticalAlign: 'middle',
            overflow: 'truncate',
            width: rect.width - 8,
          },
        });
      }
      return { type: 'group', children };
    };

    return {
      animation: false,
      grid: { left: 52, right: 14, top: 24, bottom: 18 },
      tooltip: {
        ...tooltipBase,
        trigger: 'item',
        formatter: (p: any) => {
          const m: BarMeta | undefined = p.data?.meta;
          if (!m) return '';
          return `<div style="min-width:200px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <span style="width:10px;height:10px;border-radius:2px;background:${CAT_COLOR[m.cat]}"></span>
              <b>№${m.id}</b><span style="color:${SEMANTIC.muted}">${CAT_NAME[m.cat]}</span></div>
            <div>${m.kind === 'actual' ? 'Фактическая занятость' : 'План ИИ'} · путь <b>${m.track}</b></div>
            <div style="font-variant-numeric:tabular-nums">${clock(m.start)} → ${clock(m.end)}${m.kind === 'plan' ? ' (вкл. 3 мин на освобождение)' : ''}</div>
            ${m.slot != null ? `<div>Слот входа: <b>${clock(m.slot)}</b></div>` : ''}
            <div style="color:${SEMANTIC.muted}">${STATUS_NAME[m.status as keyof typeof STATUS_NAME] ?? m.status}${m.reason ? ' — ' + m.reason : ''}</div>
            ${m.missing ? `<div style="color:${SEMANTIC.crit}">⚠ не хватает локомотива/бригады</div>` : ''}
          </div>`;
        },
      },
      xAxis: {
        type: 'value',
        min: x0,
        max: x1,
        position: 'top',
        ...axisCommon,
        axisTick: { ...axisCommon.axisTick, customValues: ticks },
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => clock(v), customValues: ticks },
        splitLine: { ...axisCommon.splitLine, customValues: ticks },
      },
      yAxis: {
        type: 'category',
        data: tracks.map((t) => t.id),
        inverse: true,
        ...axisCommon,
        splitLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          ...axisCommon.axisLabel,
          formatter: (v: string) => `{n|${v}} {p|${PARK_SHORT[parkOf.get(v) ?? ''] ?? ''}}`,
          rich: {
            n: { color: SEMANTIC.text2, fontWeight: 600, fontSize: 11, fontFamily: FONT, width: 16, align: 'right' },
            p: { color: SEMANTIC.muted, fontSize: 9, fontFamily: FONT, width: 16 },
          },
        },
      },
      series: [
        { id: 'bands', type: 'custom', renderItem: renderBand, data: bandData, silent: true, encode: { y: 0 }, z: 0, tooltip: { show: false } },
        { id: 'reserve', type: 'custom', renderItem: renderSpan('reserve'), data: reserve, silent: true, encode: { x: [1, 2], y: 0 }, z: 1, tooltip: { show: false } },
        { id: 'closed', type: 'custom', renderItem: renderSpan('closed'), data: closed, silent: true, encode: { x: [1, 2], y: 0 }, z: 1, tooltip: { show: false } },
        {
          id: 'bars',
          type: 'custom',
          renderItem: renderBar,
          data: barData,
          encode: { x: [1, 2], y: 0 },
          z: 3,
          markLine: {
            silent: true,
            symbol: 'none',
            animation: false,
            lineStyle: { color: SEMANTIC.accent, width: 1.5, type: 'solid' },
            label: { show: true, position: 'end', formatter: `сейчас ${clock(now)}`, color: SEMANTIC.accent, fontSize: 10, fontFamily: FONT, fontWeight: 600 },
            data: [{ xAxis: now }],
          },
        },
      ],
    };
  }, [station, state, plan, now]);

  const onEvents = useMemo(
    () => ({
      click: (p: unknown) => {
        const m = (p as { data?: { meta?: BarMeta } }).data?.meta;
        if (m) select({ kind: 'train', id: m.id });
      },
    }),
    [select],
  );

  return (
    <div className="gantt-wrap">
      <EChart option={option} onEvents={onEvents} ariaLabel="Диаграмма занятости путей: факт и план ИИ на 2 часа вперёд" replaceMerge={['series']} />
      <div className="chart-legend" aria-hidden="false">
        {(Object.keys(CAT_COLOR) as TrainCat[]).map((c) => (
          <span key={c} className="lg">
            <i className="lg-sw" style={{ background: CAT_COLOR[c] }} />
            {CAT_NAME[c]}
          </span>
        ))}
        <span className="lg">
          <i className="lg-sw lg-solid" /> факт
        </span>
        <span className="lg">
          <i className="lg-sw lg-plan" /> план ИИ
        </span>
        <span className="lg">
          <i className="lg-sw lg-closed" /> закрыт
        </span>
        <span className="lg lg-crit">⚠ нет локомотива/бригады</span>
      </div>
    </div>
  );
}
