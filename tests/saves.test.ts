import { describe, expect, it, vi } from "vitest";
import { endless } from "../src/game/endless";
import { Game } from "../src/game/game";
import { POWERUPS } from "../src/game/powerups";
import { olderVersion, Saves } from "../src/game/saves";
import { formatSaveDate } from "../src/render/sessions";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}

describe("saved sessions", () => {
  it("formats save dates in local time without ISO T/Z separators and handles invalid dates", () => {
    expect(formatSaveDate(new Date(2025, 0, 2, 3, 4, 5).getTime())).toBe("2025-01-02 03:04:05");
    expect(formatSaveDate(Number.MAX_SAFE_INTEGER)).toBe("Invalid save date.");
    expect(formatSaveDate()).toBe("Save data is damaged.");
  });

  it("names sessions by their local start day and preserves names across saves and reloads", () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const saves = new Saves(storage);
      const start = new Date(2025, 0, 2, 23, 59).getTime();
      vi.setSystemTime(start);
      const first = saves.newId();
      const second = saves.newId();
      expect(first).toBe("2025-01-02::01");
      expect(second).toBe("2025-01-02::02");
      vi.setSystemTime(new Date(2025, 0, 3, 0, 1));
      const thumbnail = "data:image/png;base64,aGVsbG8=";
      saves.save(first, new Game(endless), thumbnail);
      saves.save(second, new Game(endless), thumbnail);
      const reopened = new Saves(storage);
      expect(reopened.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: first, name: first, startedAt: start, thumbnail }),
        expect.objectContaining({ id: second, name: second, startedAt: start, thumbnail }),
      ]));
      reopened.save(first, reopened.load(first), "data:image/png;base64,bmV3");
      expect(reopened.list().find((session) => session.id === first)).toMatchObject({
        name: first, startedAt: start, thumbnail: "data:image/png;base64,bmV3",
      });
      expect(reopened.newId()).toBe("2025-01-03::01");
      vi.setSystemTime(start);
      expect(reopened.newId()).toBe("2025-01-02::03");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps legacy saves loadable without a thumbnail or naming metadata", () => {
    const storage = new MemoryStorage();
    const saves = new Saves(storage);
    saves.save("legacy", new Game(endless));
    const key = "mini-petri:session:legacy";
    const file = JSON.parse(storage.getItem(key)!);
    delete file.name;
    delete file.startedAt;
    storage.setItem(key, JSON.stringify(file));
    const before = saves.list()[0];
    expect(before.name).toMatch(/^\d{4}-\d{2}-\d{2}::01$/);
    expect(before.thumbnail).toBeUndefined();
    saves.save("legacy", saves.load("legacy"));
    expect(saves.list()[0].name).toBe(before.name);
  });

  it("updates old name separators without changing save IDs or reusing their running numbers", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2025, 0, 2, 12));
      const storage = new MemoryStorage();
      const saves = new Saves(storage);
      const id = "2025-01-02-01";
      saves.save(id, new Game(endless));
      const key = "mini-petri:session:" + id;
      const file = JSON.parse(storage.getItem(key)!);
      file.name = id;
      storage.setItem(key, JSON.stringify(file));
      expect(saves.list()[0]).toMatchObject({ id, name: "2025-01-02::01", damaged: false });
      saves.save(id, saves.load(id));
      expect(JSON.parse(storage.getItem(key)!).name).toBe("2025-01-02::01");
      expect(saves.newId()).toBe("2025-01-02::02");
    } finally {
      vi.useRealTimers();
    }
  });

  it("round-trips an active game and continues committed firings without losing tokens", () => {
    const storage = new MemoryStorage();
    const saves = new Saves(storage);
    const game = new Game(endless, () => 0, { survival: true });
    for (const transition of game.sim.net.transitions.values()) transition.autoInterval = undefined;
    game.sim.net.places.get("starterPlace")!.marking = ["blue", "blue"];
    game.sim.net.places.get("starterDestination")!.marking = ["blue"];
    expect(game.sim.fire("starterRelay")).toBe(true);
    expect(game.sim.fire("starterSource")).toBe(true);
    expect(game.sim.fire("starterSink")).toBe(true);
    game.step(0.1);
    game["goalDefinitions"].push({ sinkId: "starterSink", color: "red", count: Infinity });
    const kit = POWERUPS.find((item) => item.id === "blueMultiply")!;
    game.offers.set("test", { id: "test", x: 10, y: 20, expiresAt: 120, choices: [kit, kit] });
    game.setPortrait(true);
    saves.save("first", game);
    const restored = saves.load("first");
    expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(JSON.parse(JSON.stringify(game.snapshot())));
    expect(restored.goals().find((goal) => goal.color === "red")?.count).toBe(Infinity);
    expect(restored.offers.get("test")!.choices[0]).toBe(kit);
    game.step(3);
    restored.step(3);
    expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(JSON.parse(JSON.stringify(game.snapshot())));
    expect(restored.sim.inFlight).toHaveLength(0);
    expect(restored.sim.net.places.get("starterDestination")!.marking).toEqual(["blue"]);
    expect(restored.score).toBe(1);
  });

  it("restores ghosts and their committed tokens after a connection is removed", () => {
    const saves = new Saves(new MemoryStorage());
    const game = new Game(endless);
    for (const transition of game.sim.net.transitions.values()) transition.autoInterval = undefined;
    game.sim.net.places.get("starterPlace")!.marking = ["blue"];
    expect(game.sim.fire("starterRelay")).toBe(true);
    expect(game.remove("starterRelayInput")).toBe(true);
    saves.save("ghost", game);
    const restored = saves.load("ghost");
    game.step(3);
    restored.step(3);
    expect(JSON.parse(JSON.stringify(restored.snapshot()))).toEqual(JSON.parse(JSON.stringify(game.snapshot())));
  });

  it("preserves separate sessions and reports damaged files without hiding other saves", () => {
    const storage = new MemoryStorage();
    const saves = new Saves(storage);
    const game = new Game(endless, Math.random, { survival: true });
    saves.save("one", game);
    game.score = 7;
    saves.save("two", game);
    storage.setItem("mini-petri:session:bad", "{");
    expect(saves.list().map((entry) => entry.id).sort()).toEqual(["bad", "one", "two"]);
    expect(saves.list().find((entry) => entry.id === "bad")?.damaged).toBe(true);
    expect(() => saves.load("bad")).toThrow();
    expect(saves.load("one").score).toBe(0);
    expect(saves.load("two").score).toBe(7);
    saves.remove("one");
    expect(saves.list().map((entry) => entry.id).sort()).toEqual(["bad", "two"]);
  });

  it("fails when an incompatible snapshot cannot be restored", () => {
    const storage = new MemoryStorage();
    const saves = new Saves(storage);
    saves.save("bad", new Game(endless));
    const key = "mini-petri:session:bad";
    const data = JSON.parse(storage.getItem(key)!);
    delete data.state.simulation;
    storage.setItem(key, JSON.stringify(data));
    expect(() => saves.load("bad")).toThrow();
  });

  it("keeps older unsupported formats visible so users can see their version and handle the failure", () => {
    const storage = new MemoryStorage();
    const saves = new Saves(storage);
    saves.save("old", new Game(endless));
    const key = "mini-petri:session:old";
    const data = JSON.parse(storage.getItem(key)!);
    data.version = "0.0.1";
    data.format = 0;
    storage.setItem(key, JSON.stringify(data));
    expect(saves.list()).toMatchObject([{ id: "old", version: "0.0.1", damaged: false }]);
    expect(() => saves.load("old")).toThrow("Unsupported save format");
  });

  it("rejects malformed saved nodes instead of starting a broken game", () => {
    const storage = new MemoryStorage();
    const saves = new Saves(storage);
    saves.save("bad-node", new Game(endless));
    const key = "mini-petri:session:bad-node";
    const data = JSON.parse(storage.getItem(key)!);
    delete data.state.net.places[0].x;
    storage.setItem(key, JSON.stringify(data));
    expect(() => saves.load("bad-node")).toThrow("Invalid saved place");
  });

  it("warns for older major or minor versions, not patch versions", () => {
    expect(olderVersion("1.2.9", "1.3.0")).toBe(true);
    expect(olderVersion("0.9.9", "1.0.0")).toBe(true);
    expect(olderVersion("1.3.0", "1.3.4")).toBe(false);
    expect(olderVersion("2.0.0", "1.3.4")).toBe(false);
  });
});
