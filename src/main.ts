import { Application, Graphics } from "pixi.js";
import { endless } from "./game/endless";
import { Game } from "./game/game";
import { Camera } from "./input/camera";
import { Controller } from "./input/controller";
import { Navigation } from "./input/navigation";
import type { Pt } from "./render/geometry";
import { Hud } from "./render/hud";
import { NetView } from "./render/netView";
import { THEME } from "./render/style";

const STEP = 1 / 60;

async function main(): Promise<void> {
  await document.fonts.load("600 16px Fredoka");
  const app = new Application();
  await app.init({
    background: THEME.background,
    resizeTo: window,
    antialias: true,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.getElementById("app")!.appendChild(app.canvas);

  let game = new Game(endless);
  const mask = new Graphics();
  const camera = new Camera();
  const navigation = new Navigation(camera);
  let boundsVersion = -1;
  let boundsOfferVersion = -1;
  let view = createView();
  const controller = new Controller(game, view);
  const hud = new Hud(game, controller, {
    restart: () => load(),
    requestRestart: () => requestRestart(),
    togglePause: () => {
      game.paused = !game.paused;
      navigation.cancel();
    },
    selectBrush: (b) => controller.setBrush(b),
  });
  app.stage.addChild(view.root, mask, hud.root);

  function createView(): NetView {
    const v = new NetView(game);
    v.root.mask = mask;
    return v;
  }

  function rebuildView(): void {
    navigation.cancel();
    view.root.destroy({ children: true });
    view = createView();
    app.stage.addChildAt(view.root, 0);
    controller.attach(game, view);
  }

  function load(): void {
    game = new Game(endless);
    rebuildView();
    hud.setGame(game);
    boundsVersion = -1;
    boundsOfferVersion = -1;
    layout(true);
  }

  function requestRestart(): void {
    navigation.cancel();
    hud.showRestartConfirmation();
  }

  function updateBounds(): void {
    if (boundsVersion === game.sim.net.version && boundsOfferVersion === game.offerVersion) return;
    boundsVersion = game.sim.net.version;
    boundsOfferVersion = game.offerVersion;
    camera.setNodes([...game.sim.net.liveNodes(), ...game.offers.values()], game.size);
  }

  function applyCamera(): void {
    view.root.scale.set(camera.scale);
    view.root.position.set(camera.x, camera.y);
  }

  function layout(reset = false): void {
    const w = app.screen.width;
    const h = app.screen.height;
    const portrait = h > w * 1.1;
    if (portrait !== game.portrait) {
      game.setPortrait(portrait);
      rebuildView();
      boundsVersion = -1;
      reset = true;
    }
    const { top, bottom } = hud.layout(w, h);
    const viewport = { x: 0, y: top, width: Math.max(1, w), height: Math.max(1, h - top - bottom) };
    mask.clear().rect(viewport.x, viewport.y, viewport.width, viewport.height).fill(0xffffff);
    updateBounds();
    camera.layout(viewport, game.size, reset);
    applyCamera();
  }

  app.renderer.on("resize", () => layout());
  layout(true);

  const screenPoint = (event: MouseEvent): Pt => {
    const rect = app.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * app.screen.width / rect.width,
      y: (event.clientY - rect.top) * app.screen.height / rect.height,
    };
  };
  const inViewport = (p: Pt) => {
    const v = camera.viewport;
    return p.x >= v.x && p.x <= v.x + v.width && p.y >= v.y && p.y <= v.y + v.height;
  };
  const updatePointer = (p: Pt) => controller.move(camera.toWorld(p));
  const modalPointers = new Set<number>();

  app.canvas.addEventListener("pointerdown", (event) => {
    if (hud.confirming) {
      modalPointers.add(event.pointerId);
      return;
    }
    if (game.complete || event.button !== 0) return;
    const p = screenPoint(event);
    if (!inViewport(p)) return;
    const pick = view.pick(camera.toWorld(p));
    const brush = controller.brush.kind;
    navigation.down(event.pointerId, p, pick.kind === "empty" && brush !== "kit");
    app.canvas.setPointerCapture(event.pointerId);
    updatePointer(p);
    event.preventDefault();
  });
  app.canvas.addEventListener("pointermove", (event) => {
    if (game.complete || hud.confirming) return;
    const p = screenPoint(event);
    navigation.move(event.pointerId, p);
    applyCamera();
    if (inViewport(p)) updatePointer(p);
  });
  app.canvas.addEventListener("pointerup", (event) => {
    if (modalPointers.delete(event.pointerId) || game.complete || hud.confirming) {
      navigation.cancel(event.pointerId);
      return;
    }
    const p = screenPoint(event);
    const tap = navigation.up(event.pointerId, p);
    if (tap && inViewport(tap)) {
      const oldTransition = controller.selected?.tid;
      const oldPlace = controller.selectedPlace;
      controller.tap(camera.toWorld(tap));
      updateBounds();
      const selected = controller.selected;
      const place = controller.selectedPlace;
      if (selected && (selected.tid !== oldTransition || oldPlace)) {
        const transition = game.sim.net.transitions.get(selected.tid);
        if (transition && !transition.ghost && transition.open?.[selected.index]) camera.showConnection(transition);
      } else if (place && (place !== oldPlace || oldTransition)) {
        const node = game.sim.net.places.get(place);
        if (node && !node.ghost) camera.showConnection(node);
      }
      updatePointer(tap);
    }
    applyCamera();
  });
  app.canvas.addEventListener("pointercancel", (event) => {
    modalPointers.delete(event.pointerId);
    navigation.cancel(event.pointerId);
  });
  app.canvas.addEventListener("lostpointercapture", (event) => {
    modalPointers.delete(event.pointerId);
    navigation.cancel(event.pointerId);
  });
  app.canvas.addEventListener("wheel", (event) => {
    if (game.complete || hud.confirming) return;
    const p = screenPoint(event);
    if (!inViewport(p)) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? camera.viewport.height : 1;
    const delta = event.deltaY || event.deltaX;
    camera.zoom(Math.exp(Math.max(-4, Math.min(4, -delta * unit * 0.0015))), p);
    updatePointer(p);
    applyCamera();
  }, { passive: false });

  let acc = 0;
  app.ticker.add((ticker) => {
    const dt = Math.min(ticker.deltaMS / 1000, 0.1);
    acc += dt;
    while (acc >= STEP) {
      game.step(STEP);
      acc -= STEP;
    }
    if (!game.complete) {
      updateBounds();
      applyCamera();
    }
    controller.sync();
    const viewport = camera.viewport;
    const topLeft = camera.toWorld(viewport);
    view.update(ticker.elapsedMS / 1000, {
      ...topLeft,
      width: viewport.width / camera.scale,
      height: viewport.height / camera.scale,
    });
    if (hud.update(dt, (point) => ({ x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y }))) layout();
  });

  window.addEventListener("keydown", (e) => {
    if (hud.confirming) {
      if (e.key === "Escape") hud.cancelRestart();
      else if (e.key === "Enter" && !e.repeat) hud.confirmRestart();
      return;
    }
    if (e.key.toLowerCase() === "r" && !e.repeat) requestRestart();
    if (e.key === "Escape") controller.cancel();
  });
}

void main();
