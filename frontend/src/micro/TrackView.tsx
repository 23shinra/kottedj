import { memo, useMemo } from 'react';
import { useMicro } from './store';
import { highlight, indexes } from './graph';
import type { MicroFrame, MicroStatic, MSegment, MTrain } from './types';

const VB = { x: 0, y: 60, w: 1600, h: 700 };

const SW_GLYPH: Record<string, { t: string; cls: string; label: string }> = {
  ok: { t: '', cls: 'sw-ok', label: 'положение подтверждено' },
  moving: { t: '↻', cls: 'sw-moving', label: 'переводится' },
  unknown: { t: '?', cls: 'sw-unknown', label: 'положение неизвестно' },
  confirming: { t: '…', cls: 'sw-unknown', label: 'восстановление контроля' },
  fault: { t: '✕', cls: 'sw-fault', label: 'неисправна' },
  repairing: { t: 'Р', cls: 'sw-repair', label: 'в ремонте' },
};

function pt(ix: ReturnType<typeof indexes>, seg: MSegment, m: number): [number, number] {
  const a = ix.nodes[seg.a];
  const b = ix.nodes[seg.b];
  const f = Math.max(0, Math.min(1, m / seg.length_m));
  return [a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f];
}

function trainState(tr: MTrain): { cls: string; icon: string; label: string } {
  if (tr.status === 'standing') return { cls: 'tr-stand', icon: '■', label: tr.op_ru };
  if (tr.status === 'ready') return tr.blockers.length ? { cls: 'tr-wait', icon: '⏸', label: 'ждёт маршрут' } : { cls: 'tr-stand', icon: '✓', label: 'готов' };
  if (tr.v_kmh < 0.5 && (tr.stop_reason || tr.blockers.length)) return { cls: 'tr-wait', icon: '⏸', label: 'стоит' };
  return { cls: 'tr-move', icon: tr.dir === 'E' ? '▶' : '◀', label: `${Math.round(tr.v_kmh)} км/ч` };
}

export const TrackView = memo(function TrackView() {
  const stat = useMicro((s) => s.stat);
  const frame = useMicro((s) => s.frame);
  const sel = useMicro((s) => s.sel);
  if (!stat) return <div className="skeleton">Загрузка путевой схемы…</div>;
  return <TrackSvg stat={stat} frame={frame} selKey={sel ? `${sel.kind}:${sel.id}` : ''} />;
});

