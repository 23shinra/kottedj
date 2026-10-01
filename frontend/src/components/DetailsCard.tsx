import type { ReactNode } from 'react';
import { TriangleAlert, X } from 'lucide-react';
import { useStore, useViewFrame, useViewPlan } from '../store';
import type { Train, UpcomingTrain } from '../types';
import { CAT_NAME, PARK_SHORT, STATUS_NAME } from '../utils/theme';
import { clock, dur } from '../utils/time';
import { serviceProgress } from '../utils/derive';
import { CatBadge } from './common';

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

export function DetailsCard() {
  const sel = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const station = useStore((s) => s.station);
  const frame = useViewFrame();
  const plan = useViewPlan();
  if (!sel || !frame) return null;
  const st = frame.state;
  const now = st.sim_time;
  const close = (
    <button className="icon-btn" onClick={() => select(null)} aria-label="Закрыть карточку">
      <X size={16} />
    </button>
  );

  if (sel.kind === 'track') {
    const def = station?.tracks.find((t) => t.id === sel.id);
    const ts = st.tracks.find((t) => t.id === sel.id);
    const upcoming = Object.entries(plan?.assignments ?? {})
      .filter(([, a]) => a.track === sel.id && a.entry_at != null && a.entry_at >= now)
      .sort((a, b) => (a[1].entry_at ?? 0) - (b[1].entry_at ?? 0))
      .slice(0, 4);
    const statusName = { free: 'свободен', occupied: 'занят', closed: 'закрыт', reserve: 'резервный' }[ts?.status ?? 'free'];
    return (
      <aside className="details" aria-label={`Путь ${sel.id}`}>
        <header className="details-h">
          <h3>Путь {sel.id}</h3>
          <span className={`tag tag-${ts?.status}`}>{statusName}</span>
          {close}
        </header>
        <dl className="kv">
          <Row k="Парк" v={station?.parks.find((p) => p.id === def?.park)?.name ?? def?.park} />
          <Row k="Полезная длина" v={`${def?.length_m ?? '—'} м`} />
          <Row k="Принимает" v={def?.accepts.map((c) => CAT_NAME[c]).join(', ')} />
          <Row k="Оснащение" v={[def?.platform && 'платформа', def?.electrified ? 'электрифицирован' : 'не электрифицирован', def?.cargo && 'грузовой фронт'].filter(Boolean).join(', ')} />
          <Row k="Стрелочные улицы" v={`W: ${def?.ladders.W} · E: ${def?.ladders.E}`} />
          {ts?.train && (
            <Row
              k="Поезд"
              v={
                <button className="link" onClick={() => select({ kind: 'train', id: ts.train! })}>
                  №{ts.train}
                </button>
              }
            />
          )}
          {ts?.status === 'closed' && <Row k="Закрыт до" v={<span className="crit">{clock(ts.closed_until)}</span>} />}
        </dl>
        <div className="details-sec">Далее по плану</div>
        {upcoming.length ? (
          <ul className="mini-list">
            {upcoming.map(([id, a]) => (
              <li key={id}>
                <button className="link" onClick={() => select({ kind: 'train', id })}>
                  №{id}
                </button>
                <span className="num">
                  {clock(a.entry_at)} → {clock(a.dep_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">Нет запланированных поездов в горизонте плана</p>
        )}
      </aside>
    );
  }

  const t: Train | undefined = st.trains.find((x) => x.id === sel.id);
  const u: UpcomingTrain | undefined = t ? undefined : st.upcoming.find((x) => x.id === sel.id);
  const base = t ?? u;
  if (!base) {
    return (
      <aside className="details">
        <header className="details-h">
          <h3>Поезд №{sel.id}</h3>
          {close}
        </header>
        <p className="muted small">Поезд не найден в текущем кадре</p>
      </aside>
    );
  }
  const a = plan?.assignments[sel.id];
  const prog = t ? serviceProgress(t, now) : null;
  const delay = t?.delay_s ?? Math.max(0, (a?.entry_at ?? base.eta) - base.planned_arr);
  const resource = (id: string | null | undefined, from?: string, at?: number, missing?: boolean) => {
    if (missing) return <span className="crit"><TriangleAlert size={12} /> не хватает на горизонте</span>;
    if (id) return `${id}${at ? ` к ${clock(at)}` : ''}`;
    if (from) return `от поезда №${from}${at ? ` к ${clock(at)}` : ''}`;
    return '—';
  };
  const status = t?.status ?? 'scheduled';
  return (
    <aside className="details" aria-label={`Поезд ${sel.id}`}>
      <header className="details-h">
        <h3>Поезд №{base.id}</h3>
        <CatBadge cat={base.cat} />
        {close}
      </header>
      <div className={`details-status st-${status}`}>
        <b>{STATUS_NAME[status]}</b>
        {t?.reason_text && <span> — {t.reason_text}</span>}
      </div>
      <dl className="kv">
        <Row k="Длина" v={`${base.length_m} м`} />
        <Row k="Маршрут" v={`${base.side_in} → ${base.side_out}`} />
        <Row k="По графику" v={<span className="num">приб. {clock(base.planned_arr)} · отпр. {clock(base.planned_dep)}</span>} />
        <Row k="ETA к сигналу" v={<span className="num">{clock(base.eta)}</span>} />
        {t?.entered_at != null && <Row k="Принят" v={<span className="num">{clock(t.entered_at)}</span>} />}
        {t?.departed_at != null && <Row k="Отправлен" v={<span className="num">{clock(t.departed_at)}</span>} />}
        <Row k="Задержка" v={<span className={delay > 600 ? 'warn' : ''}>{delay > 0 ? dur(delay) : 'нет'}</span>} />
        {t && ['approaching', 'held', 'at_signal'].includes(t.status) && (
          <Row
            k="Подход"
            v={`${(t.pos_m / 1000).toFixed(1).replace('.', ',')} км · ${t.regulated && t.advisory_kmh ? `рекомендовано ▼ ${Math.round(t.advisory_kmh)} км/ч` : `${Math.round(t.speed_kmh)} км/ч`}`}
          />
        )}
        {t && (t.hold_until ?? 0) > now && <Row k="Удержан до" v={<span className="warn num">{clock(t.hold_until)}</span>} />}
        <Row k="Путь" v={t?.track ? `${t.track} (факт)` : a?.track ? `${a.track} (план, ${PARK_SHORT[station?.tracks.find((x) => x.id === a.track)?.park ?? ''] ?? ''})` : '—'} />
        {a && (
          <Row
            k="Слот плана"
            v={<span className="num">{a.entry_at != null ? `вход ${clock(a.entry_at)} · ` : ''}отпр. {clock(a.dep_at)}</span>}
          />
        )}
        <Row k="Локомотив" v={t?.loco ?? resource(a?.loco, a?.loco_from, a?.loco_at, a?.loco_missing)} />
        <Row k="Бригада" v={t?.crew ?? resource(a?.crew, a?.crew_from, a?.crew_at, a?.crew_missing)} />
        {t && t.res_wait_s > 0 && <Row k="Ожидание ресурса" v={dur(t.res_wait_s)} />}
      </dl>
      {prog != null && t?.status !== 'departed' && (
        <div className="details-prog" aria-label={`Обслуживание ${Math.round(prog * 100)}%`}>
          <div className="details-sec">
            Обслуживание <span className="num">{Math.round(prog * 100)}%</span>
            <span className="muted"> · до {clock(t?.service_done_at)}</span>
          </div>
          <div className="bar">
            <i style={{ width: `${prog * 100}%` }} />
          </div>
        </div>
      )}
    </aside>
  );
}
