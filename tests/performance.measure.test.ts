import { it } from "vitest";
import { Game } from "../src/game/game";
import { level2 } from "../src/game/level2";
import { POWERUPS } from "../src/game/powerups";
import { Saves } from "../src/game/saves";
import type { NetSpec } from "../src/core/net";
import { NetView } from "../src/render/netView";

it.runIf(import.meta.env.MODE === "benchmark")("measures dense-net CPU work", () => {
  const net: NetSpec = { places: [], transitions: [], arcs: [] };
  for (let i = 0; i < 120; i++) {
    const x = (i % 12) * 800, y = Math.floor(i / 12) * 240;
    net.places.push(
      { id: `p${i}`, x: x + 200, y: y + 120, capacity: 19, marking: Array(6).fill("blue") },
      { id: `q${i}`, x: x + 600, y: y + 120, capacity: 19, marking: [] },
    );
    net.transitions.push(
      { id: `s${i}`, x: x + 50, y: y + 120, kind: "source" },
      { id: `t${i}`, x: x + 400, y: y + 150, kind: "normal" },
    );
    net.arcs.push(
      { id: `sout${i}`, from: `s${i}`, to: `p${i}`, color: "blue", count: 3 },
      { id: `in${i}`, from: `p${i}`, to: `t${i}`, color: "blue", count: 3 },
      { id: `out${i}`, from: `t${i}`, to: `q${i}`, color: "red", count: 3 },
    );
  }
  const game = new Game({ ...level2, goals: [], net }, () => 0);
  for (let i = 0; i < 120; i++) {
    game.sim.fire(`s${i}`);
    game.sim.fire(`t${i}`);
  }
  const view = new NetView(game);
  const viewport = { x: 0, y: 0, width: 9600, height: 2400 };
  view.root.scale.set(0.15);
  view.update(0, viewport);
  const measure = (name: string, count: number, fn: () => void) => {
    for (let i = 0; i < 3; i++) fn();
    const samples: number[] = [];
    for (let sample = 0; sample < 7; sample++) {
      const start = performance.now();
      for (let i = 0; i < count; i++) fn();
      samples.push((performance.now() - start) / count);
    }
    samples.sort((a, b) => a - b);
    console.log(`PERF ${name}: ${samples[3].toFixed(3)} ms median (${samples[0].toFixed(3)}–${samples[6].toFixed(3)})`);
  };
  let index = 0;
  measure("pick", 300, () => {
    index++;
    view.pick({ x: (index * 137) % 9600, y: (index * 71) % 2400 });
  });
  const frame = () => {
    game.sim.time += 1 / 60;
    for (const token of game.sim.inFlight) token.progress = (token.progress + 0.01) % 1;
    view.update(1 / 60, viewport);
  };
  measure("frame-all", 20, frame);
  for (let i = 0; i < 12; i++) game.offers.set(`r${i}`, {
    id: `r${i}`, x: i * 600, y: 200, expiresAt: game.sim.time + 120, choices: [POWERUPS[0], POWERUPS[2]],
  });
  game.offerVersion++;
  view.overlay.pointer = { x: 300, y: 170 };
  measure("frame-rewards-pointer", 20, frame);
  view.overlay = {};
  measure("frame-small-viewport", 20, () => {
    game.sim.time += 1 / 60;
    view.update(1 / 60, { x: 0, y: 0, width: 1800, height: 700 });
  });
  measure("enable-and-occupancy-all", 20, () => {
    for (const transition of game.sim.net.transitions.values()) game.sim.isEnabled(transition.id);
    for (const place of game.sim.net.places.values()) game.sim.occupancy(place.id);
  });
  measure("static-rebuild", 3, () => {
    game.sim.net.version++;
    view.update(0, viewport);
  });
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() { return data.size; },
    clear: () => data.clear(), getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null, removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); },
  };
  const saves = new Saves(storage);
  for (let i = 0; i < 20; i++) saves.save(`session${i}`, game);
  measure("save-with-20-sessions", 3, () => saves.save("session0", game));
  view.root.destroy({ children: true });
}, 30000);
