import { useMemo, useState } from 'react';
import { Wrench } from 'lucide-react';
import { useViewFrame, useViewPlan } from '../store';
import type { ResourceState } from '../types';
import { clock } from '../utils/time';
import { GanttChart } from './charts/GanttChart';
import { ApproachChart } from './charts/ApproachChart';
import { Tabs, type TabItem } from './common';

const RES_STATUS: Record<string, { name: string; cls: string }> = {
  available: { name: 'свободен', cls: 'ok' },
  moving: { name: 'следует к поезду', cls: 'info' },
  boarding: { name: 'приёмка локомотива', cls: 'info' },
  working: { name: 'в поездке', cls: 'info' },
  busy: { name: 'занят', cls: 'info' },
  turnaround: { name: 'оборот / экипировка', cls: 'muted' },
  rest: { name: 'отдых', cls: 'muted' },
  failed: { name: 'неисправен', cls: 'crit' },
};

function ResourceChips({ title, items, next }: { title: string; items: ResourceState[]; next: Map<string, string> }) {
  const free = items.filter((r) => r.status === 'available').length;
  return (
    <div className="res-group">
      <div className="res-h">
        {title}
        <span className="res-count">
          свободно <b className="num">{free}</b> из {items.length}
        </span>
      </div>
      <div className="res-grid">
        {items.map((r) => {
          const s = RES_STATUS[r.status] ?? { name: r.status, cls: 'muted' };
          return (
            <div key={r.id} className={`res res-${s.cls}`} tabIndex={0} aria-label={`${r.id}: ${s.name}${r.train ? `, поезд ${r.train}` : ''}`}>
              <div className="res-top">
                <b>{r.id}</b>
                <span className={`res-st res-st-${s.cls}`}>
                  {s.cls === 'crit' ? <Wrench size={11} /> : <i className="dot" />}
                  {s.name}
                </span>
              </div>
              <div className="res-sub">
                {r.train ? `№${r.train}` : '—'}
                {r.until != null && r.status !== 'available' && <span className="num"> · до {clock(r.until)}</span>}
              </div>
              {next.get(r.id) && <div className="res-next">далее: {next.get(r.id)}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResourcesView() {
  const frame = useViewFrame();
  const plan = useViewPlan();
  const { nextLoco, nextCrew, missing } = useMemo(() => {
    const nl = new Map<string, { id: string; at: number }>();
    const nc = new Map<string, { id: string; at: number }>();
    const miss: string[] = [];
    for (const [id, a] of Object.entries(plan?.assignments ?? {})) {
      if (a.loco && a.loco_at != null && (!nl.has(a.loco) || a.loco_at < nl.get(a.loco)!.at)) nl.set(a.loco, { id, at: a.loco_at });
      if (a.crew && a.crew_at != null && (!nc.has(a.crew) || a.crew_at < nc.get(a.crew)!.at)) nc.set(a.crew, { id, at: a.crew_at });
      if (a.loco_missing || a.crew_missing) miss.push(id);
    }
    const fmt = (m: Map<string, { id: string; at: number }>) => new Map([...m].map(([k, v]) => [k, `№${v.id} к ${clock(v.at)}`]));
    return { nextLoco: fmt(nl), nextCrew: fmt(nc), missing: miss };
  }, [plan]);
  if (!frame) return null;
  return (
    <div className="res-view">
      {missing.length > 0 && (
        <div className="res-alert" role="alert">
          ⚠ На горизонте плана не хватает локомотива/бригады для: {missing.map((m) => `№${m}`).join(', ')}
        </div>
      )}
      <ResourceChips title="Локомотивы" items={frame.state.locos} next={nextLoco} />
      <ResourceChips title="Локомотивные бригады" items={frame.state.crews} next={nextCrew} />
    </div>
  );
}

type TabId = 'gantt' | 'approach' | 'res';
const TABS: TabItem<TabId>[] = [
  { id: 'gantt', label: 'Занятость путей' },
  { id: 'approach', label: 'Диаграмма подхода' },
  { id: 'res', label: 'Ресурсы' },
];
const HINT: Record<TabId, string> = {
  gantt: '−30 мин … +2 ч · сплошные — факт, пунктир — план ИИ',
  approach: 'запад — выше, восток — ниже · пунктир — траектория к слоту',
  res: 'состояние и ближайшие назначения по плану',
};

export function BottomPanel() {
  const [tab, setTab] = useState<TabId>('gantt');
  return (
    <section className="panel bottom-panel">
      <header className="panel-h">
        <Tabs idPrefix="bottom" label="Графики и ресурсы" value={tab} onChange={setTab} items={TABS} />
        <span className="h-sub">{HINT[tab]}</span>
      </header>
      <div className="bottom-b" role="tabpanel" id="bottom-panel" aria-labelledby={`bottom-tab-${tab}`}>
        {tab === 'gantt' && <GanttChart />}
        {tab === 'approach' && <ApproachChart />}
        {tab === 'res' && <ResourcesView />}
      </div>
    </section>
  );
}
