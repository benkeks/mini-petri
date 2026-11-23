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
  it("limits zoom so the full connection circle fits and keeps the zoom anchor fixed", () => {
    const c = camera();
    const point = { x: 400, y: 364 };
    const anchor = c.toWorld(point);
    c.zoom(100, point);
    expect(2 * CONNECTION_RANGE * c.scale).toBeLessThanOrEqual(viewport.height);
    expect(c.toWorld(point)).toEqual(anchor);
    c.zoom(0.001, point);
    expect(c.scale).toBeCloseTo(0.64);
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

  it("pans enough to fit a connection circle without moving an already visible circle", () => {
    const c = camera();
    c.zoom(100, { x: 400, y: 364 });
    c.showConnection({ x: 1100, y: 700 });
    const center = { x: 1100 * c.scale + c.x, y: 700 * c.scale + c.y };
    const radius = CONNECTION_RANGE * c.scale;
    expect(center.x - radius).toBeGreaterThanOrEqual(viewport.x);
    expect(center.x + radius).toBeLessThanOrEqual(viewport.x + viewport.width);
    expect(center.y - radius).toBeGreaterThanOrEqual(viewport.y);
    expect(center.y + radius).toBeLessThanOrEqual(viewport.y + viewport.height);
    const position = { x: c.x, y: c.y };
    c.showConnection({ x: 1100, y: 700 });
    expect({ x: c.x, y: c.y }).toEqual(position);
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
