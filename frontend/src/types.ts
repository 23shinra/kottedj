// Типы строго по реальным сообщениям из docs/samples/*.json и docs/api-contract.md
import type { MEvent, MicroFrame } from './micro/types';

export type Side = 'W' | 'E';
export type TrainCat = 'pass' | 'freight_transit' | 'freight_local';
export type TrainStatus =
  | 'scheduled'
  | 'approaching'
  | 'held'
  | 'at_signal'
  | 'entering'
  | 'on_track'
  | 'departing'
  | 'departed'
  | 'rerouted';
export type TrackStatus = 'free' | 'occupied' | 'closed' | 'reserve';
export type Severity = 'critical' | 'high' | 'medium' | 'info' | 'low';
export type World = 'ai' | 'baseline';

/* ---------------- Station ---------------- */
export interface Park {
  id: string;
  name: string;
}
export interface Ladder {
  id: string;
  switches: string[];
}
export interface Throat {
  id: Side;
  name: string;
  ladders: Ladder[];
}
export interface Approach {
  id: Side;
  name: string;
  throat: Side;
  length_m: number;
}
export interface TrackDef {
  id: string;
  park: string;
  length_m: number;
  platform: boolean;
  electrified: boolean;
  cargo: boolean;
  accepts: TrainCat[];
  ladders: Record<Side, string>;
  reserve: boolean;
}
export interface CategoryDef {
  id: TrainCat;
  name: string;
  priority: number;
  length_m: [number, number];
  service_min: [number, number];
  needs_loco: boolean;
  needs_crew: boolean;
  electric: boolean;
}
export interface Station {
  name: string;
  parks: Park[];
  throats: Throat[];
  approaches: Approach[];
  tracks: TrackDef[];
  categories: Record<TrainCat, CategoryDef>;
  start_clock: string;
  resources: {
    locos: number;
    crews: number;
    loco_prep_min: number;
    crew_prep_min: number;
    loco_turnaround_min: number;
    crew_rest_min: number;
  };
}

/* ---------------- Config ---------------- */
export interface IndexFactorCfg {
  name: string;
  weight: number;
  description: string;
  worst_min?: number;
  worst_count?: number;
  optimal?: [number, number];
}
export interface IndexCategoryCfg {
  id: 'norm' | 'warning' | 'critical';
  name: string;
  min: number;
  color: string;
  reason: string;
}
export interface IndexConfig {
  factors: Record<string, IndexFactorCfg>;
  categories: IndexCategoryCfg[];
  grades: { grade: string; min: number }[];
}
export interface PlannerVariantCfg {
  id: string;
  name: string;
  description: string;
  priority_scale: Record<TrainCat, number>;
  entry_delay: number;
  departure_delay: number;
}
export interface PlannerConfig {
  horizon_min: number;
  freeze_min: number;
  replan_interval_s: number;
  incident_debounce_ms: number;
  solver: { time_limit_s: number; variant_time_limit_s: number; workers: number };
  auto_apply_best_variant: boolean;
  objective: {
    entry_delay: number;
    departure_delay: number;
    track_change: number;
    unassigned_resource: number;
    starvation_weight: number;
    starvation_after_min: number;
  };
  variants: PlannerVariantCfg[];
  forecast: { window_min: number; reroute_delay_min: number };
}

/* ---------------- State ---------------- */
export interface Train {
  id: string;
  cat: TrainCat;
  length_m: number;
  side_in: Side;
  side_out: Side;
  status: TrainStatus;
  reason: string | null;
  reason_text: string | null;
  track: string | null;
  pos_m: number;
  speed_kmh: number;
  planned_arr: number;
  planned_dep: number;
  eta: number;
  entered_at: number | null;
  service_done_at: number | null;
  service_s?: number;
  ready_at: number | null;
  departed_at: number | null;
  loco: string | null;
  crew: string | null;
  loco_ready_at?: number | null;
  crew_ready_at?: number | null;
  regulated: boolean;
  advisory_kmh: number | null;
  hold_until?: number;
  stopped_at_signal: boolean;
  res_wait_s: number;
  delay_s: number;
}
export interface UpcomingTrain {
  id: string;
  cat: TrainCat;
  length_m: number;
  side_in: Side;
  side_out: Side;
  status: 'scheduled';
  planned_arr: number;
  planned_dep: number;
  eta: number;
  service_s?: number;
}
export interface TrackState {
  id: string;
  status: TrackStatus;
  train: string | null;
  closed_until: number | null;
}
export interface LadderState {
  id: string;
  busy_until: number;
  train: string | null;
}
export interface ResourceState {
  id: string;
  status: string;
  train: string | null;
  until: number | null;
}
export interface Kpi {
  sim_time?: number;
  departed_1h: number;
  due_1h: number;
  throughput_ratio: number;
  avg_deviation_min: number;
  utilization: number;
  occupied_tracks?: number;
  open_tracks?: number;
  conflicts: number;
  blocked_now?: number;
  ladder_conflicts_30m?: number;
  avg_resource_wait_min: number;
  locos_idle?: number;
  locos_total?: number;
  crews_idle?: number;
  queue_len: number;
  avg_entry_wait_min: number;
  signal_stops_1h?: number;
  total_departed?: number;
}
export interface WorldState {
  world: World;
  sim_time: number;
  trains: Train[];
  upcoming: UpcomingTrain[];
  tracks: TrackState[];
  ladders: LadderState[];
  locos: ResourceState[];
  crews: ResourceState[];
  kpi: Kpi;
  plan_version: number | null;
}

