import { useRef } from 'react';
import { Gauge, PanelRight, Settings, Siren } from 'lucide-react';
import { useIsAdmin, useStore, useViewFrame } from '../store';
import type { ViewMode } from '../types';
import { IndexReadout } from './TopBar';
import { Toolbar, ToolbarSep } from './common';

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'ai', label: 'С ИИ' },
  { id: 'baseline', label: 'Без ИИ (FCFS)' },
  { id: 'compare', label: 'Сравнение' },
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
          className={`seg-btn ${mode === m.id ? 'on' : ''}`}
          onClick={() => setMode(m.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function MacroToolbar({ onToggleSide, sideOpen }: { onToggleSide: () => void; sideOpen: boolean }) {
  const frame = useViewFrame();
  const mode = useStore((s) => s.mode);
  const setIncidentOpen = useStore((s) => s.setIncidentOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const isAdmin = useIsAdmin();
  const baseIdx = frame?.compare?.baseline?.index ?? null;
  const aiIdx = frame?.index ?? null;
  const index = mode === 'baseline' ? baseIdx : aiIdx;

  return (
    <Toolbar label="Управление разделом «Сеть и план»">
      <IndexReadout index={index} label={mode === 'baseline' ? 'Индекс FCFS' : 'Индекс'} vs={mode !== 'baseline' ? baseIdx : null} />
      <ToolbarSep />
      <ModeSwitch />
      <div className="topbar-spacer" />
      <button className="btn btn-danger" onClick={() => setIncidentOpen(true)}>
        <Siren size={14} /> Нештатная ситуация
      </button>
      <button
        className="icon-btn icon-btn-lg"
        onClick={() => setSettingsOpen(true)}
        aria-label={isAdmin ? 'Настройки индекса и планировщика' : 'Формула индекса (только просмотр)'}
        title={isAdmin ? 'Настройки' : 'Формула индекса'}
      >
        {isAdmin ? <Settings size={15} /> : <Gauge size={15} />}
      </button>
      <button className={`icon-btn icon-btn-lg side-toggle ${sideOpen ? 'on' : ''}`} onClick={onToggleSide} aria-expanded={sideOpen} aria-label="Рекомендации, очередь и журнал" title="Боковая панель">
        <PanelRight size={15} />
      </button>
    </Toolbar>
  );
}
