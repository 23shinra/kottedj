import { useEffect } from 'react';
import { CircleCheck, CircleAlert, History, Info, RotateCcw, TriangleAlert, WifiOff, X } from 'lucide-react';
import { useIsStale, useStore } from '../store';
import { getHelloAt, reconnectNow } from '../api/live';
import { clock, wallClock } from '../utils/time';
import { useNow } from '../utils/hooks';

export function ConnectionBanner() {
  const stale = useIsStale();
  const conn = useStore((s) => s.conn);
  const hasFrame = useStore((s) => !!s.frame);
  const now = useNow(500);
  if (!stale) return null;
  const secs = conn.retryAt ? Math.max(0, Math.ceil((conn.retryAt - now) / 1000)) : null;
  return (
    <div className="banner banner-crit" role="alert">
      <WifiOff size={16} />
      <span>
        <b>Нет связи с сервером</b>
        {hasFrame && conn.lastMsgAt ? <> — данные на {wallClock(conn.lastMsgAt)}</> : null}
        <span className="banner-sub">
          {conn.status === 'reconnecting' || conn.status === 'offline'
            ? ` · попытка ${conn.attempt}${secs != null ? `, следующая через ${secs} с` : ''}`
            : ' · подключение…'}
          . Показаны последние полученные данные, действия могут не выполниться.
        </span>
      </span>
      <button className="btn btn-xs btn-ghost" onClick={reconnectNow}>
        Повторить сейчас
      </button>
    </div>
  );
}

export function HistoryBanner() {
  const hv = useStore((s) => s.historyView);
  const setHistoryView = useStore((s) => s.setHistoryView);
  if (!hv) return null;
  const sim = hv.frame?.state.sim_time;
  return (
    <div className="banner banner-warn" role="status">
      <History size={16} />
      <span>
        <b>Просмотр истории {sim != null ? clock(sim) : ''}</b> · кадр от {wallClock(hv.ts)}. Все виджеты показывают сохранённое состояние, действия отключены.
        {hv.error && <span className="banner-sub"> Ошибка: {hv.error}</span>}
      </span>
      <button className="btn btn-xs btn-warn" onClick={() => setHistoryView(null)}>
        <RotateCcw size={13} /> Вернуться в онлайн
      </button>
    </div>
  );
}

export function BaselineNote() {
  const mode = useStore((s) => s.mode);
  if (mode !== 'baseline') return null;
  return (
    <div className="banner banner-info" role="status">
      <Info size={16} />
      <span>
        <b>Режим «Без ИИ (FCFS)»</b>: KPI, индекс и факторы — параллельного двойника с реактивным диспетчером. Схема, очередь и график путей
        показывают мир ИИ для наглядного сравнения.
      </span>
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const drop = useStore((s) => s.dropToast);
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          {t.kind === 'ok' ? <CircleCheck size={16} /> : t.kind === 'error' ? <CircleAlert size={16} /> : t.kind === 'warn' ? <TriangleAlert size={16} /> : <Info size={16} />}
          <span>{t.text}</span>
          <button className="icon-btn" onClick={() => drop(t.id)} aria-label="Закрыть уведомление">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Замер задержки «событие в симуляторе → отрисовка» после коммита каждого нового кадра. */
export function LatencyProbe() {
  const frame = useStore((s) => s.frame);
  const push = useStore((s) => s.pushLatency);
  useEffect(() => {
    if (!frame || document.hidden || Date.now() - getHelloAt() < 3000) return; // прогрев после (пере)подключения
    const emitted = frame.emitted_at;
    // ждём фактической отрисовки (следующий кадр анимации после коммита)
    const id = requestAnimationFrame(() => {
      const lat = Date.now() - emitted;
      if (lat >= 0 && lat < 60000) push(lat);
    });
    return () => cancelAnimationFrame(id);
  }, [frame, push]);
  return null;
}
