import { describe, expect, it } from "vitest";
import { Game } from "../src/game/game";
import { level2 } from "../src/game/level2";
import { NetView } from "../src/render/netView";

describe("build area", () => {
  it("fades in and out over 250 ms, including when reversed partway", () => {
    const game = new Game(level2);
    const view = new NetView(game);
    const viewport = { x: -300, y: -300, width: 1800, height: 1400 };
    const background = view.root.children[0];
    view.overlay = { build: { kind: "place" } };
    view.update(0.125, viewport);
    expect(background.visible).toBe(true);
    expect(background.alpha).toBeCloseTo(0.5);
    view.update(0.125, viewport);
    expect(background.alpha).toBe(1);
    view.overlay = {};
    view.update(0.125, viewport);
    expect(background.alpha).toBeCloseTo(0.5);
    view.overlay = { build: { kind: "transition" } };
    view.update(0.125, viewport);
    expect(background.alpha).toBe(1);
    game.complete = true;
    view.update(0.25, viewport);
    expect(background.visible).toBe(false);
    view.root.destroy({ children: true });
  });
});
