import { useEffect, useState } from 'react';
import { ExternalLink, Lock, Pause, Play, Plus, Route as RouteIcon, TriangleAlert, X } from 'lucide-react';
import { useIsAdmin } from '../store';
import { microApi, runCommand } from './api';
import { useMicro } from './store';
import type { Blocker, CommandResult, LocoModel, MSelection, MTrain, RepairTask, Source, WagonModel } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Card = Record<string, any>;

const KIND_RU: Record<string, string> = {
  train: 'Поезд',
  segment: 'Участок',
  switch: 'Стрелка',
  signal: 'Светофор',
  device: 'Устройство',
  worker: 'Сотрудник',
  loco: 'Модель локомотива',
  wagon: 'Модель вагона',
};

function useCard(sel: MSelection): { card: Card | null; error: string | null; reload: () => void } {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const frameT = useMicro((s) => Math.floor((s.frame?.t ?? 0) / 5));
  useEffect(() => {
    setCard(null);
    setError(null);
  }, [sel?.kind, sel?.id]);
  useEffect(() => {
    if (!sel) return;
    let alive = true;
    microApi
      .card<Card>(sel.kind, sel.id)
      .then((c) => alive && (setCard(c), setError(null)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sel?.kind, sel?.id, frameT, tick]);
  return { card, error, reload: () => setTick((t) => t + 1) };
}

export function Blockers({ items, title = 'Почему ждёт' }: { items: Blocker[]; title?: string }) {
  const select = useMicro((s) => s.select);
  if (!items.length) return null;
  return (
    <div className="blk">
      <div className="blk-h">
        <TriangleAlert size={13} aria-hidden="true" /> {title}
      </div>
      <ul>
        {items.map((b, i) => (
          <li key={i} className={b.persistent ? 'blk-pers' : ''}>
            <div>{b.text}</div>
            {b.waits && <div className="blk-w">Ожидается: {b.waits}</div>}
            {b.trains.length > 0 && (
              <div className="blk-t">
                Затронуты:{' '}
                {b.trains.map((t) => (
                  <button key={t} className="chip-link" onClick={() => select({ kind: 'train', id: t })}>
                    № {t}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Result({ r }: { r: CommandResult | null }) {
  if (!r) return null;
  if (r.ok) return <div className="cmd-ok">✓ {r.message}</div>;
  return (
    <div className="cmd-fail">
      <div>✕ {r.message}</div>
      {r.blockers && <Blockers items={r.blockers} title="Команда отклонена" />}
    </div>
  );
}

function Sources({ list }: { list: Source[] }) {
  return (
    <ul className="src">
      {list.map((s) => (
        <li key={s.url}>
          <a href={s.url} target="_blank" rel="noreferrer">
            {s.title} <ExternalLink size={11} aria-hidden="true" />
          </a>
          <span className="muted"> · {s.level === 'manufacturer' ? 'производитель' : s.level === 'operator' ? 'оператор' : 'вторичный'}</span>
        </li>
      ))}
    </ul>
  );
}

function Chain({ items }: { items: { id: string; name: string; status: string; status_ru: string }[] }) {
  const select = useMicro((s) => s.select);
  return (
    <ul className="chain">
      {items.map((d) => (
        <li key={d.id}>
          <button className={`dv dv-${d.status}`} onClick={() => select({ kind: 'device', id: d.id })}>
            <span className="dv-id">{d.id}</span>
          </button>
          <span className="chain-n">{d.name}</span>
          <span className={`chain-s st-${d.status}`}>{d.status_ru}</span>
        </li>
      ))}
    </ul>
  );
}

export function LocoModelCard({ m }: { m: LocoModel }) {
  return (
    <>
      <dl className="kv">
        <dt>Назначение</dt>
        <dd>{m.purpose}</dd>
        <dt>Род тяги</dt>
        <dd>{m.traction_ru ?? m.traction}</dd>
        <dt>Колея</dt>
        <dd>{m.gauge} мм</dd>
        <dt>Мощность</dt>
        <dd>{m.power_kw} кВт</dd>
        <dt>Служебная масса</dt>
        <dd>{m.mass_t} т</dd>
        <dt>Сила тяги</dt>
        <dd>
          трогание {m.f_start_kn} кН · длительная {m.f_cont_kn} кН при {m.v_cont_kmh} км/ч
        </dd>
        <dt>Конструкц. скорость</dt>
        <dd>{m.vmax_kmh} км/ч</dd>
        <dt>Длина / оси</dt>
        <dd>
          {m.length_m} м · {m.axle_formula}
        </dd>
      </dl>
      {m.notes && <p className="note">{m.notes}</p>}
      <div className="details-sec">Источники</div>
      <Sources list={m.sources} />
    </>
  );
}

export function WagonModelCard({ m }: { m: WagonModel }) {
  return (
    <>
      <dl className="kv">
        <dt>Тип</dt>
        <dd>{m.type_ru}</dd>
        <dt>Колея</dt>
        <dd>{m.gauge} мм</dd>
        <dt>Длина по автосцепкам</dt>
        <dd>{m.length_m} м</dd>
        <dt>Тара</dt>
        <dd>{m.tare_t} т</dd>
        {m.capacity_t > 0 && (
          <>
            <dt>Грузоподъёмность</dt>
            <dd>{m.capacity_t} т</dd>
          </>
        )}
        {m.seats > 0 && (
          <>
            <dt>Мест</dt>
            <dd>{m.seats}</dd>
          </>
        )}
        <dt>Скорость</dt>
        <dd>{m.vmax_kmh} км/ч</dd>
        <dt>Груз</dt>
        <dd>{m.cargo.join(', ')}</dd>
      </dl>
      {m.notes && <p className="note">{m.notes}</p>}
      <div className="details-sec">Источники</div>
      <Sources list={m.sources} />
    </>
  );
}

function TrainCard({ c }: { c: Card }) {
  const tr = c as MTrain & Card;
  const [res, setRes] = useState<CommandResult | null>(null);
  const [showW, setShowW] = useState(false);
  const act = async (cmd: Record<string, unknown>) => setRes(await runCommand(cmd));
  const mc = c.mass_check;
  const massOk = mc.actual_t <= mc.allowed_t;
  return (
    <>
      <div className="card-status">
        <span className={`tst tst-${tr.status}`}>{tr.status_ru}</span>
        {tr.dest && <span>путь {tr.dest}</span>}
        <span className="muted">
          {tr.frm} → {tr.to} · {tr.op_ru}
        </span>
      </div>
      <dl className="kv">
        <dt>Прибытие</dt>
        <dd>
          план {tr.plan.arrive ?? '—'} · факт {tr.actual.arrive ?? '—'}
          {tr.arr_delay_min != null && tr.arr_delay_min >= 1 && <b className="warn"> +{Math.round(tr.arr_delay_min)} мин</b>}
        </dd>
        <dt>Отправление</dt>
        <dd>
          план {tr.plan.depart} · {tr.actual.depart ? `факт ${tr.actual.depart}` : tr.actual.expected_depart ? `ожид. ${tr.actual.expected_depart}` : '—'}
          {tr.dep_delay_min != null && tr.dep_delay_min >= 1 && <b className="warn"> +{Math.round(tr.dep_delay_min)} мин</b>}
        </dd>
        <dt>Скорость</dt>
        <dd>{tr.v_kmh} км/ч</dd>
        {tr.stop_reason && (
          <>
            <dt>Остановка</dt>
            <dd>{tr.stop_reason}</dd>
          </>
        )}
        {tr.routes.length > 0 && (
          <>
            <dt>Маршрут</dt>
            <dd>{tr.routes.join(', ')}</dd>
          </>
        )}
      </dl>
      <Blockers items={tr.blockers} />
      {tr.delay_reasons.length > 0 && (
        <>
          <div className="details-sec">Причины задержки (накоплено)</div>
          <ul className="dly">
            {tr.delay_reasons.map((d) => (
              <li key={d.reason}>
                <span>{d.reason}</span>
                <b className="num">{d.min} мин</b>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="card-actions">
        {tr.status !== 'departed' && tr.status !== 'rejected' && (
          <button className="btn btn-xs" onClick={() => act({ type: 'hold', train: tr.id, on: !tr.manual_hold })}>
            {tr.manual_hold ? <Play size={13} /> : <Pause size={13} />}
            {tr.manual_hold ? 'Отпустить' : 'Удержать'}
          </button>
        )}
        {(tr.status === 'scheduled' || tr.status === 'held') && (
          <button className="btn btn-xs" onClick={() => act({ type: 'delay', train: tr.id, minutes: 15, note: 'задержка, внесённая диспетчером' })}>
            +15 мин задержки
          </button>
        )}
        {tr.status !== 'departed' && tr.status !== 'rejected' && (
          <button className="btn btn-xs" onClick={() => act({ type: 'add_loco', train: tr.id, model: c.locos[0].model, note: 'прицеплен дополнительный локомотив' })}>
            <Plus size={13} /> Локомотив
          </button>
        )}
      </div>
      <Result r={res} />

      <div className="details-sec">Состав</div>
      <dl className="kv">
        <dt>Локомотивы</dt>
        <dd>{tr.consist.locos}</dd>
        <dt>Вагоны</dt>
        <dd>{tr.consist.groups.map((g: { model: string; count: number }) => `${g.count} × ${g.model}`).join(', ')}</dd>
        <dt>Длина / масса</dt>
        <dd>
          {tr.consist.length_m} м · {tr.consist.mass_t} т (вагоны {tr.consist.wagons_mass_t} т)
        </dd>
        {tr.consist.capacity_t > 0 && (
          <>
            <dt>Загрузка</dt>
            <dd>
              {tr.consist.load_t} из {tr.consist.capacity_t} т ({tr.load_pct}%)
            </dd>
          </>
        )}
        <dt>Колея / скорость</dt>
        <dd>
          {tr.consist.gauge} мм · до {tr.consist.vmax_kmh} км/ч
        </dd>
        <dt>Допустимая масса</dt>
        <dd className={massOk ? 'ok' : 'crit'}>
          {mc.allowed_t} т на подъёме {mc.grade_permille} ‰ — {massOk ? 'в норме' : `превышение ${mc.actual_t - mc.allowed_t} т`}
          <div className="muted small">{mc.formula}</div>
        </dd>
      </dl>
      {tr.reject_reasons.length > 0 && <Blockers title="Отказ в приёме" items={tr.reject_reasons.map((t: string) => ({ key: 'r', text: t, objects: [], trains: [], waits: '', persistent: true }))} />}

      <div className="details-sec">Пригодность путей</div>
      <ul className="acc">
        {Object.entries(c.acceptance as Record<string, string[]>).map(([t, r]) => (
          <li key={t} className={r.length ? 'acc-no' : 'acc-ok'} title={r.join('\n')}>
            <b>{r.length ? '✕' : '✓'} {t}</b>
            {r.length > 0 && <span className="muted small"> {r[0]}</span>}
          </li>
        ))}
      </ul>

      <div className="details-sec">Локомотивы (экземпляр + модель)</div>
      {c.locos.map((l: Card) => (
        <details key={l.id} className="inst">
          <summary>
            <b>{l.id}</b> · {l.model_name} · {l.state} · пробег {l.mileage_km.toLocaleString('ru-RU')} км · износ {l.wear_pct}%
          </summary>
          <dl className="kv">
            <dt>Обслуживание</dt>
            <dd>
              {l.last_service}, до следующего ТО {l.next_service_km.toLocaleString('ru-RU')} км
            </dd>
          </dl>
          <LocoModelCard m={l.model_card} />
        </details>
      ))}
      <div className="details-sec">
        Вагоны ({c.wagons.length}){' '}
        <button className="link" onClick={() => setShowW((v) => !v)}>
          {showW ? 'скрыть' : 'показать'}
        </button>
      </div>
      {showW && (
        <div className="table-wrap">
          <table className="wtbl">
            <thead>
              <tr>
                <th>№</th>
                <th>Модель</th>
                <th>Груз, т</th>
                <th>Износ</th>
                <th>Пробег, км</th>
                <th>Ремонт</th>
              </tr>
            </thead>
            <tbody>
              {c.wagons.map((w: Card) => (
                <tr key={w.number} title={`${w.model_name}: ${w.state}; следующий ремонт ${w.next_repair}`}>
                  <td className="num">{w.number}</td>
                  <td>{w.model}</td>
                  <td className="num">{w.type === 'пассажирский' ? `${w.passengers} пасс.` : `${w.load_t}/${w.capacity_t}`}</td>
                  <td className="num">{w.wear_pct}%</td>
                  <td className="num">{w.mileage_km.toLocaleString('ru-RU')}</td>
                  <td className="small">{w.last_repair}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SwitchCard({ c }: { c: Card }) {
  const [res, setRes] = useState<CommandResult | null>(null);
  const act = async (cmd: Record<string, unknown>) => setRes(await runCommand(cmd));
  return (
    <>
      <div className="card-status">
        <span className={`tst sw-st-${c.state}`}>{c.state_ru}</span>
        {c.locked_by && (
          <span>
            <Lock size={12} /> {c.locked_by}
          </span>
        )}
        {c.occupied && <span className="warn">под поездом {c.occupied}</span>}
      </div>
      <dl className="kv">
        <dt>Подтверждённое</dt>
        <dd>{c.pos ? (c.pos === '+' ? 'плюсовое (+)' : 'минусовое (−)') : 'нет контроля'}</dd>
        <dt>Заданное</dt>
        <dd>{c.commanded === '+' ? 'плюсовое (+)' : 'минусовое (−)'}</dd>
        <dt>Время перевода</dt>
        <dd>{c.throw_s} с</dd>
        <dt>Переводов</dt>
        <dd>
          {c.throws}
          {c.last_throw ? `, последний ${c.last_throw}` : ''}
        </dd>
        <dt>Ветви</dt>
        <dd>
          + {c.normal} · − {c.reverse} · хвост {c.stem}
        </dd>
      </dl>
      <div className="card-actions">
        <button className="btn btn-xs" onClick={() => act({ type: 'throw_switch', switch: c.id, pos: '+' })}>
          Перевести в +
        </button>
        <button className="btn btn-xs" onClick={() => act({ type: 'throw_switch', switch: c.id, pos: '-' })}>
          Перевести в −
        </button>
      </div>
      <Result r={res} />
      <div className="details-sec">Цепочка оборудования (до питания)</div>
      <Chain items={c.equipment} />
      <div className="details-sec">Маршруты через стрелку</div>
      <p className="small muted">{c.routes.join(', ')}</p>
    </>
  );
}

function SignalCard({ c }: { c: Card }) {
  const [res, setRes] = useState<CommandResult | null>(null);
  const frame = useMicro((s) => s.frame);
  const act = async (cmd: Record<string, unknown>) => setRes(await runCommand(cmd));
  return (
    <>
      <div className="card-status">
        <span className={`tst sig-st-${c.dark ? 'dark' : c.open ? 'open' : 'closed'}`}>
          {c.dark ? '× погашен (запрещающий)' : c.open ? `открыт: ${c.route}` : 'закрыт'}
        </span>
        <span className="muted">
          {c.type === 'entry' ? 'входной' : 'выходной'} · направление {c.dir === 'E' ? 'на восток' : 'на запад'}
        </span>
      </div>
      <div className="details-sec">Маршруты от сигнала (ручная установка — те же проверки)</div>
      <ul className="rts">
        {c.routes.map((r: string) => {
          const active = frame?.routes.find((x) => x.id === r);
          return (
            <li key={r}>
              <RouteIcon size={12} aria-hidden="true" /> <span className="rt-id">{r}</span>
              {active ? (
                <>
                  <span className="muted small">{active.state === 'set' ? 'установлен' : active.state === 'passed' ? 'поезд за сигналом' : `устанавливается${active.problem ? `: ${active.problem}` : ''}`}</span>
                  <button className="btn btn-xs btn-ghost" onClick={() => act({ type: 'cancel_route', route: r })}>
                    <X size={12} /> Отменить
                  </button>
                </>
              ) : (
                <button className="btn btn-xs" onClick={() => act({ type: 'set_route', route: r })}>
                  Установить
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <Result r={res} />
      <div className="details-sec">Цепочка оборудования</div>
      <Chain items={c.equipment} />
    </>
  );
}

function SegmentCard({ c }: { c: Card }) {
  const s = c.static;
  return (
    <>
      <div className="card-status">
        {c.false ? <span className="tst tst-crit">ЛЗ — ложная занятость</span> : c.occ ? <span className="tst tst-inbound">занят поездом {c.occ}</span> : <span className="tst tst-ok">свободен</span>}
        {c.lock && (
          <span>
            <Lock size={12} /> {c.lock}
          </span>
        )}
      </div>
      <dl className="kv">
        <dt>Название</dt>
        <dd>{s.name}</dd>
        <dt>Тип</dt>
        <dd>{s.kind === 'track' ? 'станционный путь' : s.kind === 'approach' ? 'перегон (однопутный)' : 'участок горловины'}</dd>
        <dt>Длина / колея</dt>
        <dd>
          {s.length_m} м · {s.gauge} мм
        </dd>
        <dt>Скорость</dt>
        <dd>до {s.vmax_kmh} км/ч</dd>
        {s.ops_ru.length > 0 && (
          <>
            <dt>Операции</dt>
            <dd>{s.ops_ru.join(', ')}</dd>
          </>
        )}
        {s.restrictions.length > 0 && (
          <>
            <dt>Ограничения</dt>
            <dd>{s.restrictions.join('; ')}</dd>
          </>
        )}
      </dl>
      <div className="details-sec">Оборудование</div>
      <Chain items={c.equipment} />
      <div className="details-sec">Маршруты через участок</div>
      <p className="small muted">{c.routes.join(', ') || '—'}</p>
    </>
  );
}

function TaskLine({ t }: { t: RepairTask }) {
  return (
    <li>
      <b>{t.id}</b> · {t.phase_ru} · {t.cause}
      {t.result && <div className="muted small">{t.result}</div>}
    </li>
  );
}

function DeviceCard({ c, reload }: { c: Card; reload: () => void }) {
  const isAdmin = useIsAdmin();
  const setFault = useMicro((s) => s.setFaultOpen);
  const select = useMicro((s) => s.select);
  const workers = useMicro((s) => s.stat?.staff ?? []);
  const [res, setRes] = useState<CommandResult | null>(null);
  return (
    <>
      <div className="card-status">
        <span className={`tst dvst-${c.status}`}>{c.status_ru}</span>
        <span className="muted">
          {c.kind_ru}
          {c.post ? ` · пост ЭЦ-${c.post}` : ''}
        </span>
      </div>
      <dl className="kv">
        {c.note && (
          <>
            <dt>Неисправность</dt>
            <dd>{c.note}</dd>
          </>
        )}
        {c.cause && c.status === 'no_supply' && (
          <>
            <dt>Причина</dt>
            <dd>
              <button className="chip-link" onClick={() => select({ kind: 'device', id: c.cause })}>
                {c.cause}
              </button>
            </dd>
          </>
        )}
        {c.link && (
          <>
            <dt>Объект</dt>
            <dd>
              <button className="chip-link" onClick={() => select({ kind: c.link[0], id: c.link[1] })}>
                {c.link[0] === 'switch' ? 'стрелка' : c.link[0] === 'signal' ? 'светофор' : 'участок'} {c.link[1]}
              </button>
            </dd>
          </>
        )}
        <dt>Требует</dt>
        <dd>{c.requires.length ? c.requires.map((g: string[]) => (g.length > 1 ? `любой из (${g.join(', ')})` : g[0])).join(' и ') : '—'}</dd>
        <dt>Питает/управляет</dt>
        <dd>{c.dependents.length ? c.dependents.slice(0, 12).join(', ') + (c.dependents.length > 12 ? ` и ещё ${c.dependents.length - 12}` : '') : '—'}</dd>
        <dt>Ответственный</dt>
        <dd>
          {c.responsible && (
            <button className="chip-link" onClick={() => select({ kind: 'worker', id: c.responsible })}>
              {workers.find((w) => w.id === c.responsible)?.name ?? c.responsible}
            </button>
          )}
        </dd>
      </dl>
      <div className="card-actions">
        <button className="btn btn-xs btn-danger-soft" onClick={() => setFault(true)} disabled={c.health !== 'ok'}>
          Внести отказ…
        </button>
        {isAdmin && c.health !== 'ok' && (
          <button
            className="btn btn-xs"
            onClick={async () => {
              setRes(await runCommand({ type: 'restore', device: c.id }));
              reload();
            }}
          >
            Восстановить мгновенно (отладка)
          </button>
        )}
      </div>
      <Result r={res} />
      {c.history.length > 0 && (
        <>
          <div className="details-sec">Ремонты</div>
          <ul className="tasks-mini">
            {c.history.map((t: RepairTask) => (
              <TaskLine key={t.id} t={t} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function WorkerCard({ c }: { c: Card }) {
  return (
    <>
      <div className="card-status">
        <span className={`tst ${c.busy ? 'tst-inbound' : 'tst-ok'}`}>{c.busy ? `занят: ${c.task}` : 'свободен'}</span>
        <span className="muted">{c.role}</span>
      </div>
      <dl className="kv">
        <dt>Закреплено устройств</dt>
        <dd>{c.devices.length}</dd>
        <dt>Премиальный баланс</dt>
        <dd>
          <b className="num">{c.balance}</b> у.е. <span className="muted small">(эксперимент)</span>
        </dd>
      </dl>
      <div className="details-sec">Журнал начислений</div>
      <ul className="ledger">
        {c.ledger.map((e: Card, i: number) => (
          <li key={i}>
            <b className={e.delta >= 0 ? 'pos num' : 'neg num'}>
              {e.delta >= 0 ? '+' : ''}
              {e.delta}
            </b>
            <span>{e.reason}</span>
          </li>
        ))}
      </ul>
      {c.tasks.length > 0 && (
        <>
          <div className="details-sec">Задачи</div>
          <ul className="tasks-mini">
            {c.tasks.map((t: RepairTask) => (
              <TaskLine key={t.id} t={t} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function CardPanel() {
  const sel = useMicro((s) => s.sel);
  const select = useMicro((s) => s.select);
  const { card, error, reload } = useCard(sel);
  if (!sel) return <div className="empty">Выберите поезд, участок, стрелку, светофор или устройство на схеме.</div>;
  return (
    <div className="mcard">
      <div className="mcard-h">
        <h3>
          {KIND_RU[sel.kind]} {sel.kind === 'device' || sel.kind === 'loco' || sel.kind === 'wagon' ? (card?.name ?? sel.id) : sel.id}
        </h3>
        <button className="icon-btn" onClick={() => select(null)} aria-label="Закрыть карточку">
          <X size={16} />
        </button>
      </div>
      {error && <div className="cmd-fail">{error}</div>}
      {!card && !error && <div className="skeleton">Загрузка…</div>}
      {card && sel.kind === 'train' && <TrainCard c={card} />}
      {card && sel.kind === 'switch' && <SwitchCard c={card} />}
      {card && sel.kind === 'signal' && <SignalCard c={card} />}
      {card && sel.kind === 'segment' && <SegmentCard c={card} />}
      {card && sel.kind === 'device' && <DeviceCard c={card} reload={reload} />}
      {card && sel.kind === 'worker' && <WorkerCard c={card} />}
      {card && sel.kind === 'loco' && <LocoModelCard m={card as LocoModel} />}
      {card && sel.kind === 'wagon' && <WagonModelCard m={card as WagonModel} />}
    </div>
  );
}
