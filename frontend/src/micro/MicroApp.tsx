import { useEffect, useState } from 'react';
import { Info, PanelRight, Pause, Play, RotateCcw, Siren, TrainFront } from 'lucide-react';
import { useStore } from '../store';
import { Popover, Stat, StatStrip, Tabs, Toolbar, ToolbarSep } from '../components/common';
import { refreshStatic, runCommand } from './api';
import { CardPanel } from './CardPanel';
import { EquipmentView } from './EquipmentView';
import { FaultDialog } from './FaultDialog';
import { BonusTab, CatalogTab, LogTab, RepairTab, TrainsTab } from './SidePanels';
import { useMicro, type MicroTab, type MicroView } from './store';
import { TrackLegend, TrackView } from './TrackView';

const SCALES = [1, 10, 30, 60, 120, 300, 600];

function ControlBar({ sideOpen, onToggleSide, descOpen, onToggleDesc }: { sideOpen: boolean; onToggleSide: () => void; descOpen: boolean; onToggleDesc: () => void }) {
  const frame = useMicro((s) => s.frame);
  const stat = useMicro((s) => s.stat);
  const setFaultOpen = useMicro((s) => s.setFaultOpen);
  if (!frame || !stat) {
    return (
      <Toolbar label="Управление моделью">
        <span className="muted small">Загрузка модели…</span>
      </Toolbar>
    );
  }
  const scn = stat.scenarios.find((s) => s.id === frame.scenario);
  const pct = frame.duration_s ? Math.min(100, (100 * frame.t) / frame.duration_s) : 0;
  const scaleOpts = SCALES.includes(frame.scale) ? SCALES : [...SCALES, frame.scale].sort((a, b) => a - b);
  return (
    <Toolbar label="Управление моделью">
      <div className="tb-grp">
        {frame.running ? (
          <button className="btn" onClick={() => runCommand({ type: 'pause' })}>
            <Pause size={14} /> Пауза
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => runCommand({ type: 'run' })}>
            <Play size={14} /> Пуск
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => runCommand({ type: 'reset' }, 'Сценарий сброшен в начальное состояние')} title="Вернуть сценарий в начальное состояние">
          <RotateCcw size={14} /> Сброс
        </button>
        <span className={`run-st ${frame.running ? 'on' : ''}`} role="status">
          {frame.running ? '▶ идёт' : '❚❚ пауза'}
        </span>
      </div>
      <ToolbarSep />
      <label className="tb-f">
        <span className="tb-label">Масштаб</span>
        <select value={frame.scale} onChange={(e) => runCommand({ type: 'set_scale', scale: Number(e.target.value) })} aria-label="Масштаб времени">
          {scaleOpts.map((s) => (
            <option key={s} value={s}>
              ×{s} · 1 мин = {s >= 60 ? `${s / 60} ч` : `${s} мин`}
            </option>
          ))}
        </select>
      </label>
      <label className="tb-f tb-scn" title={scn?.description}>
        <span className="tb-label">Сценарий</span>
        <select value={frame.scenario} onChange={(e) => runCommand({ type: 'reset', scenario: e.target.value }, 'Сценарий загружен')} aria-label="Сценарий">
          {stat.scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      {scn?.description && (
        <button className={`icon-btn ${descOpen ? 'on' : ''}`} onClick={onToggleDesc} aria-expanded={descOpen} aria-label="Описание сценария" title="Описание сценария">
          <Info size={15} />
        </button>
      )}
      <div className="topbar-spacer" />
      <label className="switch-row" title="Автодиспетчер: приём, маршруты, порядок отправления, перепланирование после отказов">
        <input type="checkbox" checked={frame.auto} onChange={(e) => runCommand({ type: 'auto', on: e.target.checked })} />
        <span className="switch-ui" aria-hidden="true" />
        Автодиспетчер
      </label>
      <ToolbarSep />
      <button className="btn btn-danger" onClick={() => setFaultOpen(true)}>
        <Siren size={14} /> Внести отказ
      </button>
      <button className={`icon-btn icon-btn-lg side-toggle ${sideOpen ? 'on' : ''}`} onClick={onToggleSide} aria-expanded={sideOpen} aria-label="Карточки, поезда, ремонт и журнал" title="Боковая панель">
        <PanelRight size={15} />
      </button>
      <div className="tb-prog" role="progressbar" aria-label="Прогон сценария" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} title={`Прогон сценария: ${Math.round(frame.t / 60)} из ${Math.round(frame.duration_s / 60)} мин`}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </Toolbar>
  );
}

function MicroKpis() {
  const k = useMicro((s) => s.frame?.kpi);
  if (!k) return <div className="stats stats-empty" aria-busy="true" />;
  return (
    <StatStrip label="Показатели модели">
      <Stat label="Поезда, отправлено" value={`${k.departed} / ${k.trains}`} sub={`на станции ${k.in_station} · ждут ${k.held}${k.rejected ? ` · отказ ${k.rejected}` : ''}`} />
      <Stat label="Задержка приб. / отпр." value={`${k.avg_arr_delay_min} / ${k.avg_dep_delay_min}`} unit="мин" tone={k.avg_dep_delay_min >= 10 ? 'warn' : undefined} />
      <Stat label="Ожидание" value={k.wait_min} unit="мин" sub="стоянок без операции" />
      <Stat label="Маршруты" value={k.routes_set} sub={`отказов ${k.route_refusals} · ручн. ${k.manual_ok}/${k.manual_ok + k.manual_refused}`} />
      <Stat label="Груз выгр. / погр." value={`${Math.round(k.unloaded_t)} / ${Math.round(k.loaded_t)}`} unit="т" />
      <Stat label="Отказы" value={k.active_faults} sub={`задач ${k.open_tasks} · MTTR ${k.mttr_min ?? '—'} мин`} tone={k.active_faults ? 'crit' : undefined} />
      <Stat label="Готовность устройств" value={`${k.availability_pct}%`} tone={k.availability_pct < 99 ? 'warn' : undefined} />
      <Stat
        label="Безопасность"
        value={k.safety_violations ? `✕ ${k.safety_violations}` : '✓ 0'}
        sub={`реакция ${k.reaction_ok ? '✓' : '✕'} · ${k.reaction_max_s} с до запрета`}
        tone={k.safety_violations || !k.reaction_ok ? 'crit' : undefined}
      />
    </StatStrip>
  );
}

