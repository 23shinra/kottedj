import { useEffect, useMemo, useState } from 'react';
import { Lock } from 'lucide-react';
import { useIsAdmin, useStore } from '../store';
import { api, errText } from '../api/rest';
import type { IndexConfig, PlannerConfig } from '../types';
import { fmtNum } from '../utils/time';
import { Modal } from './common';

const OBJ_LABELS: Record<keyof PlannerConfig['objective'], string> = {
  entry_delay: 'Задержка приёма (вес)',
  departure_delay: 'Задержка отправления (вес)',
  track_change: 'Штраф за смену пути, с',
  unassigned_resource: 'Штраф: нет локомотива/бригады',
  starvation_weight: 'Вес «голодания» местных',
  starvation_after_min: 'Порог «голодания», мин',
};

const SPEEDS = [1, 5, 10, 20, 40, 60];

function ReadOnlyFormula({ cfg }: { cfg: IndexConfig }) {
  const total = Object.values(cfg.factors).reduce((a, f) => a + f.weight, 0) || 1;
  const cats = [...cfg.categories].sort((a, b) => b.min - a.min);
  return (
    <div className="settings-ro">
      <div className="inline-info">
        <Lock size={14} /> Изменять веса и параметры может только администратор. Ниже — действующая формула.
      </div>
      <div className="formula-eq big">
        I = 100 · Σ w<sub>k</sub> · s<sub>k</sub>, s<sub>k</sub> ∈ [0, 1], Σ w<sub>k</sub> = 1
      </div>
      <table className="ftable">
        <thead>
          <tr>
            <th scope="col">Фактор</th>
            <th scope="col">Вес</th>
            <th scope="col">Как считается</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(cfg.factors).map(([id, f]) => (
            <tr key={id}>
              <td>{f.name}</td>
              <td className="num">{fmtNum((f.weight / total) * 100, 0)}%</td>
              <td className="muted">{f.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="thresholds">
        {cats.map((c, i) => (
          <span key={c.id} className="thr" style={{ ['--c' as string]: c.color }}>
            <i />
            {c.name}: {i === 0 ? `≥ ${c.min}` : i === cats.length - 1 ? `< ${cats[i - 1].min}` : `${c.min}–${cats[i - 1].min - 1}`} — {c.reason}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const indexConfig = useStore((s) => s.indexConfig);
  const plannerConfig = useStore((s) => s.plannerConfig);
  const timeScale = useStore((s) => s.timeScale);
  const setIndexConfig = useStore((s) => s.setIndexConfig);
  const setPlannerConfig = useStore((s) => s.setPlannerConfig);
  const setTimeScale = useStore((s) => s.setTimeScale);
  const toast = useStore((s) => s.toast);
  const admin = useIsAdmin();
  const [idx, setIdx] = useState<IndexConfig | null>(null);
  const [pl, setPl] = useState<PlannerConfig | null>(null);
  const [speed, setSpeed] = useState(timeScale);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setIdx(indexConfig ? structuredClone(indexConfig) : null);
    setPl(plannerConfig ? structuredClone(plannerConfig) : null);
    setSpeed(timeScale);
    // актуализируем с сервера
    api.getIndexConfig().then((c) => c && typeof c === 'object' && setIdx(structuredClone(c))).catch(() => undefined);
    api.getPlannerConfig().then((c) => c && typeof c === 'object' && setPl(structuredClone(c))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const total = useMemo(() => (idx ? Object.values(idx.factors).reduce((a, f) => a + f.weight, 0) : 1), [idx]);
  if (!open) return null;
  const close = () => setOpen(false);

  if (!admin) {
    return (
      <Modal
        title="Формула индекса состояния"
        onClose={close}
        labelledBy="settings-h"
      >
        {indexConfig ? <ReadOnlyFormula cfg={indexConfig} /> : <p className="muted">Конфигурация не загружена</p>}
      </Modal>
    );
  }

  const idxDirty = JSON.stringify(idx) !== JSON.stringify(indexConfig);
  const plDirty = JSON.stringify(pl) !== JSON.stringify(plannerConfig);
  const cats = idx ? [...idx.categories].sort((a, b) => b.min - a.min) : [];
  const norm = cats.find((c) => c.id === 'norm');
  const warn = cats.find((c) => c.id === 'warning');
  const thrInvalid = !!norm && !!warn && warn.min >= norm.min;

  const save = async () => {
    if (!idx || !pl) return;
    if (total <= 0) {
      toast('error', 'Сумма весов должна быть больше нуля');
      return;
    }
    setSaving(true);
    try {
      if (idxDirty) {
        const r = await api.putIndexConfig(idx);
        setIndexConfig(r && typeof r === 'object' && 'factors' in r ? r : idx);
      }
      if (plDirty) {
        const r = await api.putPlannerConfig(pl);
        setPlannerConfig(r && typeof r === 'object' && 'solver' in r ? r : pl);
      }
      toast('ok', idxDirty || plDirty ? 'Настройки сохранены и применены без перезапуска' : 'Изменений нет');
    } catch (e) {
      toast('error', `Не удалось сохранить: ${errText(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const applySpeed = async () => {
    try {
      await api.simSpeed(speed);
      setTimeScale(speed);
      toast('ok', `Скорость модели: ×${speed}`);
    } catch (e) {
      toast('error', `Скорость не изменена: ${errText(e)}`);
    }
  };

  const setWeight = (id: string, w: number) => setIdx((c) => (c ? { ...c, factors: { ...c.factors, [id]: { ...c.factors[id], weight: w } } } : c));
  const setCatMin = (id: string, v: number) => setIdx((c) => (c ? { ...c, categories: c.categories.map((x) => (x.id === id ? { ...x, min: v } : x)) } : c));

  return (
    <Modal
      wide
      labelledBy="settings-h"
      title="Настройки индекса и оптимизатора"
      onClose={close}
      footer={
        <>
          <button
            className="btn btn-ghost"
            onClick={() => {
              setIdx(indexConfig ? structuredClone(indexConfig) : null);
              setPl(plannerConfig ? structuredClone(plannerConfig) : null);
            }}
            disabled={!idxDirty && !plDirty}
          >
            Сбросить
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || (!idxDirty && !plDirty) || thrInvalid}>
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </>
      }
    >
      <div className="settings-grid">
        <section className="set-sec">
          <h3>Веса факторов индекса</h3>
          <p className="muted small">Веса нормируются автоматически: I = 100 · Σ (wₖ / Σw) · sₖ</p>
          {idx &&
            Object.entries(idx.factors).map(([id, f]) => (
              <div className="wrow" key={id}>
                <label htmlFor={`w-${id}`} title={f.description}>
                  {f.name}
                </label>
                <input id={`w-${id}`} type="range" min={0} max={1} step={0.01} value={f.weight} onChange={(e) => setWeight(id, Number(e.target.value))} style={{ ['--p' as string]: `${f.weight * 100}%` }} />
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={f.weight}
                  onChange={(e) => setWeight(id, Math.max(0, Math.min(1, Number(e.target.value) || 0)))}
                  aria-label={`${f.name}: вес`}
                  className="num-in"
                />
                <span className="wpct num">{fmtNum(total ? (f.weight / total) * 100 : 0, 1)}%</span>
              </div>
            ))}
          <h3>Пороги категорий</h3>
          {norm && warn && (
            <div className="row2">
              <label>
                <span className="thr-l" style={{ ['--c' as string]: norm.color }}>
                  <i /> «{norm.name}» от
                </span>
                <input type="number" min={1} max={100} value={norm.min} onChange={(e) => setCatMin('norm', Number(e.target.value))} className="num-in" />
              </label>
              <label>
                <span className="thr-l" style={{ ['--c' as string]: warn.color }}>
                  <i /> «{warn.name}» от
                </span>
                <input type="number" min={0} max={99} value={warn.min} onChange={(e) => setCatMin('warning', Number(e.target.value))} className="num-in" />
              </label>
            </div>
          )}
          {thrInvalid && <div className="inline-warn">Порог «Внимание» должен быть ниже порога «Норма»</div>}
        </section>

        <section className="set-sec">
          <h3>Оптимизатор (CP-SAT)</h3>
          {pl && (
            <>
              <div className="row2">
                <label>
                  Лимит времени решателя, с
                  <input
                    type="number"
                    min={0.1}
                    max={30}
                    step={0.1}
                    className="num-in"
                    value={pl.solver.time_limit_s}
                    onChange={(e) => setPl({ ...pl, solver: { ...pl.solver, time_limit_s: Number(e.target.value) } })}
                  />
                </label>
                <label>
                  Горизонт планирования, мин
                  <input type="number" min={30} max={480} step={10} className="num-in" value={pl.horizon_min} onChange={(e) => setPl({ ...pl, horizon_min: Number(e.target.value) })} />
                </label>
              </div>
              <label className="switch-row">
                <input type="checkbox" checked={pl.auto_apply_best_variant} onChange={(e) => setPl({ ...pl, auto_apply_best_variant: e.target.checked })} />
                <span className="switch-ui" aria-hidden="true" />
                Автоматически применять лучший вариант при инциденте
              </label>
              <h4>Веса целевой функции</h4>
              <div className="obj-grid">
                {(Object.keys(OBJ_LABELS) as (keyof PlannerConfig['objective'])[]).map((k) => (
                  <label key={k}>
                    {OBJ_LABELS[k]}
                    <input type="number" step="any" min={0} className="num-in" value={pl.objective[k]} onChange={(e) => setPl({ ...pl, objective: { ...pl.objective, [k]: Number(e.target.value) } })} />
                  </label>
                ))}
              </div>
            </>
          )}
          <h3>Скорость модели</h3>
          <div className="row-inline">
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Ускорение модельного времени">
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  ×{s} {s === 20 ? '(по умолчанию)' : ''}
                </option>
              ))}
            </select>
            <button className="btn btn-ghost" onClick={applySpeed} disabled={speed === timeScale}>
              Применить скорость
            </button>
            <span className="muted small">1 с реального = {speed} с модельного</span>
          </div>
        </section>
      </div>
    </Modal>
  );
}
