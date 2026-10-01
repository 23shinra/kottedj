import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Container, Info, Minus, OctagonAlert, Package, TriangleAlert, Users, X } from 'lucide-react';
import type { Severity, TrainCat } from '../types';
import { CAT_COLOR, CAT_NAME } from '../utils/theme';
import { useDismiss } from '../utils/hooks';

export const CatIcon = memo(function CatIcon({ cat, size = 14, colored = true }: { cat: TrainCat; size?: number; colored?: boolean }) {
  const Icon = cat === 'pass' ? Users : cat === 'freight_transit' ? Container : Package;
  return (
    <Icon
      size={size}
      color={colored ? CAT_COLOR[cat] : 'currentColor'}
      aria-label={CAT_NAME[cat]}
      role="img"
      strokeWidth={2.2}
      style={{ flex: 'none' }}
    />
  );
});

export function CatBadge({ cat }: { cat: TrainCat }) {
  return (
    <span className="cat-badge" style={{ ['--c' as string]: CAT_COLOR[cat] }}>
      <CatIcon cat={cat} size={12} />
      {CAT_NAME[cat]}
    </span>
  );
}

export function SevIcon({ sev, size = 16 }: { sev: Severity; size?: number }) {
  if (sev === 'critical') return <OctagonAlert size={size} className="sev-ic sev-critical" aria-label="критично" />;
  if (sev === 'high') return <TriangleAlert size={size} className="sev-ic sev-high" aria-label="важно" />;
  if (sev === 'medium') return <TriangleAlert size={size} className="sev-ic sev-medium" aria-label="внимание" />;
  return <Info size={size} className="sev-ic sev-info" aria-label="информация" />;
}

/**
 * Дельта «ИИ против FCFS». better: 'lower' — меньше лучше (ожидание, очередь), 'higher' — больше лучше.
 * Цвет дублирован стрелкой и знаком.
 */
export function Delta({ ai, base, better, unit = '', digits = 1, pct = false }: {
  ai: number;
  base: number;
  better: 'lower' | 'higher';
  unit?: string;
  digits?: number;
  pct?: boolean;
}) {
  if (!Number.isFinite(ai) || !Number.isFinite(base)) return null;
  const diff = ai - base;
  const eps = Math.pow(10, -digits) / 2;
  if (Math.abs(diff) < eps) {
    return (
      <span className="delta delta-eq" title="Без разницы с FCFS">
        <Minus size={11} /> 0
      </span>
    );
  }
  const good = better === 'lower' ? diff < 0 : diff > 0;
  const shown = pct && base !== 0 ? `${Math.round((Math.abs(diff) / Math.abs(base)) * 100)}%` : `${Math.abs(diff).toLocaleString('ru-RU', { maximumFractionDigits: digits })}${unit}`;
  return (
    <span className={`delta ${good ? 'delta-good' : 'delta-bad'}`} title={good ? 'Лучше, чем без ИИ' : 'Хуже, чем без ИИ'}>
      {diff < 0 ? <ArrowDown size={11} strokeWidth={2.6} /> : <ArrowUp size={11} strokeWidth={2.6} />}
      {diff < 0 ? '−' : '+'}
      {shown}
    </span>
  );
}

export function PanelHeader({ id, title, sub, extra }: { id?: string; title: ReactNode; sub?: ReactNode; extra?: ReactNode }) {
  return (
    <header className="panel-h">
      <h2 id={id ? `${id}-h` : undefined}>
        {title}
        {sub && <span className="h-sub">{sub}</span>}
      </h2>
      {extra && <div className="panel-extra">{extra}</div>}
    </header>
  );
}

export function Panel({ title, sub, extra, children, className = '', id }: {
  title: ReactNode;
  sub?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section className={`panel ${className}`} aria-labelledby={id ? `${id}-h` : undefined}>
      <PanelHeader id={id} title={title} sub={sub} extra={extra} />
      <div className="panel-b">{children}</div>
    </section>
  );
}

