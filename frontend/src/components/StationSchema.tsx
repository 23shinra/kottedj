import { memo, useMemo } from 'react';
import { Hand, Pause, TrainFront, Gauge as GaugeIc } from 'lucide-react';
import { useStore, useViewFrame, useViewPlan } from '../store';
import type { LadderState, Plan, Side, Station, TrackState, Train } from '../types';
import { useSize } from '../utils/hooks';
import { CAT_COLOR, CAT_NAME, catColor } from '../utils/theme';
import { clock } from '../utils/time';
import { serviceProgress } from '../utils/derive';
import { DetailsCard } from './DetailsCard';
import { CatIcon } from './common';

/* ======================= Геометрия ======================= */
interface TrackGeo {
  id: string;
  park: string;
  y: number;
  ladderW: string;
  ladderE: string;
  xW: number; // точка ответвления от стрелочной улицы W
  xE: number;
  length_m: number;
  platform: boolean;
  reserve: boolean;
}
interface Layout {
  W: number;
  H: number;
  yMain: number;
  pitch: number;
  apW: [number, number]; // x начала перегона (15 км) и входного сигнала
  apE: [number, number];
  thW: [number, number];
  thE: [number, number];
  body: [number, number];
  tracks: TrackGeo[];
  parks: { id: string; name: string; y0: number; y1: number; label: string }[];
  platforms: { y: number; label: string }[];
  ladders: { id: string; side: Side; x0: number; y0: number; x1: number; y1: number; points: { x: number; y: number }[] }[];
}

const PARK_LABEL: Record<string, string> = {
  P: 'Пассажирский парк',
  PO: 'Приёмо-отправочный парк',
  G: 'Грузовой парк',
};

function computeLayout(st: Station, W: number, H: number): Layout {
  const apLen = Math.max(190, Math.min(340, W * 0.2));
  const thLen = Math.max(84, Math.min(150, W * 0.085));
  const pad = 10;
  const apW: [number, number] = [pad + 34, pad + apLen];
  const thW: [number, number] = [apW[1] + 8, apW[1] + 8 + thLen];
  const apE: [number, number] = [W - pad - 34, W - pad - apLen];
  const thE: [number, number] = [apE[1] - 8 - thLen, apE[1] - 8];
  const body: [number, number] = [thW[1] + 6, thE[0] - 6];

  const tracks = st.tracks;
  const units = tracks.length + 1.15 /*верх*/ + 0.5 * 2 /*платформы*/ + 1.15 * (st.parks.length - 1) + 0.55;
  const pitch = Math.max(16, Math.min(34, H / units));
  let y = pitch * 1.15;
  const geo: TrackGeo[] = [];
  const parks: Layout['parks'] = [];
  const platforms: Layout['platforms'] = [];
  let prevPark = '';
  let platN = 0;
  tracks.forEach((t, i) => {
    if (t.park !== prevPark) {
      if (prevPark) y += pitch * 1.15;
      parks.push({ id: t.park, name: st.parks.find((p) => p.id === t.park)?.name ?? t.park, y0: y, y1: y, label: '' });
      prevPark = t.park;
    }
    geo.push({
      id: t.id,
      park: t.park,
      y,
      ladderW: t.ladders.W,
      ladderE: t.ladders.E,
      xW: 0,
      xE: 0,
      length_m: t.length_m,
      platform: t.platform,
      reserve: t.reserve,
    });
    parks[parks.length - 1].y1 = y;
    const next = tracks[i + 1];
    // островная платформа между парой платформенных путей (1–2, 3–4)
    const pairStart = t.platform && platN % 2 === 0;
    if (t.platform) platN += 1;
    if (pairStart && next?.platform && next.park === t.park) {
      platforms.push({ y: y + pitch * 0.75, label: `Платформа ${platforms.length + 1}` });
      y += pitch * 1.5;
    } else {
      y += pitch;
    }
  });
  for (const p of parks) {
    const ids = geo.filter((g) => g.park === p.id).map((g) => g.id);
    p.label = `${PARK_LABEL[p.id] ?? p.name} · пути ${ids[0]}–${ids[ids.length - 1]}`;
  }

  // главный путь — между группами стрелочных улиц (A сверху, B снизу)
  const firstB = geo.findIndex((g) => g.ladderW.endsWith('B'));
  const yMain = firstB > 0 ? (geo[firstB - 1].y + geo[firstB].y) / 2 : (geo[0].y + geo[geo.length - 1].y) / 2;
  const maxDy = Math.max(...geo.map((g) => Math.abs(g.y - yMain)));
  const k = (thLen - 18) / maxDy;
  for (const g of geo) {
    const d = Math.abs(g.y - yMain) * k;
    g.xW = thW[0] + 8 + d;
    g.xE = thE[1] - 8 - d;
  }
  const ladders: Layout['ladders'] = [];
  for (const th of st.throats) {
    for (const l of th.ladders) {
      const served = geo.filter((g) => (th.id === 'W' ? g.ladderW : g.ladderE) === l.id);
      if (!served.length) continue;
      const far = served.reduce((a, b) => (Math.abs(b.y - yMain) > Math.abs(a.y - yMain) ? b : a));
      const x0 = th.id === 'W' ? thW[0] + 8 : thE[1] - 8;
      ladders.push({
        id: l.id,
        side: th.id,
        x0,
        y0: yMain,
        x1: th.id === 'W' ? far.xW : far.xE,
        y1: far.y,
        points: served.map((g) => ({ x: th.id === 'W' ? g.xW : g.xE, y: g.y })),
      });
    }
  }
  return { W, H: y + pitch * 0.2, yMain, pitch, apW, apE, thW, thE, body, tracks: geo, parks, platforms, ladders };
}

