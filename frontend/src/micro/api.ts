import { useStore } from '../store';
import { ApiError } from '../api/rest';
import type { CommandResult, MicroStatic } from './types';
import { useMicro } from './store';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { auth } = useStore.getState();
  if (auth.mock) throw new ApiError(503, 'Микромодель доступна только при подключении к серверу');
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
      detail = typeof j.detail === 'string' ? j.detail : '';
    } catch {
      /* not json */
    }
    if (res.status === 401) useStore.getState().logout();
    throw new ApiError(res.status, detail || `Ошибка ${res.status}`);
  }
  return (await res.json()) as T;
}

export const microApi = {
  static: () => req<MicroStatic>('GET', '/api/micro/static'),
  card: <T>(kind: string, id: string) => req<T>('GET', `/api/micro/card/${kind}/${encodeURIComponent(id)}`),
  command: (cmd: Record<string, unknown>) => req<CommandResult>('POST', '/api/micro/command', cmd),
};

let loading = false;

export async function refreshStatic(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    useMicro.getState().setStatic(await microApi.static());
  } finally {
    loading = false;
  }
}

/** Команда с уведомлением; при отказе показывает конкретные причины. */
export async function runCommand(cmd: Record<string, unknown>, okText?: string): Promise<CommandResult | null> {
  const toast = useStore.getState().toast;
  try {
    const r = await microApi.command(cmd);
    if (r.ok) toast('ok', okText ?? r.message);
    else toast('warn', r.blockers?.length ? `${r.message}: ${r.blockers.map((b) => b.text).join('; ')}` : r.message);
    if (cmd.type === 'reset') await refreshStatic();
    return r;
  } catch (e) {
    toast('error', e instanceof Error ? e.message : String(e));
    return null;
  }
}
