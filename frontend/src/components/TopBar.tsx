import { memo, useRef, useState } from 'react';
import { ChevronDown, CircleCheck, LogOut, Network, OctagonAlert, Route, TriangleAlert, Unplug } from 'lucide-react';
import { useStore, useViewFrame } from '../store';
import type { IndexValue } from '../types';
import { clock, clockSec } from '../utils/time';
import { reconnectNow } from '../api/live';
import { mockServer } from '../api/mock';
import { useDismiss, useNow } from '../utils/hooks';
import { useMicro, type Section } from '../micro/store';

function catIcon(id: string, size = 13) {
  if (id === 'norm') return <CircleCheck size={size} aria-hidden="true" />;
  if (id === 'warning') return <TriangleAlert size={size} aria-hidden="true" />;
  return <OctagonAlert size={size} aria-hidden="true" />;
}

/** Круговой индикатор индекса — для крупных блоков (сравнение двойников). */
export const IndexGauge = memo(function IndexGauge({ index, label }: { index: IndexValue | null; label?: string }) {
  const v = index?.value ?? 0;
  const color = index?.category.color ?? 'var(--muted)';
  const r = 22;
  const c = 2 * Math.PI * r;
  const arc = 0.75;
  const len = c * arc * Math.max(0, Math.min(1, v / 100));
  const size = (r + 4) * 2;
  return (
    <div
      className="gauge"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={`Индекс состояния станции${label ? ' ' + label : ''}: ${Math.round(v)} из 100, класс ${index?.grade ?? '—'}, ${index?.category.name ?? ''}`}
      title={index?.category.reason}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <g transform={`rotate(135 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line-2)" strokeWidth={4} strokeDasharray={`${c * arc} ${c}`} />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={4}
            strokeDasharray={`${len} ${c}`}
            style={{ transition: 'stroke-dasharray .6s ease, stroke .3s' }}
          />
        </g>
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" className="gauge-num">
          {index ? Math.round(v) : '—'}
        </text>
      </svg>
      <div className="gauge-meta">
        <span className="gauge-label">{label ?? 'Индекс станции'}</span>
        <span className="gauge-cat" style={{ color }}>
          {index && catIcon(index.category.id)}
          {index?.category.name ?? 'нет данных'}
          {index && <span className="idx-g">{index.grade}</span>}
        </span>
      </div>
    </div>
  );
});

/** Компактное значение индекса для панели раздела. */
export function IndexReadout({ index, label, vs }: { index: IndexValue | null; label: string; vs?: IndexValue | null }) {
  const color = index?.category.color ?? 'var(--muted)';
  const d = index && vs ? Math.round(index.value - vs.value) : null;
  return (
    <div
      className="idx"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(index?.value ?? 0)}
      aria-label={`${label}: ${index ? Math.round(index.value) : 'нет данных'} из 100, класс ${index?.grade ?? '—'}, ${index?.category.name ?? ''}`}
      title={index?.category.reason}
    >
      <span className="idx-l">{label}</span>
      <span className="idx-v" style={{ color: index ? color : undefined }}>
        {index ? Math.round(index.value) : '—'}
      </span>
      {index && (
        <>
          <span className="idx-g" style={{ color, borderColor: color }}>
            {index.grade}
          </span>
          <span className="idx-cat" style={{ color }}>
            {catIcon(index.category.id)}
            {index.category.name}
          </span>
        </>
      )}
      {vs && d != null && (
        <span className="idx-vs" title="Индекс параллельного двойника без ИИ">
          FCFS <b className="num">{Math.round(vs.value)}</b>{' '}
          <span className={d >= 0 ? 'pos' : 'neg'}>
            {d >= 0 ? '+' : '−'}
            {Math.abs(d)}
          </span>
        </span>
      )}
    </div>
  );
}

export function ConnStatus() {
  const conn = useStore((s) => s.conn);
  const mock = useStore((s) => s.auth.mock);
  const now = useNow(conn.status === 'online' ? 5000 : 500);
  const secs = conn.retryAt ? Math.max(0, Math.ceil((conn.retryAt - now) / 1000)) : 0;
  let cls = 'status-ok';
  let text = 'Онлайн';
  if (conn.status === 'connecting' || conn.status === 'idle') {
    cls = 'status-info';
    text = 'Подключение…';
  } else if (conn.status === 'reconnecting') {
    cls = 'status-warn';
    text = conn.retryAt ? `Переподключение, попытка ${conn.attempt}, через ${secs} с` : `Переподключение, попытка ${conn.attempt}`;
  } else if (conn.status === 'offline') {
    cls = 'status-crit';
    text = conn.retryAt ? `Нет связи, повтор через ${secs} с` : 'Нет связи';
  }
  return (
    <span className="tb-grp">
      <span className={`status ${cls}`} role="status" aria-live="polite">
        {text}
        {mock && conn.status === 'online' && <span className="status-tag">демо</span>}
      </span>
      {(conn.status === 'reconnecting' || conn.status === 'offline') && (
        <button className="btn btn-xs" onClick={reconnectNow}>
          Повторить
        </button>
      )}
    </span>
  );
}

function Latency() {
  const lat = useStore((s) => s.latency);
  const n = lat.samples.length;
  const ok = lat.p95 < 500;
  return (
    <span
      className={`lat ${n && !ok ? 'lat-warn' : ''}`}
      title={`Задержка от генерации события в симуляторе до отрисовки в браузере.\nСреднее ${Math.round(lat.avg)} мс, p95 ${Math.round(lat.p95)} мс по ${n} кадрам. Требование: < 500 мс.`}
      aria-label={`Задержка интерфейса: среднее ${Math.round(lat.avg)} миллисекунд, 95-й перцентиль ${Math.round(lat.p95)}${n && !ok ? ', выше нормы' : ''}`}
    >
      Задержка <b className="num">{n ? Math.round(lat.avg) : '—'} мс</b>
      {n > 0 && !ok && <TriangleAlert size={12} aria-hidden="true" />}
    </span>
  );
}

function UserMenu() {
  const auth = useStore((s) => s.auth);
  const logout = useStore((s) => s.logout);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  const role = auth.role === 'admin' ? 'администратор' : 'диспетчер';
  return (
    <div className="umenu" ref={ref}>
      <button className="btn btn-ghost umenu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`${auth.username}, ${role}`} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">
          {(auth.username ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="umenu-name">{auth.username}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {open && (
        <div className="umenu-pop" role="menu">
          <div className="umenu-head">
            {auth.username}
            <small>{role}</small>
          </div>
          {auth.mock && (
            <button
              role="menuitem"
              className="umenu-item"
              onClick={() => {
                mockServer.simulateDrop(15000);
                setOpen(false);
              }}
            >
              <Unplug size={14} /> Симулировать обрыв связи
            </button>
          )}
          <button role="menuitem" className="umenu-item" onClick={logout}>
            <LogOut size={14} /> Выйти
          </button>
        </div>
      )}
    </div>
  );
}

const SECTIONS: { id: Section; label: string; icon: JSX.Element }[] = [
  { id: 'micro', label: 'Станция', icon: <Route size={14} /> },
  { id: 'macro', label: 'Сеть и план', icon: <Network size={14} /> },
];

function SectionTabs() {
  const section = useMicro((s) => s.section);
  const setSection = useMicro((s) => s.setSection);
  return (
    <nav className="navtabs" aria-label="Раздел">
      {SECTIONS.map((s) => (
        <button key={s.id} className={`navtab ${section === s.id ? 'on' : ''}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => setSection(s.id)}>
          {s.icon}
          {s.label}
        </button>
      ))}
    </nav>
  );
}

