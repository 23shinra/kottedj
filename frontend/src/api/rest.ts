import { useStore } from '../store';
import type {
  Frame,
  IndexConfig,
  Incident,
  LoginResponse,
  Plan,
  PlannerConfig,
  RecommendationAction,
  TimelinePoint,
} from '../types';
import { mockServer } from './mock';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const ERR_TEXT: Record<number, string> = {
  400: 'Некорректный запрос',
  401: 'Сессия истекла — войдите снова',
  403: 'Недостаточно прав для действия',
  404: 'Не найдено',
  409: 'Конфликт: действие уже неактуально',
  422: 'Ошибка проверки данных',
  500: 'Внутренняя ошибка сервера',
  502: 'Сервер недоступен',
  503: 'Сервис временно недоступен',
  504: 'Сервер не ответил вовремя',
};

async function request<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const { auth } = useStore.getState();
  if (auth.mock) return mockServer.rest<T>(method, path, body);

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;

  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Нет связи с сервером');
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j.detail === 'string' ? j.detail : j.message ?? '';
    } catch {
      /* not json */
    }
    if (res.status === 401 && !path.endsWith('/auth/login')) {
      useStore.getState().logout();
    }
    throw new ApiError(res.status, detail || ERR_TEXT[res.status] || `Ошибка ${res.status}`);
  }
  if (raw) return (await res.blob()) as unknown as T;
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? await res.json() : await res.text()) as T;
}

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Нормализуем ответ /api/history/frame: сервер может вернуть frame напрямую или {frame, plan}. */
function normalizeHistory(r: unknown): { frame: Frame | null; plan: Plan | null } {
  if (!r || typeof r !== 'object') return { frame: null, plan: null };
  const o = r as Record<string, unknown>;
  if (o.frame && typeof o.frame === 'object') {
    return { frame: o.frame as Frame, plan: (o.plan as Plan) ?? null };
  }
  if (o.state) {
    const plan = (o.plan as Plan) ?? null;
    return { frame: o as unknown as Frame, plan };
  }
  return { frame: null, plan: null };
}

export const api = {
  login: (username: string, password: string) =>
    request<LoginResponse>('POST', '/api/auth/login', { username, password }),
  applyVariant: (variant: string) => request<unknown>('POST', '/api/plan/apply', { variant }),
  incident: (body: Incident) => request<unknown>('POST', '/api/incidents', body),
  stress: () => request<unknown>('POST', '/api/incidents/stress', {}),
  action: (a: RecommendationAction) => request<unknown>('POST', '/api/actions', a),
  timeline: (minutes = 15) =>
    request<{ points: TimelinePoint[] }>('GET', `/api/history/timeline?minutes=${minutes}`),
  historyFrame: async (ts: number) =>
    normalizeHistory(await request<unknown>('GET', `/api/history/frame?ts=${Math.round(ts)}`)),
  getIndexConfig: () => request<IndexConfig>('GET', '/api/config/index'),
  putIndexConfig: (c: IndexConfig) => request<IndexConfig>('PUT', '/api/config/index', c),
  getPlannerConfig: () => request<PlannerConfig>('GET', '/api/config/planner'),
  putPlannerConfig: (c: PlannerConfig) => request<PlannerConfig>('PUT', '/api/config/planner', c),
  simSpeed: (time_scale: number) => request<unknown>('POST', '/api/sim/speed', { time_scale }),
  report: (kind: 'csv' | 'pdf', minutes = 60) =>
    request<Blob>('GET', `/api/reports/summary.${kind}?minutes=${minutes}`, undefined, true),
};

/** Скачивание отчёта через fetch → blob (с заголовком авторизации). */
export async function downloadReport(kind: 'csv' | 'pdf'): Promise<void> {
  const blob = await api.report(kind, 60);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  a.href = url;
  a.download = `station-report-${stamp}.${kind}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
