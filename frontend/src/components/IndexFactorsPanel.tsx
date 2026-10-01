import { useState } from 'react';
import { ChevronDown, ChevronRight, Sigma } from 'lucide-react';
import { useStore, useViewFrame } from '../store';
import { fmtNum } from '../utils/time';
import { Panel } from './common';

export function IndexFactorsPanel() {
  const frame = useViewFrame();
  const mode = useStore((s) => s.mode);
  const cfg = useStore((s) => s.indexConfig);
  const [open, setOpen] = useState(false);
  const index = mode === 'baseline' ? frame?.compare?.baseline?.index : frame?.index;
  if (!index) {
    return (
      <Panel id="factors" title="Индекс: вклад факторов" icon={<Sigma size={15} />}>
        <p className="muted small">Нет данных</p>
      </Panel>
    );
  }
  const top = (index.top?.length ? index.top : [...index.factors].sort((a, b) => b.loss - a.loss)).slice(0, 5);
  const maxW = Math.max(...index.factors.map((f) => f.weight * 100), 1);
  const cats = [...(cfg?.categories ?? [])].sort((a, b) => b.min - a.min);
  return (
    <Panel
      id="factors"
      title="Индекс: вклад факторов"
      icon={<Sigma size={15} />}
      extra={
        <span className="badge" style={{ color: index.category.color, borderColor: index.category.color }}>
          {mode === 'baseline' ? 'FCFS · ' : ''}
          {fmtNum(index.value, 1)} · {index.grade}
        </span>
      }
    >
      <p className="factor-reason">{index.category.reason}</p>
      <div className="factor-cap">Потеря баллов (из максимума веса фактора)</div>
      <ul className="factors">
        {top.map((f) => {
          const max = f.weight * 100;
          return (
            <li key={f.id} className="factor">
              <div className="factor-top">
                <span className="factor-name">{f.name}</span>
                <span className={`factor-loss num ${f.loss >= max * 0.5 ? 'crit' : f.loss > 0.5 ? 'warn' : 'muted'}`}>
                  {f.loss > 0 ? `−${fmtNum(f.loss, 1)}` : '0'} <small>из {fmtNum(max, 0)}</small>
                </span>
              </div>
              <div
                className="factor-bar"
                role="meter"
                aria-valuemin={0}
                aria-valuemax={max}
                aria-valuenow={f.loss}
                aria-label={`${f.name}: потеряно ${fmtNum(f.loss, 1)} из ${fmtNum(max, 0)} баллов`}
              >
                <i className="kept" style={{ width: `${(f.points / maxW) * 100}%` }} />
                <i className="lost" style={{ width: `${(f.loss / maxW) * 100}%` }} />
              </div>
              <div className="factor-why">{f.why}</div>
            </li>
          );
        })}
      </ul>
      <button className="btn btn-xs btn-ghost more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Формула индекса
      </button>
      {open && (
        <div className="formula">
          <div className="formula-eq">
            I = 100 · Σ w<sub>k</sub> · s<sub>k</sub> = <b className="num">{fmtNum(index.value, 1)}</b>
          </div>
          <table className="ftable">
            <thead>
              <tr>
                <th scope="col">Фактор</th>
                <th scope="col">w</th>
                <th scope="col">s</th>
                <th scope="col">баллы</th>
              </tr>
            </thead>
            <tbody>
              {index.factors.map((f) => (
                <tr key={f.id} title={f.description}>
                  <td>{f.name}</td>
                  <td className="num">{fmtNum(f.weight, 2)}</td>
                  <td className="num">{fmtNum(f.score, 3)}</td>
                  <td className="num">{fmtNum(f.points, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="thresholds">
            {cats.map((c, i) => (
              <span key={c.id} className="thr" style={{ ['--c' as string]: c.color }}>
                <i />
                {c.name}: {i === 0 ? `≥ ${c.min}` : i === cats.length - 1 ? `< ${cats[i - 1].min}` : `${c.min}–${cats[i - 1].min - 1}`}
              </span>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
