export type Dir = 'E' | 'W';

export interface MNode {
  id: string;
  kind: 'boundary' | 'joint' | 'switch' | 'buffer';
  x: number;
  y: number;
  label?: string;
  switch?: string;
}

export interface MSegment {
  id: string;
  a: string;
  b: string;
  length_m: number;
  vmax_kmh: number;
  gauge: number;
  kind: 'approach' | 'throat' | 'track';
  name: string;
  park: string;
  ops: string[];
  ops_ru: string[];
  platform: boolean;
  restrictions: string[];
}

export interface MSignal {
  id: string;
  node: string;
  dir: Dir;
  kind: 'entry' | 'exit';
  name: string;
}

export interface MRoute {
  id: string;
  signal: string;
  dir: Dir;
  kind: 'entry' | 'exit';
  dest: string;
  segments: string[];
  switches: [string, string][];
}

export interface MDevice {
  id: string;
  name: string;
  kind: string;
  kind_ru: string;
  post: string | null;
  module: string | null;
  link: [string, string] | null;
  requires: string[][];
}

export interface MPost {
  id: string;
  name: string;
  power: string;
  lan: string;
  uvk: string[];
  modules: string[];
}

export interface Source {
  title: string;
  url: string;
  level: string;
}

export interface LocoModel {
  id: string;
  name: string;
  purpose: string;
  traction: string;
  traction_ru: string;
  gauge: number;
  power_kw: number;
  mass_t: number;
  vmax_kmh: number;
  f_start_kn: number;
  f_cont_kn: number;
  v_cont_kmh: number;
  length_m: number;
  axles: number;
  axle_formula: string;
  sources: Source[];
  notes: string;
}

export interface WagonModel {
  id: string;
  name: string;
  type: string;
  type_ru: string;
  gauge: number;
  length_m: number;
  tare_t: number;
  capacity_t: number;
  vmax_kmh: number;
  axles: number;
  seats: number;
  cargo: string[];
  dangerous_cargo: boolean;
  sources: Source[];
  notes: string;
}

export interface ScenarioInfo {
  id: string;
  name: string;
  description: string;
  duration_h: number;
  order: number;
}

export interface MEvent {
  seq: number;
  t: number;
  clock: string;
  kind: string;
  level: 'info' | 'warn' | 'alarm';
  text: string;
  objects: string[];
  trains: string[];
  source: string;
}

export interface Worker {
  id: string;
  name: string;
  role: string;
  specialty: string;
  posts: string[];
  task: string | null;
  busy: boolean;
}

export interface MicroStatic {
  version: number;
  infra: {
    name: string;
    demo: boolean;
    electrified: boolean;
    nodes: MNode[];
    segments: MSegment[];
    switches: { id: string; node: string; stem: string; normal: string; reverse: string }[];
    signals: MSignal[];
    boundaries: Record<string, { node: string; name: string; gauge: number; grade_permille: number }>;
    routes: MRoute[];
    switch_throw_s: number;
  };
  equipment: {
    posts: MPost[];
    devices: MDevice[];
    fault_kinds: Record<string, string[]>;
    status_ru: Record<string, string>;
    kind_ru: Record<string, string>;
  };
  catalog: { locomotives: LocoModel[]; wagons: WagonModel[] };
  staff: Worker[];
  scenarios: ScenarioInfo[];
  scenario: string;
  scale: { min: number; max: number; default: number };
  start_clock: string;
  events: MEvent[];
}

export interface Blocker {
  key: string;
  text: string;
  objects: string[];
  trains: string[];
  waits: string;
  persistent: boolean;
}

export type TrainStatus = 'scheduled' | 'held' | 'rejected' | 'inbound' | 'standing' | 'ready' | 'outbound' | 'departed';

