import { useState } from 'react';
import { CircleAlert, LogIn, MonitorPlay, TrainFront } from 'lucide-react';
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
      setAuth({ token: r.token, role: r.role, username: r.username, mock: false });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const down = status === 0 || status === 502 || status === 503 || status === 504;
      setUnreachable(down);
      setError(down ? 'Сервер недоступен. Можно открыть демо-режим на записанных данных.' : status === 401 ? 'Неверный логин или пароль' : errText(err));
    } finally {
      setBusy(false);
    }
  };

  const demo = (role: Role) => setAuth({ token: 'mock', role, username: role === 'admin' ? 'admin' : 'dispatcher', mock: true });

  return (
    <div className="login">
      <div className="login-hero" aria-hidden="true">
        <svg viewBox="0 0 600 260" className="login-art">
          <defs>
            <linearGradient id="lg1" x1="0" x2="1">
              <stop offset="0" stopColor="#8b9cff" stopOpacity="0" />
              <stop offset="0.5" stopColor="#8b9cff" stopOpacity="0.9" />
              <stop offset="1" stopColor="#8b9cff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line x1="0" y1="130" x2="150" y2="130" stroke="#2a3956" strokeWidth="3" />
          <line x1="450" y1="130" x2="600" y2="130" stroke="#2a3956" strokeWidth="3" />
          {[40, 70, 100, 160, 190, 220].map((y, i) => (
            <g key={y}>
              <line x1="150" y1="130" x2={190 + Math.abs(130 - y) * 0.3} y2={y} stroke="#2a3956" strokeWidth="2" />
              <line x1={190 + Math.abs(130 - y) * 0.3} y1={y} x2={410 - Math.abs(130 - y) * 0.3} y2={y} stroke="#2a3956" strokeWidth="3" />
              <line x1={410 - Math.abs(130 - y) * 0.3} y1={y} x2="450" y2="130" stroke="#2a3956" strokeWidth="2" />
              {i % 2 === 0 && <rect x={240 + i * 8} y={y - 6} width={90} height={12} rx={4} fill={['#3987e5', '#d95926', '#199e70'][i / 2]} opacity="0.85" />}
            </g>
          ))}
          <rect x="0" y="128" width="600" height="4" fill="url(#lg1)">
            <animate attributeName="x" from="-600" to="600" dur="3.5s" repeatCount="indefinite" />
          </rect>
        </svg>
        <h1>Цифровая станция</h1>
        <p>ИИ-диспетчер: слоты прибытия, пути, локомотивы и бригады — без очереди у входного сигнала.</p>
        <ul className="login-points">
          <li>
            <b>2 цифровых двойника</b> на одном потоке: FCFS против ИИ
          </li>
          <li>
            <b>CP-SAT</b> перепланирование за ~1 с при нештатной ситуации
          </li>
          <li>
            <b>Виртуальная очередь</b>: регулирование скорости вместо стоянки
          </li>
        </ul>
      </div>
      <div className="login-card">
        <div className="login-brand">
          <span className="logo">
            <TrainFront size={22} />
          </span>
          <div>
            <div className="brand-name">Цифровая станция</div>
            <div className="brand-sub">Вход в АРМ диспетчера</div>
          </div>
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
            <LogIn size={16} /> {busy ? 'Вход…' : 'Войти'}
          </button>
        </form>
        <div className={`login-demo ${unreachable ? 'emph' : ''}`}>
          <div className="login-demo-h">
            <MonitorPlay size={15} /> Демо без сервера
          </div>
          <p className="muted small">Интерфейс на записанных данных с локальным симулятором.</p>
          <div className="row-inline">
            <button className="btn btn-ghost" onClick={() => demo('dispatcher')}>
              Как диспетчер
            </button>
            <button className="btn btn-ghost" onClick={() => demo('admin')}>
              Как администратор
            </button>
          </div>
        </div>
        <p className="login-foot muted small">Демо-пользователи: dispatcher / dispatcher, admin / admin</p>
      </div>
    </div>
  );
}
