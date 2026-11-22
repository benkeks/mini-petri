import type { Level } from "./level";

export const level1: Level = {
  name: "Level 1 — First Junction",
  width: 1200,
  height: 800,
  goals: [
    { sinkId: "sinkY", color: "yellow", count: 10 },
    { sinkId: "sinkG", color: "green", count: 8 },
    { sinkId: "sinkB", color: "blue", count: 6 },
  ],
  ramp: { every: 20, factor: 0.9, min: 1.2 },
  net: {
    places: [
      { id: "pR", x: 300, y: 220, marking: ["red", "red"] },
      { id: "pB", x: 300, y: 580, marking: ["blue", "blue"] },
      { id: "pY", x: 750, y: 140, marking: [] },
      { id: "pG", x: 750, y: 400, marking: [] },
      { id: "pB2", x: 750, y: 660, marking: [] },
    ],
    transitions: [
      { id: "srcR", x: 110, y: 220, kind: "source", label: "red", autoInterval: 3.5 },
      { id: "srcB", x: 110, y: 580, kind: "source", label: "blue", autoInterval: 4 },
      { id: "tSplit", x: 520, y: 140, kind: "normal", label: "split" },
      { id: "tMix", x: 520, y: 400, kind: "normal", label: "mix" },
      { id: "tShip", x: 520, y: 660, kind: "normal", label: "ship" },
      { id: "sinkY", x: 1020, y: 140, kind: "sink", autoInterval: 0.3 },
      { id: "sinkG", x: 1020, y: 400, kind: "sink", autoInterval: 0.3 },
      { id: "sinkB", x: 1020, y: 660, kind: "sink", autoInterval: 0.3 },
    ],
    arcs: [
      { id: "a1", from: "srcR", to: "pR", color: "red" },
      { id: "a2", from: "srcB", to: "pB", color: "blue" },
      { id: "a3", from: "pR", to: "tSplit", color: "red" },
      { id: "a4", from: "tSplit", to: "pY", color: "yellow", count: 2 },
      { id: "a5", from: "pR", to: "tMix", color: "red" },
      { id: "a6", from: "pB", to: "tMix", color: "blue" },
      { id: "a7", from: "tMix", to: "pG", color: "green" },
      // Black arcs move tokens of any color.
      { id: "a8", from: "pB", to: "tShip" },
      { id: "a9", from: "tShip", to: "pB2" },
      { id: "a10", from: "pY", to: "sinkY", color: "yellow", count: 2 },
      { id: "a11", from: "pG", to: "sinkG", color: "green" },
      { id: "a12", from: "pB2", to: "sinkB" },
    ],
  },
};
