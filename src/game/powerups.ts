import type { Kit } from "./level";

export const BOMB_PRICE = 25;

export type Powerup = (
  | { id: string; label: string; afterEpoch: number; kind: "coins"; amount: number }
  | { id: string; label: string; afterEpoch: number; kind: "capacity" | "auto" | "life" }
  | { id: string; label: string; afterEpoch: number; kind: "kit"; price: number; kit: Kit }
  | { id: string; label: string; afterEpoch: number; kind: "bomb"; price: number }
) & {
  /** Exclusive offer cutoff; existing items and offers remain usable. */
  untilEpoch?: number;
};

export const POWERUPS: readonly Powerup[] = [
  { id: "coins5", label: "5 coins", afterEpoch: 0, kind: "coins", amount: 5 },
  { id: "capacity", label: "Free place\nupgrade", afterEpoch: 10, kind: "capacity" },
  { id: "auto", label: "Free time\nupgrade", afterEpoch: 0, kind: "auto" },
  {
    id: "blueMultiply", label: "Blue 2→3\n7 coins", afterEpoch: 15, kind: "kit", price: 7,
    kit: { id: "blueMultiply", ports: [{ dir: "in", color: "blue", count: 2 }, { dir: "out", color: "blue", count: 3 }] },
  },
  { id: "coins10", label: "10 coins", afterEpoch: 20, untilEpoch: 300, kind: "coins", amount: 10 },
  {
    id: "blueToRed", label: "Blue 2→red\n5 coins", afterEpoch: 25, kind: "kit", price: 5,
    kit: { id: "blueToRed", ports: [{ dir: "in", color: "blue", count: 2 }, { dir: "out", color: "red" }] },
  },
  {
    id: "redToBlue", label: "Red→blue\n5 coins", afterEpoch: 30, kind: "kit", price: 5,
    kit: { id: "redToBlue", ports: [{ dir: "in", color: "red" }, { dir: "out", color: "blue" }] },
  },
  {
    id: "blueToGreen", label: "Blue→green\n10 coins", afterEpoch: 35, kind: "kit", price: 10,
    kit: { id: "blueToGreen", ports: [{ dir: "in", color: "blue" }, { dir: "out", color: "green" }] },
  },
  {
    id: "splitAny", label: "Any 2→3\n20 coins", afterEpoch: 40, kind: "kit", price: 20,
    kit: { id: "splitAny", copyInputColor: true, ports: [{ dir: "in", count: 2 }, { dir: "out", count: 3 }] },
  },
  { id: "life", label: "Extra life", afterEpoch: 50, kind: "life" },
  {
    id: "redToGreen", label: "Red→green\n5 coins", afterEpoch: 60, untilEpoch: 250, kind: "kit", price: 5,
    kit: { id: "redToGreen", ports: [{ dir: "in", color: "red" }, { dir: "out", color: "green" }] },
  },
  {
    id: "redBlueToYellow", label: "Red+blue→yellow\n10 coins", afterEpoch: 90, kind: "kit", price: 10,
    kit: { id: "redBlueToYellow", ports: [{ dir: "in", color: "red" }, { dir: "in", color: "blue" }, { dir: "out", color: "yellow" }] },
  },
  {
    id: "redTwoBlueToYellow", label: "Red+2 blue→2 yellow\n20 coins", afterEpoch: 120, kind: "kit", price: 20,
    kit: { id: "redTwoBlueToYellow", ports: [{ dir: "in", color: "red" }, { dir: "in", color: "blue", count: 2 }, { dir: "out", color: "yellow", count: 2 }] },
  },
  { id: "coins20", label: "20 coins", afterEpoch: 150, kind: "coins", amount: 20 },
  {
    id: "redToBlueGreen", label: "Red→blue+green\n5 coins", afterEpoch: 250, kind: "kit", price: 5,
    kit: { id: "redToBlueGreen", ports: [{ dir: "in", color: "red" }, { dir: "out", color: "blue" }, { dir: "out", color: "green" }] },
  },
  { id: "coins50", label: "50 coins", afterEpoch: 300, kind: "coins", amount: 50 },
  { id: "bomb", label: "Bomb\n25 coins", afterEpoch: 500, kind: "bomb", price: BOMB_PRICE },
];
