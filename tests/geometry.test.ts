import { describe, expect, it } from "vitest";
import { octilinearRoute, outsidePlace, tokenSlots } from "../src/render/geometry";
import { placeRadius } from "../src/game/placeSize";
import { STORED_TOKEN_RADIUS } from "../src/render/style";

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

  describe("place capacity layouts", () => {
    it.each([1, 7, 19])("stacks %i outlined boxes inside its place from the bottom", (capacity) => {
      const slots = tokenSlots(capacity);
      expect(slots).toHaveLength(capacity);
      const halfBox = STORED_TOKEN_RADIUS + 1;
      for (const [i, a] of slots.entries()) {
        expect(Math.hypot(Math.abs(a.x) + halfBox, Math.abs(a.y) + halfBox)).toBeLessThan(placeRadius(capacity) - 2.5);
        if (i > 0) expect(a.y).toBeLessThanOrEqual(slots[i - 1].y);
        for (const b of slots.slice(i + 1)) {
          expect(Math.abs(a.x - b.x) >= 2 * halfBox || Math.abs(a.y - b.y) >= 2 * halfBox).toBe(true);
        }
      }
    });

    it("rejects capacities without a matching layout", () => {
      expect(() => placeRadius(4)).toThrow("Unsupported place capacity");
    });

    it("clips bent arcs exactly at the place outline", () => {
      const route = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 100, y: 10 }];
      const [start, end] = outsidePlace(route, placeRadius(7));
      expect(Math.hypot(start.x, start.y)).toBeCloseTo(placeRadius(7));
      expect(start.y).toBe(10);
      expect(end).toEqual(route[2]);
    });
  });
});
