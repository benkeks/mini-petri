import type { Kit, Level } from "./level";

const split: Kit = {
  id: "split",
  ports: [
    { dir: "in", color: "red" },
    { dir: "out", color: "yellow", count: 2 },
  ],
};
const mix: Kit = {
  id: "mix",
  ports: [
    { dir: "in", color: "red" },
    { dir: "in", color: "blue" },
    { dir: "out", color: "green" },
  ],
};
const relay: Kit = {
  id: "relay",
  ports: [{ dir: "in" }, { dir: "out" }],
};

/**
 * Demonstrates building: the green sink has no place yet, the first red source runs dry,
 * a second red source waits to be connected, and a drain wastes blue tokens until removed.
 * The blue source is unlimited, so the drain cannot make the level unwinnable.
 */
export const level2: Level = {
  name: "Level 2 — Building Site",
  width: 1200,
  height: 800,
  goals: [
    { sinkId: "sinkY", color: "yellow", count: 6 },
    { sinkId: "sinkG", color: "green", count: 5 },
  ],
  ramp: { every: Infinity, factor: 1, min: 1 },
  tools: { place: true, kits: [split, mix, relay], remove: true, auto: true, faster: true, capacity: true },
  net: {
    places: [
      { id: "pR", x: 280, y: 180, capacity: 4, marking: ["red"] },
      { id: "pY", x: 700, y: 180, marking: [] },
      { id: "pB", x: 280, y: 520, capacity: 4, marking: ["blue"] },
    ],
    transitions: [
      { id: "srcR", x: 100, y: 180, kind: "source", autoInterval: 3, supply: 6 },
      { id: "srcB", x: 100, y: 520, kind: "source", autoInterval: 3 },
      { id: "srcR2", x: 640, y: 700, kind: "source", autoInterval: 3, supply: 10, open: [{ dir: "out", color: "red" }] },
      { id: "tSplit", x: 480, y: 180, kind: "normal" },
      { id: "tDrain", x: 480, y: 620, kind: "normal", autoInterval: 2.5 },
      { id: "sinkY", x: 1000, y: 180, kind: "sink", autoInterval: 0.3 },
      { id: "sinkG", x: 1000, y: 520, kind: "sink", autoInterval: 0.3, open: [{ dir: "in", color: "green" }] },
    ],
    arcs: [
      { id: "a1", from: "srcR", to: "pR", color: "red" },
      { id: "a2", from: "srcB", to: "pB", color: "blue" },
      { id: "a3", from: "pR", to: "tSplit", color: "red" },
      { id: "a4", from: "tSplit", to: "pY", color: "yellow", count: 2 },
      { id: "a5", from: "pY", to: "sinkY", color: "yellow", count: 2 },
      { id: "a6", from: "pB", to: "tDrain", color: "blue" },
    ],
  },
};
