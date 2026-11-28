import type { Net, Port, Transition } from "../core/net";
import { placeLevel, placeRadius } from "../game/placeSize";
import { TRANSITION_H, TRANSITION_W } from "./style";

const OPEN_PORT_LENGTH = 46;

export interface Pt {
  x: number;
  y: number;
}

export function isUltraWide(width: number, height: number): boolean {
  return width >= height * 2;
}

/** Drawn size of a transition bar. */
export interface BarSize {
  w: number;
  h: number;
}

/** Distance from a node's center to its outline along unit direction (dx, dy). */
function boundaryDistance(net: Net, bar: BarSize, id: string, dx: number, dy: number): number {
  const place = net.places.get(id);
  if (place) return placeRadius(place.capacity);
  const tx = Math.abs(dx) > 1e-9 ? bar.w / 2 / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-9 ? bar.h / 2 / Math.abs(dy) : Infinity;
  return Math.min(tx, ty);
}

/** Straight leg (along the flow axis) with which arcs preferably enter/leave transitions. */
const MIN_STUB = 44;

/**
 * Mini Metro-style octilinear route from a place to a transition (center to center): a diagonal
 * leg at the place and a leg along the flow axis (x in landscape, y in portrait) into the
 * transition. If that straight leg would be shorter than MIN_STUB, a third leg perpendicular
 * to the flow is added at the place.
 */
export function octilinearRoute(place: Pt, transition: Pt, flowAxisX: boolean): Pt[] {
  const dx = transition.x - place.x;
  const dy = transition.y - place.y;
  // Work in (along flow, across flow) coordinates.
  const along = flowAxisX ? dx : dy;
  const across = flowAxisX ? dy : dx;
  const toWorld = (u: number, v: number): Pt =>
    flowAxisX ? { x: place.x + u, y: place.y + v } : { x: place.x + v, y: place.y + u };
  const su = Math.sign(along);
  const sv = Math.sign(across);
  const pts: Pt[] = [toWorld(0, 0)];
  const stub = Math.max(Math.abs(along) - Math.abs(across), Math.min(MIN_STUB, Math.abs(along) / 2));
  const diag = Math.abs(along) - stub;
  pts.push(toWorld(0, sv * (Math.abs(across) - diag)));
  pts.push(toWorld(along - su * stub, across));
  pts.push(toWorld(along, across));
  return dedupe(pts);
}

function dedupe(pts: Pt[]): Pt[] {
  return pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-6);
}

/** An arc's route, always oriented from its place (center) to its transition (outline). */
export interface ArcRoute {
  pts: Pt[];
  placeId: string;
  /** True if the arc runs from the place to the transition (an input arc). */
  fromPlace: boolean;
}

/**
 * Routes an arc; `shift` moves its attachment point across the transition bar so that several
 * arcs on the same side of a transition run in parallel instead of merging.
 */
export function arcRoute(net: Net, bar: BarSize, portrait: boolean, from: string, to: string, shift = 0): ArcRoute {
  const fromPlace = net.places.has(from);
  const [placeId, tid] = fromPlace ? [from, to] : [to, from];
  const t = net.pos(tid);
  const attach = portrait ? { x: t.x + shift, y: t.y } : { x: t.x, y: t.y + shift };
  const pts = octilinearRoute(net.pos(placeId), attach, !portrait);
  if (pts.length >= 2) {
    const n = pts.length;
    const a = pts[n - 2];
    const b = pts[n - 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const e = Math.min(boundaryDistance(net, bar, tid, -ux, -uy), len);
    pts[n - 1] = { x: b.x - ux * e, y: b.y - uy * e };
  }
  return { pts, placeId, fromPlace };
}

/** Shared by live nodes and proposed builds so bars, ports and arcs agree before and after release. */
export function transitionLayout(net: Net, t: Transition, defaultPortrait: boolean, arcs = net.arcsOf(t.id)) {
  const live = arcs.filter((arc) => !arc.ghost);
  const placeOf = (arc: (typeof arcs)[number]) => net.pos(arc.from === t.id ? arc.to : arc.from);
  const directions = live.map((arc) => {
    const place = placeOf(arc);
    const dx = Math.abs(place.x - t.x), dy = Math.abs(place.y - t.y);
    return dy > dx ? "vertical" : dx > dy ? "horizontal" : "diagonal";
  });
  const portrait = directions.length && directions.every((direction) => direction === "vertical") ? true
    : directions.length && directions.every((direction) => direction === "horizontal") ? false : defaultPortrait;
  const bar = portrait ? { w: TRANSITION_H, h: TRANSITION_W } : { w: TRANSITION_W, h: TRANSITION_H };
  const sideOf = (arc: (typeof arcs)[number]) => {
    const place = placeOf(arc);
    const along = portrait ? place.y - t.y : place.x - t.x;
    return along < 0 ? -1 : along > 0 ? 1 : 0;
  };
  const sideCounts = { [-1]: 0, [1]: 0 };
  for (const arc of live) {
    const side = sideOf(arc);
    if (side) sideCounts[side]++;
  }
  const ports = (t.open ?? []).map((port, index) => {
    const preferred = port.dir === "in" ? -1 : 1;
    const other = preferred === -1 ? 1 : -1;
    return { port, index, side: sideCounts[preferred] > sideCounts[other] ? other : preferred };
  });
  const routes = new Map<string, ArcRoute>();
  const stubs: { tid: string; index: number; port: Port; edge: Pt; plug: Pt }[] = [];
  for (const sign of [-1, 1]) {
    const sorted = arcs.filter((arc) => (sideOf(arc) || (arc.to === t.id ? -1 : 1)) === sign)
      .sort((a, b) => (portrait ? placeOf(a).x - placeOf(b).x : placeOf(a).y - placeOf(b).y));
    const open = ports.filter((port) => port.side === sign);
    const n = sorted.length + open.length;
    const spacing = Math.min(16, (portrait ? bar.w : bar.h) / Math.max(1, n));
    const shiftOf = (i: number) => (i - (n - 1) / 2) * spacing;
    sorted.forEach((arc, i) => routes.set(arc.id, arcRoute(net, bar, portrait, arc.from, arc.to, shiftOf(i))));
    open.forEach(({ port, index }, i) => {
      const shift = shiftOf(sorted.length + i);
      const half = (portrait ? bar.h : bar.w) / 2;
      const at = (along: number): Pt => portrait ? { x: t.x + shift, y: t.y + along } : { x: t.x + along, y: t.y + shift };
      stubs.push({ tid: t.id, index, port, edge: at(sign * half), plug: at(sign * (half + OPEN_PORT_LENGTH)) });
    });
  }
  return { portrait, bar, sideCounts, routes, stubs };
}

export function polylineLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/** Point at distance `d` along the polyline (clamped to its ends). */
export function pointAt(pts: Pt[], d: number): Pt {
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (d <= seg || i === pts.length - 1) return lerp(pts[i - 1], pts[i], seg > 0 ? Math.min(1, Math.max(0, d / seg)) : 0);
    d -= seg;
  }
  return pts[0];
}