function MacroClock() {
  const frame = useViewFrame();
  const timeScale = useStore((s) => s.timeScale);
  const sim = frame?.state.sim_time;
  return (
    <div className="simclock" aria-label={`Модельное время ${clock(sim)}, ускорение ${timeScale}`}>
      <span className="simclock-t">{clock(sim)}</span>
      <span className="simclock-s">{sim != null ? clockSec(sim).slice(6) : ''}</span>
      <span className="speed" title="Ускорение модельного времени">
        ×{timeScale}
      </span>
    </div>
  );
}

function MicroClock() {
  const frame = useMicro((s) => s.frame);
  return (
    <div className="simclock" aria-label={frame ? `Модельное время ${frame.clock}, ${frame.date}, ускорение ${frame.scale}` : 'Модельное время загружается'}>
      <span className="simclock-t">{frame?.clock ?? '—:—'}</span>
      <span className="simclock-s">{frame?.date ?? ''}</span>
      {frame && (
        <span className="speed" title="Ускорение модельного времени">
          ×{frame.scale}
        </span>
      )}
    </div>
  );
}

function Brand() {
  const station = useStore((s) => s.station);
  const section = useMicro((s) => s.section);
  const microName = useMicro((s) => s.stat?.infra.name);
  const name = section === 'micro' ? microName : station?.name;
  return (
    <div className="brand">
      <span className="brand-name">Цифровая станция</span>
      <span className="brand-sub" title={name}>
        {name ?? 'загрузка…'}
      </span>
    </div>
  );
}

export function TopBar() {
  const section = useMicro((s) => s.section);
  return (
    <header className="topbar" role="banner">
      <Brand />
      <SectionTabs />
      {section === 'micro' ? <MicroClock /> : <MacroClock />}
      <div className="topbar-spacer" />
      <div className="topbar-status">
        {section === 'macro' && <Latency />}
        <ConnStatus />
      </div>
      <UserMenu />
    </header>
  );
}
