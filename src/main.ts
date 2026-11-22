import { Application } from "pixi.js";
import { Game } from "./game/game";
import { level1 } from "./game/level1";
import { Hud } from "./render/hud";
import { NetView } from "./render/netView";
import { THEME } from "./render/style";

const STEP = 1 / 60;

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

  let game = new Game(level1);
  let view = new NetView(game);
  const hud = new Hud(game, restart);
  app.stage.addChild(view.root, hud.root);

  function rebuildView(): void {
    view.root.destroy({ children: true });
    view = new NetView(game);
    app.stage.addChildAt(view.root, 0);
  }

  function restart(): void {
    game = new Game(level1);
    rebuildView();
    hud.setGame(game);
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
    const top = hud.layout(w, h);
    const availH = h - top - 30;
    const scale = Math.min(w / lw, availH / lh) * 0.96;
    view.root.scale.set(scale);
    view.root.position.set((w - lw * scale) / 2, top + (availH - lh * scale) / 2);
  }

  app.renderer.on("resize", layout);
  layout();

  let acc = 0;
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    acc += dt;
    while (acc >= STEP) {
      game.step(STEP);
      acc -= STEP;
    }
    view.update();
    hud.update(dt);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "r") restart();
  });
}

void main();
