import { memo, useEffect, useRef, useState } from 'react';
import {
  Bot,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Gauge,
  LogOut,
  OctagonAlert,
  RefreshCw,
  Scale,
  Settings,
  Siren,
  Timer,
  TrainFront,
  TriangleAlert,
  Unplug,
  User,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useIsAdmin, useStore, useViewFrame } from '../store';
import type { IndexValue, ViewMode } from '../types';
import { clock, clockSec } from '../utils/time';
import { reconnectNow } from '../api/live';
import { mockServer } from '../api/mock';
import { useNow } from '../utils/hooks';

function catIcon(id: string, size = 14) {
  if (id === 'norm') return <CircleCheck size={size} aria-hidden="true" />;
  if (id === 'warning') return <TriangleAlert size={size} aria-hidden="true" />;
  return <OctagonAlert size={size} aria-hidden="true" />;
}

export const IndexGauge = memo(function IndexGauge({ index, label, compact = false }: { index: IndexValue | null; label?: string; compact?: boolean }) {
  const v = index?.value ?? 0;
  const color = index?.category.color ?? 'var(--muted)';
  const r = compact ? 20 : 23;
  const c = 2 * Math.PI * r;
  const arc = 0.75; // 270°
  const len = c * arc * Math.max(0, Math.min(1, v / 100));
  const size = (r + 5) * 2;
  return (
    <div
      className={`gauge ${compact ? 'gauge-compact' : ''}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      aria-label={`Индекс состояния станции${label ? ' ' + label : ''}: ${Math.round(v)} из 100, класс ${index?.grade ?? '—'}, ${index?.category.name ?? ''}`}
      title={index?.category.reason}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <g transform={`rotate(135 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={5} strokeDasharray={`${c * arc} ${c}`} strokeLinecap="round" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={5}
            strokeDasharray={`${len} ${c}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray .6s ease, stroke .3s' }}
          />
        </g>
        <text x="50%" y="52%" textAnchor="middle" dominantBaseline="middle" className="gauge-num">
          {index ? Math.round(v) : '—'}
        </text>
      </svg>
      <div className="gauge-meta">
        <div className="gauge-top">
          <span className="gauge-label">{label ?? 'Индекс станции'}</span>
          <span className="grade" style={{ borderColor: color, color }}>
            {index?.grade ?? '—'}
          </span>
        </div>
        <div className="gauge-cat" style={{ color }}>
          {index && catIcon(index.category.id)}
          {index?.category.name ?? 'нет данных'}
        </div>
      </div>
    </div>
  );
});

const MODES: { id: ViewMode; label: string; icon: JSX.Element }[] = [
  { id: 'ai', label: 'С ИИ', icon: <Bot size={14} /> },
  { id: 'baseline', label: 'Без ИИ (FCFS)', icon: <User size={14} /> },
  { id: 'compare', label: 'Сравнение', icon: <Scale size={14} /> },
];

function ModeSwitch() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = (i + (e.key === 'ArrowRight' ? 1 : MODES.length - 1)) % MODES.length;
    setMode(MODES[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div className="seg" role="radiogroup" aria-label="Режим отображения">
      {MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => (refs.current[i] = el)}
          role="radio"
          aria-checked={mode === m.id}
          tabIndex={mode === m.id ? 0 : -1}
          className={`seg-btn ${mode === m.id ? 'on' : ''} seg-${m.id}`}
          onClick={() => setMode(m.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {m.icon}
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function ConnPill() {
  const conn = useStore((s) => s.conn);
  const mock = useStore((s) => s.auth.mock);
  const now = useNow(conn.status === 'online' ? 5000 : 500);
  let cls = 'pill-ok';
  let icon = <Wifi size={14} aria-hidden="true" />;
  let text = 'Онлайн';
  if (conn.status === 'connecting' || conn.status === 'idle') {
    cls = 'pill-info';
    icon = <RefreshCw size={14} className="spin" aria-hidden="true" />;
    text = 'Подключение…';
  } else if (conn.status === 'reconnecting') {
    cls = 'pill-warn';
    icon = <RefreshCw size={14} className="spin" aria-hidden="true" />;
    const secs = conn.retryAt ? Math.max(0, Math.ceil((conn.retryAt - now) / 1000)) : 0;
    text = conn.retryAt ? `Переподключение… (попытка ${conn.attempt}, через ${secs} с)` : `Переподключение… (попытка ${conn.attempt})`;
  } else if (conn.status === 'offline') {
    cls = 'pill-crit';
    icon = <WifiOff size={14} aria-hidden="true" />;
    const secs = conn.retryAt ? Math.max(0, Math.ceil((conn.retryAt - now) / 1000)) : 0;
    text = conn.retryAt ? `Нет связи · повтор через ${secs} с` : 'Нет связи';
  }
  return (
    <div className="pill-wrap">
      <span className={`pill ${cls}`} role="status" aria-live="polite">
        {icon}
        {text}
        {mock && conn.status === 'online' && <span className="pill-tag">демо</span>}
      </span>
      {(conn.status === 'reconnecting' || conn.status === 'offline') && (
        <button className="btn btn-xs btn-ghost" onClick={reconnectNow}>
          Повторить
        </button>
      )}
    </div>
  );
}

export function LatencyChip() {
  const lat = useStore((s) => s.latency);
  const n = lat.samples.length;
  const ok = lat.p95 < 500;
  return (
    <span
      className={`chip ${n ? (ok ? 'chip-ok' : 'chip-warn') : ''}`}
      title={`Задержка от генерации события в симуляторе до отрисовки в браузере.\nСреднее ${Math.round(lat.avg)} мс, p95 ${Math.round(lat.p95)} мс по ${n} кадрам. Требование: < 500 мс.`}
      aria-label={`Задержка интерфейса: среднее ${Math.round(lat.avg)} миллисекунд, 95-й перцентиль ${Math.round(lat.p95)}`}
    >
      <Timer size={13} aria-hidden="true" />
      Задержка UI: <b className="num">{n ? Math.round(lat.avg) : '—'} мс</b>
      <span className="chip-sub num">p95 {n ? Math.round(lat.p95) : '—'}</span>
      {n > 0 && (ok ? <CircleCheck size={12} aria-label="в норме" /> : <CircleAlert size={12} aria-label="выше нормы" />)}
    </span>
  );
}

function UserMenu() {
  const auth = useStore((s) => s.auth);
  const logout = useStore((s) => s.logout);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [open]);
  return (
    <div className="umenu" ref={ref}>
      <button className="btn btn-ghost umenu-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">
          {(auth.username ?? '?').slice(0, 1).toUpperCase()}
        </span>
        <span className="umenu-name">
          {auth.username}
          <small>{auth.role === 'admin' ? 'администратор' : 'диспетчер'}</small>
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="umenu-pop" role="menu">
          {auth.mock && (
            <button
              role="menuitem"
              className="umenu-item"
              onClick={() => {
                mockServer.simulateDrop(15000);
                setOpen(false);
              }}
            >
              <Unplug size={14} /> Симулировать обрыв связи (демо)
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

export function TopBar() {
  const frame = useViewFrame();
  const station = useStore((s) => s.station);
  const timeScale = useStore((s) => s.timeScale);
  const mode = useStore((s) => s.mode);
  const setIncidentOpen = useStore((s) => s.setIncidentOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const isAdmin = useIsAdmin();
  const sim = frame?.state.sim_time;
  const index = mode === 'baseline' ? frame?.compare?.baseline?.index ?? null : frame?.index ?? null;
  const baseIdx = frame?.compare?.baseline?.index;
  const aiIdx = frame?.index;

  return (
    <header className="topbar" role="banner">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          <TrainFront size={20} />
        </span>
        <div>
          <div className="brand-name">Цифровая станция</div>
          <div className="brand-sub">{station?.name ?? 'загрузка…'}</div>
        </div>
      </div>

      <div className="simclock" aria-label={`Модельное время ${clock(sim)}, ускорение ${timeScale}`}>
        <span className="simclock-t num">{clock(sim)}</span>
        <span className="simclock-s num">{sim != null ? clockSec(sim).slice(6) : ''}</span>
        <span className="speed num" title="Ускорение модельного времени">×{timeScale}</span>
      </div>

      <div className="gauge-wrap">
        <IndexGauge index={index} label={mode === 'baseline' ? 'Индекс · FCFS' : 'Индекс · ИИ'} />
        {mode !== 'baseline' && baseIdx && aiIdx && (
          <div className="gauge-vs" title="Индекс параллельного двойника без ИИ">
            FCFS <b className="num">{Math.round(baseIdx.value)}</b>
            <span className={aiIdx.value >= baseIdx.value ? 'pos' : 'neg'}>
              {aiIdx.value >= baseIdx.value ? '+' : '−'}
              {Math.abs(Math.round(aiIdx.value - baseIdx.value))}
            </span>
          </div>
        )}
      </div>

      <ModeSwitch />

      <div className="topbar-spacer" />

      <div className="topbar-status">
        <ConnPill />
        <LatencyChip />
      </div>

      <button className="btn btn-danger" onClick={() => setIncidentOpen(true)}>
        <Siren size={16} /> Нештатная ситуация
      </button>
      <button
        className="icon-btn icon-btn-lg"
        onClick={() => setSettingsOpen(true)}
        aria-label={isAdmin ? 'Настройки индекса и планировщика' : 'Формула индекса (только просмотр)'}
        title={isAdmin ? 'Настройки' : 'Формула индекса'}
      >
        {isAdmin ? <Settings size={18} /> : <Gauge size={18} />}
      </button>
      <UserMenu />
    </header>
  );
}
