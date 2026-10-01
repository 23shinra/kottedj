import { useMemo, useState } from 'react';
import { AlertOctagon, FlaskConical, Info, TriangleAlert } from 'lucide-react';
import { useIsAdmin } from '../store';
import { runCommand } from './api';
import { useMicro } from './store';
import type { BonusCfg, MEvent, MTrain } from './types';

function fmtClock(startClock: string, t: number | null | undefined): string {
  if (t == null) return '—';
  const [h, m] = startClock.split(':').map(Number);
  const s = h * 3600 + m * 60 + t;
  return `${String(Math.floor(s / 3600) % 24).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

const ST_ICON: Record<string, string> = {
  scheduled: '◷',
  held: '⏸',
  rejected: '⛔',
  inbound: '▶',
  standing: '■',
  ready: '✓',
  outbound: '▶',
  departed: '↗',
};

function delayOf(tr: MTrain): number | null {
  if (tr.dep_delay_min != null) return tr.dep_delay_min;
  if (tr.arr_delay_min != null) return tr.arr_delay_min;
  return null;
}

export function TrainsTab() {
  const frame = useMicro((s) => s.frame);
  const select = useMicro((s) => s.select);
  if (!frame) return null;
  return (
    <div className="tbl-scroll">
      <table className="mtbl mtbl-trains">
        <thead>
          <tr>
            <th>Поезд</th>
            <th>Состояние</th>
            <th>Путь</th>
            <th title="Прибытие: план, ниже факт">Приб.</th>
            <th title="Отправление: план, ниже факт или прогноз">Отпр.</th>
            <th title="Отклонение от плана, мин">Δ</th>
          </tr>
        </thead>
        <tbody>
          {frame.trains.map((tr) => {
            const d = delayOf(tr);
            const b = tr.blockers[0];
            const why = b ? b.text : tr.status !== 'standing' ? tr.stop_reason : null;
            return (
              <tr key={tr.id} onClick={() => select({ kind: 'train', id: tr.id })} className={`row-${tr.status}`}>
                <td className="nowrap">
                  <b className="num">{tr.id}</b>
                  <div className="muted small">{tr.kind === 'passenger' ? 'пасс.' : 'груз.'} · {tr.consist.gauge}</div>
                </td>
                <td>
                  <span className={`tst tst-${tr.status}`}>
                    {ST_ICON[tr.status]} {tr.status_ru}
                  </span>
                  {why && (
                    <div className="row-why" title={b ? `${b.text}${b.waits ? `\nОжидается: ${b.waits}` : ''}` : why}>
                      {why}
                    </div>
                  )}
                </td>
                <td>{tr.dest ?? tr.preferred ?? '—'}</td>
                <td className="num nowrap">
                  {tr.plan.arrive ?? '—'}
                  <div className="muted">{tr.actual.arrive ?? '—'}</div>
                </td>
                <td className="num nowrap">
                  {tr.plan.depart}
                  <div className="muted">{tr.actual.depart ?? (tr.actual.expected_depart ? `≈${tr.actual.expected_depart}` : '—')}</div>
                </td>
                <td className={`num nowrap ${d != null && d >= 1 ? 'warn' : ''}`}>{d != null ? `${d >= 0 ? '+' : ''}${Math.round(d)}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function RepairTab() {
  const frame = useMicro((s) => s.frame);
  const stat = useMicro((s) => s.stat);
  const select = useMicro((s) => s.select);
  const isAdmin = useIsAdmin();
  const [dur, setDur] = useState<string>('');
  if (!frame || !stat) return null;
  const { tasks, workers, repair_cfg } = frame.staff;
  const sc = stat.start_clock;
  return (
    <div className="pad">
      <div className="rep-cfg">
        <span>
          Длительность ремонта по умолчанию: <b>{repair_cfg.default_duration_min} мин</b> модельного времени · выход {repair_cfg.travel_min} мин · проверка {repair_cfg.verify_min} мин
        </span>
        {isAdmin && (
          <span className="rep-cfg-edit">
            <input type="number" min={5} max={480} placeholder="мин" value={dur} onChange={(e) => setDur(e.target.value)} aria-label="Новая длительность ремонта, мин" />
            <button className="btn btn-xs" disabled={!dur} onClick={() => runCommand({ type: 'repair_config', cfg: { default_duration_min: Number(dur) } }).then(() => setDur(''))}>
              Задать
            </button>
          </span>
        )}
      </div>
      <div className="details-sec">Исполнители</div>
      <ul className="workers">
        {workers.map((w) => (
          <li key={w.id} onClick={() => select({ kind: 'worker', id: w.id })}>
            <b>{w.name}</b> <span className="muted small">{w.role}</span>
            <span className={`tst ${w.busy ? 'tst-inbound' : 'tst-ok'}`}>{w.busy ? `● ${w.task}` : '○ свободен'}</span>
          </li>
        ))}
      </ul>
      <div className="details-sec">Ремонтные задачи</div>
      {!tasks.length && <div className="empty">Задач нет — оборудование исправно.</div>}
      <ul className="tasks">
        {tasks.map((t) => {
          const total = t.phase === 'work' ? t.duration_min * 60 : t.phase === 'travel' ? repair_cfg.travel_min * 60 : repair_cfg.verify_min * 60;
          const left = t.phase_end_t != null ? Math.max(0, t.phase_end_t - frame.t) : 0;
          const pct = t.phase_end_t != null && total ? Math.round(100 * (1 - left / total)) : t.phase === 'done' ? 100 : 0;
          return (
            <li key={t.id} className={`task task-${t.phase}`} onClick={() => select({ kind: 'device', id: t.device })}>
              <div className="task-h">
                <b>{t.id}</b>
                <span className={`tst task-st-${t.phase}`}>{t.phase_ru}</span>
                <span className="muted small">{t.worker ? workers.find((w) => w.id === t.worker)?.name : 'не назначен'}</span>
              </div>
              <div>
                {t.device} · {t.object} — {t.cause}
              </div>
              <div className="muted small">
                создана {fmtClock(sc, t.created_t)} · ремонт {t.duration_min} мин
                {t.phase_end_t != null && ` · этап до ${fmtClock(sc, t.phase_end_t)}`}
                {t.finished_t != null && ` · завершена ${fmtClock(sc, t.finished_t)} (${Math.round((t.finished_t - t.created_t) / 60)} мин)`}
              </div>
              {t.phase !== 'done' && t.phase !== 'queued' && t.phase !== 'blocked' && (
                <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <i style={{ width: `${pct}%` }} />
                </div>
              )}
              {t.result && <div className="small">{t.result}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const BONUS_FIELDS: { k: keyof BonusCfg; label: string; type: 'num' | 'bool' }[] = [
  { k: 'accrual_per_device_hour', label: 'Начисление, у.е. за устройство·час', type: 'num' },
  { k: 'stop_accrual_on_downtime', label: 'Не начислять за время простоя', type: 'bool' },
  { k: 'downtime_penalty_per_hour', label: 'Штраф за час простоя (свой отказ)', type: 'num' },
  { k: 'penalize_upstream', label: 'Штрафовать за чужой (вышестоящий) отказ', type: 'bool' },
  { k: 'repair_cost', label: 'Условная стоимость ремонта', type: 'num' },
  { k: 'fast_recovery_min', label: 'Быстрое восстановление, мин', type: 'num' },
  { k: 'fast_recovery_discount', label: 'Скидка за быстрое восстановление (доля)', type: 'num' },
  { k: 'min_balance', label: 'Минимальный баланс', type: 'num' },
];

export function BonusTab() {
  const frame = useMicro((s) => s.frame);
  const stat = useMicro((s) => s.stat);
  const isAdmin = useIsAdmin();
  const [edit, setEdit] = useState<Partial<BonusCfg>>({});
  const [who, setWho] = useState<string>('');
  if (!frame || !stat) return null;
  const b = frame.bonus;
  const names = Object.fromEntries(frame.staff.workers.map((w) => [w.id, w.name]));
  const ledger = who ? b.ledger.filter((e) => e.worker === who) : b.ledger;
  return (
    <div className="pad">
      <div className="exp-banner" role="note">
        <FlaskConical size={15} aria-hidden="true" />
        <div>
          <b>Экспериментальная модель — гипотеза для обсуждения.</b> Эффективность не доказана; правила настраиваемые. Каждое изменение
          баланса записано с причиной.
        </div>
      </div>
      <table className="mtbl">
        <thead>
          <tr>
            <th>Сотрудник</th>
            <th>Устройств</th>
            <th>Баланс</th>
            <th>Текущий час</th>
          </tr>
        </thead>
        <tbody>
          {b.accounts.map((a) => (
            <tr key={a.worker} onClick={() => setWho(who === a.worker ? '' : a.worker)} className={who === a.worker ? 'row-sel' : ''}>
              <td>{names[a.worker]}</td>
              <td className="num">{a.devices}</td>
              <td className="num">
                <b>{a.balance.toFixed(1)}</b>
              </td>
              <td className="small">
                +{a.pending_ok_dev_h} уст.·ч{a.pending_penalty_min > 0 && <span className="neg"> · простой {a.pending_penalty_min} мин</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details className="bonus-cfg">
        <summary>Правила начисления {isAdmin ? '(редактирование — администратор)' : '(просмотр)'}</summary>
        <div className="cfg-grid">
          {BONUS_FIELDS.map((f) => {
            const cur = (edit[f.k] ?? b.cfg[f.k]) as number | boolean;
            return (
              <label key={f.k}>
                <span>{f.label}</span>
                {f.type === 'bool' ? (
                  <input type="checkbox" checked={!!cur} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, [f.k]: e.target.checked })} />
                ) : (
                  <input type="number" step="0.1" value={String(cur)} disabled={!isAdmin} onChange={(e) => setEdit({ ...edit, [f.k]: Number(e.target.value) })} />
                )}
              </label>
            );
          })}
        </div>
        {isAdmin && (
          <button className="btn btn-xs btn-primary" disabled={!Object.keys(edit).length} onClick={() => runCommand({ type: 'bonus_config', cfg: edit }).then(() => setEdit({}))}>
            Применить
          </button>
        )}
      </details>
      <div className="details-sec">Журнал изменений баланса{who ? ` · ${names[who]}` : ''}</div>
      {!ledger.length && <div className="empty">Записи появляются по итогам каждого модельного часа и при завершении ремонта.</div>}
      <ul className="ledger">
        {ledger.map((e, i) => (
          <li key={i}>
            <span className="muted num small">{fmtClock(stat.start_clock, e.t)}</span>
            <b className={e.delta > 0 ? 'pos num' : e.delta < 0 ? 'neg num' : 'muted num'}>
              {e.delta > 0 ? '+' : ''}
              {e.delta.toFixed(1)}
            </b>
            <span>
              <span className="muted">{names[e.worker]}:</span> {e.reason}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LOG_FILTERS: { id: string; label: string; kinds: string[] }[] = [
  { id: 'all', label: 'Все', kinds: [] },
  { id: 'train', label: 'Движение', kinds: ['train'] },
  { id: 'route', label: 'Маршруты и сигналы', kinds: ['route', 'signal', 'switch'] },
  { id: 'disp', label: 'Решения диспетчера', kinds: ['dispatcher', 'command'] },
  { id: 'fault', label: 'Отказы и ремонт', kinds: ['fault', 'repair', 'safety'] },
  { id: 'bonus', label: 'Премия', kinds: ['bonus'] },
];

function LevelIcon({ e }: { e: MEvent }) {
  if (e.level === 'alarm') return <AlertOctagon size={13} className="crit" aria-label="тревога" />;
  if (e.level === 'warn') return <TriangleAlert size={13} className="warn" aria-label="предупреждение" />;
  return <Info size={13} className="muted" aria-label="информация" />;
}

export function LogTab() {
  const events = useMicro((s) => s.events);
  const select = useMicro((s) => s.select);
  const [f, setF] = useState('all');
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const kinds = LOG_FILTERS.find((x) => x.id === f)?.kinds ?? [];
    const ql = q.trim().toLowerCase();
    return events.filter((e) => (!kinds.length || kinds.includes(e.kind)) && (!ql || e.text.toLowerCase().includes(ql))).slice(0, 300);
  }, [events, f, q]);
  return (
    <div className="mlog">
      <div className="mlog-f">
        {LOG_FILTERS.map((x) => (
          <button key={x.id} className={`btn btn-xs ${f === x.id ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setF(x.id)}>
            {x.label}
          </button>
        ))}
        <input className="mlog-q" placeholder="Поиск: № поезда, стрелка…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск по журналу" />
      </div>
      <ol className="mlog-l" aria-live="polite">
        {shown.map((e) => (
          <li key={e.seq} className={`lv-${e.level}`} onClick={() => e.trains[0] && select({ kind: 'train', id: e.trains[0] })}>
            <span className="num muted">{e.clock}</span>
            <LevelIcon e={e} />
            <span>
              {e.text}
              {e.source && <span className="muted small"> · {e.source}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CatalogTab() {
  const stat = useMicro((s) => s.stat);
  const select = useMicro((s) => s.select);
  if (!stat) return null;
  return (
    <div className="pad">
      <p className="small muted">
        Справочные модели (характеристики из открытых источников). Экземпляры — номера, пробег, износ, ремонты — в карточке поезда.
      </p>
      <div className="details-sec">Локомотивы</div>
      <ul className="cat">
        {stat.catalog.locomotives.map((m) => (
          <li key={m.id} onClick={() => select({ kind: 'loco', id: m.id })}>
            <b>{m.name}</b>
            <span className="muted small">
              {m.traction_ru} · {m.gauge} мм · {m.power_kw} кВт · Fк {m.f_cont_kn} кН · {m.mass_t} т
            </span>
          </li>
        ))}
      </ul>
      <div className="details-sec">Вагоны</div>
      <ul className="cat">
        {stat.catalog.wagons.map((m) => (
          <li key={m.id} onClick={() => select({ kind: 'wagon', id: m.id })}>
            <b>{m.name}</b>
            <span className="muted small">
              {m.type_ru} · {m.gauge} мм · {m.length_m} м · тара {m.tare_t} т{m.capacity_t ? ` · г/п ${m.capacity_t} т` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
