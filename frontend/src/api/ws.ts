import type { ServerMsg } from '../types';

export interface WsStatus {
  status: 'connecting' | 'online' | 'reconnecting' | 'offline';
  attempt: number;
  retryAt: number | null;
}

export interface LiveSocketOptions {
  url: () => string;
  onMessage: (m: ServerMsg) => void;
  onStatus: (s: WsStatus) => void;
  onAuthError: () => void;
  /** Нет сообщений дольше → соединение считается «зависшим» и переоткрывается. */
  staleMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * WebSocket-клиент: экспоненциальный backoff с джиттером (0.5 с → 30 с),
 * heartbeat (ответ pong на ping, watchdog 6 с без сообщений), реакция на online/offline браузера.
 */
export class LiveSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | null = null;
  private watchdog: number | null = null;
  private lastMsgAt = 0;
  private stopped = true;
  private gotMessage = false;
  private opts: Required<LiveSocketOptions>;

  constructor(opts: LiveSocketOptions) {
    this.opts = { staleMs: 6000, baseDelayMs: 500, maxDelayMs: 30000, ...opts };
  }

  start(): void {
    this.stopped = false;
    window.addEventListener('online', this.onBrowserOnline);
    window.addEventListener('offline', this.onBrowserOffline);
    this.watchdog = window.setInterval(this.checkStale, 1000);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener('online', this.onBrowserOnline);
    window.removeEventListener('offline', this.onBrowserOffline);
    if (this.watchdog != null) window.clearInterval(this.watchdog);
    if (this.retryTimer != null) window.clearTimeout(this.retryTimer);
    this.watchdog = this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(1000, 'client stop');
      } catch {
        /* ignore */
      }
    }
  }

  send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** Немедленная попытка переподключения (кнопка «Повторить»). */
  reconnectNow(): void {
    if (this.stopped) return;
    if (this.retryTimer != null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.dropSocket();
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    this.gotMessage = false;
    this.opts.onStatus({ status: this.attempt === 0 ? 'connecting' : 'reconnecting', attempt: this.attempt, retryAt: null });
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastMsgAt = Date.now();

    ws.onopen = () => {
      this.lastMsgAt = Date.now();
    };
    ws.onmessage = (ev) => {
      this.lastMsgAt = Date.now();
      if (!this.gotMessage) {
        this.gotMessage = true;
        this.attempt = 0;
        this.opts.onStatus({ status: 'online', attempt: 0, retryAt: null });
      }
      let msg: ServerMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      } catch {
        return;
      }
      if (msg.type === 'ping') {
        this.send({ type: 'pong' });
        return;
      }
      this.opts.onMessage(msg);
    };
    ws.onerror = () => {
      /* onclose придёт следом */
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (ev.code === 4401 || ev.code === 4403 || ev.code === 1008) {
        this.opts.onAuthError();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close(4000, 'stale');
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const exp = Math.min(this.opts.maxDelayMs, this.opts.baseDelayMs * 2 ** (this.attempt - 1));
    // «equal jitter»: половина фиксированная, половина случайная
    const delay = Math.round(exp / 2 + Math.random() * (exp / 2));
    const retryAt = Date.now() + delay;
    const offline = !navigator.onLine || this.attempt > 6;
    this.opts.onStatus({ status: offline ? 'offline' : 'reconnecting', attempt: this.attempt, retryAt });
    if (this.retryTimer != null) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private checkStale = (): void => {
    if (this.stopped || !this.ws) return;
    if (Date.now() - this.lastMsgAt > this.opts.staleMs) {
      // «тихий» обрыв: сокет формально открыт, но данных нет
      this.dropSocket();
      this.scheduleReconnect();
    }
  };

  private onBrowserOnline = (): void => this.reconnectNow();
  private onBrowserOffline = (): void => {
    this.dropSocket();
    this.scheduleReconnect();
  };
}
