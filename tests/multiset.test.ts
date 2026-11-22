import { describe, expect, it } from "vitest";
import { addInto, contains, expand, subtractFrom, total } from "../src/core/multiset";

describe("multiset", () => {
  it("adds, subtracts and drops zero entries", () => {
    const m = { red: 1 };
    addInto(m, { red: 2, blue: 1 });
    expect(m).toEqual({ red: 3, blue: 1 });
    subtractFrom(m, { blue: 1, red: 1 });
    expect(m).toEqual({ red: 2 });
    expect(total(m)).toBe(2);
  });

  it("checks containment per color", () => {
    expect(contains({ red: 2, blue: 1 }, { red: 2 })).toBe(true);
    expect(contains({ red: 2 }, { red: 1, blue: 1 })).toBe(false);
    expect(contains({}, {})).toBe(true);
  });

  it("throws on underflow without mutating", () => {
    const m = { red: 1 };
    expect(() => subtractFrom(m, { red: 2 })).toThrow();
    expect(m).toEqual({ red: 1 });
  });

  it("expands in canonical color order", () => {
    expect(expand({ blue: 1, red: 2 })).toEqual(["red", "red", "blue"]);
  });
});
