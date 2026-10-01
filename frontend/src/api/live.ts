import { useStore } from '../store';
import type { Frame, ServerMsg, VariantsMsg } from '../types';
import { mockServer } from './mock';
import { LiveSocket } from './ws';

/* ---------- rAF-батчинг кадров: за один кадр анимации рендерим только последний frame ---------- */
let pendingFrame: Frame | null = null;
let rafId: number | null = null;
let droppedFrames = 0;

function flushFrame() {
  rafId = null;
  const f = pendingFrame;
  pendingFrame = null;
  if (f) useStore.getState().applyFrame(f);
}

function queueFrame(f: Frame) {
  if (pendingFrame) droppedFrames++;
  pendingFrame = f;
  if (rafId == null) {
    rafId = requestAnimationFrame(flushFrame);
    // в фоновой вкладке rAF не вызывается — подстраховка таймером
    if (document.hidden) window.setTimeout(() => rafId != null && (cancelAnimationFrame(rafId), flushFrame()), 250);
  }
}

export function getHelloAt(): number {
  return helloAt;
}

export function getDroppedFrames(): number {
  return droppedFrames;
}

/* ---------- Варианты: показываем модалку только для новых (не при повторной отправке после reconnect) ---------- */
const SEEN_KEY = 'ds.variantsSeen';
let helloAt = 0;

function variantsKey(v: VariantsMsg): string {
  const c = v.variants?.[0]?.created_at ?? v.variants?.[0]?.sim_time ?? 0;
  return `${v.applied}|${JSON.stringify(v.incident)}|${c}`;
}

function handleVariants(v: VariantsMsg) {
  const key = variantsKey(v);
  const seen = sessionStorage.getItem(SEEN_KEY);
  const isReplay = Date.now() - helloAt < 1500;
  const open = key !== seen && !isReplay;
  sessionStorage.setItem(SEEN_KEY, key);
  useStore.getState().applyVariants(v, open);
}

export function handleServerMsg(m: ServerMsg): void {
  const st = useStore.getState();
  switch (m.type) {
    case 'hello':
      helloAt = Date.now();
      st.applyHello(m);
      break;
    case 'frame':
      queueFrame(m);
      break;
    case 'plan':
      st.applyPlan(m.plan);
      break;
    case 'variants':
      handleVariants(m);
      break;
    case 'events':
      if (Array.isArray(m.events) && m.events.length) st.addEvents(m.events);
      break;
    default:
      break;
  }
}

/* ---------- Транспорт ---------- */
let socket: LiveSocket | null = null;
let lastMsgThrottle = 0;

export function startLive(): () => void {
  const { auth } = useStore.getState();
  const setConn = useStore.getState().setConn;

  const onMessage = (m: ServerMsg) => {
    const now = Date.now();
    if (now - lastMsgThrottle > 1000) {
      lastMsgThrottle = now;
      setConn({ lastMsgAt: now });
    }
    handleServerMsg(m);
  };

  if (auth.mock) {
    setConn({ status: 'connecting', attempt: 0, retryAt: null });
    mockServer.start(onMessage, (s) => setConn({ status: s.status, attempt: s.attempt, retryAt: s.retryAt }));
    return () => mockServer.stop();
  }

  socket = new LiveSocket({
    url: () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const token = encodeURIComponent(useStore.getState().auth.token ?? '');
      return `${proto}://${location.host}/ws/live?token=${token}`;
    },
    onMessage,
    onStatus: (s) => setConn({ status: s.status, attempt: s.attempt, retryAt: s.retryAt }),
    onAuthError: () => {
      useStore.getState().toast('error', 'Сессия недействительна — войдите снова');
      useStore.getState().logout();
    },
  });
  socket.start();
  return () => {
    socket?.stop();
    socket = null;
  };
}

export function reconnectNow(): void {
  if (useStore.getState().auth.mock) mockServer.reconnectNow();
  else socket?.reconnectNow();
}