/** The part of the polyline from distance `d` to its end. */
export function subpath(pts: Pt[], d: number): Pt[] {
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (d < seg || i === pts.length - 1) {
      return [lerp(pts[i - 1], pts[i], seg > 0 ? Math.min(1, Math.max(0, d / seg)) : 0), ...pts.slice(i)];
    }
    d -= seg;
  }
  return pts.slice();
}

/** Clips a route beginning at a place's center to its circular outline. */
export function outsidePlace(pts: Pt[], radius: number): Pt[] {
  const center = pts[0];
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (Math.hypot(b.x - center.x, b.y - center.y) < radius) continue;
    const a = pts[i - 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const x = a.x - center.x;
    const y = a.y - center.y;
    const length2 = dx * dx + dy * dy;
    const dot = x * dx + y * dy;
    const t = (-dot + Math.sqrt(dot * dot - length2 * (x * x + y * y - radius * radius))) / length2;
    return [lerp(a, b, t), ...pts.slice(i)];
  }
  return pts.slice(-1);
}

/** Polyline shifted sideways by `off` (to the left of the direction of travel), with mitered bends. */
export function offsetPolyline(pts: Pt[], off: number): Pt[] {
  if (off === 0 || pts.length < 2) return pts;
  const normals = pts.slice(1).map((q, i) => {
    const p = pts[i];
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { x: -(q.y - p.y) / len, y: (q.x - p.x) / len };
  });
  return pts.map((p, i) => {
    const n1 = normals[Math.max(0, i - 1)];
    const n2 = normals[Math.min(normals.length - 1, i)];
    const k = 1 + n1.x * n2.x + n1.y * n2.y;
    const mx = (n1.x + n2.x) / k;
    const my = (n1.y + n2.y) / k;
    return { x: p.x + mx * off, y: p.y + my * off };
  });
}

export function distanceToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + (b.x - a.x) * t), p.y - (a.y + (b.y - a.y) * t)));
  }
  return best;
}

export function segmentInsideRect(a: Pt, b: Pt, center: Pt, width: number, height: number): [number, number] | undefined {
  let enter = 0, exit = 1;
  for (const [start, delta, half] of [
    [a.x - center.x, b.x - a.x, width / 2],
    [a.y - center.y, b.y - a.y, height / 2],
  ]) {
    if (delta === 0) {
      if (Math.abs(start) > half) return undefined;
    } else {
      const t1 = (-half - start) / delta, t2 = (half - start) / delta;
      enter = Math.max(enter, Math.min(t1, t2));
      exit = Math.min(exit, Math.max(t1, t2));
    }
  }
  return enter < exit ? [enter, exit] : undefined;
}

export function segmentInsideCircle(a: Pt, b: Pt, center: Pt, radius: number): [number, number] | undefined {
  const dx = b.x - a.x, dy = b.y - a.y;
  const x = a.x - center.x, y = a.y - center.y;
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return undefined;
  const dot = x * dx + y * dy;
  const discriminant = dot * dot - length2 * (x * x + y * y - radius * radius);
  if (discriminant <= 0) return undefined;
  const root = Math.sqrt(discriminant);
  const enter = Math.max(0, (-dot - root) / length2);
  const exit = Math.min(1, (-dot + root) / length2);
  return enter < exit ? [enter, exit] : undefined;
}

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

const TOKEN_SLOT_LAYOUTS = [[1], [2, 3, 2], [3, 4, 5, 4, 3]].map((rows) =>
  rows.flatMap((count, row) => Array.from({ length: count }, (_, column) => ({
    x: (column - (count - 1) / 2) * 13,
    y: ((rows.length - 1) / 2 - row) * 13,
  }))));

/** Slots fill each place from the bottom row upward. */
export function tokenSlots(capacity?: number): readonly Pt[] {
  return TOKEN_SLOT_LAYOUTS[placeLevel(capacity)];
}
