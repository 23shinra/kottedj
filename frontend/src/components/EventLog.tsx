import { memo, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Hand, MousePointerClick, ScrollText, Siren, Radio, TrainFront, Wrench } from 'lucide-react';
import { useStore } from '../store';
import type { SimEvent } from '../types';
import { clockSec } from '../utils/time';
import { Panel } from './common';

const FILTERS = [
  { id: 'all', label: 'Все' },
  { id: 'incident', label: 'Инциденты' },
  { id: 'action', label: 'Действия' },
  { id: 'move', label: 'Движение' },
] as const;
type F = (typeof FILTERS)[number]['id'];

function kindOf(e: SimEvent): 'incident' | 'action' | 'move' | 'other' {
  if (e.type.startsWith('incident') || e.type === 'signal_stop' || e.severity === 'critical' || e.severity === 'high') return 'incident';
  if (e.type === 'action' || e.type === 'plan' || e.type === 'apply') return 'action';
  if (['enter', 'depart', 'spawn', 'reroute'].includes(e.type)) return 'move';
  return 'other';
}

function EvIcon({ e }: { e: SimEvent }) {
  const s = 13;
  switch (e.type) {
    case 'enter':
      return <ArrowDownToLine size={s} aria-label="приём" />;
    case 'depart':
      return <ArrowUpFromLine size={s} aria-label="отправление" />;
    case 'spawn':
      return <TrainFront size={s} aria-label="на подходе" />;
    case 'resource':
      return <Wrench size={s} aria-label="ресурс" />;
    case 'action':
      return <MousePointerClick size={s} aria-label="действие" />;
    case 'signal_stop':
      return <Hand size={s} aria-label="остановка у сигнала" />;
    case 'telemetry':
      return <Radio size={s} aria-label="телеметрия" />;
    default:
      return e.type.startsWith('incident') ? <Siren size={s} aria-label="инцидент" /> : <ScrollText size={s} aria-hidden="true" />;
  }
}

const EvRow = memo(function EvRow({ e }: { e: SimEvent }) {
  const k = kindOf(e);
  return (
    <li className={`ev ev-${k} ${e.type === 'incident' ? 'ev-incident-strong' : ''}`}>
      <span className="ev-t num">{clockSec(e.t)}</span>
      <span className="ev-ic">
        <EvIcon e={e} />
      </span>
      <span className="ev-text">
        {e.world === 'baseline' && <span className="ev-world">FCFS</span>}
        {e.text}
      </span>
    </li>
  );
});

export function EventLog() {
  const events = useStore((s) => s.events);
  const [f, setF] = useState<F>('all');
  const [hideTelemetry, setHideTelemetry] = useState(true);
  const list = useMemo(
    () => events.filter((e) => (!hideTelemetry || e.type !== 'telemetry') && (f === 'all' || kindOf(e) === f)).slice(0, 80),
    [events, f, hideTelemetry],
  );
  return (
    <Panel
      id="events"
      title="Журнал событий"
      icon={<ScrollText size={15} />}
      extra={<span className="muted small num">{events.length}</span>}
      className="events-panel"
    >
      <div className="ev-filters" role="group" aria-label="Фильтр событий">
        {FILTERS.map((x) => (
          <button key={x.id} className={`fchip ${f === x.id ? 'on' : ''}`} aria-pressed={f === x.id} onClick={() => setF(x.id)}>
            {x.label}
          </button>
        ))}
        <label className="fcheck">
          <input type="checkbox" checked={!hideTelemetry} onChange={(e) => setHideTelemetry(!e.target.checked)} /> телеметрия
        </label>
      </div>
      <ul className="evlist" aria-live="off">
        {list.map((e, i) => (
          <EvRow key={`${e.t}-${i}-${e.text}`} e={e} />
        ))}
        {!list.length && <li className="muted small">Событий нет</li>}
      </ul>
    </Panel>
  );
}
