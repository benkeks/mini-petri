import { describe, expect, it } from "vitest";
import { octilinearRoute } from "../src/render/geometry";

const angles = (pts: { x: number; y: number }[]) =>
  pts.slice(1).map((q, i) => (Math.atan2(q.y - pts[i].y, q.x - pts[i].x) * 180) / Math.PI);

describe("octilinearRoute", () => {
  it.each([
    [{ x: 300, y: 220 }, { x: 520, y: 400 }, true],
    [{ x: 0, y: 0 }, { x: 40, y: -300 }, true],
    [{ x: 0, y: 0 }, { x: -300, y: 50 }, false],
  ])("uses only the eight directions and enters the transition along the flow axis", (p, t, flowX) => {
    const pts = octilinearRoute(p, t, flowX);
    expect(pts[0]).toEqual(p);
    expect(pts.at(-1)!.x).toBeCloseTo(t.x);
    expect(pts.at(-1)!.y).toBeCloseTo(t.y);
    for (const a of angles(pts)) expect(Math.abs(a / 45 - Math.round(a / 45))).toBeLessThan(1e-9);
    const last = angles(pts).at(-1)!;
    expect(Math.abs(Math.sin(((flowX ? last : last - 90) * Math.PI) / 180))).toBeLessThan(1e-9);
  });
});
