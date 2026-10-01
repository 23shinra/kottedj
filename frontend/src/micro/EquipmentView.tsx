import { memo, useMemo } from 'react';
import { CircleCheck, CircleSlash, PlugZap, ShieldHalf, Wrench, XOctagon } from 'lucide-react';
import { useMicro } from './store';
import { deviceStatus, highlight, indexes } from './graph';
import type { MDevice } from './types';

const ST_ICON: Record<string, JSX.Element> = {
  ok: <CircleCheck size={12} aria-hidden="true" />,
  reserve: <ShieldHalf size={12} aria-hidden="true" />,
  fault: <XOctagon size={12} aria-hidden="true" />,
  repair: <Wrench size={12} aria-hidden="true" />,
  no_supply: <PlugZap size={12} aria-hidden="true" />,
};

const ST_SHORT: Record<string, string> = {
  ok: 'норма',
  reserve: 'резерв',
  fault: 'отказ',
  repair: 'ремонт',
  no_supply: 'нет пит./упр.',
};

function Dev({ d, big = false, hl, sel }: { d: MDevice; big?: boolean; hl: boolean; sel: boolean }) {
  const frame = useMicro((s) => s.frame);
  const stat = useMicro((s) => s.stat);
  const select = useMicro((s) => s.select);
  const st = deviceStatus(frame, d.id);
  const statusRu = stat?.equipment.status_ru[st] ?? st;
  const note = frame?.devices[d.id]?.note;
  const cause = frame?.devices[d.id]?.cause;
  return (
    <button
      className={`dv dv-${st} ${big ? 'dv-big' : ''} ${hl ? 'dv-hl' : ''} ${sel ? 'dv-sel' : ''}`}
      onClick={() => select({ kind: 'device', id: d.id })}
      title={`${d.name}\n${d.kind_ru}\nСостояние: ${statusRu}${note ? ` — ${note}` : ''}${cause && st === 'no_supply' ? `\nПричина: ${cause}` : ''}`}
      aria-label={`${d.name}: ${statusRu}`}
    >
      {ST_ICON[st] ?? <CircleSlash size={12} />}
      <span className="dv-id">{d.id}</span>
      {big && <span className="dv-st">{ST_SHORT[st] ?? st}</span>}
    </button>
  );
}

export const EquipmentView = memo(function EquipmentView() {
  const stat = useMicro((s) => s.stat);
  const frame = useMicro((s) => s.frame);
  const sel = useMicro((s) => s.sel);
  const hl = useMemo(() => (stat ? highlight(stat, frame, sel) : null), [stat, frame, sel]);
  if (!stat || !hl) return <div className="skeleton">Загрузка схемы оборудования…</div>;
  const ix = indexes(stat);
  const devs = stat.equipment.devices;
  const isSel = (id: string) => sel?.kind === 'device' && sel.id === id;
  const feeders = devs.filter((d) => d.kind === 'feeder');
  const byModule = (m: string, kinds: string[]) => devs.filter((d) => d.module === m && kinds.includes(d.kind));

  return (
    <div className="eq" aria-label="Схема технического оборудования централизации">
      <div className="eq-feed">
        <span className="eq-cap">Внешнее питание (1Ф / 2Ф, взаимное резервирование)</span>
        {feeders.map((d) => (
          <Dev key={d.id} d={d} big hl={hl.devices.has(d.id)} sel={isSel(d.id)} />
        ))}
      </div>
      <div className="eq-posts">
        {stat.equipment.posts.map((p) => (
          <section key={p.id} className="eq-post" aria-label={p.name}>
            <h3>{p.name}</h3>
            <div className="eq-row">
              <Dev d={ix.dev[p.power]} big hl={hl.devices.has(p.power)} sel={isSel(p.power)} />
            </div>
            <div className="eq-row eq-row-core">
              <div className="eq-pair" title="Два комплекта УВК в горячем резерве: достаточно одного исправного">
                <span className="eq-cap">УВК · горячий резерв</span>
                {p.uvk.map((u) => (
                  <Dev key={u} d={ix.dev[u]} big hl={hl.devices.has(u)} sel={isSel(u)} />
                ))}
              </div>
              <Dev d={ix.dev[p.lan]} big hl={hl.devices.has(p.lan)} sel={isSel(p.lan)} />
            </div>
            <div className="eq-mods">
              {p.modules.map((m) => {
                const sw = byModule(m, ['coupling', 'switch_drive']).filter((d) => d.link?.[0] === 'switch');
                const sg = byModule(m, ['coupling', 'signal_unit']).filter((d) => d.link?.[0] === 'signal');
                const rc = byModule(m, ['track_circuit']);
                return (
                  <div key={m} className={`eq-mod ${hl.devices.has(m) ? 'eq-mod-hl' : ''}`}>
                    <div className="eq-mod-h">
                      <Dev d={ix.dev[m]} big hl={hl.devices.has(m)} sel={isSel(m)} />
                    </div>
                    {sw.length > 0 && (
                      <div className="eq-grp">
                        <span className="eq-cap">Стрелки: муфта → привод</span>
                        <div className="eq-chips">
                          {sw.map((d) => (
                            <Dev key={d.id} d={d} hl={hl.devices.has(d.id)} sel={isSel(d.id)} />
                          ))}
                        </div>
                      </div>
                    )}
                    {sg.length > 0 && (
                      <div className="eq-grp">
                        <span className="eq-cap">Светофоры: муфта → блок</span>
                        <div className="eq-chips">
                          {sg.map((d) => (
                            <Dev key={d.id} d={d} hl={hl.devices.has(d.id)} sel={isSel(d.id)} />
                          ))}
                        </div>
                      </div>
                    )}
                    {rc.length > 0 && (
                      <div className="eq-grp">
                        <span className="eq-cap">Рельсовые цепи</span>
                        <div className="eq-chips">
                          {rc.map((d) => (
                            <Dev key={d.id} d={d} hl={hl.devices.has(d.id)} sel={isSel(d.id)} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
      <div className="mlegend">
        <span>{ST_ICON.ok}норма</span>
        <span>{ST_ICON.reserve}работа на резерве</span>
        <span>{ST_ICON.fault}неисправно</span>
        <span>{ST_ICON.repair}в ремонте</span>
        <span>{ST_ICON.no_supply}нет питания/управления</span>
        <span className="muted">СМ — кабельная муфта (допущение), СП — электропривод, СВ — светофорный блок, РЦ — рельсовая цепь</span>
      </div>
    </div>
  );
});
