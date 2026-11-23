import { describe, expect, it } from "vitest";
import { octilinearRoute, outsidePlace, TOKEN_SLOTS } from "../src/render/geometry";
import { placeRadius } from "../src/game/placeSize";
import { TOKEN_RADIUS } from "../src/render/style";

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
    it.each([1, 7, 19])("fits exactly %i token slots inside its place", (capacity) => {
      expect(TOKEN_SLOTS).toHaveLength(19);
      const radius = placeRadius(capacity);
      const slots = TOKEN_SLOTS.slice(0, capacity);
      for (const [i, a] of slots.entries()) {
        expect(Math.hypot(a.x, a.y) + TOKEN_RADIUS).toBeLessThan(radius);
        for (const b of slots.slice(i + 1)) {
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(TOKEN_RADIUS * 2 - 1e-9);
        }
      }
      if (capacity < 19) {
        const next = TOKEN_SLOTS[capacity];
        expect(Math.hypot(next.x, next.y) + TOKEN_RADIUS).toBeGreaterThan(radius);
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
