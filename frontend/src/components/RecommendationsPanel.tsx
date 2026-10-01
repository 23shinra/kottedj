import { useMemo, useState } from 'react';
import { Check, CircleCheck, Cpu, EyeOff, Layers, Lightbulb, TriangleAlert } from 'lucide-react';
import { useStore, useViewPlan } from '../store';
import type { Recommendation } from '../types';
import { api, errText } from '../api/rest';
import { SEVERITY_NAME, SEVERITY_RANK } from '../utils/theme';
import { Panel, SevIcon } from './common';

function RecItem({ r, readOnly }: { r: Recommendation; readOnly: boolean }) {
  const dismiss = useStore((s) => s.dismiss);
  const accepted = useStore((s) => !!s.accepted[r.id]);
  const markAccepted = useStore((s) => s.markAccepted);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const accept = async () => {
    if (!r.action) return;
    setBusy(true);
    try {
      await api.action(r.action);
      markAccepted(r.id);
      toast('ok', `Принято: ${r.title}`);
    } catch (e) {
      toast('error', `Не удалось выполнить «${r.title}»: ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`rec sev-${r.severity} ${accepted ? 'rec-done' : ''}`}>
      <SevIcon sev={r.severity} />
      {!r.action && (
        <button className="icon-btn rec-x" onClick={() => dismiss(r.id)} aria-label={`Скрыть: ${r.title}`} title="Скрыть">
          <EyeOff size={13} />
        </button>
      )}
      <div className="rec-body">
        <div className="rec-title">
          <span className={`sev-tag sev-tag-${r.severity}`}>{SEVERITY_NAME[r.severity]}</span>
          {r.title}
        </div>
        <div className="rec-text">{r.text}</div>
        {r.action && (
          <div className="rec-actions">
            {accepted ? (
              <span className="rec-accepted">
                <Check size={13} /> принято, ожидаем пересчёт плана
              </span>
            ) : (
              <button className="btn btn-xs btn-primary" onClick={accept} disabled={busy || readOnly} aria-label={`Принять рекомендацию: ${r.title}`}>
                <Check size={13} /> {busy ? 'Отправка…' : 'Принять'}
              </button>
            )}
            <button className="btn btn-xs btn-ghost" onClick={() => dismiss(r.id)} aria-label={`Скрыть рекомендацию: ${r.title}`}>
              <EyeOff size={13} /> Скрыть
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

export function RecommendationsPanel() {
  const plan = useViewPlan();
  const dismissed = useStore((s) => s.dismissed);
  const readOnly = useStore((s) => !!s.historyView);
  const variants = useStore((s) => s.variants);
  const setVariantsOpen = useStore((s) => s.setVariantsOpen);
  const [showInfo, setShowInfo] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const recs = useMemo(
    () =>
      (plan?.recommendations ?? [])
        .filter((r) => !dismissed[r.id])
        .slice()
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)),
    [plan, dismissed],
  );
  const main = recs.filter((r) => r.severity !== 'info');
  const info = recs.filter((r) => r.severity === 'info');
  const conflicts = plan?.conflicts ?? [];
  const resolved = conflicts.filter((c) => c.resolved).length;
  const unresolved = conflicts.filter((c) => !c.resolved);
  const crit = recs.filter((r) => r.severity === 'critical' || r.severity === 'high').length;

  return (
    <Panel
      id="recs"
      title="Рекомендации и предупреждения"
      icon={<Lightbulb size={15} />}
      extra={crit > 0 ? <span className="badge badge-crit">{crit} важных</span> : <span className="badge badge-ok">в норме</span>}
    >
      {plan && (
        <div className="plan-meta">
          <Cpu size={13} />
          План v{plan.version ?? '—'} · <b>{plan.variant_name}</b> · {plan.solver.engine.toUpperCase()} {plan.solver.status} ·{' '}
          <span className="num">{plan.solver.time_ms} мс</span>
          {variants && (
            <button className="btn btn-xs btn-ghost" onClick={() => setVariantsOpen(true)}>
              <Layers size={12} /> Варианты
            </button>
          )}
        </div>
      )}
      {!plan && <p className="muted small">Ожидание плана от оптимизатора…</p>}
      <ul className="recs" aria-label="Рекомендации">
        {(showAll ? main : main.slice(0, 4)).map((r) => (
          <RecItem key={r.id} r={r} readOnly={readOnly} />
        ))}
        {showInfo &&
          info.map((r) => (
            <RecItem key={r.id} r={r} readOnly={readOnly} />
          ))}
      </ul>
      <div className="more-row">
        {main.length > 4 && (
          <button className="btn btn-xs btn-ghost" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
            {showAll ? 'Свернуть' : `Ещё ${main.length - 4} предупреждений`}
          </button>
        )}
        {info.length > 0 && (
          <button className="btn btn-xs btn-ghost" onClick={() => setShowInfo((v) => !v)} aria-expanded={showInfo}>
            {showInfo ? 'Скрыть подсказки' : `Подсказки по слотам и ресурсам (${info.length})`}
          </button>
        )}
      </div>

      {conflicts.length > 0 && (
        <div className="conflicts">
          <div className="conf-h">
            <span>
              Обнаружено <b className="num">{conflicts.length}</b> конфликтов, решено <b className="num ok">{resolved}</b>
              {unresolved.length > 0 && (
                <>
                  , требуют решения <b className="num crit">{unresolved.length}</b>
                </>
              )}
            </span>
          </div>
          <div className="conf-bar" aria-hidden="true">
            <i style={{ width: `${(resolved / conflicts.length) * 100}%` }} />
          </div>
          <ul className="conf-list">
            {[...unresolved, ...(showResolved ? conflicts.filter((c) => c.resolved) : [])].map((c, i) => (
              <li key={i} className={c.resolved ? 'ok' : 'bad'}>
                {c.resolved ? <CircleCheck size={14} aria-label="решён" /> : <TriangleAlert size={14} aria-label="не решён" />}
                <div>
                  <div>{c.text}</div>
                  <div className="conf-res">
                    {c.resolved ? '✓ ' : '⚠ '}
                    {c.resolution}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {resolved > 0 && (
            <button className="btn btn-xs btn-ghost more" onClick={() => setShowResolved((v) => !v)} aria-expanded={showResolved}>
              {showResolved ? 'Скрыть решённые' : `Показать решённые ИИ (${resolved})`}
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}