/* ---------------- Index ---------------- */
export interface IndexCategory {
  id: 'norm' | 'warning' | 'critical';
  name: string;
  color: string;
  reason: string;
}
export interface IndexFactor {
  id: string;
  name: string;
  weight: number;
  score: number;
  points: number;
  loss: number;
  why: string;
  description: string;
}
export interface IndexValue {
  value: number;
  grade: string;
  category: IndexCategory;
  factors: IndexFactor[];
  top: IndexFactor[];
}

/* ---------------- Plan ---------------- */
export interface Assignment {
  track: string;
  entry_at?: number;
  dep_at: number;
  loco?: string | null;
  loco_from?: string;
  loco_at?: number;
  crew?: string | null;
  crew_from?: string;
  crew_at?: number;
  loco_missing?: boolean;
  crew_missing?: boolean;
}
export interface PlanConflict {
  type: string;
  severity: Severity;
  trains?: string[];
  park?: string;
  at?: number;
  text: string;
  resolved: boolean;
  resolution: string;
}
export interface RecommendationAction {
  type: 'open_track' | 'reroute' | 'add_loco' | 'add_crew' | string;
  track?: string;
  train?: string;
  [k: string]: unknown;
}
export interface Recommendation {
  id: string;
  severity: Severity;
  kind: string;
  title: string;
  text: string;
  action: RecommendationAction | null;
}
export interface Solver {
  engine: 'cp-sat' | 'greedy' | string;
  status: string;
  objective?: number;
  bound?: number;
  time_ms: number;
  vars?: number;
  constraints?: number;
}
export interface Plan {
  version?: number;
  sim_time: number;
  created_at?: number;
  variant: string;
  variant_name: string;
  description?: string;
  assignments: Record<string, Assignment>;
  solver: Solver;
  projected_kpi: Partial<Kpi>;
  projected_index: IndexValue;
  trains_planned?: number;
  conflicts: PlanConflict[];
  recommendations: Recommendation[];
  total_ms: number;
}

/* ---------------- Messages ---------------- */
export interface CompareBlock {
  kpi: Kpi;
  index: IndexValue;
}
export interface Frame {
  type: 'frame';
  seq: number;
  emitted_at: number;
  received_at?: number;
  state: WorldState;
  index: IndexValue;
  compare: { baseline: CompareBlock; ai: CompareBlock };
  link?: Record<string, string | number>;
}
export interface HelloMsg {
  type: 'hello';
  station: Station;
  index_config: IndexConfig;
  planner_config: PlannerConfig;
  time_scale?: number;
  user?: { username: string; role: Role };
}
export interface PlanMsg {
  type: 'plan';
  plan: Plan;
}
export interface Incident {
  type: 'close_track' | 'delay' | 'loco_failure' | 'stress' | string;
  track?: string;
  train?: string;
  minutes?: number;
  duration_min?: number;
  loco?: string;
}
export interface VariantsMsg {
  type: 'variants';
  incident: Incident;
  variants: Plan[];
  applied: string;
}
export interface SimEvent {
  t: number;
  type: string;
  text: string;
  world: World;
  train?: string;
  track?: string;
  loco?: string;
  severity?: Severity;
}
export interface EventsMsg {
  type: 'events';
  events: SimEvent[];
}
export interface PingMsg {
  type: 'ping';
}
export interface MicroMsg extends Omit<MicroFrame, 'type'> {
  type: 'micro';
}
export interface MicroEventsMsg {
  type: 'micro_events';
  version?: number;
  events: MEvent[];
}
export type ServerMsg = HelloMsg | Frame | PlanMsg | VariantsMsg | EventsMsg | PingMsg | MicroMsg | MicroEventsMsg;

/* ---------------- REST ---------------- */
export type Role = 'dispatcher' | 'admin';
export interface LoginResponse {
  token: string;
  role: Role;
  username: string;
}
export interface TimelinePoint {
  ts: number;
  sim_time: number;
  index_ai: number;
  index_baseline: number;
  queue_ai: number;
  queue_baseline: number;
}
export interface HistoryFrameResponse {
  frame: Frame;
  plan?: Plan | null;
}

export type ViewMode = 'ai' | 'baseline' | 'compare';