export function Toolbar({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`toolbar ${className}`} role="toolbar" aria-label={label}>
      {children}
    </div>
  );
}

export function ToolbarSep() {
  return <span className="tb-sep" aria-hidden="true" />;
}

export function StatStrip({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`stats ${className}`} role="region" aria-label={label}>
      {children}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'crit';

export function Stat({ label, value, unit, sub, tone, title, aside, ariaLabel }: {
  label: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  title?: string;
  aside?: ReactNode;
  ariaLabel?: string;
}) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`} title={title} tabIndex={title || ariaLabel ? 0 : undefined} aria-label={ariaLabel}>
      <span className="stat-l">{label}</span>
      <span className="stat-main">
        <b className="stat-v num">{value}</b>
        {unit && <span className="stat-u">{unit}</span>}
        {aside}
      </span>
      {sub != null && sub !== '' && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export function Tabs<T extends string>({ items, value, onChange, label, idPrefix }: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = (i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length;
    onChange(items[n].id);
    refs.current[n]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="tabs">
      {items.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => (refs.current[i] = el)}
          role="tab"
          id={`${idPrefix}-tab-${t.id}`}
          aria-selected={value === t.id}
          aria-controls={`${idPrefix}-panel`}
          tabIndex={value === t.id ? 0 : -1}
          className={`tab ${value === t.id ? 'on' : ''}`}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.icon}
          <span>{t.label}</span>
          {!!t.count && <span className="cnt num">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Popover({ button, buttonLabel, children, className = '', up = false }: {
  button: ReactNode;
  buttonLabel: string;
  children: ReactNode;
  className?: string;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return (
    <div className="popwrap" ref={ref}>
      <button className={`btn btn-xs btn-ghost ${open ? 'on' : ''}`} aria-expanded={open} aria-label={buttonLabel} onClick={() => setOpen((o) => !o)}>
        {button}
      </button>
      {open && (
        <div className={`pop ${up ? 'pop-up' : ''} ${className}`} role="dialog" aria-label={buttonLabel}>
          {children}
        </div>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide = false, footer, labelledBy = 'modal-title' }: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = el?.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    focusable?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const items = Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'));
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={ref}>
        <header className="modal-h">
          <h2 id={labelledBy}>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <div className="modal-b">{children}</div>
        {footer && <footer className="modal-f">{footer}</footer>}
      </div>
    </div>
  );
}

/** Мини-спарклайн на чистом SVG (дёшево при 2 Гц). */
export const Sparkline = memo(function Sparkline({ values, color = 'var(--accent)', compare, height = 26, width = 96, label }: {
  values: number[];
  compare?: number[];
  color?: string;
  height?: number;
  width?: number;
  label?: string;
}) {
  const all = [...values, ...(compare ?? [])].filter(Number.isFinite);
  if (all.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (max - min < 1e-6) {
    max += 1;
    min -= 1;
  }
  const path = (vs: number[]) => {
    const n = vs.length;
    let d = '';
    let pen = false;
    vs.forEach((v, i) => {
      if (!Number.isFinite(v)) {
        pen = false;
        return;
      }
      const x = (i / Math.max(1, n - 1)) * (width - 4) + 2;
      const y = height - 3 - ((v - min) / (max - min)) * (height - 6);
      d += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const lastIdx = values.length - 1;
  const lv = values[lastIdx];
  return (
    <svg width={width} height={height} className="spark" role="img" aria-label={label ?? 'тренд за 5 минут'}>
      {compare && <path d={path(compare)} fill="none" stroke="var(--muted)" strokeWidth={1.2} strokeDasharray="2 2" opacity={0.7} />}
      <path d={path(values)} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
      {Number.isFinite(lv) && (
        <circle cx={width - 2} cy={height - 3 - ((lv - min) / (max - min)) * (height - 6)} r={2.2} fill={color} />
      )}
    </svg>
  );
});
