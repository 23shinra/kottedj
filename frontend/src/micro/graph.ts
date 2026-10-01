import type { MDevice, MicroFrame, MicroStatic, MSelection } from './types';

export interface Indexes {
  dev: Record<string, MDevice>;
  byLink: Record<string, string[]>;
  dependents: Record<string, string[]>;
  nodes: Record<string, { x: number; y: number; kind: string }>;
}

const cache = new WeakMap<MicroStatic, Indexes>();

export function indexes(st: MicroStatic): Indexes {
  const hit = cache.get(st);
  if (hit) return hit;
  const dev: Record<string, MDevice> = {};
  const byLink: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  for (const d of st.equipment.devices) {
    dev[d.id] = d;
    if (d.link) (byLink[`${d.link[0]}:${d.link[1]}`] ??= []).push(d.id);
    for (const g of d.requires) for (const r of g) (dependents[r] ??= []).push(d.id);
  }
  const nodes: Indexes['nodes'] = {};
  for (const n of st.infra.nodes) nodes[n.id] = { x: n.x, y: n.y, kind: n.kind };
  const ix = { dev, byLink, dependents, nodes };
  cache.set(st, ix);
  return ix;
}

export function upstream(ix: Indexes, ids: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...ids];
  while (stack.length) {
    const i = stack.pop()!;
    if (out.has(i) || !ix.dev[i]) continue;
    out.add(i);
    for (const g of ix.dev[i].requires) stack.push(...g);
  }
  return out;
}

export function downstream(ix: Indexes, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const i = stack.pop()!;
    if (out.has(i)) continue;
    out.add(i);
    stack.push(...(ix.dependents[i] ?? []));
  }
  return out;
}

const LINK_KIND: Record<string, string> = { switch: 'switch', signal: 'signal', segment: 'segment' };

/** Что подсветить в обоих представлениях для текущего выбора. */
export function highlight(st: MicroStatic, frame: MicroFrame | null, sel: MSelection): { objects: Set<string>; devices: Set<string> } {
  const objects = new Set<string>();
  const devices = new Set<string>();
  if (!sel) return { objects, devices };
  const ix = indexes(st);
  if (sel.kind === 'device') {
    for (const d of downstream(ix, sel.id)) {
      devices.add(d);
      const l = ix.dev[d]?.link;
      if (l) objects.add(`${LINK_KIND[l[0]]}:${l[1]}`);
    }
    for (const d of upstream(ix, [sel.id])) devices.add(d);
  } else if (sel.kind === 'switch' || sel.kind === 'signal' || sel.kind === 'segment') {
    objects.add(`${sel.kind}:${sel.id}`);
    for (const d of upstream(ix, ix.byLink[`${sel.kind}:${sel.id}`] ?? [])) devices.add(d);
  } else if (sel.kind === 'train' && frame) {
    const tr = frame.trains.find((t) => t.id === sel.id);
    if (tr) {
      objects.add(`train:${tr.id}`);
      for (const [s] of tr.occ) objects.add(`segment:${s}`);
      for (const r of frame.routes) if (r.train === tr.id) r.segs.forEach((s) => objects.add(`segment:${s}`));
      if (tr.dest) objects.add(`segment:${tr.dest}`);
    }
  }
  return { objects, devices };
}

export function deviceStatus(frame: MicroFrame | null, id: string): string {
  return frame?.devices[id]?.status ?? 'ok';
}
