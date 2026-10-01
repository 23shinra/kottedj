import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { useStore } from '../store';
import { api, ApiError, errText } from '../api/rest';
import type { Role } from '../types';

export function Login() {
  const setAuth = useStore((s) => s.setAuth);
  const [username, setUsername] = useState('dispatcher');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(username.trim(), password);
      setAuth({
        token: r.token,
        role: r.role,
        username: r.username,
        mock: false,
      });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const down = status === 0 || status === 502 || status === 503 || status === 504;
      setUnreachable(down);
      setError(down ? 'Сервер недоступен. Можно открыть демо-режим на записанных данных.' : status === 401 ? 'Неверный логин или пароль' : errText(err));
    } finally {
      setBusy(false);
    }
  };

  const demo = async (role: Role) => {
    const name = role === 'admin' ? 'admin' : 'dispatcher';
    if (!unreachable) {
      setBusy(true);
      try {
        const r = await api.login(name, name);
        setAuth({
          token: r.token,
          role: r.role,
          username: r.username,
          mock: false,
        });
        return;
      } catch {
        /* сервер недоступен или демо-пароль изменён — открываем демо на записанных данных */
      } finally {
        setBusy(false);
      }
    }
    setAuth({ token: 'mock', role, username: name, mock: true });
  };

  return (
    <main className="login">
      <div className="login-card">
        <div className="login-brand">
          <h1>Цифровая станция</h1>
          <span className="muted small">Вход в АРМ диспетчера</span>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>
            Логин
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
          </label>
          <label>
            Пароль
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          {error && (
            <div className={`login-err ${unreachable ? 'warn' : ''}`} role="alert">
              <CircleAlert size={15} /> {error}
            </div>
          )}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
            {busy ? 'Вход…' : 'Войти'}
          </button>
        </form>
        <div className="login-demo">
          <span className="small muted">Демо-вход{unreachable ? ' на записанных данных' : ''}</span>
          <div className="login-demo-row">
            <button className="btn" disabled={busy} onClick={() => demo('dispatcher')}>
              Диспетчер
            </button>
            <button className="btn" disabled={busy} onClick={() => demo('admin')}>
              Администратор
            </button>
          </div>
          <p className="login-foot muted small">dispatcher / dispatcher · admin / admin</p>
        </div>
      </div>
    </main>
  );
}
