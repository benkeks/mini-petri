import { Application, Rectangle } from "pixi.js";
import { Game } from "./game/game";
import { levels } from "./game/levels";
import { Controller } from "./input/controller";
import { Hud } from "./render/hud";
import { NetView } from "./render/netView";
import { THEME } from "./render/style";

const STEP = 1 / 60;

/** Level from the URL hash (`#2` is the second level), defaulting to the first. */
function levelFromHash(): number {
  const n = Number.parseInt(location.hash.slice(1), 10);
  return Number.isInteger(n) && n >= 1 && n <= levels.length ? n - 1 : 0;
}

async function main(): Promise<void> {
  const app = new Application();
  await app.init({
    background: THEME.background,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.getElementById("app")!.appendChild(app.canvas);

  let levelIndex = levelFromHash();
  let game = new Game(levels[levelIndex]);
  let view = createView();
  const controller = new Controller(game, view);
  const hud = new Hud(game, levelIndex, levels.length, controller, {
    restart: () => load(levelIndex),
    selectLevel: (i) => {
      if (i === levelIndex) load(i);
      else location.hash = `#${i + 1}`;
    },
    selectBrush: (b) => controller.setBrush(b),
  });
  app.stage.addChild(view.root, hud.root);

  /** The net view; taps anywhere on the world (outside the HUD) go to the controller. */
  function createView(): NetView {
    const v = new NetView(game);
    v.root.eventMode = "static";
    v.root.hitArea = new Rectangle(-1e5, -1e5, 2e5, 2e5);
    v.root.on("pointerdown", (e) => controller.tap(v.root.toLocal(e.global)));
    v.root.on("pointermove", (e) => controller.move(v.root.toLocal(e.global)));
    return v;
  }

  function rebuildView(): void {
    view.root.destroy({ children: true });
    view = createView();
    app.stage.addChildAt(view.root, 0);
    controller.attach(game, view);
  }

  function load(index: number): void {
    levelIndex = index;
    game = new Game(levels[index]);
    rebuildView();
    hud.setGame(game, index);
    layout();
  }

  function layout(): void {
    const w = app.screen.width;
    const h = app.screen.height;
    const portrait = h > w * 1.1;
    if (portrait !== game.portrait) {
      game.setPortrait(portrait);
      rebuildView();
    }
    const { width: lw, height: lh } = game.size;
    const { top, bottom } = hud.layout(w, h);
    const availH = h - top - bottom;
    const scale = Math.min(w / lw, availH / lh) * 0.96;
    view.root.scale.set(scale);
    view.root.position.set((w - lw * scale) / 2, top + (availH - lh * scale) / 2);
  }

  app.renderer.on("resize", layout);
  window.addEventListener("hashchange", () => load(levelFromHash()));
  layout();

  let acc = 0;
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    acc += dt;
    while (acc >= STEP) {
      game.step(STEP);
      acc -= STEP;
    }
    controller.sync();
    view.update();
    hud.update(dt);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "r") load(levelIndex);
    if (e.key === "Escape") controller.cancel();
  });
}

void main();
