import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './store';
import type { Role } from './types';
import '@fontsource-variable/inter';
import './styles/app.css';

// ?mock=1 — демо-режим без сервера (для разработки и скриншотов); &role=dispatcher — роль диспетчера
const params = new URLSearchParams(location.search);
if (params.get('mock') === '1') {
  const role: Role = params.get('role') === 'dispatcher' ? 'dispatcher' : 'admin';
  const cur = useStore.getState().auth;
  if (!cur.mock || cur.role !== role) useStore.getState().setAuth({ token: 'mock', role, username: role, mock: true });
  const mode = params.get('mode');
  if (mode === 'compare' || mode === 'baseline' || mode === 'ai') useStore.getState().setMode(mode);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
