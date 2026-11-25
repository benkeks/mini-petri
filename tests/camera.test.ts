import { describe, expect, it } from "vitest";
import { BUILD_RANGE, CONNECTION_RANGE } from "../src/game/game";
import { Camera } from "../src/input/camera";
import { Navigation } from "../src/input/navigation";

const world = { width: 1200, height: 800 };
const viewport = { x: 0, y: 64, width: 800, height: 600 };

function camera(): Camera {
  const c = new Camera();
  c.setNodes([{ x: 100, y: 100 }, { x: 1100, y: 700 }], world);
  c.layout(viewport, world, true);
  return c;
}

describe("camera", () => {
  it("centers a requested sink in the HUD-free viewport without changing zoom", () => {
    const c = camera();
    const scale = c.scale;
    const sink = { x: 1100, y: 700 };
    c.focus(sink);
    expect(c.scale).toBe(scale);
    expect(sink.x * c.scale + c.x).toBeCloseTo(viewport.x + viewport.width / 2);
    expect(sink.y * c.scale + c.y).toBeCloseTo(viewport.y + viewport.height / 2);
  });

  it.each([0.3, 0.65])("scrolls continuously to a sink over %s real seconds without changing zoom", (duration) => {
    const c = camera();
    const sink = { x: 1100, y: 700 };
    const center = { x: 400, y: 364 };
    const start = c.toWorld(center);
    const scale = c.scale;
    c.focus(sink, duration);
    expect(c.toWorld(center)).toEqual(start);
    c.update(duration / 3);
    const midway = c.toWorld(center);
    expect(midway.x).toBeGreaterThan(start.x);
    expect(midway.x).toBeLessThan(sink.x);
    expect(midway.y).toBeGreaterThan(start.y);
    expect(midway.y).toBeLessThan(sink.y);
    c.update(duration / 3);
    expect(c.toWorld(center).x).toBeLessThan(sink.x);
    c.update(duration / 3);
    expect(c.toWorld(center).x).toBeCloseTo(sink.x);
    expect(c.toWorld(center).y).toBeCloseTo(sink.y);
    expect(c.scale).toBe(scale);
    const end = { x: c.x, y: c.y };
    c.update(1);
    expect({ x: c.x, y: c.y }).toEqual(end);
  });

  it.each(["pan", "zoom"] as const)("lets manual %s interrupt a camera scroll", (action) => {
    const c = camera();
    c.focus({ x: 1100, y: 700 }, 0.3);
    c.update(0.1);
    if (action === "pan") c.pan(20, 10);
    else c.zoom(1.1, { x: 400, y: 364 });
    const position = { x: c.x, y: c.y };
    c.update(1);
    expect({ x: c.x, y: c.y }).toEqual(position);
  });

  it("retargets from the current camera position and preserves the destination on resize", () => {
    const c = camera();
    c.focus({ x: 1100, y: 700 }, 0.3);
    c.update(0.1);
    const start = c.toWorld({ x: 400, y: 364 });
    c.focus({ x: 100, y: 100 }, 0.65);
    expect(c.toWorld({ x: 400, y: 364 })).toEqual(start);
    c.layout({ x: 0, y: 80, width: 360, height: 600 }, world, false);
    c.update(0.65);
    expect(c.toWorld({ x: 180, y: 380 }).x).toBeCloseTo(100);
    expect(c.toWorld({ x: 180, y: 380 }).y).toBeCloseTo(100);
    c.focus({ x: 1100, y: 700 }, 0.3);
    c.layout(viewport, world, true);
    const reset = { x: c.x, y: c.y };
    c.update(1);
    expect({ x: c.x, y: c.y }).toEqual(reset);
  });

  it("limits zoom so the full connection circle fits and keeps the zoom anchor fixed", () => {
    const c = camera();
    const point = { x: 400, y: 364 };
    const anchor = c.toWorld(point);
    c.zoom(100, point);
    expect(2 * CONNECTION_RANGE * c.scale).toBeLessThanOrEqual(viewport.height);
    expect(c.toWorld(point)).toEqual(anchor);
    c.zoom(0.001, point);
    expect(c.scale).toBeCloseTo(0.16);
  });

  it("allows width-based zoom on ultra-wide phones", () => {
    const c = camera();
    const wide = { x: 0, y: 68, width: 844, height: 180 };
    const anchor = { x: 422, y: 158 };
    c.layout(wide, world, true, true);
    c.zoom(100, anchor);
    expect(c.scale).toBeCloseTo(844 / (2 * CONNECTION_RANGE));
    expect(c.scale).toBeGreaterThan(4 * wide.height / (2 * CONNECTION_RANGE));
    c.layout(viewport, world, false);
    expect(c.scale).toBeCloseTo(viewport.height / (2 * CONNECTION_RANGE));
  });

  it("clamps the camera center to the current live-node bounds plus build range", () => {
    const c = camera();
    const center = { x: 400, y: 364 };
    c.pan(100000, 100000);
    expect(c.toWorld(center).x).toBeCloseTo(100 - BUILD_RANGE);
    expect(c.toWorld(center).y).toBeCloseTo(100 - BUILD_RANGE);
    c.pan(-100000, -100000);
    expect(c.toWorld(center).x).toBeCloseTo(1100 + BUILD_RANGE);
    expect(c.toWorld(center).y).toBeCloseTo(700 + BUILD_RANGE);
    c.setNodes([{ x: 500, y: 400 }], world);
    expect(c.toWorld(center).x).toBeCloseTo(500 + BUILD_RANGE);
    expect(c.toWorld(center).y).toBeCloseTo(400 + BUILD_RANGE);
  });

  it("extends the camera bounds when the net grows beyond its initial frame", () => {
    const c = camera();
    c.setNodes([{ x: -500, y: 100 }, { x: 1800, y: 700 }], world);
    c.pan(-100000, 0);
    expect(c.toWorld({ x: 400, y: 364 }).x).toBeCloseTo(1800 + BUILD_RANGE);
    c.pan(100000, 0);
    expect(c.toWorld({ x: 400, y: 364 }).x).toBeCloseTo(-500 - BUILD_RANGE);
  });

  it("includes expanded place build ranges in the reachable camera bounds", () => {
    const c = camera();
    c.setNodes([{ x: 100, y: 100, range: 308 }, { x: 1100, y: 700, range: 264 }], world);
    c.pan(100000, 100000);
    expect(c.toWorld({ x: 400, y: 364 }).x).toBeCloseTo(-208);
    expect(c.toWorld({ x: 400, y: 364 }).y).toBeCloseTo(-208);
    c.pan(-100000, -100000);
    expect(c.toWorld({ x: 400, y: 364 }).x).toBeCloseTo(1364);
    expect(c.toWorld({ x: 400, y: 364 }).y).toBeCloseTo(964);
  });

  it("preserves the world center on resize and clamps zoom to the new viewport", () => {
    const c = camera();
    c.zoom(100, { x: 400, y: 364 });
    const center = c.toWorld({ x: 400, y: 364 });
    c.layout({ x: 0, y: 80, width: 360, height: 600 }, world, false);
    expect(c.toWorld({ x: 180, y: 380 }).x).toBeCloseTo(center.x);
    expect(c.toWorld({ x: 180, y: 380 }).y).toBeCloseTo(center.y);
    expect(2 * CONNECTION_RANGE * c.scale).toBeLessThanOrEqual(360);
  });
});

