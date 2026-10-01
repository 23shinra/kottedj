import { useEffect, useRef, useState } from 'react';

/** Текущее время, обновляемое с заданным интервалом. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Debounce-колбэк. */
export function useDebounced<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  const t = useRef<number | null>(null);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => void (t.current != null && window.clearTimeout(t.current)), []);
  return (...a: A) => {
    if (t.current != null) window.clearTimeout(t.current);
    t.current = window.setTimeout(() => f.current(...a), ms);
  };
}

/** Размер элемента (ResizeObserver). */
export function useSize<T extends HTMLElement>(): [React.RefObject<T>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}
