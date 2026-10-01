import { create } from 'zustand';
import type {
  Frame,
  HelloMsg,
  IndexConfig,
  Kpi,
  Plan,
  PlannerConfig,
  Role,
  SimEvent,
  Station,
  VariantsMsg,
  ViewMode,
} from '../types';
import { setStartClock } from '../utils/time';

export type ConnStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface HistPoint {
  ts: number; // реальное время, мс
  sim: number;
  ai: Kpi;
  base: Kpi;
  idxAi: number;
  idxBase: number;
}

export interface Toast {
  id: number;
  kind: 'ok' | 'error' | 'info' | 'warn';
  text: string;
}

export type Selection = { kind: 'train'; id: string } | { kind: 'track'; id: string } | null;

export interface HistoryView {
  ts: number;
  loading: boolean;
  frame: Frame | null;
  plan: Plan | null;
  error?: string;
}

const AUTH_KEY = 'ds.auth';
const HIST_MAX = 960; // ~16 минут при 1 точке/с
const HIST_STEP_MS = 1000;
const LAT_MAX = 120;
const EVENTS_MAX = 300;

interface AuthState {
  token: string | null;
  role: Role | null;
  username: string | null;
  mock: boolean;
}

function loadAuth(): AuthState {
  try {
    const raw = sessionStorage.getItem(AUTH_KEY);
    if (raw) return JSON.parse(raw) as AuthState;
  } catch {
    /* ignore */
  }
  return { token: null, role: null, username: null, mock: false };
}

export interface AppState {
  auth: AuthState;
  setAuth: (a: AuthState) => void;
  logout: () => void;

  conn: { status: ConnStatus; attempt: number; retryAt: number | null; lastMsgAt: number | null };
  setConn: (c: Partial<AppState['conn']>) => void;

  station: Station | null;
  indexConfig: IndexConfig | null;
  plannerConfig: PlannerConfig | null;
  timeScale: number;
  frame: Frame | null;
  plan: Plan | null;
  variants: VariantsMsg | null;
  variantsOpen: boolean;
  events: SimEvent[];
  hist: HistPoint[];

  applyHello: (m: HelloMsg) => void;
  applyFrame: (f: Frame) => void;
  applyPlan: (p: Plan) => void;
  applyVariants: (v: VariantsMsg, open: boolean) => void;
  addEvents: (e: SimEvent[]) => void;
  setVariantsOpen: (o: boolean) => void;
  setTimeScale: (n: number) => void;
  setIndexConfig: (c: IndexConfig) => void;
  setPlannerConfig: (c: PlannerConfig) => void;
  mergeTimeline: (pts: HistPoint[]) => void;

  latency: { samples: number[]; avg: number; p95: number };
  pushLatency: (ms: number) => void;

  mode: ViewMode;
  setMode: (m: ViewMode) => void;
  selection: Selection;
  select: (s: Selection) => void;
  historyView: HistoryView | null;
  setHistoryView: (h: HistoryView | null) => void;
  dismissed: Record<string, true>;
  dismiss: (id: string) => void;
  accepted: Record<string, true>;
  markAccepted: (id: string) => void;

  incidentOpen: boolean;
  setIncidentOpen: (o: boolean) => void;
  settingsOpen: boolean;
  setSettingsOpen: (o: boolean) => void;

