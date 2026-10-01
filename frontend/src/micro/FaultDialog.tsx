import { useEffect, useMemo, useState } from 'react';
import { Siren, X } from 'lucide-react';
import { runCommand } from './api';
import { useMicro } from './store';

export function FaultDialog() {
  const open = useMicro((s) => s.faultOpen);
  const setOpen = useMicro((s) => s.setFaultOpen);
  const stat = useMicro((s) => s.stat);
  const frame = useMicro((s) => s.frame);
  const sel = useMicro((s) => s.sel);
  const [post, setPost] = useState('1');
  const [device, setDevice] = useState('');
  const [note, setNote] = useState('');
  const [minutes, setMinutes] = useState('');

  useEffect(() => {
    if (!open || !stat) return;
    let dev = '';
    if (sel?.kind === 'device') dev = sel.id;
    else if (sel?.kind === 'switch') dev = `СМ-${sel.id}`;
    else if (sel?.kind === 'signal') dev = `СВ-${sel.id}`;
    else if (sel?.kind === 'segment') dev = `РЦ-${sel.id}`;
    const d = stat.equipment.devices.find((x) => x.id === dev);
    if (d) {
      setPost(d.post ?? '');
      setDevice(d.id);
    } else setDevice('');
    setNote('');
    setMinutes(String(frame?.staff.repair_cfg.default_duration_min ?? 60));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, setOpen]);

  const devices = useMemo(() => (stat ? stat.equipment.devices.filter((d) => (post ? d.post === post : d.post === null)) : []), [stat, post]);
  if (!open || !stat) return null;
  const d = stat.equipment.devices.find((x) => x.id === device);
  const kinds = d ? stat.equipment.fault_kinds[d.kind] ?? [] : [];
  const healthy = d && !(frame?.devices[d.id]?.status === 'fault' || frame?.devices[d.id]?.status === 'repair');

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fault-h" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <h2 id="fault-h">
            <Siren size={16} /> Внести отказ оборудования
          </h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Закрыть">
            <X size={16} />
          </button>
        </div>
        <div className="modal-b fault-form">
          <label>
            <span>Пост</span>
            <select value={post} onChange={(e) => (setPost(e.target.value), setDevice(''))}>
              <option value="">Внешнее питание (фидеры)</option>
              {stat.equipment.posts.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Устройство</span>
            <select value={device} onChange={(e) => (setDevice(e.target.value), setNote(''))}>
              <option value="">— выберите —</option>
              {devices.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.id} · {x.name}
                  {frame?.devices[x.id] ? ` (${stat.equipment.status_ru[frame.devices[x.id].status]})` : ''}
                </option>
              ))}
            </select>
          </label>
          {d && (
            <label>
              <span>Неисправность</span>
              <select value={note} onChange={(e) => setNote(e.target.value)}>
                {kinds.map((k) => (
                  <option key={k} value={k === kinds[0] ? '' : k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Длительность ремонта, мин модельного времени</span>
            <input type="number" min={1} max={600} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </label>
          <p className="small muted">
            Последствия рассчитываются по графу зависимостей: потеря контроля стрелки («?»), погашенный сигнал, ложная занятость или работа на резерве.
            Запрет движения вступает в силу немедленно — до следующего шага поезда.
          </p>
        </div>
        <div className="modal-f">
          <button className="btn btn-ghost" onClick={() => setOpen(false)}>
            Отмена
          </button>
          <button
            className="btn btn-danger"
            disabled={!d || !healthy}
            onClick={async () => {
              const r = await runCommand({ type: 'fault', device, note: note || undefined, repair_min: minutes ? Number(minutes) : undefined });
              if (r?.ok) setOpen(false);
            }}
          >
            Внести отказ
          </button>
        </div>
      </div>
    </div>
  );
}