function TrackSvg({ stat, frame, selKey }: { stat: MicroStatic; frame: MicroFrame | null; selKey: string }) {
  const select = useMicro((s) => s.select);
  const sel = useMicro((s) => s.sel);
  const ix = indexes(stat);
  const hl = useMemo(() => highlight(stat, frame, sel), [stat, frame, sel]);
  const segs = stat.infra.segments;
  const segMap = useMemo(() => Object.fromEntries(segs.map((s) => [s.id, s])), [segs]);
  const routeOf = (id: string) => frame?.routes.find((r) => r.id === id);

  return (
    <svg
      className="trk"
      viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`}
      role="img"
      aria-label="Путевая схема станции: участки, стрелки, сигналы и поезда"
      preserveAspectRatio="xMidYMid meet"
    >
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="6" fill="var(--crit)" />
        </pattern>
      </defs>

      <text x={700} y={78} className="park-label">Парк колеи 1520 мм</text>
      <text x={700} y={590} className="park-label park-1435">Парк колеи 1435 мм (тупиковый)</text>
      <g className="tx-front">
        <rect x={660} y={472} width={300} height={36} rx={6} />
        <text x={810} y={494} textAnchor="middle">
          Перегрузочный фронт 1435 → 1520 · склад {Math.round(frame?.stock_t ?? 0)} т
        </text>
      </g>

      {segs.map((s) => {
        const a = ix.nodes[s.a];
        const b = ix.nodes[s.b];
        const st = frame?.segments[s.id];
        const locked = !!st?.lock;
        const r = st?.lock ? routeOf(st.lock) : undefined;
        const cls = [
          'seg',
          `g${s.gauge}`,
          `k-${s.kind}`,
          locked ? (r?.state === 'setting' ? 'seg-setting' : 'seg-locked') : '',
          st?.false ? 'seg-false' : '',
          hl.objects.has(`segment:${s.id}`) ? 'seg-hl' : '',
          selKey === `segment:${s.id}` ? 'seg-sel' : '',
        ].join(' ');
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        const label =
          s.kind === 'track' ? `${s.id} · ${s.length_m} м` : s.kind === 'approach' ? `${s.name} · ${s.length_m / 1000} км` : '';
        return (
          <g key={s.id} className={cls}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="seg-base" />
            {st?.false && <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="seg-false-line" stroke="url(#hatch)" />}
            <line
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className="seg-hit"
              onClick={() => select({ kind: 'segment', id: s.id })}
              tabIndex={0}
              role="button"
              aria-label={`Участок ${s.name}${st?.false ? ', ложная занятость' : ''}${locked ? `, замкнут маршрутом ${st?.lock}` : ''}`}
              onKeyDown={(e) => e.key === 'Enter' && select({ kind: 'segment', id: s.id })}
            />
            {label && (
              <text x={mx} y={my - 9} className={`seg-label ${s.kind === 'track' ? 'seg-label-track' : ''}`} textAnchor="middle">
                {label}
                {s.platform ? ' · платформа' : ''}
              </text>
            )}
            {st?.false && (
              <text x={mx} y={my + 16} className="seg-false-tag" textAnchor="middle">
                ЛЗ
              </text>
            )}
          </g>
        );
      })}

      {stat.infra.nodes
        .filter((n) => n.kind === 'boundary' || n.kind === 'buffer')
        .map((n) => (
          <g key={n.id} className={`nd nd-${n.kind}`}>
            {n.kind === 'buffer' ? (
              <line x1={n.x} y1={n.y - 8} x2={n.x} y2={n.y + 8} />
            ) : (
              <text x={n.x} y={n.y + 24} textAnchor={n.x < 800 ? 'start' : 'end'} className="bnd-label">
                {n.label}
              </text>
            )}
          </g>
        ))}

      {frame?.trains.map((tr) => {
        if (!tr.occ.length) return null;
        const ts = trainState(tr);
        const parts = tr.occ.map(([sid, from, to]) => {
          const s = segMap[sid];
          const p1 = pt(ix, s, from);
          const p2 = pt(ix, s, to);
          return { sid, p1, p2 };
        });
        const headSeg = segMap[tr.occ[0][0]];
        const headM = tr.dir === 'E' ? tr.occ[0][2] : tr.occ[0][1];
        const [hx, hy] = pt(ix, headSeg, headM);
        const sel2 = selKey === `train:${tr.id}`;
        return (
          <g
            key={tr.id}
            className={`trn ${tr.kind === 'passenger' ? 'trn-pass' : 'trn-freight'} g${tr.consist.gauge} ${ts.cls} ${sel2 ? 'trn-sel' : ''}`}
            onClick={() => select({ kind: 'train', id: tr.id })}
            role="button"
            tabIndex={0}
            aria-label={`Поезд ${tr.id}: ${tr.status_ru}, ${ts.label}`}
            onKeyDown={(e) => e.key === 'Enter' && select({ kind: 'train', id: tr.id })}
          >
            {parts.map((p) => (
              <line key={p.sid} x1={p.p1[0]} y1={p.p1[1]} x2={p.p2[0]} y2={p.p2[1]} className="trn-body" />
            ))}
            <circle cx={hx} cy={hy} r={6} className="trn-head" />
            <g transform={`translate(${hx}, ${hy - 24})`}>
              <rect x={-36} y={-12} width={72} height={21} rx={4} className="trn-tag" />
              <text x={0} y={3} textAnchor="middle" className="trn-tag-t">
                {ts.icon} {tr.id}
              </text>
            </g>
          </g>
        );
      })}

      {stat.infra.switches.map((sw) => {
        const n = ix.nodes[sw.node];
        const st = frame?.switches[sw.id];
        const g = SW_GLYPH[st?.state ?? 'ok'];
        const branch = segMap[st?.pos === '-' ? sw.reverse : sw.normal];
        const other = branch.a === sw.node ? ix.nodes[branch.b] : ix.nodes[branch.a];
        const dx = other.x - n.x;
        const dy = other.y - n.y;
        const len = Math.hypot(dx, dy) || 1;
        const known = st && (st.state === 'ok' || st.state === 'moving');
        const hlOn = hl.objects.has(`switch:${sw.id}`);
        return (
          <g
            key={sw.id}
            className={`sw ${g.cls} ${st?.locked_by ? 'sw-locked' : ''} ${hlOn ? 'sw-hl' : ''} ${selKey === `switch:${sw.id}` ? 'sw-sel' : ''}`}
            onClick={() => select({ kind: 'switch', id: sw.id })}
            role="button"
            tabIndex={0}
            aria-label={`Стрелка ${sw.id}: ${g.label}${known ? `, положение ${st?.pos === '+' ? 'плюсовое' : 'минусовое'}` : ''}`}
            onKeyDown={(e) => e.key === 'Enter' && select({ kind: 'switch', id: sw.id })}
          >
            {known && <line x1={n.x} y1={n.y} x2={n.x + (dx / len) * 22} y2={n.y + (dy / len) * 22} className="sw-pos" />}
            <circle cx={n.x} cy={n.y} r={g.t ? 11 : 5} className="sw-dot" />
            {g.t && (
              <text x={n.x} y={n.y + 5} textAnchor="middle" className="sw-glyph">
                {g.t}
              </text>
            )}
            <text x={n.x - 4} y={n.y - 12} textAnchor="end" className="sw-label">
              {sw.id}
              {known ? (st?.pos === '+' ? '+' : '−') : ''}
            </text>
          </g>
        );
      })}

      {stat.infra.signals.map((sg) => {
        const n = ix.nodes[sg.node];
        const st = frame?.signals[sg.id];
        const side = sg.dir === 'E' ? 1 : -1;
        const x = n.x - side * 10;
        const y = n.y + side * 15;
        const aspect = st?.dark ? 'dark' : st?.open ? 'open' : 'closed';
        const text = aspect === 'dark' ? 'погашен' : aspect === 'open' ? `открыт (${st?.route})` : 'закрыт';
        return (
          <g
            key={sg.id}
            className={`sig sig-${aspect} ${hl.objects.has(`signal:${sg.id}`) ? 'sig-hl' : ''} ${selKey === `signal:${sg.id}` ? 'sig-sel' : ''}`}
            onClick={() => select({ kind: 'signal', id: sg.id })}
            role="button"
            tabIndex={0}
            aria-label={`Светофор ${sg.id}: ${text}`}
            onKeyDown={(e) => e.key === 'Enter' && select({ kind: 'signal', id: sg.id })}
          >
            <line x1={x - side * 7} y1={y} x2={x} y2={y} className="sig-mast" />
            <circle cx={x + side * 5} cy={y} r={5} className="sig-lamp" />
            {aspect === 'dark' && (
              <text x={x + side * 5} y={y + 3.5} textAnchor="middle" className="sig-x">
                ×
              </text>
            )}
            <text x={x + side * 13} y={y + 4} textAnchor={side > 0 ? 'start' : 'end'} className="sig-label">
              {sg.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function TrackLegend() {
  return (
    <div className="mlegend" aria-label="Условные обозначения путевой схемы">
      <span><i className="lg-line lg-free" />свободен</span>
      <span><i className="lg-line lg-locked" />маршрут замкнут</span>
      <span><i className="lg-line lg-setting" />маршрут устанавливается</span>
      <span><i className="lg-line lg-false" />ЛЗ — ложная занятость</span>
      <span><i className="lg-line lg-1435" />колея 1435</span>
      <span><i className="lg-train lg-freight" />грузовой</span>
      <span><i className="lg-train lg-pass" />пассажирский</span>
      <span><b className="lg-g">▶</b>движется</span>
      <span><b className="lg-g">⏸</b>ожидает</span>
      <span><b className="lg-g">■</b>операция на пути</span>
      <span><b className="lg-g">?</b>стрелка без контроля</span>
      <span><b className="lg-g">✕</b>неисправна</span>
      <span><b className="lg-g">Р</b>в ремонте</span>
      <span><i className="lg-lamp lg-open" />открыт</span>
      <span><i className="lg-lamp lg-closed" />закрыт</span>
      <span><i className="lg-lamp lg-dark" />× погашен</span>
    </div>
  );
}
