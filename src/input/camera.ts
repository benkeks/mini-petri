import { BUILD_RANGE, CONNECTION_RANGE } from "../game/game";
import type { Pt } from "../render/geometry";

export interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Screen-space transform bounded by the current live net. */
export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  private minScale = 1;
  private maxScale = 1;
  private bounds: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private scroll?: { from: Pt; to: Pt; elapsed: number; duration: number };
  viewport: Viewport = { x: 0, y: 0, width: 1, height: 1 };

  layout(viewport: Viewport, world: { width: number; height: number }, reset: boolean, ultraWide = false): void {
    if (reset) this.scroll = undefined;
    const previousCenter = this.toWorld({
      x: this.viewport.x + this.viewport.width / 2,
      y: this.viewport.y + this.viewport.height / 2,
    });
    this.viewport = viewport;
    this.maxScale = (ultraWide ? viewport.width : Math.min(viewport.width, viewport.height)) / (2 * CONNECTION_RANGE);
    this.minScale = Math.min(this.maxScale, 0.96 * Math.min(viewport.width / world.width, viewport.height / world.height));
    this.scale = reset ? this.minScale : clamp(this.scale, this.minScale, this.maxScale);
    const center = reset ? { x: world.width / 2, y: world.height / 2 } : previousCenter;
    this.x = viewport.x + viewport.width / 2 - center.x * this.scale;
    this.y = viewport.y + viewport.height / 2 - center.y * this.scale;
    this.clamp();
  }

  setNodes(nodes: readonly (Pt & { range?: number })[], world: { width: number; height: number }): void {
    if (nodes.length === 0) {
      this.bounds = { minX: 0, minY: 0, maxX: world.width, maxY: world.height };
    } else {
      this.bounds = {
        minX: Math.min(...nodes.map((n) => n.x - (n.range ?? BUILD_RANGE))),
        minY: Math.min(...nodes.map((n) => n.y - (n.range ?? BUILD_RANGE))),
        maxX: Math.max(...nodes.map((n) => n.x + (n.range ?? BUILD_RANGE))),
        maxY: Math.max(...nodes.map((n) => n.y + (n.range ?? BUILD_RANGE))),
      };
    }
    this.clamp();
  }

  toWorld(point: Pt): Pt {
    return { x: (point.x - this.x) / this.scale, y: (point.y - this.y) / this.scale };
  }

  pan(dx: number, dy: number): void {
    this.scroll = undefined;
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  focus(center: Pt, duration = 0): void {
    const v = this.viewport;
    this.scroll = duration > 0 ? {
      from: this.toWorld({ x: v.x + v.width / 2, y: v.y + v.height / 2 }),
      to: { x: clamp(center.x, this.bounds.minX, this.bounds.maxX), y: clamp(center.y, this.bounds.minY, this.bounds.maxY) },
      elapsed: 0,
      duration,
    } : undefined;
    if (!this.scroll) this.centerOn(center);
  }

  /** Advance focus scrolling on the real clock, including while gameplay is paused or over. */
  update(dt: number): void {
    const scroll = this.scroll;
    if (!scroll) return;
    scroll.elapsed = Math.min(scroll.duration, scroll.elapsed + dt);
    const ease = 1 - (1 - scroll.elapsed / scroll.duration) ** 3;
    this.centerOn({
      x: scroll.from.x + (scroll.to.x - scroll.from.x) * ease,
      y: scroll.from.y + (scroll.to.y - scroll.from.y) * ease,
    });
    if (scroll.elapsed === scroll.duration) this.scroll = undefined;
  }

  private centerOn(center: Pt): void {
    const v = this.viewport;
    this.x = v.x + v.width / 2 - center.x * this.scale;
    this.y = v.y + v.height / 2 - center.y * this.scale;
    this.clamp();
  }

  /** Zoom around a screen point, optionally moving that point as with a pinch. */
  zoom(factor: number, from: Pt, to = from): void {
    this.scroll = undefined;
    const anchor = this.toWorld(from);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    this.x = to.x - anchor.x * this.scale;
    this.y = to.y - anchor.y * this.scale;
    this.clamp();
  }

  /** Reveal the connection circle, centering axes on which it cannot fit. */
  showConnection(center: Pt, range = CONNECTION_RANGE): void {
    const v = this.viewport;
    const radius = range * this.scale;
    const rx = Math.min(radius, v.width / 2);
    const ry = Math.min(radius, v.height / 2);
    const x = center.x * this.scale + this.x;
    const y = center.y * this.scale + this.y;
    const dx = x - rx < v.x ? v.x - (x - rx) : x + rx > v.x + v.width ? v.x + v.width - (x + rx) : 0;
    const dy = y - ry < v.y ? v.y - (y - ry) : y + ry > v.y + v.height ? v.y + v.height - (y + ry) : 0;
    this.pan(dx, dy);
  }

  private clamp(): void {
    const v = this.viewport;
    const center = this.toWorld({ x: v.x + v.width / 2, y: v.y + v.height / 2 });
    const x = clamp(center.x, this.bounds.minX, this.bounds.maxX);
    const y = clamp(center.y, this.bounds.minY, this.bounds.maxY);
    this.x = v.x + v.width / 2 - x * this.scale;
    this.y = v.y + v.height / 2 - y * this.scale;
  }
}