  toasts: Toast[];
  toast: (kind: Toast['kind'], text: string) => void;
  dropToast: (id: number) => void;
}

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => ({
  auth: loadAuth(),
  setAuth: (a) => {
    sessionStorage.setItem(AUTH_KEY, JSON.stringify(a));
    set({ auth: a });
  },
  logout: () => {
    sessionStorage.removeItem(AUTH_KEY);
    set({
      auth: { token: null, role: null, username: null, mock: false },
      frame: null,
      plan: null,
      variants: null,
      events: [],
      hist: [],
      historyView: null,
      conn: { status: 'idle', attempt: 0, retryAt: null, lastMsgAt: null },
    });
  },

  conn: { status: 'idle', attempt: 0, retryAt: null, lastMsgAt: null },
  setConn: (c) => set((s) => ({ conn: { ...s.conn, ...c } })),

  station: null,
  indexConfig: null,
  plannerConfig: null,
  timeScale: 20,
  frame: null,
  plan: null,
  variants: null,
  variantsOpen: false,
  events: [],
  hist: [],

  applyHello: (m) => {
    setStartClock(m.station?.start_clock);
    set((s) => ({
      station: m.station,
      indexConfig: m.index_config,
      plannerConfig: m.planner_config,
      timeScale: m.time_scale ?? s.timeScale,
    }));
  },
  applyFrame: (f) => {
    const s = get();
    const now = Date.now();
    let hist = s.hist;
    const last = hist[hist.length - 1];
    if (!last || now - last.ts >= HIST_STEP_MS || f.state.sim_time < last.sim) {
      const pt: HistPoint = {
        ts: now,
        sim: f.state.sim_time,
        ai: f.compare?.ai?.kpi ?? f.state.kpi,
        base: f.compare?.baseline?.kpi ?? f.state.kpi,
        idxAi: f.compare?.ai?.index?.value ?? f.index.value,
        idxBase: f.compare?.baseline?.index?.value ?? f.index.value,
      };
      hist = hist.length >= HIST_MAX ? [...hist.slice(hist.length - HIST_MAX + 1), pt] : [...hist, pt];
    }
    set({ frame: f, hist });
  },
  applyPlan: (p) => set({ plan: p }),
  applyVariants: (v, open) => set({ variants: v, variantsOpen: open || get().variantsOpen }),
  addEvents: (e) =>
    set((s) => {
      const merged = [...e.slice().reverse(), ...s.events];
      return { events: merged.length > EVENTS_MAX ? merged.slice(0, EVENTS_MAX) : merged };
    }),
  setVariantsOpen: (o) => set({ variantsOpen: o }),
  setTimeScale: (n) => set({ timeScale: n }),
  setIndexConfig: (c) => set({ indexConfig: c }),
  setPlannerConfig: (c) => set({ plannerConfig: c }),
  mergeTimeline: (pts) =>
    set((s) => {
      if (!pts.length) return {};
      const first = s.hist[0]?.ts ?? Infinity;
      const older = pts.filter((p) => p.ts < first - 500);
      return { hist: [...older, ...s.hist].slice(-HIST_MAX) };
    }),

  latency: { samples: [], avg: 0, p95: 0 },
  pushLatency: (ms) =>
    set((s) => {
      const samples = s.latency.samples.length >= LAT_MAX ? s.latency.samples.slice(1) : s.latency.samples.slice();
      samples.push(ms);
      const sorted = samples.slice().sort((a, b) => a - b);
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      return { latency: { samples, avg, p95 } };
    }),

  mode: 'ai',
  setMode: (m) => set({ mode: m }),
  selection: null,
  select: (sel) => set({ selection: sel }),
  historyView: null,
  setHistoryView: (h) => set({ historyView: h }),
  dismissed: {},
  dismiss: (id) => set((s) => ({ dismissed: { ...s.dismissed, [id]: true } })),
  accepted: {},
  markAccepted: (id) => set((s) => ({ accepted: { ...s.accepted, [id]: true } })),

  incidentOpen: false,
  setIncidentOpen: (o) => set({ incidentOpen: o }),
  settingsOpen: false,
  setSettingsOpen: (o) => set({ settingsOpen: o }),

  toasts: [],
  toast: (kind, text) => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }));
    window.setTimeout(() => get().dropToast(id), kind === 'error' ? 6000 : 4000);
  },
  dropToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/* ---------- Селекторы отображаемых данных (онлайн или кадр истории) ---------- */

export const useViewFrame = (): Frame | null =>
  useStore((s) => (s.historyView ? s.historyView.frame ?? s.frame : s.frame));

export const useViewPlan = (): Plan | null =>
  useStore((s) => (s.historyView ? s.historyView.plan ?? s.plan : s.plan));

export const useIsStale = (): boolean =>
  useStore((s) => s.conn.status !== 'online' && s.conn.status !== 'idle');

export const useIsAdmin = (): boolean => useStore((s) => s.auth.role === 'admin');