const VIEWS: { id: MicroView; label: string }[] = [
  { id: 'both', label: 'Обе схемы' },
  { id: 'track', label: 'Путевая схема' },
  { id: 'equip', label: 'Оборудование' },
];

function ViewSwitch() {
  const view = useMicro((s) => s.view);
  const setView = useMicro((s) => s.setView);
  return (
    <div className="seg" role="radiogroup" aria-label="Представление">
      {VIEWS.map((v) => (
        <button key={v.id} role="radio" aria-checked={view === v.id} className={`seg-btn ${view === v.id ? 'on' : ''}`} onClick={() => setView(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
  );
}

function Workspace() {
  const view = useMicro((s) => s.view);
  const stat = useMicro((s) => s.stat);
  return (
    <section className="panel mviews" aria-label="Схемы станции">
      <header className="panel-h">
        <ViewSwitch />
        <div className="panel-extra">
          {view !== 'track' && <span className="h-sub">выбор объекта подсвечивает связанные объекты на обеих схемах</span>}
          {view !== 'equip' && (
            <Popover button="Легенда" buttonLabel="Условные обозначения путевой схемы" className="legend-pop">
              <TrackLegend />
            </Popover>
          )}
        </div>
      </header>
      <div className="mviews-split">
        {view !== 'equip' && (
          <section className="mview" aria-label="Станция и движение">
            <div className="mview-cap">
              <b>Станция и движение</b>
              <span>
                {stat?.infra.name}
                {stat?.infra.demo ? ' · демонстрационная разметка' : ''}
              </span>
            </div>
            <div className="mview-b">
              <TrackView />
            </div>
          </section>
        )}
        {view !== 'track' && (
          <section className="mview" aria-label="Оборудование и обслуживание">
            <div className="mview-cap">
              <b>Оборудование и обслуживание</b>
            </div>
            <div className="mview-b mview-eq">
              <EquipmentView />
            </div>
          </section>
        )}
      </div>
    </section>
  );
}

function SideTabs() {
  const tab = useMicro((s) => s.tab);
  const setTab = useMicro((s) => s.setTab);
  const tasks = useMicro((s) => s.frame?.staff.tasks.filter((t) => t.phase !== 'done').length ?? 0);
  const items: { id: MicroTab; label: string; count?: number }[] = [
    { id: 'card', label: 'Карточка' },
    { id: 'trains', label: 'Поезда' },
    { id: 'repair', label: 'Ремонт', count: tasks },
    { id: 'bonus', label: 'Премия' },
    { id: 'log', label: 'Журнал' },
    { id: 'catalog', label: 'Справка' },
  ];
  return (
    <aside className="mside" aria-label="Карточки, поезда, ремонт, премия, журнал">
      <Tabs idPrefix="mside" label="Боковая панель" value={tab} onChange={setTab} items={items} />
      <div className="mside-b" role="tabpanel" id="mside-panel" aria-labelledby={`mside-tab-${tab}`}>
        {tab === 'card' && <CardPanel />}
        {tab === 'trains' && <TrainsTab />}
        {tab === 'repair' && <RepairTab />}
        {tab === 'bonus' && <BonusTab />}
        {tab === 'log' && <LogTab />}
        {tab === 'catalog' && <CatalogTab />}
      </div>
    </aside>
  );
}

export function MicroApp({ sideOpen, onToggleSide }: { sideOpen: boolean; onToggleSide: () => void }) {
  const mock = useStore((s) => s.auth.mock);
  const online = useStore((s) => s.conn.status === 'online');
  const view = useMicro((s) => s.view);
  const stat = useMicro((s) => s.stat);
  const scnDesc = useMicro((s) => s.stat?.scenarios.find((x) => x.id === s.frame?.scenario)?.description);
  const [descOpen, setDescOpen] = useState(false);

  useEffect(() => {
    if (online && !mock && !stat) refreshStatic().catch(() => undefined);
  }, [online, mock, stat]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const s = useMicro.getState();
      if (e.key === 'Escape' && s.sel && !s.faultOpen) s.select(null);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  if (mock) {
    return (
      <main id="main" className="micro-empty">
        <TrainFront size={28} />
        <p>Микромодель станции работает только при подключении к серверу (docker compose). В демо-режиме доступен раздел «Сеть и план».</p>
        <button className="btn btn-primary" onClick={() => useStore.getState().logout()}>
          Войти через сервер
        </button>
      </main>
    );
  }

  return (
    <main id="main" className={`micro view-${view}`}>
      <ControlBar sideOpen={sideOpen} onToggleSide={onToggleSide} descOpen={descOpen} onToggleDesc={() => setDescOpen((o) => !o)} />
      {descOpen && scnDesc && <div className="tb-desc">{scnDesc}</div>}
      <MicroKpis />
      <div className="mbody">
        <Workspace />
        <SideTabs />
      </div>
      <FaultDialog />
    </main>
  );
}
