import { useMemo } from 'react';
import { Hand, ListOrdered, Pause } from 'lucide-react';
import { useStore, useViewFrame, useViewPlan } from '../store';
import { buildQueue, type QueueRow } from '../utils/derive';
import { clock } from '../utils/time';
import { CAT_NAME } from '../utils/theme';
import { CatIcon, Panel } from './common';

function ModeCell({ r }: { r: QueueRow }) {
  if (r.status === 'at_signal') return <span className="q-mode q-crit">■ стоит у сигнала</span>;
  if (r.status === 'held') return <span className="q-mode q-warn">❚❚ удержан{r.hold_until ? ` до ${clock(r.hold_until)}` : ''}</span>;
  if (r.status === 'scheduled') return <span className="q-mode q-muted">по графику</span>;
  if (r.advisory != null) return <span className="q-mode q-info">▼ {Math.round(r.advisory)} км/ч</span>;
  return <span className="q-mode">{Math.round(r.speed ?? 0)} км/ч</span>;
}

export function QueuePanel() {
  const frame = useViewFrame();
  const plan = useViewPlan();
  const select = useStore((s) => s.select);
  const selection = useStore((s) => s.selection);
  const rows = useMemo(() => (frame ? buildQueue(frame.state, plan) : []), [frame, plan]);
  const atSignal = rows.filter((r) => r.status === 'at_signal').length;
  const regulated = rows.filter((r) => r.status === 'held' || (r.status === 'approaching' && r.advisory != null)).length;
  return (
    <Panel
      id="queue"
      title="Виртуальная очередь на подходе"
      icon={<ListOrdered size={15} />}
      extra={
        <div className="q-counters">
          <span className={`cnt ${atSignal ? 'cnt-crit' : 'cnt-ok'}`}>
            <Hand size={12} /> у сигнала стоят: <b className="num">{atSignal}</b>
          </span>
          <span className="cnt cnt-info">
            <Pause size={12} /> регулируются: <b className="num">{regulated}</b>
          </span>
        </div>
      }
    >
      {rows.length === 0 ? (
        <p className="muted small">Очереди нет — поезда принимаются без ожидания</p>
      ) : (
        <div className="table-wrap">
          <table className="qtable">
            <thead>
              <tr>
                <th scope="col">№</th>
                <th scope="col">ETA</th>
                <th scope="col" title="Слот входа по плану ИИ">Слот</th>
                <th scope="col">Путь</th>
                <th scope="col">Режим</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 30).map((r) => (
                <tr
                  key={r.id}
                  className={`${r.status === 'at_signal' ? 'row-crit' : ''} ${selection?.kind === 'train' && selection.id === r.id ? 'row-sel' : ''}`}
                  tabIndex={0}
                  onClick={() => select({ kind: 'train', id: r.id })}
                  onKeyDown={(e) => e.key === 'Enter' && select({ kind: 'train', id: r.id })}
                  title={r.reason ?? undefined}
                  aria-label={`Поезд ${r.id}, ${CAT_NAME[r.cat]}, ETA ${clock(r.eta)}, слот ${clock(r.slot)}, путь ${r.track ?? 'не назначен'}${r.reason ? ', ' + r.reason : ''}`}
                >
                  <td>
                    <span className="q-id">
                      <CatIcon cat={r.cat} size={12} />
                      <b className="num">{r.id}</b>
                      <small>{r.side}</small>
                    </span>
                  </td>
                  <td className="num">{clock(r.eta)}</td>
                  <td className="num">
                    {r.slot != null ? (
                      <span className={r.slot - r.eta > 300 ? 'q-shift' : ''}>
                        {clock(r.slot)}
                        {r.slot - r.eta > 60 && <small> +{Math.round((r.slot - r.eta) / 60)}</small>}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">{r.track ?? '—'}</td>
                  <td>
                    <ModeCell r={r} />
                    {r.reason && r.status !== 'scheduled' && <div className="q-reason">{r.reason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
