import { useEffect, useMemo, useRef, useState } from 'react';
import { Ban, Clock, Siren, TrainTrack, Wrench, X, Zap } from 'lucide-react';
import { useStore } from '../store';
import { api, errText } from '../api/rest';
import type { Incident } from '../types';
import { clock } from '../utils/time';

export function IncidentDrawer() {
  const open = useStore((s) => s.incidentOpen);
  const setOpen = useStore((s) => s.setIncidentOpen);
  const station = useStore((s) => s.station);
  const frame = useStore((s) => s.frame);
  const toast = useStore((s) => s.toast);
  const history = useStore((s) => !!s.historyView);
  const [track, setTrack] = useState('');
  const [duration, setDuration] = useState(40);
  const [train, setTrain] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [loco, setLoco] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const trains = useMemo(() => {
    if (!frame) return [];
    const live = frame.state.trains.filter((t) => t.status !== 'departed' && t.status !== 'rerouted').map((t) => ({ id: t.id, label: `№${t.id} · ${t.status === 'on_track' ? `путь ${t.track}` : t.status === 'at_signal' ? 'у сигнала' : 'на подходе'}` }));
    const up = frame.state.upcoming.slice(0, 12).map((u) => ({ id: u.id, label: `№${u.id} · по графику ${clock(u.planned_arr)}` }));
    return [...live, ...up];
  }, [frame]);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('select, button')?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, setOpen]);

  if (!open) return null;

  const send = async (key: string, body: Incident | 'stress', okText: string) => {
    setBusy(key);
    try {
      if (body === 'stress') await api.stress();
      else await api.incident(body);
      toast('warn', `${okText}. ИИ строит варианты перепланирования…`);
      setOpen(false);
    } catch (e) {
      toast('error', `Не удалось создать инцидент: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const tracks = station?.tracks ?? [];
  const tState = new Map((frame?.state.tracks ?? []).map((t) => [t.id, t]));
  const locos = frame?.state.locos ?? [];

  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="inc-h" ref={ref}>
        <header className="drawer-h">
          <h2 id="inc-h">
            <Siren size={18} /> Нештатная ситуация
          </h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть">
            <X size={18} />
          </button>
        </header>
        <p className="drawer-lead">
          Инцидент применяется к обоим цифровым двойникам. ИИ сразу пересчитает план и предложит 3 варианта — сравните их с реакцией FCFS-диспетчера.
        </p>
        {history && <div className="inline-warn">Режим просмотра истории: вернитесь в онлайн, чтобы создавать инциденты.</div>}

        <form
          className="inc-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (track) send('close', { type: 'close_track', track, duration_min: duration }, `Путь ${track} закрыт на ${duration} мин`);
          }}
        >
          <h3>
            <Ban size={15} /> Закрыть путь
          </h3>
          <div className="row2">
            <label>
              Путь
              <select value={track} onChange={(e) => setTrack(e.target.value)} required>
                <option value="">— выберите —</option>
                {tracks.map((t) => {
                  const s = tState.get(t.id);
                  return (
                    <option key={t.id} value={t.id} disabled={s?.status === 'closed'}>
                      {t.id} · {station?.parks.find((p) => p.id === t.park)?.name} {s?.status === 'closed' ? '(закрыт)' : s?.train ? `(занят №${s.train})` : s?.status === 'reserve' ? '(резерв)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>
            <label>
              Длительность
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {[15, 30, 40, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} мин
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="btn btn-danger-soft" type="submit" disabled={!track || !!busy || history}>
            <TrainTrack size={14} /> {busy === 'close' ? 'Отправка…' : 'Закрыть путь'}
          </button>
        </form>

        <form
          className="inc-card"
          onSubmit={(e) => {
            e.preventDefault();
            if (train) send('delay', { type: 'delay', train, minutes }, `Поезд №${train} задержан на ${minutes} мин`);
          }}
        >
          <h3>
            <Clock size={15} /> Задержка поезда
          </h3>
          <div className="row2">
            <label>
              Поезд
              <select value={train} onChange={(e) => setTrain(e.target.value)} required>
                <option value="">— выберите —</option>
                {trains.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              На сколько
              <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                {[5, 10, 15, 20, 30, 45, 60].map((m) => (
                  <option key={m} value={m}>
                    +{m} мин
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button className="btn btn-danger-soft" type="submit" disabled={!train || !!busy || history}>
            <Clock size={14} /> {busy === 'delay' ? 'Отправка…' : 'Задержать поезд'}
          </button>
        </form>

        <form
          className="inc-card"
          onSubmit={(e) => {
            e.preventDefault();
            send('loco', { type: 'loco_failure', ...(loco ? { loco } : {}) }, `Отказ локомотива${loco ? ' ' + loco : ''}`);
          }}
        >
          <h3>
            <Wrench size={15} /> Отказ локомотива
          </h3>
          <label>
            Локомотив
            <select value={loco} onChange={(e) => setLoco(e.target.value)}>
              <option value="">любой свободный (выберет сервер)</option>
              {locos.map((l) => (
                <option key={l.id} value={l.id} disabled={l.status === 'failed'}>
                  {l.id} · {l.status}
                  {l.train ? ` · №${l.train}` : ''}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-danger-soft" type="submit" disabled={!!busy || history}>
            <Wrench size={14} /> {busy === 'loco' ? 'Отправка…' : 'Вывести из строя'}
          </button>
        </form>

        <div className="inc-card inc-stress">
          <h3>
            <Zap size={15} /> Стресс-тест
          </h3>
          <p className="muted small">Несколько сбоев одновременно + поток событий ×10 в течение 30 с. Проверка, что интерфейс и планировщик держат нагрузку (задержка UI &lt; 500 мс).</p>
          <button className="btn btn-stress" onClick={() => send('stress', 'stress', 'Запущен стресс-тест ×10')} disabled={!!busy || history}>
            <Zap size={18} /> {busy === 'stress' ? 'Запуск…' : 'Стресс ×10'}
          </button>
        </div>
      </aside>
    </div>
  );
}
