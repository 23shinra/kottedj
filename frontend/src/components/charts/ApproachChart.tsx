/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo } from 'react';
import { useStore, useViewFrame, useViewPlan } from '../../store';
import type { TrainCat } from '../../types';
import { axisCommon, tooltipBase, FONT } from '../../utils/echarts';
import { CAT_COLOR, CAT_NAME, SEMANTIC } from '../../utils/theme';
import { clock } from '../../utils/time';
import { EChart } from './EChart';

const CATS: TrainCat[] = ['pass', 'freight_transit', 'freight_local'];

/**
 * Диаграмма подхода: расстояние до входного сигнала во времени.
 * Запад — выше нуля, восток — ниже. Пунктир — плановая траектория к слоту входа.
 */
export function ApproachChart() {
  const frame = useViewFrame();
  const plan = useViewPlan();
  const select = useStore((s) => s.select);
  const state = frame?.state;
  const now = state?.sim_time ?? 0;

  const option = useMemo(() => {
    if (!state) return {};
    const pending = state.trains.filter((t) => ['approaching', 'held', 'at_signal'].includes(t.status));
    const sign = (side: string) => (side === 'W' ? 1 : -1);
    const traj = pending.map((t) => {
      const a = plan?.assignments[t.id];
      const arrive = a?.entry_at ?? t.eta;
      const d = (t.pos_m / 1000) * sign(t.side_in);
      return { value: [now, d, Math.max(now + 30, arrive), 0], cat: t.cat, id: t.id, stop: t.status === 'at_signal' };
    });
    const renderTraj = (params: any, api: any) => {
      const it = traj[params.dataIndex];
      const p0 = api.coord([api.value(0), api.value(1)]);
      const p1 = api.coord([api.value(2), api.value(3)]);
      return {
        type: 'line',
        shape: { x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] },
        style: { stroke: CAT_COLOR[it.cat as TrainCat], lineWidth: 1.5, lineDash: [5, 4], opacity: 0.75 },
        silent: true,
      };
    };
    return {
      animation: false,
      grid: { left: 64, right: 18, top: 30, bottom: 28 },
      legend: {
        top: 0,
        right: 10,
        textStyle: { color: SEMANTIC.text2, fontSize: 11, fontFamily: FONT },
        itemWidth: 10,
        itemHeight: 10,
        data: CATS.map((c) => CAT_NAME[c]),
      },
      tooltip: {
        ...tooltipBase,
        trigger: 'item',
        formatter: (p: any) => {
          const d = p.data;
          if (!d?.id) return '';
          return `<b>№${d.id}</b> · ${CAT_NAME[d.cat as TrainCat]}<br/>${Math.abs(d.value[1]).toFixed(1)} км до сигнала ${d.value[1] >= 0 ? 'W' : 'E'}<br/>${d.info}`;
        },
      },
      xAxis: {
        type: 'value',
        min: now - 5 * 60,
        max: now + 60 * 60,
        interval: 900,
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => clock(v) },
      },
      yAxis: {
        type: 'value',
        min: -15,
        max: 15,
        interval: 5,
        name: 'км до входного сигнала',
        nameLocation: 'middle',
        nameGap: 44,
        nameTextStyle: { color: SEMANTIC.muted, fontSize: 11, fontFamily: FONT },
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => (v === 0 ? 'сигнал' : `${v > 0 ? 'W' : 'E'} ${Math.abs(v)}`) },
      },
      series: [
        {
          id: 'traj',
          type: 'custom',
          renderItem: renderTraj,
          data: traj,
          encode: { x: [0, 2], y: [1, 3] },
          z: 1,
          tooltip: { show: false },
          markLine: {
            silent: true,
            symbol: 'none',
            data: [
              { yAxis: 0, lineStyle: { color: SEMANTIC.crit, type: 'solid', width: 1.5 }, label: { formatter: 'входной сигнал', color: SEMANTIC.crit, position: 'insideEndTop', fontSize: 10 } },
              { xAxis: now, lineStyle: { color: SEMANTIC.accent, type: 'solid', width: 1.5 }, label: { formatter: `сейчас ${clock(now)}`, color: SEMANTIC.accent, fontSize: 10 } },
            ],
          },
        },
        ...CATS.map((c) => ({
          id: `pts-${c}`,
          name: CAT_NAME[c],
          type: 'scatter',
          symbol: c === 'pass' ? 'circle' : c === 'freight_transit' ? 'rect' : 'diamond',
          symbolSize: 11,
          itemStyle: { color: CAT_COLOR[c], borderColor: SEMANTIC.surface, borderWidth: 2 },
          z: 3,
          label: { show: true, position: 'right', formatter: (p: any) => p.data.id, color: SEMANTIC.text2, fontSize: 10, fontFamily: FONT },
          data: pending
            .filter((t) => t.cat === c)
            .map((t) => {
              const a = plan?.assignments[t.id];
              const info =
                t.status === 'at_signal'
                  ? `<span style="color:${SEMANTIC.critText}">■ стоит у сигнала</span>`
                  : t.status === 'held'
                    ? 'удержан на предыдущей станции'
                    : t.regulated && t.advisory_kmh
                      ? `▼ ${Math.round(t.advisory_kmh)} км/ч (регулирование)`
                      : `${Math.round(t.speed_kmh)} км/ч`;
              return {
                value: [now, (t.pos_m / 1000) * sign(t.side_in)],
                id: t.id,
                cat: t.cat,
                info: `${info}${a?.entry_at ? `<br/>слот входа ${clock(a.entry_at)} · путь ${a.track}` : ''}`,
                itemStyle: t.status === 'at_signal' ? { borderColor: SEMANTIC.crit, borderWidth: 3 } : undefined,
              };
            }),
        })),
      ],
    };
  }, [state, plan, now]);

  const onEvents = useMemo(
    () => ({
      click: (p: unknown) => {
        const id = (p as { data?: { id?: string } }).data?.id;
        if (id) select({ kind: 'train', id });
      },
    }),
    [select],
  );

  return <EChart option={option} onEvents={onEvents} ariaLabel="Диаграмма подхода: расстояние поездов до входного сигнала и плановые траектории к слотам" />;
}
