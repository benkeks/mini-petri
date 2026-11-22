import type { Net } from "../core/net";
import { PLACE_RADIUS } from "./style";

export interface Pt {
  x: number;
  y: number;
}

/** Drawn size of a transition bar. */
export interface BarSize {
  w: number;
  h: number;
}

/** Distance from a node's center to its outline along unit direction (dx, dy). */
function boundaryDistance(net: Net, bar: BarSize, id: string, dx: number, dy: number): number {
  if (net.places.has(id)) return PLACE_RADIUS;
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

export function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Slots for token dots inside a place: center, inner ring of 6, outer ring of 10. */
export const TOKEN_SLOTS: Pt[] = (() => {
  const slots: Pt[] = [{ x: 0, y: 0 }];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
    slots.push({ x: Math.cos(a) * 14, y: Math.sin(a) * 14 });
  }
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    slots.push({ x: Math.cos(a) * 25, y: Math.sin(a) * 25 });
  }
  return slots;
})();