export interface MTrain {
  id: string;
  kind: 'freight' | 'passenger';
  status: TrainStatus;
  status_ru: string;
  frm: string;
  to: string;
  op: string;
  op_ru: string;
  dest: string | null;
  preferred: string | null;
  dir: Dir;
  v_kmh: number;
  occ: [string, number, number][];
  head: string | null;
  head_off: number;
  plan: { arrive: string | null; depart: string; dwell_min: number };
  actual: { spawned: string | null; arrive: string | null; depart: string | null; expected_depart: string | null };
  arr_delay_min: number | null;
  dep_delay_min: number | null;
  delay_reasons: { reason: string; min: number }[];
  blockers: Blocker[];
  stop_reason: string | null;
  waiting_for: string[];
  consist: {
    locos: string;
    loco_count: number;
    wagons: number;
    groups: { model: string; count: number }[];
    length_m: number;
    mass_t: number;
    wagons_mass_t: number;
    load_t: number;
    capacity_t: number;
    vmax_kmh: number;
    gauge: number;
  };
  manual_hold: boolean;
  reject_reasons: string[];
  load_pct: number | null;
  routes: string[];
}

export type SwitchStateId = 'ok' | 'moving' | 'unknown' | 'confirming' | 'fault' | 'repairing';

export interface RepairTask {
  id: string;
  device: string;
  object: string;
  cause: string;
  created_t: number;
  duration_min: number;
  phase: 'queued' | 'travel' | 'work' | 'verify' | 'blocked' | 'done';
  phase_ru: string;
  worker: string | null;
  phase_end_t: number | null;
  start_t: number | null;
  finished_t: number | null;
  result: string;
}

export interface LedgerEntry {
  t: number;
  worker: string;
  delta: number;
  balance: number;
  reason: string;
  kind: 'accrual' | 'penalty' | 'repair' | 'info';
  device: string | null;
}

export interface BonusCfg {
  initial_balance: number;
  accrual_per_device_hour: number;
  stop_accrual_on_downtime: boolean;
  downtime_penalty_per_hour: number;
  penalize_upstream: boolean;
  repair_cost: number;
  fast_recovery_min: number;
  fast_recovery_discount: number;
  min_balance: number;
}

export interface Reaction {
  device: string;
  t_fault: number;
  clock: string;
  t_ban: number;
  signals_closed: string[];
  trains: string[];
  checked: { train: string; t: number; stop_m: number; v_kmh: number; brake_m: number; reason: string | null; ok: boolean }[];
  ok: boolean;
}

export interface MicroKpi {
  trains: number;
  departed: number;
  in_station: number;
  held: number;
  rejected: number;
  avg_arr_delay_min: number;
  avg_dep_delay_min: number;
  wait_min: number;
  routes_set: number;
  route_refusals: number;
  manual_ok: number;
  manual_refused: number;
  throws: number;
  unloaded_t: number;
  loaded_t: number;
  active_faults: number;
  open_tasks: number;
  mttr_min: number | null;
  availability_pct: number;
  safety_violations: number;
  reaction_ok: boolean;
  reaction_max_s: number;
}

export interface MicroFrame {
  type?: 'micro';
  version: number;
  t: number;
  clock: string;
  date: string;
  scenario: string;
  running: boolean;
  scale: number;
  duration_s: number;
  auto: boolean;
  stock_t: number;
  trains: MTrain[];
  switches: Record<string, { pos: '+' | '-'; target: '+' | '-'; state: SwitchStateId; state_ru: string; locked_by: string | null; occupied: string | null }>;
  signals: Record<string, { open: boolean; route: string | null; dark: boolean }>;
  segments: Record<string, { occ: string | null; lock: string | null; false: boolean }>;
  routes: { id: string; train: string | null; state: string; manual: boolean; segs: string[]; problem: string | null }[];
  devices: Record<string, { status: string; note: string; cause: string }>;
  staff: { workers: Worker[]; tasks: RepairTask[]; repair_cfg: { default_duration_min: number; travel_min: number; verify_min: number } };
  bonus: {
    experimental: boolean;
    cfg: BonusCfg;
    accounts: { worker: string; balance: number; devices: number; pending_ok_dev_h: number; pending_penalty_min: number }[];
    ledger: LedgerEntry[];
  };
  kpi: MicroKpi;
  reactions: Reaction[];
  events?: MEvent[];
  seq: number;
  emitted_at?: number;
}

export type MSelection =
  | { kind: 'train' | 'segment' | 'switch' | 'signal' | 'device' | 'worker'; id: string }
  | { kind: 'loco' | 'wagon'; id: string }
  | null;

export interface CommandResult {
  ok: boolean;
  message: string;
  blockers?: Blocker[];
  changes?: string[];
}
