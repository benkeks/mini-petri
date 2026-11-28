import { Application, Rectangle } from "pixi.js";
import { endless } from "./game/endless";
import { buildRange, Game } from "./game/game";
import { olderVersion, Saves } from "./game/saves";
import { Camera } from "./input/camera";
import { Controller } from "./input/controller";
import { Navigation } from "./input/navigation";
import { AboutScreen } from "./render/about";
import { isUltraWide, type Pt } from "./render/geometry";
import { Hud } from "./render/hud";
import { NetView } from "./render/netView";
import { StatisticsScreen } from "./render/statistics";
import { SessionPicker } from "./render/sessions";
import { THEME } from "./render/style";
import "./render/statistics.css";

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

  let game = new Game(endless, Math.random, { survival: true });
  let saves: Saves | undefined;
  let sessionId: string | undefined;
  const camera = new Camera();
  const navigation = new Navigation(camera);
  let boundsVersion = -1;
  let boundsOfferVersion = -1;
  let view = createView();
  const controller = new Controller(game, view);
  let pausedBeforeStatistics = false;
  const statistics = new StatisticsScreen(() => {
    if (!game.complete) game.paused = pausedBeforeStatistics;
  });
  let pausedBeforeAbout = false;
  const about = new AboutScreen(() => {
    if (!game.complete) game.paused = pausedBeforeAbout;
  });
  const smartphone = /iPhone|iPod|Android.*Mobile/i.test(navigator.userAgent)
    || (navigator.maxTouchPoints > 0 && window.matchMedia("(pointer: coarse)").matches
      && Math.min(window.screen.width, window.screen.height) <= 600);
  const hud = new Hud(game, controller, {
    showStatistics: () => showStatistics(),
    showAbout: () => showAbout(),
    toggleFullscreen: smartphone ? () => { void toggleFullscreen(); } : undefined,
    restart: (save) => restart(save),
    requestRestart: () => requestRestart(),
    togglePause: () => {
      if (game.complete) return;
      game.paused = !game.paused;
      hud.setPaused(game.paused);
      navigation.cancel();
      controller.cancelPress();
    },
    selectBrush: (b) => controller.setBrush(b),
    focusSink: (sinkId) => {
      const sink = game.endangeredSinks().find((sink) => sink.sinkId === sinkId);
      if (!sink || game.complete) return;
      navigation.cancel();
      updateBounds();
      camera.focus(sink, 0.3);
    },
  });
  const updateFullscreen = () => hud.setFullscreenActive(Boolean(document.fullscreenElement));
  document.addEventListener("fullscreenchange", updateFullscreen);
  updateFullscreen();
  app.stage.addChild(view.root, hud.root);
  listenForGameOver();

  async function toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    } catch (error) {
      console.error("Unable to toggle fullscreen", error);
      hud.showNotice("Fullscreen is unavailable. Try your browser's fullscreen mode.");
    }
  }

  function listenForGameOver(): void {
    const observed = game;
    observed.onLifeLost((position) => {
      if (game !== observed || observed.lives !== 0) return;
      navigation.cancel();
      updateBounds();
      camera.focus(position, 0.65);
    });
  }

  function createView(): NetView {
    const v = new NetView(game);
    v.rewardTarget = (choice) => camera.toWorld(hud.rewardTarget(choice));
    return v;
  }

  function rebuildView(): void {
    navigation.cancel();
    view.root.destroy({ children: true });
    view = createView();
    app.stage.addChildAt(view.root, 0);
    controller.attach(game, view);
  }

  function installGame(next: Game): void {
    statistics.close();
    about.close();
    game = next;
    listenForGameOver();
    rebuildView();
    hud.setGame(game);
    boundsVersion = -1;
    boundsOfferVersion = -1;
    layout(true);
  }

  function storageError(message: string, error: unknown): void {
    console.error(message, error);
    hud.showNotice(message);
  }

  function restart(save = false): boolean {
    if (save && (!saves || !sessionId)) {
      storageError("Could not save: browser storage is unavailable.", new Error("Storage unavailable"));
      return false;
    }
    let nextId: string | undefined;
    try {
      nextId = saves?.newId();
      if (saves && sessionId) {
        if (save) saves.save(sessionId, game, captureThumbnail());
        else saves.remove(sessionId);
      }
    } catch (error) {
      storageError("Could not save or restart the session.", error);
      return false;
    }
    sessionId = nextId;
    installGame(new Game(endless, Math.random, { survival: true }));
    return true;
  }

  function loadSession(id: string): boolean {
    const previous = game;
    try {
      if (!saves) throw new Error("Storage unavailable");
      const restored = saves.load(id);
      installGame(restored);
      sessionId = id;
      return true;
    } catch (error) {
      if (game !== previous) installGame(previous);
      storageError("Could not load saved session.", error);
      return false;
    }
  }

  const sessions = new SessionPicker(
    (id) => loadSession(id),
    (id) => {
      try {
        if (!saves) throw new Error("Storage unavailable");
        saves.remove(id);
        return saves.list();
      } catch (error) {
        storageError("Could not delete saved session.", error);
        return undefined;
      }
    },
    () => {
      try {
        sessionId = saves?.newId();
      } catch (error) {
        storageError("Could not create a saved session.", error);
      }
      game.paused = false;
    },
  );

  function saveSession(): void {
    if (!saves || !sessionId || sessions.open) return;
    try {
      saves.save(sessionId, game, captureThumbnail());
    } catch (error) {
      storageError("Could not save the session.", error);
    }
  }

  function captureThumbnail(): string {
    const viewport = camera.viewport;
    const world = camera.toWorld(viewport);
    const hudVisible = hud.root.visible;
    try {
      hud.root.visible = false;
      return view.capture({
        ...world, width: viewport.width / camera.scale, height: viewport.height / camera.scale,
      }, () => {
        const image = app.renderer.extract.canvas({
          target: app.stage,
          frame: new Rectangle(viewport.x, viewport.y, viewport.width, viewport.height),
          resolution: 128 / Math.max(viewport.width, viewport.height),
          clearColor: THEME.background,
          antialias: true,
        });
        if (!(image instanceof HTMLCanvasElement)
          && !(typeof OffscreenCanvas !== "undefined" && image instanceof OffscreenCanvas)) {
          throw new Error("Unsupported save thumbnail canvas");
        }
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 128;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not create save thumbnail canvas");
        context.fillStyle = `#${THEME.background.toString(16).padStart(6, "0")}`;
        context.fillRect(0, 0, 128, 128);
        context.drawImage(image, (128 - image.width) / 2, (128 - image.height) / 2);
        return canvas.toDataURL("image/png");
      });
    } finally {
      hud.root.visible = hudVisible;
    }
  }

  function initializeSessions(): void {
    try {
      saves = new Saves(window.localStorage);
      const saved = saves.list();
      if (saved.length === 0) sessionId = saves.newId();
      else if (saved.length === 1 && !saved[0].damaged && saved[0].version && !olderVersion(saved[0].version)
        && loadSession(saved[0].id)) return;
      else {
        game.paused = true;
        sessions.show(saved, saved.length === 1 && !saved[0].damaged && !olderVersion(saved[0].version ?? "")
          ? "Could not load this session. It may be incompatible or damaged." : "");
      }
    } catch (error) {
      saves = undefined;
      storageError("Browser storage is unavailable; this game will not be saved.", error);
    }
  }

  function showStatistics(): void {
    if (statistics.open || about.open) return;
    pausedBeforeStatistics = game.paused;
    game.paused = true;
    navigation.cancel();
    controller.cancelPress();
    controller.move();
    hud.closeMenu();
    statistics.show(game);
  }

  function showAbout(): void {
    if (about.open || statistics.open) return;
    pausedBeforeAbout = game.paused;
    game.paused = true;
    navigation.cancel();
    controller.cancelPress();
    controller.move();
    hud.closeMenu();
    about.show();
  }

  function requestRestart(): void {
    navigation.cancel();
    controller.cancelPress();
    controller.move();
    mousePosition = undefined;
    hud.showRestartConfirmation();
  }

  function updateBounds(): void {
    if (boundsVersion === game.sim.net.version && boundsOfferVersion === game.offerVersion) return;
    boundsVersion = game.sim.net.version;
    boundsOfferVersion = game.offerVersion;
    camera.setNodes([...game.sim.net.liveNodes().map((node) => ({ ...node, range: buildRange(node) })),
      ...game.offers.values()], game.size);
  }

  function applyCamera(): void {
    view.root.scale.set(camera.scale);
    view.root.position.set(camera.x, camera.y);
  }

  let cameraScreen = { width: 0, height: 0 };

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
    updateBounds();
    if (reset || w !== cameraScreen.width || h !== cameraScreen.height) {
      camera.layout(viewport, game.size, reset, isUltraWide(w, h));
      cameraScreen = { width: w, height: h };
    } else {
      camera.viewport = viewport;
    }
    applyCamera();
  }

  app.renderer.on("resize", () => layout());
  layout(true);
  initializeSessions();
  window.setInterval(saveSession, 60_000);
  window.addEventListener("pagehide", saveSession);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveSession(); });

  const screenPoint = (event: MouseEvent): Pt => {
    const rect = app.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * app.screen.width / rect.width,
      y: (event.clientY - rect.top) * app.screen.height / rect.height,
    };
  };
  const inViewport = (p: Pt) => {
    return p.x >= 0 && p.x <= app.screen.width && p.y >= 0 && p.y <= app.screen.height && !hud.blocks(p);
  };
  const updatePointer = (p: Pt) => controller.move(camera.toWorld(p));
  let mousePosition: Pt | undefined;
  const modalPointers = new Set<number>();
  const worldPointers = new Set<number>();
  let editingPointer: number | undefined;

  app.canvas.addEventListener("pointerdown", (event) => {
    if (hud.confirming) {
      modalPointers.add(event.pointerId);
      return;
    }
    if (game.complete || event.button !== 0) return;
    const p = screenPoint(event);
    if (!inViewport(p)) return;
    if (event.pointerType !== "mouse") mousePosition = undefined;
    const pick = view.pick(camera.toWorld(p));
    const brush = controller.brush.kind;
    const touch = event.pointerType === "touch" ? { screen: p, time: event.timeStamp } : undefined;
    const editing = worldPointers.size === 0 && controller.press(camera.toWorld(p), touch);
    worldPointers.add(event.pointerId);
    if (worldPointers.size > 1) {
      controller.cancelPress();
      editingPointer = undefined;
    } else {
      editingPointer = editing ? event.pointerId : undefined;
      camera.pan(0, 0);
    }
    navigation.down(event.pointerId, p, !editing && pick.kind === "empty" && brush !== "kit", editing);
    app.canvas.setPointerCapture(event.pointerId);
    updatePointer(p);
    event.preventDefault();
  });
  app.canvas.addEventListener("pointermove", (event) => {
    if (game.complete || hud.confirming) return;
    const p = screenPoint(event);
    navigation.move(event.pointerId, p);
    applyCamera();
    if (event.pointerType === "mouse") mousePosition = p;
    if (inViewport(p)) updatePointer(p);
    else controller.move();
  });
  app.canvas.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse") mousePosition = undefined;
    controller.move();
  });
  app.canvas.addEventListener("pointerup", (event) => {
    worldPointers.delete(event.pointerId);
    const editing = editingPointer === event.pointerId;
    if (editing) editingPointer = undefined;
    if (modalPointers.delete(event.pointerId) || game.complete || hud.confirming) {
      navigation.cancel(event.pointerId);
      controller.cancelPress();
      return;
    }
    const p = screenPoint(event);
    const tap = navigation.up(event.pointerId, p);
    if (tap && inViewport(tap)) {
      const touch = event.pointerType === "touch" ? { screen: tap, time: event.timeStamp } : undefined;
      const chain = event.pointerType === "mouse" && event.shiftKey;
      if (editing) controller.release(camera.toWorld(tap), touch, chain);
      else controller.tap(camera.toWorld(tap), touch, chain);
      updateBounds();
      updatePointer(tap);
    } else {
      controller.cancelPress();
      controller.move();
    }
    if (event.pointerType === "touch") controller.move();
    applyCamera();
  });
  app.canvas.addEventListener("pointercancel", (event) => {
    worldPointers.delete(event.pointerId);
    if (editingPointer === event.pointerId) editingPointer = undefined;
    controller.cancelPress();
    controller.move();
    modalPointers.delete(event.pointerId);
    navigation.cancel(event.pointerId);
  });
  app.canvas.addEventListener("lostpointercapture", (event) => {
    worldPointers.delete(event.pointerId);
    if (editingPointer === event.pointerId) {
      editingPointer = undefined;
      controller.cancelPress();
      controller.move();
    }
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
    }
    camera.update(dt);
    applyCamera();
    if (mousePosition && inViewport(mousePosition)) {
      const world = camera.toWorld(mousePosition);
      controller.move(world);
      const pick = view.pick(world);
      app.canvas.style.cursor = controller.interactive(pick) ? "pointer"
        : pick.kind === "empty" && controller.brush.kind !== "kit" ? "grab" : "default";
    }
    controller.sync(dt);
    if (hud.update(dt, (point) => ({ x: point.x * camera.scale + camera.x, y: point.y * camera.scale + camera.y }))) layout();
    const topLeft = camera.toWorld({ x: 0, y: 0 });
    view.update(ticker.elapsedMS / 1000, {
      ...topLeft,
      width: app.screen.width / camera.scale,
      height: app.screen.height / camera.scale,
    });
  });

  window.addEventListener("keydown", (e) => {
    if (sessions.open) return;
    if (about.open) {
      if (e.key === "Escape") about.close();
      return;
    }
    if (statistics.open) {
      if (e.key === "Escape") statistics.close();
      return;
    }
    if (hud.confirming) {
      if (e.key === "Escape") hud.cancelRestart();
      else if (e.key === "Enter" && !e.repeat) hud.confirmRestart();
      return;
    }
    if (hud.manuallyPaused && e.key === "Escape") {
      game.paused = false;
      hud.setPaused(false);
      return;
    }
    if (e.key.toLowerCase() === "r" && !e.repeat) requestRestart();
    if (e.key === "Escape" && !hud.closeMenu()) controller.cancel();
  });
}

void main();
