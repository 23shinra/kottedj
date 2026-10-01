import { useState } from 'react';
import { FileSpreadsheet, FileText, History, Radio, RotateCcw } from 'lucide-react';
import { useStore } from '../store';
import { api, downloadReport, errText } from '../api/rest';
import { useDebounced, useNow } from '../utils/hooks';
import { clock, wallClock } from '../utils/time';

const WINDOW_MS = 15 * 60000;

export function useHistoryControls() {
  const setHistoryView = useStore((s) => s.setHistoryView);
  const toast = useStore((s) => s.toast);
  const fetchFrame = useDebounced(async (ts: number) => {
    try {
      const r = await api.historyFrame(ts);
      const cur = useStore.getState().historyView;
      if (!cur || cur.ts !== ts) return; // пользователь уже сдвинул ползунок
      if (!r.frame) throw new Error('Кадр не найден');
      setHistoryView({ ts, loading: false, frame: r.frame, plan: r.plan });
    } catch (e) {
      const cur = useStore.getState().historyView;
      if (cur && cur.ts === ts) setHistoryView({ ...cur, loading: false, error: errText(e) });
      toast('error', `История недоступна: ${errText(e)}`);
    }
  }, 250);
  const seek = (ts: number) => {
    const prev = useStore.getState().historyView;
    setHistoryView({ ts, loading: true, frame: prev?.frame ?? null, plan: prev?.plan ?? null });
    fetchFrame(ts);
  };
  const live = () => setHistoryView(null);
  return { seek, live };
}

function nearestSim(ts: number): number | null {
  const hist = useStore.getState().hist;
  if (!hist.length) return null;
  let best = hist[0];
  for (const h of hist) if (Math.abs(h.ts - ts) < Math.abs(best.ts - ts)) best = h;
  return Math.abs(best.ts - ts) < 5000 ? best.sim : null;
}

export function HistoryBar() {
  const hv = useStore((s) => s.historyView);
  const link = useStore((s) => s.frame?.link);
  const toast = useStore((s) => s.toast);
  const now = useNow(1000);
  const { seek, live } = useHistoryControls();
  const [dl, setDl] = useState<string | null>(null);
  const min = now - WINDOW_MS;
  const value = hv ? Math.max(min, hv.ts) : now;
  const histSim = hv ? hv.frame?.state.sim_time ?? nearestSim(hv.ts) : null;

  const onChange = (v: number) => {
    if (now - v < 2500) {
      live();
      return;
    }
    seek(v);
  };

  const download = async (kind: 'csv' | 'pdf') => {
    setDl(kind);
    try {
      await downloadReport(kind);
      toast('ok', `Отчёт ${kind.toUpperCase()} сохранён`);
    } catch (e) {
      toast('error', `Отчёт ${kind.toUpperCase()}: ${errText(e)}`);
    } finally {
      setDl(null);
    }
  };

  return (
    <footer className="histbar" aria-label="История и отчёты">
      <div className="hist-label">
        <History size={15} />
        {hv ? (
          <span className="hist-state warn">
            Просмотр истории <b className="num">{histSim != null ? clock(histSim) : '…'}</b>
            <span className="muted num"> ({wallClock(hv.ts)})</span>
            {hv.loading && <span className="muted"> · загрузка…</span>}
          </span>
        ) : (
          <span className="hist-state ok">
            <Radio size={13} /> Онлайн
          </span>
        )}
      </div>
      <div className="hist-slider">
        <input
          type="range"
          min={min}
          max={now}
          step={1000}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Перемотка истории за последние 15 минут"
          aria-valuetext={hv ? `Просмотр ${wallClock(hv.ts)}` : 'Онлайн'}
          style={{ ['--p' as string]: `${((value - min) / WINDOW_MS) * 100}%` }}
        />
        <div className="hist-ticks" aria-hidden="true">
          <span>−15 мин</span>
          <span>−10</span>
          <span>−5</span>
          <span>сейчас</span>
        </div>
      </div>
      {hv && (
        <button className="btn btn-xs btn-warn" onClick={live}>
          <RotateCcw size={13} /> Вернуться в онлайн
        </button>
      )}
      <div className="links" aria-label="Состояние сервисов">
        {link &&
          (['simulator', 'ingest', 'planner'] as const).map((k) =>
            link[k] != null ? (
              <span key={k} className={`link-st ${link[k] === 'up' ? 'up' : 'down'}`} title={`${k}: ${link[k]}`}>
                <i />
                {k === 'simulator' ? 'симулятор' : k === 'ingest' ? 'приём данных' : 'оптимизатор'}
              </span>
            ) : null,
          )}
      </div>
      <div className="exports">
        <button className="btn btn-xs btn-ghost" onClick={() => download('csv')} disabled={!!dl}>
          <FileSpreadsheet size={14} /> {dl === 'csv' ? 'Загрузка…' : 'Отчёт CSV'}
        </button>
        <button className="btn btn-xs btn-ghost" onClick={() => download('pdf')} disabled={!!dl}>
          <FileText size={14} /> {dl === 'pdf' ? 'Загрузка…' : 'Отчёт PDF'}
        </button>
      </div>
    </footer>
  );
}
