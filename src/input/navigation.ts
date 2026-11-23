import type { Pt } from "../render/geometry";
import type { Camera } from "./camera";

const DRAG_THRESHOLD = 6;

interface Pointer {
  start: Pt;
  last: Pt;
  draggable: boolean;
  moved: boolean;
}

const midpoint = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distinguishes taps, background drags and two-pointer pinch gestures. */
export class Navigation {
  private readonly pointers = new Map<number, Pointer>();

  constructor(private readonly camera: Camera) {}

  down(id: number, point: Pt, draggable: boolean): void {
    this.pointers.set(id, { start: point, last: point, draggable, moved: false });
    if (this.pointers.size > 1) for (const pointer of this.pointers.values()) pointer.moved = true;
  }

  move(id: number, point: Pt): void {
    const pointer = this.pointers.get(id);
    if (!pointer) return;
    const others = [...this.pointers.entries()].filter(([other]) => other !== id);
    if (this.pointers.size === 2) {
      const other = others[0][1].last;
      const before = distance(pointer.last, other);
      const after = distance(point, other);
      if (before > 0 && after > 0) this.camera.zoom(after / before, midpoint(pointer.last, other), midpoint(point, other));
    } else if (this.pointers.size === 1) {
      const wasMoved = pointer.moved;
      if (distance(pointer.start, point) > DRAG_THRESHOLD) pointer.moved = true;
      if (pointer.moved && pointer.draggable) {
        const from = wasMoved ? pointer.last : pointer.start;
        this.camera.pan(point.x - from.x, point.y - from.y);
      }
    }
    pointer.last = point;
  }

  up(id: number, point: Pt): Pt | undefined {
    const pointer = this.pointers.get(id);
    if (!pointer) return undefined;
    this.move(id, point);
    this.pointers.delete(id);
    return pointer.moved ? undefined : point;
  }

  cancel(id?: number): void {
    if (id === undefined) this.pointers.clear();
    else this.pointers.delete(id);
  }
}