/* ======================= Слой: статичная инфраструктура ======================= */
const StaticLayer = memo(function StaticLayer({ L, station }: { L: Layout; station: Station }) {
  const apW = station.approaches.find((a) => a.id === 'W');
  const apE = station.approaches.find((a) => a.id === 'E');
  const thWName = station.throats.find((t) => t.id === 'W')?.name ?? 'Горловина W';
  const thEName = station.throats.find((t) => t.id === 'E')?.name ?? 'Горловина E';
  const km = [15, 10, 5, 0];
  const len = apW?.length_m ?? 15000;
  return (
    <g>
      {/* парки */}
      {L.parks.map((p) => (
        <g key={p.id}>
          <rect
            x={L.body[0] - 4}
            y={p.y0 - L.pitch * 0.5}
            width={L.body[1] - L.body[0] + 8}
            height={p.y1 - p.y0 + L.pitch}
            rx={6}
            className={`park-band park-${p.id}`}
          />
          <text x={L.body[0] + 4} y={p.y0 - L.pitch * 0.62} className="park-label">
            {p.label}
          </text>
        </g>
      ))}
      {L.platforms.map((p) => (
        <g key={p.label}>
          <rect x={L.body[0] + 34} y={p.y - 3.5} width={L.body[1] - L.body[0] - 68} height={7} rx={2} className="platform" />
          <text x={(L.body[0] + L.body[1]) / 2} y={p.y + 2.8} className="platform-label" textAnchor="middle">
            {p.label}
          </text>
        </g>
      ))}

      {/* перегоны */}
      <line x1={L.apW[0] - 26} y1={L.yMain} x2={L.thW[0] + 8} y2={L.yMain} className="rail main" />
      <line x1={L.apE[0] + 26} y1={L.yMain} x2={L.thE[1] - 8} y2={L.yMain} className="rail main" />
      <text x={L.apW[0] - 26} y={14} className="ap-label">
        {apW?.name ?? 'Перегон W'}
      </text>
      <text x={L.apE[0] + 26} y={14} className="ap-label" textAnchor="end">
        {apE?.name ?? 'Перегон E'}
      </text>
      {km.map((k) => {
        const xw = L.apW[1] - ((k * 1000) / len) * (L.apW[1] - L.apW[0]);
        const xe = L.apE[1] + ((k * 1000) / len) * (L.apE[0] - L.apE[1]);
        return (
          <g key={k} className="km">
            <line x1={xw} x2={xw} y1={L.yMain - 3} y2={L.yMain + 3} />
            <line x1={xe} x2={xe} y1={L.yMain - 3} y2={L.yMain + 3} />
            {k > 0 && (
              <>
                <text x={xw} y={L.yMain + 14} textAnchor="middle">
                  {k} км
                </text>
                <text x={xe} y={L.yMain + 14} textAnchor="middle">
                  {k} км
                </text>
              </>
            )}
          </g>
        );
      })}
      {/* соседние станции */}
      <g className="nb-station">
        <rect x={L.apW[0] - 34} y={L.yMain - 9} width={16} height={18} rx={3} />
        <rect x={L.apE[0] + 18} y={L.yMain - 9} width={16} height={18} rx={3} />
      </g>

      {/* горловины */}
      <text x={(L.thW[0] + L.thW[1]) / 2} y={L.H - 2} className="throat-label" textAnchor="middle">
        {thWName}
      </text>
      <text x={(L.thE[0] + L.thE[1]) / 2} y={L.H - 2} className="throat-label" textAnchor="middle">
        {thEName}
      </text>

      {/* соединения путей со стрелочными улицами */}
      {L.tracks.map((t) => (
        <g key={t.id}>
          <line x1={t.xW} y1={t.y} x2={L.body[0]} y2={t.y} className="rail" />
          <line x1={L.body[1]} y1={t.y} x2={t.xE} y2={t.y} className="rail" />
        </g>
      ))}
    </g>
  );
});

