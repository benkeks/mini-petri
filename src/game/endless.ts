import type { Level } from "./level";
import { relay } from "./level2";

/** The starter route requires the player to fire the relay. */
export const endless: Level = {
  name: "Endless",
  mode: "endless",
  width: 1200,
  height: 800,
  goals: [{ sinkId: "starterSink", color: "blue", count: 5 }],
  ramp: { every: Infinity, factor: 1, min: 1 },
  tools: { place: true, kits: [relay], remove: true, auto: true, capacity: true },
  net: {
    places: [
      { id: "starterPlace", x: 400, y: 400, capacity: 19, marking: [], indestructible: true },
      { id: "starterDestination", x: 800, y: 400, capacity: 7, marking: [] },
    ],
    transitions: [
      { id: "starterSource", x: 200, y: 400, kind: "source", autoInterval: 3 },
      { id: "starterRelay", x: 600, y: 400, kind: "normal" },
      { id: "starterSink", x: 1000, y: 400, kind: "sink", autoInterval: 0.6 },
    ],
    arcs: [
      { id: "starterOutput", from: "starterSource", to: "starterPlace", color: "blue" },
      { id: "starterRelayInput", from: "starterPlace", to: "starterRelay" },
      { id: "starterRelayOutput", from: "starterRelay", to: "starterDestination" },
      { id: "starterInput", from: "starterDestination", to: "starterSink", color: "blue" },
    ],
  },
};
