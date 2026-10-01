import { useState } from 'react';
import { Check, CircleCheck, Cpu, Sparkles, Trophy } from 'lucide-react';
import { useStore } from '../store';
import { api, errText } from '../api/rest';
import type { Incident, Plan } from '../types';
import { fmtNum } from '../utils/time';
import { Delta, Modal } from './common';

function incidentText(i: Incident): string {
  switch (i.type) {
    case 'close_track':
      return `Закрытие пути ${i.track ?? ''}${i.duration_min ? ` на ${i.duration_min} мин` : ''}`;
    case 'delay':
      return `Задержка поезда №${i.train ?? ''}${i.minutes ? ` на ${i.minutes} мин` : ''}`;
    case 'loco_failure':
      return `Отказ локомотива${i.loco ? ' ' + i.loco : ''}`;
    case 'stress':
      return 'Стресс-тест: каскад сбоев';
    default:
      return i.type;
  }
}

function VariantCard({ v, applied, appliedLabel, best, curIndex, curKpi, onApply, busy }: {
  v: Plan;
  applied: boolean;
  appliedLabel: string;
  best: boolean;
  curIndex: number;
  curKpi: { avg_entry_wait_min: number; avg_deviation_min: number; conflicts: number } | null;
  onApply: () => void;
  busy: boolean;
}) {
  const pi = v.projected_index;
  const d = pi.value - curIndex;
  const k = v.projected_kpi;
  return (
    <article className={`variant ${applied ? 'variant-applied' : ''}`} aria-label={`Вариант ${v.variant_name}`}>
      <header>
        <h3>{v.variant_name}</h3>
        {best && (
          <span className="badge badge-ok">
            <Trophy size={11} /> лучший индекс
          </span>
        )}
      </header>
      <p className="variant-desc">{v.description ?? ''}</p>
      <div className="variant-idx">
        <span className="variant-idx-v num" style={{ color: pi.category.color }}>
          {fmtNum(pi.value, 1)}
        </span>
        <div>
          <div className="variant-grade">
            класс <b>{pi.grade}</b> · {pi.category.name}
          </div>
          <div className={`variant-d num ${d >= 0 ? 'pos' : 'neg'}`}>
            {d >= 0 ? '▲ +' : '▼ −'}
            {fmtNum(Math.abs(d), 1)} к текущему
          </div>
        </div>
      </div>
      <dl className="variant-kpi">
        <dt>Ожидание приёма</dt>
        <dd>
          <b className="num">{fmtNum(k.avg_entry_wait_min, 1)} мин</b>
          {curKpi && k.avg_entry_wait_min != null && <Delta ai={k.avg_entry_wait_min} base={curKpi.avg_entry_wait_min} better="lower" />}
        </dd>
        <dt>Отклонение от графика</dt>
        <dd>
          <b className="num">{fmtNum(k.avg_deviation_min, 1)} мин</b>
          {curKpi && k.avg_deviation_min != null && <Delta ai={k.avg_deviation_min} base={curKpi.avg_deviation_min} better="lower" />}
        </dd>
        <dt>Конфликты</dt>
        <dd>
          <b className="num">{k.conflicts ?? '—'}</b>
        </dd>
        <dt>Пропускная</dt>
        <dd>
          <b className="num">
            {k.departed_1h ?? '—'} / {k.due_1h ?? '—'}
          </b>
        </dd>
      </dl>
      <div className="variant-solver">
        <Cpu size={12} /> {v.solver.engine.toUpperCase()} · {v.solver.status} · <span className="num">{v.solver.time_ms} мс</span>
      </div>
      <footer>
        {applied ? (
          <span className="variant-applied-tag">
            <CircleCheck size={15} /> {appliedLabel}
          </span>
        ) : (
          <button className="btn btn-primary" onClick={onApply} disabled={busy}>
            <Check size={14} /> {busy ? 'Применение…' : 'Применить'}
          </button>
        )}
      </footer>
    </article>
  );
}

export function VariantsModal() {
  const open = useStore((s) => s.variantsOpen);
  const msg = useStore((s) => s.variants);
  const setOpen = useStore((s) => s.setVariantsOpen);
  const frame = useStore((s) => s.frame);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState<string | null>(null);
  if (!open || !msg) return null;
  const curIndex = frame?.index.value ?? 0;
  const curKpi = frame?.state.kpi ?? null;
  const best = msg.variants.reduce<Plan | null>((a, b) => (!a || b.projected_index.value > a.projected_index.value ? b : a), null);
  const applied = manual ?? msg.applied;
  const appliedPlan = msg.variants.find((v) => v.variant === msg.applied);
  const totalMs = msg.variants.reduce((a, v) => a + (v.total_ms ?? v.solver.time_ms), 0);

  const apply = async (id: string) => {
    setBusy(id);
    try {
      await api.applyVariant(id);
      setManual(id);
      toast('ok', `Применён вариант «${msg.variants.find((v) => v.variant === id)?.variant_name}»`);
    } catch (e) {
      toast('error', `Не удалось применить вариант: ${errText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      wide
      labelledBy="variants-h"
      title={
        <>
          <Sparkles size={18} /> Варианты перепланирования
        </>
      }
      onClose={() => {
        setOpen(false);
        setManual(null);
      }}
    >
      <div className="variants-head">
        <div>
          <div className="muted small">Инцидент</div>
          <div className="variants-inc">{incidentText(msg.incident)}</div>
        </div>
        <div className="replan-ms">
          Перепланирование за <b className="num">{appliedPlan?.total_ms ?? appliedPlan?.solver.time_ms ?? '—'} мс</b>
          <span className="muted small"> · 3 варианта за {fmtNum(totalMs / 1000, 1)} с</span>
        </div>
      </div>
      <div className="variants">
        {msg.variants.map((v) => (
          <VariantCard
            key={v.variant}
            v={v}
            applied={v.variant === applied}
            appliedLabel={manual ? 'Применён диспетчером' : 'Применён автоматически'}
            best={v.variant === best?.variant}
            curIndex={curIndex}
            curKpi={curKpi}
            busy={busy === v.variant}
            onApply={() => apply(v.variant)}
          />
        ))}
      </div>
      {manual && manual !== msg.applied && <p className="muted small">Вариант применён диспетчером вручную.</p>}
    </Modal>
  );
}