/* ======================= Слой: стрелочные улицы ======================= */
const LaddersLayer = memo(function LaddersLayer({ L, busy, now }: { L: Layout; busy: LadderState[]; now: number }) {
  return (
    <g>
      {L.ladders.map((l) => {
        const b = busy.find((x) => x.id === l.id && x.busy_until > now);
        const midX = (l.x0 + l.x1) / 2;
        const midY = (l.y0 + l.y1) / 2;
        const up = l.y1 < l.y0;
        return (
          <g key={l.id} className={`ladder ${b ? 'busy' : ''}`}>
            <title>{b ? `Стрелочная улица ${l.id} занята маршрутом №${b.train} до ${clock(b.busy_until)}` : `Стрелочная улица ${l.id} свободна`}</title>
            <line x1={l.x0} y1={l.y0} x2={l.x1} y2={l.y1} className="ladder-line" />
            {l.points.map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={2.4} className="switch" />
            ))}
            <g transform={`translate(${l.side === 'W' ? midX - 22 : midX + 22}, ${midY + (up ? -2 : 2)})`}>
              <rect x={-15} y={-8} width={30} height={16} rx={4} className="ladder-tag" />
              <text textAnchor="middle" y={4} className="ladder-tag-t">
                {l.id}
              </text>
            </g>
            {b && (
              <text
                x={l.side === 'W' ? midX - 40 : midX + 40}
                y={midY + (up ? -2 : 2) + 4}
                textAnchor={l.side === 'W' ? 'end' : 'start'}
                className="ladder-busy-t"
              >
                №{b.train} · до {clock(b.busy_until)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

/* ======================= Слой: пути ======================= */
function LockGlyph({ x, y }: { x: number; y: number }) {
  return (
    <g transform={`translate(${x - 5}, ${y - 7})`} className="lock" aria-hidden="true">
      <rect x={0} y={5} width={10} height={8} rx={1.5} />
      <path d="M2.2 5 V3.4 a2.8 2.8 0 0 1 5.6 0 V5" fill="none" />
    </g>
  );
}

const TrackRow = memo(function TrackRow({ g, L, ts, train, now, selected, onSelect, planned }: {
  g: TrackGeo;
  L: Layout;
  ts: TrackState | undefined;
  train: Train | undefined;
  now: number;
  selected: boolean;
  onSelect: (id: string, kind: 'track' | 'train') => void;
  planned: string | null;
}) {
  const x0 = L.body[0];
  const x1 = L.body[1];
  const bw = x1 - x0;
  const status = ts?.status ?? 'free';
  const h = Math.max(10, Math.min(16, L.pitch * 0.62));
  const barX = x0 + 30;
  const maxBar = bw - 30 - 52;
  const barW = train ? Math.max(40, Math.min(maxBar, (train.length_m / g.length_m) * maxBar)) : 0;
  const prog = train ? serviceProgress(train, now) : null;
  const reason = train?.reason_text ?? (train ? STATUS_SHORT[train.status] : null);
  const reasonFits = train && status !== 'closed' && maxBar - barW > 96;
  const label = `Путь ${g.id}, ${g.length_m} м, ${status === 'free' ? 'свободен' : status === 'occupied' ? `занят поездом ${ts?.train}` : status === 'closed' ? `закрыт до ${clock(ts?.closed_until)}` : 'резервный'}`;
  return (
    <g
      className={`track st-${status} ${selected ? 'sel' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => onSelect(train ? train.id : g.id, train ? 'train' : 'track')}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(train ? train.id : g.id, train ? 'train' : 'track'))}
    >
      <title>{label}</title>
      <rect x={x0} y={g.y - L.pitch / 2} width={bw} height={L.pitch} className="track-hit" />
      <line x1={x0} y1={g.y} x2={x1} y2={g.y} className="track-line" />
      <g className="track-no">
        <rect x={x0 + 2} y={g.y - 8} width={22} height={16} rx={4} />
        <text x={x0 + 13} y={g.y + 4} textAnchor="middle">
          {g.id}
        </text>
      </g>
      <text x={x1 - 4} y={g.y - 4} textAnchor="end" className="track-len">
        {g.length_m} м
      </text>

      {status === 'reserve' && !train && (
        <g>
          <rect x={x0 + 28} y={g.y - h / 2} width={bw - 32} height={h} rx={3} className="reserve-fill" />
          <text x={(x0 + x1) / 2} y={g.y + 4} textAnchor="middle" className="reserve-t">
            резерв · открыть по рекомендации
          </text>
        </g>
      )}
      {status !== 'closed' && status !== 'reserve' && !train && planned && (
        <text x={x0 + 34} y={g.y + 4} className="track-next">
          далее: №{planned}
        </text>
      )}
      {train && (
        <g className={`occ tr-${train.status}`} style={{ ['--c' as string]: catColor(train.cat) }}>
          <rect x={barX} y={g.y - h / 2} width={barW} height={h} rx={4} className="occ-bar" />
          {prog != null && (
            <>
              <rect x={barX + 3} y={g.y + h / 2 - 3.5} width={barW - 6} height={2} rx={1} className="occ-prog-bg" />
              <rect x={barX + 3} y={g.y + h / 2 - 3.5} width={(barW - 6) * prog} height={2} rx={1} className="occ-prog" />
            </>
          )}
          <text x={barX + 7} y={g.y + 3.6} className="occ-t">
            №{train.id}
            {prog != null && barW > 110 ? ` · ${Math.round(prog * 100)}%` : ''}
          </text>
          {(train.status === 'entering' || train.status === 'departing') && (
            <text x={barX + barW - 6} y={g.y + 3.6} textAnchor="end" className="occ-arrow">
              {(train.status === 'entering' ? train.side_in : train.side_out) === 'W'
                ? train.status === 'entering'
                  ? '→'
                  : '←'
                : train.status === 'entering'
                  ? '←'
                  : '→'}
            </text>
          )}
          {reasonFits && reason && (
            <text x={barX + barW + 8} y={g.y + 4} className="occ-reason">
              {reason}
            </text>
          )}
        </g>
      )}
      {status === 'closed' && (
        <g>
          <rect x={x0 + 28} y={g.y - h / 2 - 1} width={bw - 32} height={h + 2} rx={3} className={`closed-fill ${train ? 'over' : ''}`} />
          <LockGlyph x={x1 - 150} y={g.y} />
          <text x={x1 - 138} y={g.y + 4} className="closed-t">
            ЗАКРЫТ до {clock(ts?.closed_until)}
          </text>
        </g>
      )}
    </g>
  );
});

const STATUS_SHORT: Record<string, string> = {
  entering: 'приём',
  departing: 'отправление',
  on_track: 'стоянка',
};

/* ======================= Слой: поезда на подходе ======================= */
interface Chip {
  t: Train;
  side: Side;
  x: number; // точка на линии
  cx: number; // позиция фишки
  cy: number;
}
const CHIP_W = 100;
const CHIP_H = 30;

function layoutChips(trains: Train[], L: Layout): Chip[] {
  const res: Chip[] = [];
  const lanesAvail = Math.max(2, Math.floor((L.yMain - 26) / (CHIP_H + 6)));
  const laneY = (lane: number) => {
    const k = Math.floor(lane / 2) + 1;
    const above = lane % 2 === 0;
    return above ? L.yMain - 10 - k * (CHIP_H + 6) + CHIP_H / 2 - 4 : L.yMain + 18 + (k - 1) * (CHIP_H + 6) + CHIP_H / 2;
  };
  for (const side of ['W', 'E'] as Side[]) {
    const [a, s] = side === 'W' ? L.apW : L.apE;
    const list = trains
      .filter((t) => t.side_in === side)
      .map((t) => {
        const frac = Math.max(0, Math.min(1, t.pos_m / 15000));
        return { t, x: s + (a - s) * frac };
      })
      .sort((p, q) => (side === 'W' ? q.x - p.x : p.x - q.x)); // ближние к сигналу — первыми
    const laneEnds: number[] = [];
    for (const it of list) {
      let lane = 0;
      // фишка выравнивается по линии, но не выходит за перегон
      const lo = Math.min(a, s);
      const hi = Math.max(a, s);
      const cx = Math.max(lo + CHIP_W / 2 - 30, Math.min(hi - CHIP_W / 2 + 8, it.x));
      while (lane < lanesAvail * 2 && laneEnds[lane] != null && Math.abs(laneEnds[lane] - cx) < CHIP_W + 4) lane++;
      laneEnds[lane] = cx;
      res.push({ t: it.t, side, x: it.x, cx, cy: laneY(lane) });
    }
  }
  return res;
}

const ApproachChip = memo(function ApproachChip({ c, yMain, selected, onSelect }: {
  c: Chip;
  yMain: number;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const t = c.t;
  const atSignal = t.status === 'at_signal' || t.stopped_at_signal && t.pos_m <= 1;
  const held = t.status === 'held' || ((t.hold_until ?? 0) > 0 && t.speed_kmh === 0 && t.pos_m >= 14900);
  const sub = atSignal ? '■ стоит у сигнала' : held ? '❚❚ удержан' : t.regulated && t.advisory_kmh != null ? `▼ ${Math.round(t.advisory_kmh)} км/ч` : `${Math.round(t.speed_kmh)} км/ч`;
  const kmLeft = (t.pos_m / 1000).toFixed(1).replace('.', ',');
  const color = CAT_COLOR[t.cat];
  const label = `Поезд ${t.id}, ${CAT_NAME[t.cat]}, ${kmLeft} км до входного сигнала ${t.side_in}, ${atSignal ? 'стоит у входного сигнала' : held ? 'удержан на предыдущей станции' : t.regulated ? `регулирование скорости ${Math.round(t.advisory_kmh ?? 0)} км/ч` : 'на подходе'}`;
  const above = c.cy < yMain;
  return (
    <g
      className={`chip-g ${atSignal ? 'at-signal' : ''} ${held ? 'held' : ''} ${t.regulated ? 'regulated' : ''} ${selected ? 'sel' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => onSelect(t.id)}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(t.id))}
    >
      <title>{label}</title>
      {/* маркер на линии */}
      <g className="mv" style={{ transform: `translate(${c.x}px, ${yMain}px)` }}>
        <path d={c.side === 'W' ? 'M-6,-5 L5,0 L-6,5 Z' : 'M6,-5 L-5,0 L6,5 Z'} fill={color} className="mk" />
      </g>
      {/* выноска + фишка */}
      <g className="mv" style={{ transform: `translate(${c.cx}px, ${c.cy}px)` }}>
        <line x1={c.x - c.cx} y1={yMain - c.cy + (above ? -6 : 6)} x2={0} y2={above ? CHIP_H / 2 : -CHIP_H / 2} className="leader" />
        <rect x={-CHIP_W / 2} y={-CHIP_H / 2} width={CHIP_W} height={CHIP_H} rx={6} className="chip-bg" />
        <rect x={-CHIP_W / 2} y={-CHIP_H / 2} width={4} height={CHIP_H} rx={2} fill={color} />
        <text x={-CHIP_W / 2 + 10} y={-2} className="chip-no">
          №{t.id}
        </text>
        <text x={CHIP_W / 2 - 6} y={-2} className="chip-km" textAnchor="end">
          {kmLeft} км
        </text>
        <text x={-CHIP_W / 2 + 10} y={11} className={`chip-sub ${atSignal ? 'crit' : held ? 'warn' : t.regulated ? 'info' : ''}`}>
          {sub}
        </text>
      </g>
    </g>
  );
});

function Signal({ x, y, side, stop }: { x: number; y: number; side: Side; stop: number }) {
  const dir = side === 'W' ? 1 : -1;
  return (
    <g className={`signal ${stop ? 'stop' : 'go'}`} aria-label={`Входной сигнал ${side}: ${stop ? `стоят ${stop}` : 'свободно'}`}>
      <title>{`Входной сигнал ${side}${stop ? ` — у сигнала стоят: ${stop}` : ''}`}</title>
      <line x1={x} y1={y} x2={x} y2={y - 22} className="mast" />
      <line x1={x} y1={y - 22} x2={x + dir * 7} y2={y - 22} className="mast" />
      <circle cx={x + dir * 11} cy={y - 22} r={5} className="lamp" />
      {stop > 0 && (
        <g transform={`translate(${x + dir * 22}, ${y - 22})`}>
          <rect x={side === 'W' ? 0 : -28} y={-8} width={28} height={16} rx={4} className="stop-tag" />
          <text x={side === 'W' ? 14 : -14} y={4} textAnchor="middle" className="stop-tag-t">
            ■{stop}
          </text>
        </g>
      )}
    </g>
  );
}

/* ======================= Компонент ======================= */
export function StationSchema() {
  const station = useStore((s) => s.station);
  const frame = useViewFrame();
  const plan = useViewPlan();
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const [ref, size] = useSize<HTMLDivElement>();

  const L = useMemo(() => (station && size.w > 0 ? computeLayout(station, Math.max(900, size.w), Math.max(300, size.h)) : null), [station, size.w, size.h]);

  const state = frame?.state;
  const now = state?.sim_time ?? 0;
  const tmap = useMemo(() => {
    const m = new Map<string, Train>();
    state?.trains.forEach((t) => m.set(t.id, t));
    return m;
  }, [state]);
  const tsMap = useMemo(() => new Map((state?.tracks ?? []).map((t) => [t.id, t])), [state]);
  const nextOnTrack = useMemo(() => nextPlanned(plan, now), [plan, now]);
  const approach = useMemo(() => (state?.trains ?? []).filter((t) => ['approaching', 'held', 'at_signal'].includes(t.status)), [state]);
  const chips = useMemo(() => (L ? layoutChips(approach, L) : []), [approach, L]);

  const counts = useMemo(() => {
    let sig = 0,
      reg = 0,
      held = 0;
    for (const t of approach) {
      if (t.status === 'at_signal') sig++;
      else if (t.status === 'held' || (t.hold_until ?? 0) > now) held++;
      else if (t.regulated) reg++;
    }
    return { sig, reg, held, sigW: approach.filter((t) => t.status === 'at_signal' && t.side_in === 'W').length, sigE: approach.filter((t) => t.status === 'at_signal' && t.side_in === 'E').length };
  }, [approach, now]);

  const onSelect = (id: string, kind: 'track' | 'train') => select(selection && selection.id === id && selection.kind === kind ? null : { kind, id });

  return (
    <section className="panel schema-panel" aria-labelledby="schema-h">
      <header className="panel-h">
        <h2 id="schema-h">
          <TrainFront size={15} /> Схема станции
          <span className="h-sub">живое состояние мира ИИ</span>
        </h2>
        <div className="schema-counters" aria-live="polite">
          <span className={`cnt ${counts.sig ? 'cnt-crit' : 'cnt-ok'}`} title="Поезда, стоящие у входного сигнала">
            <Hand size={13} /> у сигнала: <b className="num">{counts.sig}</b>
          </span>
          <span className="cnt cnt-info" title="Поезда, идущие с рекомендованной пониженной скоростью к своему слоту">
            <GaugeIc size={13} /> регулируются скоростью: <b className="num">{counts.reg}</b>
          </span>
          <span className="cnt cnt-warn" title="Поезда, удержанные на предыдущей станции до своего слота">
            <Pause size={13} /> удержаны: <b className="num">{counts.held}</b>
          </span>
        </div>
      </header>
      <div className="schema-body" ref={ref}>
        {L && station && state ? (
          <svg width={L.W} height={L.H} viewBox={`0 0 ${L.W} ${L.H}`} className="schema-svg" role="group" aria-label="Схема путевого развития станции">
            <defs>
              <pattern id="hatch-red" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
                <rect width="7" height="7" fill="rgba(240,68,56,0.12)" />
                <line x1="0" y1="0" x2="0" y2="7" stroke="rgba(240,68,56,0.65)" strokeWidth="2.4" />
              </pattern>
            </defs>
            <StaticLayer L={L} station={station} />
            <LaddersLayer L={L} busy={state.ladders} now={now} />
            {L.tracks.map((g) => {
              const ts = tsMap.get(g.id);
              const tr = ts?.train ? tmap.get(ts.train) : undefined;
              return (
                <TrackRow
                  key={g.id}
                  g={g}
                  L={L}
                  ts={ts}
                  train={tr && tr.status !== 'departed' ? tr : undefined}
                  now={now}
                  selected={!!selection && ((selection.kind === 'track' && selection.id === g.id) || (selection.kind === 'train' && selection.id === tr?.id))}
                  onSelect={onSelect}
                  planned={nextOnTrack.get(g.id) ?? null}
                />
              );
            })}
            <Signal x={L.apW[1] + 2} y={L.yMain} side="W" stop={counts.sigW} />
            <Signal x={L.apE[1] - 2} y={L.yMain} side="E" stop={counts.sigE} />
            {chips.map((c) => (
              <ApproachChip key={c.t.id} c={c} yMain={L.yMain} selected={selection?.kind === 'train' && selection.id === c.t.id} onSelect={(id) => onSelect(id, 'train')} />
            ))}
          </svg>
        ) : (
          <div className="skeleton">Ожидание данных станции…</div>
        )}
        {selection && <DetailsCard />}
      </div>
      <Legend />
    </section>
  );
}

function nextPlanned(plan: Plan | null, now: number): Map<string, string> {
  const m = new Map<string, { id: string; at: number }>();
  if (!plan) return new Map();
  for (const [id, a] of Object.entries(plan.assignments)) {
    if (a.entry_at == null || a.entry_at < now) continue;
    const cur = m.get(a.track);
    if (!cur || a.entry_at < cur.at) m.set(a.track, { id, at: a.entry_at });
  }
  return new Map([...m.entries()].map(([k, v]) => [k, `${v.id} в ${clock(v.at)}`]));
}

const Legend = memo(function Legend() {
  return (
    <div className="legend" aria-label="Легенда схемы">
      {(Object.keys(CAT_COLOR) as (keyof typeof CAT_COLOR)[]).map((c) => (
        <span key={c} className="lg">
          <CatIcon cat={c} size={12} />
          <i className="lg-sw" style={{ background: CAT_COLOR[c] }} />
          {CAT_NAME[c]}
        </span>
      ))}
      <span className="lg-sep" />
      <span className="lg">
        <i className="lg-track free" /> свободен
      </span>
      <span className="lg">
        <i className="lg-track closed" /> закрыт
      </span>
      <span className="lg">
        <i className="lg-track reserve" /> резерв
      </span>
      <span className="lg">
        <i className="lg-ladder" /> занятая стрелочная улица
      </span>
      <span className="lg-sep" />
      <span className="lg lg-crit">■ стоит у сигнала</span>
      <span className="lg lg-info">▼ 35 км/ч — регулирование скорости</span>
      <span className="lg lg-warn">❚❚ удержан на пред. станции</span>
    </div>
  );
});
