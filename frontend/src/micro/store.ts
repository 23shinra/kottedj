import { create } from 'zustand';
import type { MEvent, MicroFrame, MicroStatic, MSelection } from './types';

export type Section = 'macro' | 'micro';
export type MicroView = 'both' | 'track' | 'equip';
export type MicroTab = 'card' | 'trains' | 'repair' | 'bonus' | 'log' | 'catalog';

const SECTION_KEY = 'ds.section';
const EVENTS_MAX = 600;

interface MicroState {
  section: Section;
  setSection: (s: Section) => void;
  stat: MicroStatic | null;
  frame: MicroFrame | null;
  events: MEvent[];
  sel: MSelection;
  view: MicroView;
  tab: MicroTab;
  faultOpen: boolean;
  setStatic: (s: MicroStatic) => void;
  applyFrame: (f: MicroFrame) => void;
  addEvents: (version: number | undefined, e: MEvent[]) => void;
  select: (s: MSelection) => void;
  setView: (v: MicroView) => void;
  setTab: (t: MicroTab) => void;
  setFaultOpen: (o: boolean) => void;
}

export const useMicro = create<MicroState>((set, get) => ({
  section: (sessionStorage.getItem(SECTION_KEY) as Section) || 'micro',
  setSection: (s) => {
    sessionStorage.setItem(SECTION_KEY, s);
    set({ section: s });
  },
  stat: null,
  frame: null,
  events: [],
  sel: null,
  view: 'both',
  tab: 'trains',
  faultOpen: false,
  setStatic: (s) => set({ stat: s, events: s.events.slice().reverse().slice(0, EVENTS_MAX) }),
  applyFrame: (f) => set({ frame: f }),
  addEvents: (version, e) => {
    const st = get().stat;
    if (version != null && st && version !== st.version) return;
    const known = get().events[0]?.seq ?? 0;
    const fresh = e.filter((x) => x.seq > known).reverse();
    if (!fresh.length) return;
    set((s) => ({ events: [...fresh, ...s.events].slice(0, EVENTS_MAX) }));
  },
  select: (sel) => set((s) => ({ sel, tab: sel ? 'card' : s.tab })),
  setView: (view) => set({ view }),
  setTab: (tab) => set({ tab }),
  setFaultOpen: (faultOpen) => set({ faultOpen }),
}));