describe("navigation", () => {
  it("releases a dragged edit preview without panning, but never commits a pinch", () => {
    const c = camera();
    const nav = new Navigation(c);
    const position = { x: c.x, y: c.y };
    nav.down(1, { x: 400, y: 364 }, false, true);
    nav.move(1, { x: 470, y: 400 });
    expect({ x: c.x, y: c.y }).toEqual(position);
    expect(nav.up(1, { x: 470, y: 400 })).toEqual({ x: 470, y: 400 });
    nav.down(1, { x: 350, y: 364 }, false, true);
    nav.down(2, { x: 450, y: 364 }, false);
    nav.move(2, { x: 500, y: 364 });
    expect(nav.up(2, { x: 500, y: 364 })).toBeUndefined();
    expect(nav.up(1, { x: 350, y: 364 })).toBeUndefined();
  });

  it("distinguishes a tap from an empty-space drag and never drags in placement mode", () => {
    const c = camera();
    const nav = new Navigation(c);
    nav.down(1, { x: 400, y: 364 }, true);
    expect(nav.up(1, { x: 402, y: 365 })).toEqual({ x: 402, y: 365 });
    const x = c.x;
    nav.down(1, { x: 400, y: 364 }, true);
    nav.move(1, { x: 450, y: 364 });
    expect(c.x).toBeCloseTo(x + 50);
    expect(nav.up(1, { x: 450, y: 364 })).toBeUndefined();
    nav.down(1, { x: 400, y: 364 }, false);
    nav.move(1, { x: 450, y: 364 });
    expect(c.x).toBeCloseTo(x + 50);
    expect(nav.up(1, { x: 450, y: 364 })).toBeUndefined();
  });

  it("zooms with two fingers and does not turn a pinch or cancellation into a tap", () => {
    const c = camera();
    const nav = new Navigation(c);
    nav.down(1, { x: 350, y: 364 }, false);
    nav.down(2, { x: 450, y: 364 }, false);
    nav.move(2, { x: 500, y: 364 });
    expect(c.scale).toBeCloseTo(0.96);
    expect(nav.up(2, { x: 500, y: 364 })).toBeUndefined();
    expect(nav.up(1, { x: 350, y: 364 })).toBeUndefined();
    nav.down(3, { x: 400, y: 364 }, true);
    nav.cancel(3);
    expect(nav.up(3, { x: 400, y: 364 })).toBeUndefined();
  });
});
