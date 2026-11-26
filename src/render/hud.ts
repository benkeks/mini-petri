import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { COLORS, type Color } from "../core/multiset";
import { ENDLESS_RULES, MAX_LIVES, type CoinEvent, type Game } from "../game/game";
import type { Powerup } from "../game/powerups";
import { brushesOf, sameBrush, type Brush, type Controller } from "../input/controller";
import { isUltraWide, type Pt } from "./geometry";
import { THEME, TOKEN_COLORS } from "./style";
import { drawHeart, drawToolIcon } from "./toolIcon";

const TOOL_SIZE = 48;
const TOOL_GAP = 8;
const REMOVE_EXTRA_GAP = 8;
const COIN_ROW = 48;
const COIN_SHAKE_TIME = 0.35;
const RESOURCE_MOTION_TIME = 0.18;
const TOOL_SELECT_TIME = 0.2;
const DELIVERY_JUMP_TIME = 0.4 / 3;
const DELIVERY_BOX_SPACING = 16;
const DELIVERY_COLORS: readonly Color[] = ["blue", "red", "green", "yellow"];
const META_ICON_SIZE = 40;
const WARNING_START = 124;
const WARNING_GAP = 24;
const WARNING_ROW = 44;
/** Room for the hint line above the toolbar. */
const HINT_SPACE = 34;

export interface HudActions {
  toggleFullscreen?(): void;
  showStatistics?(): void;
  restart(): void;
  requestRestart(): void;
  togglePause(): void;
  selectBrush(b: Brush): void;
  focusSink(sinkId: string): void;
}

interface ToolButton {
  brush: Brush;
  root: Container;
  bg: Graphics;
  icon: Graphics;
  badges: Graphics;
  count: Text;
  price: Text;
  baseY: number;
  hovered: boolean;
  selected: boolean;
  selectionAge: number;
}

interface SinkWarning {
  text: Graphics;
  baseY: number;
  remaining: number;
}

const POP_TIME = 0.55;
const MODAL_TIME = 0.16;
const CONFETTI = 36;
const POPUP_OVERSHOOT = 1.14;

function popupFit(width: number, height: number): number {
  return Math.max(0, Math.min(1, (width - 24) / (340 * POPUP_OVERSHOOT), (height - 32) / (180 * POPUP_OVERSHOOT)));
}

/** Keep the card clear of both the current sink position and its camera-scroll destination. */
export function survivalPopupPosition(width: number, height: number, avoid: readonly (Pt & { radius: number })[], previous?: Pt): Pt {
  const center = { x: width / 2, y: height / 2 };
  const fit = popupFit(width, height);
  const halfW = 170 * fit * POPUP_OVERSHOOT;
  const halfH = 90 * fit * POPUP_OVERSHOOT + 4;
  const clampX = (x: number) => Math.max(halfW + 12, Math.min(width - halfW - 12, x));
  const clampY = (y: number) => Math.max(halfH + 12, Math.min(height - halfH - 12, y));
  const clear = (point: Pt) => avoid.every((sink) =>
    Math.abs(point.x - sink.x) >= halfW + sink.radius - 1e-6
    || Math.abs(point.y - sink.y) >= halfH + sink.radius - 1e-6);
  if (previous && previous.x === clampX(previous.x) && previous.y === clampY(previous.y) && clear(previous)) return previous;
  const candidates = [center, ...avoid.flatMap((sink) => [
    { x: center.x, y: clampY(sink.y - sink.radius - halfH) },
    { x: center.x, y: clampY(sink.y + sink.radius + halfH) },
    { x: clampX(sink.x - sink.radius - halfW), y: center.y },
    { x: clampX(sink.x + sink.radius + halfW), y: center.y },
  ])];
  return candidates.filter(clear).sort((a, b) =>
    Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y))[0] ?? center;
}

interface Confetto {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: number;
  r: number;
}

interface CoinFlight {
  event: CoinEvent;
  age: number;
}

interface ResourceMotion {
  direction: "gain" | "loss";
  age: number;
}

/** Back-out easing: overshoots a little before settling at 1. */
function easeOutBack(k: number): number {
  const c = 1.9;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
}

/** Centers each toolbar row, keeping the removal tool close but slightly separated. */
export function toolbarLayout(width: number, brushes: readonly Brush[]): {
  size: number;
  rows: number;
  positions: { x: number; row: number }[];
} {
  const size = Math.max(1, Math.min(TOOL_SIZE, (width - 32) / 2 - TOOL_GAP));
  const available = Math.max(size, width - 16);
  const rows: number[][] = [[]];
  const rowWidth = (row: number[]) => row.length * size + Math.max(0, row.length - 1) * TOOL_GAP
    + (row.length > 1 && brushes[row[row.length - 1]].kind === "remove" ? REMOVE_EXTRA_GAP : 0);
  brushes.forEach((_, index) => {
    let row = rows[rows.length - 1];
    if (row.length && rowWidth([...row, index]) > available) {
      row = [];
      rows.push(row);
    }
    row.push(index);
  });
  const last = rows[rows.length - 1];
  const previous = rows[rows.length - 2];
  if (last.length === 1 && brushes[last[0]].kind === "remove" && previous?.length > 1
    && size * 2 + TOOL_GAP + REMOVE_EXTRA_GAP <= available) last.unshift(previous.pop()!);
  const positions: { x: number; row: number }[] = [];
  rows.forEach((row, rowIndex) => {
    let x = (width - rowWidth(row)) / 2 + size / 2;
    row.forEach((index, i) => {
      if (i > 0) x += size + TOOL_GAP + (brushes[index].kind === "remove" ? REMOVE_EXTRA_GAP : 0);
      positions[index] = { x, row: rowIndex };
    });
  });
  return { size, rows: rows.length, positions };
}

/** Screen-space overlay: time, goal progress, toolbar, hint and the level-won popup. */
export class Hud {
  readonly root = new Container();
  private readonly backplates = new Graphics();
  private regions: Rectangle[] = [];
  private readonly title: Text;
  private readonly stats: Text;
  private readonly deliveryIcons = new Container();
  private readonly deliveryBoxes = new Map<Color, { icon: Graphics; jumpAge?: number }>();
  private readonly scoredColors = new Set<Color>();
  private readonly meta: Text;
  private readonly coins: Text;
  private readonly lives: Text;
  private readonly coinIcon = new Graphics();
  private readonly lifeIcon = new Graphics();
  private readonly warningLayer = new Container();
  private readonly warnings = new Map<string, SinkWarning>();
  private readonly pause: Text;
  private readonly restart: Text;
  private readonly skip: Text;
  private readonly fullscreen?: Text;
  private readonly menuButton = new Graphics();
  private readonly fullscreenIcon = new Graphics();
  private readonly menuDismiss = new Graphics();
  private menuOpen = false;
  private fullscreenActive = false;
  private readonly hint: Text;
  private readonly toolbar = new Container();
  private readonly coinLayer = new Graphics();
  private coinFlights: CoinFlight[] = [];
  private coinBaseX = 0;
  private lifeBaseX = 0;
  private resourceBaseY = 0;
  private coinShakeAge?: number;
  private coinMotion?: ResourceMotion;
  private lifeMotion?: ResourceMotion;
  private readonly heartLayer = new Graphics();
  private heartFlights: { position: Pt; age: number }[] = [];
  private readonly deathFlash = new Graphics();
  private flash?: { color: number; age: number };
  private tools: ToolButton[] = [];
  private toolSize = TOOL_SIZE;
  /** Dims the net and swallows taps while the level-won popup is shown. */
  private readonly shade = new Graphics();
  private readonly popup = new Container();
  private readonly card = new Graphics();
  private readonly heading: Text;
  private readonly detail: Text;
  private readonly statisticsButton = new Container();
  private readonly againButton = new Container();
  private readonly endlessButton = new Container();
  private readonly confettiLayer = new Graphics();
  private readonly confirmationShade = new Graphics();
  private readonly confirmation = new Container();
  private readonly pauseShade = new Graphics();
  private readonly pauseButton = new Container();
  private pauseRequested = false;
  private pauseProgress = 0;
  private confirmationProgress = 0;
  private confirmationFit = 1;
  private wasPaused = false;
  private confirmationKind: "restart" | "endless" = "restart";
  private readonly confirmTitle: Text;
  private readonly confirmDetail: Text;
  private readonly confirmLabel: Text;
  confirming = false;
  private confetti: Confetto[] = [];
  /** Real seconds since the popup appeared, or undefined while it is hidden. */
  private shownFor?: number;
  private resultDismissed = false;
  private width = 0;
  private height = 0;
  private fatalSink?: Pt;
  private popupCenter?: Pt;
  private viewportCenter: Pt = { x: 0, y: 0 };
  private navigationState = "";
  private navigationWidth?: number;
  private navigationHeight = 0;
  private notice?: { text: string; remaining: number };

  constructor(
    private game: Game,
    private readonly controller: Controller,
    private readonly actions: HudActions,
  ) {
    const onRestart = () => actions.requestRestart();
    const style = { fontFamily: THEME.font, fill: THEME.ink };
    this.title = new Text({ text: game.level.name.toUpperCase(), style: { ...style, fontSize: 18, fontWeight: "bold" } });
    this.title.visible = game.level.mode !== "endless";
    this.stats = new Text({ text: "", style: { ...style, fontSize: 24, fontWeight: "bold" } });
    this.stats.label = "delivery-score";
    this.stats.cursor = "pointer";
    this.stats.on("pointertap", () => {
      if (this.game.level.mode === "endless") this.actions.showStatistics?.();
    });
    this.deliveryIcons.cursor = "pointer";
    this.deliveryIcons.on("pointertap", () => {
      if (this.game.level.mode === "endless") this.actions.showStatistics?.();
    });
    for (const color of DELIVERY_COLORS) {
      const icon = new Graphics().roundRect(-5, -5, 10, 10, 1)
        .fill(TOKEN_COLORS[color]).stroke({ width: 1.5, color: 0xffffff });
      icon.label = `delivery-${color}`;
      this.deliveryIcons.addChild(icon);
      this.deliveryBoxes.set(color, { icon });
    }
    this.meta = new Text({ text: "", style: { ...style, fontSize: 14 } });
    this.coins = new Text({ text: "", style: { ...style, fontSize: 16, fontWeight: "bold", fill: 0xffffff } });
    this.coins.anchor.set(0.5);
    this.lives = new Text({ text: "", style: { ...style, fontSize: 16, fontWeight: "bold", fill: 0xffffff } });
    this.lives.anchor.set(0.5);
    this.coinIcon.circle(0, 0, 20).fill(0xdd8a25).stroke({ width: 2, color: 0xa97717 });
    drawHeart(this.lifeIcon, 0, 1, 1.4);
    this.restart = new Text({ text: "RESTART", style: { ...style, fontSize: 15, fontWeight: "bold" } });
    this.restart.label = "meta-restart";
    this.pause = new Text({ text: "PAUSE", style: { ...style, fontSize: 15, fontWeight: "bold" } });
    this.pause.label = "meta-pause";
    this.skip = new Text({ text: "SKIP TO ENDLESS", style: { ...style, fontSize: 15, fontWeight: "bold" } });
    this.skip.label = "meta-endless";
    const toggleFullscreen = actions.toggleFullscreen;
    if (toggleFullscreen) {
      this.fullscreen = new Text({ text: "FULLSCREEN", style: { ...style, fontSize: 15, fontWeight: "bold" } });
      this.fullscreen.label = "meta-fullscreen";
      this.fullscreen.on("pointertap", toggleFullscreen);
    }
    this.menuButton.label = "meta-menu";
    this.fullscreenIcon.label = "meta-fullscreen-icon";
    for (const icon of [this.menuButton, this.fullscreenIcon]) {
      icon.eventMode = "static";
      icon.cursor = "pointer";
      icon.hitArea = new Rectangle(0, 0, META_ICON_SIZE, META_ICON_SIZE);
      icon.on("pointerover", () => { icon.tint = THEME.warn; });
      icon.on("pointerout", () => { icon.tint = 0xffffff; });
    }
    this.menuButton.on("pointertap", () => {
      this.menuOpen = !this.menuOpen;
      this.updateNavigationVisibility();
      this.layout(this.width, this.height);
    });
    this.fullscreenIcon.on("pointertap", () => {
      this.closeMenu();
      toggleFullscreen?.();
    });
    this.menuDismiss.eventMode = "static";
    this.menuDismiss.label = "meta-menu-dismiss";
    this.menuDismiss.on("pointertap", () => this.closeMenu());
    this.drawNavigationIcons();
    for (const control of this.metaControls()) {
      control.anchor.set(1, 0);
      control.eventMode = "static";
      control.cursor = "pointer";
      control.on("pointerover", () => { control.tint = THEME.warn; });
      control.on("pointerout", () => { control.tint = 0xffffff; });
    }
    this.restart.on("pointertap", () => { this.closeMenu(); onRestart(); });
    this.pause.on("pointertap", () => { this.closeMenu(); actions.togglePause(); });
    this.skip.on("pointertap", () => this.showEndlessConfirmation());
    this.hint = new Text({
      text: "",
      style: { ...style, fontSize: 13, fill: 0x6e685e, wordWrap: true, wordWrapWidth: 600, align: "center" },
    });
    this.hint.anchor.set(0.5, 1);

    this.shade.eventMode = "static";
    this.shade.on("pointertap", () => {
      if (!this.game.survivalFailed) {
        this.resultDismissed = true;
        this.hidePopup();
      }
    });
    this.heading = new Text({ text: "LEVEL COMPLETE!", style: { ...style, fontSize: 32, fontWeight: "bold" } });
    this.heading.anchor.set(0.5);
    this.heading.position.set(0, -38);
    this.detail = new Text({ text: "", style: { ...style, fontSize: 17, fill: 0x6e685e } });
    this.detail.label = "result-score";
    this.detail.cursor = "pointer";
    this.detail.eventMode = "static";
    this.detail.on("pointertap", () => {
      if (this.game.survivalFailed) this.actions.showStatistics?.();
    });
    this.detail.anchor.set(0.5);
    this.detail.position.set(0, 4);
    const statisticsBackground = new Graphics().roundRect(-72, -13, 144, 26, 13)
      .fill(0xe7e0dc).stroke({ width: 1.5, color: THEME.muted });
    const statisticsText = new Text({ text: "VIEW STATISTICS", style: { ...style, fontSize: 13, fontWeight: "bold" } });
    statisticsText.anchor.set(0.5);
    this.statisticsButton.addChild(statisticsBackground, statisticsText);
    this.statisticsButton.label = "result-statistics";
    this.statisticsButton.position.set(0, 8);
    this.statisticsButton.hitArea = new Rectangle(-72, -13, 144, 26);
    this.statisticsButton.eventMode = "static";
    this.statisticsButton.cursor = "pointer";
    this.statisticsButton.on("pointertap", () => this.actions.showStatistics?.());
    this.statisticsButton.on("pointerover", () => this.statisticsButton.scale.set(1.05));
    this.statisticsButton.on("pointerout", () => this.statisticsButton.scale.set(1));
    const button = (c: Container, label: string, onTap: () => void, color: number = THEME.ink) => {
      const bg = new Graphics().roundRect(-72, -20, 144, 40, 20).fill(color);
      const text = new Text({ text: label, style: { ...style, fontSize: 18, fontWeight: "bold", fill: 0xffffff } });
      text.anchor.set(0.5);
      c.addChild(bg, text);
      c.eventMode = "static";
      c.cursor = "pointer";
      c.hitArea = new Rectangle(-72, -20, 144, 40);
      c.on("pointertap", onTap);
      c.on("pointerover", () => { c.scale.set(1.05); });
      c.on("pointerout", () => { c.scale.set(1); });
      return text;
    };
    button(this.againButton, "RESTART", () => this.game.survivalFailed ? actions.restart() : onRestart());
    button(this.endlessButton, "ENDLESS", () => this.continueEndless());
    button(this.pauseButton, "END PAUSE", () => actions.togglePause());
    this.pauseButton.label = "end-pause";
    this.pauseShade.label = "pause-shade";
    this.pauseShade.eventMode = "static";
    this.pauseShade.on("pointertap", () => {
      if (this.pauseRequested && !this.confirming) actions.togglePause();
    });
    this.pauseShade.visible = this.pauseButton.visible = false;
    this.card.roundRect(-170, -90, 340, 180, 18).fill(THEME.background).stroke({ width: 3, color: THEME.ink });
    this.card.eventMode = "static";
    this.popup.addChild(this.card, this.againButton, this.endlessButton, this.heading, this.detail, this.statisticsButton);

    this.confirmationShade.eventMode = "static";
    this.confirmationShade.on("pointertap", () => this.cancelRestart());
    this.confirmationShade.alpha = 0.4;
    const confirmCard = new Graphics().roundRect(-170, -90, 340, 180, 18)
      .fill(THEME.background).stroke({ width: 3, color: THEME.ink });
    confirmCard.eventMode = "static";
    const confirmTitle = this.confirmTitle = new Text({ text: "RESTART GAME?", style: { ...style, fontSize: 25, fontWeight: "bold" } });
    confirmTitle.anchor.set(0.5);
    confirmTitle.position.set(0, -48);
    const confirmDetail = this.confirmDetail = new Text({ text: "ALL PROGRESS WILL BE LOST.", style: { ...style, fontSize: 14, fill: 0x6e685e } });
    confirmDetail.anchor.set(0.5);
    confirmDetail.position.set(0, -12);
    const cancelButton = new Container();
    const confirmButton = new Container();
    button(cancelButton, "CANCEL", () => this.cancelRestart());
    this.confirmLabel = button(confirmButton, "RESTART", () => this.confirmRestart(), THEME.warn);
    cancelButton.position.set(-77, 50);
    confirmButton.position.set(77, 50);
    this.confirmation.addChild(confirmCard, confirmTitle, confirmDetail, cancelButton, confirmButton);
    this.confirmationShade.visible = this.confirmation.visible = false;
    this.deathFlash.eventMode = "none";

    this.root.addChild(
      this.backplates,
      this.title,
      this.stats,
      this.deliveryIcons,
      this.meta,
      this.coinIcon,
      this.lifeIcon,
      this.coins,
      this.lives,
      this.warningLayer,
      this.toolbar,
      this.hint,
      this.coinLayer,
      this.heartLayer,
      this.shade,
      this.confettiLayer,
      this.popup,
      this.menuDismiss,
      ...(this.fullscreen ? [this.fullscreen] : []),
      this.pause,
      this.restart,
      this.skip,
      this.fullscreenIcon,
      this.menuButton,
      this.pauseShade,
      this.pauseButton,
      this.confirmationShade,
      this.confirmation,
      this.deathFlash,
    );
    this.listenForResources(game);
    this.stats.eventMode = this.deliveryIcons.eventMode = game.level.mode === "endless" && actions.showStatistics ? "static" : "none";
    this.updateDeliveryIcons(0);
    this.buildToolbar();
    this.hidePopup();
    this.updateNavigationVisibility();
  }

  setGame(game: Game): void {
    this.game = game;
    this.stats.eventMode = this.deliveryIcons.eventMode = game.level.mode === "endless" && this.actions.showStatistics ? "static" : "none";
    this.menuOpen = false;
    this.updateNavigationVisibility();
    this.confirming = false;
    this.pauseRequested = false;
    this.resultDismissed = false;
    this.coinFlights = [];
    this.scoredColors.clear();
    for (const box of this.deliveryBoxes.values()) box.jumpAge = undefined;
    this.updateDeliveryIcons(0);
    this.coinShakeAge = undefined;
    this.coinMotion = this.lifeMotion = undefined;
    this.coins.rotation = this.coinIcon.rotation = this.lives.rotation = this.lifeIcon.rotation = 0;
    this.coinLayer.clear();
    this.heartFlights = [];
    this.heartLayer.clear();
    this.flash = undefined;
    this.notice = undefined;
    this.deathFlash.clear();
    for (const warning of this.warnings.values()) warning.text.destroy();
    this.warnings.clear();
    this.listenForResources(game);
    this.title.text = game.level.name.toUpperCase();
    this.title.visible = game.level.mode !== "endless";
    this.buildToolbar();
    this.hidePopup();
  }

  setFullscreenActive(active: boolean): void {
    this.fullscreenActive = active;
    if (this.fullscreen) this.fullscreen.text = active ? "EXIT FULLSCREEN" : "FULLSCREEN";
    this.drawNavigationIcons();
  }

  closeMenu(): boolean {
    if (!this.menuOpen) return false;
    this.menuOpen = false;
    this.updateNavigationVisibility();
    this.layout(this.width, this.height);
    return true;
  }

  private compactNavigation(): boolean {
    return this.game.portrait && !!this.fullscreen;
  }

  private updateNavigationVisibility(): void {
    const compact = this.compactNavigation();
    if (!compact) this.menuOpen = false;
    this.menuButton.visible = this.fullscreenIcon.visible = compact;
    this.menuDismiss.visible = compact && this.menuOpen;
    if (this.fullscreen) this.fullscreen.visible = !compact;
    this.pause.visible = (!compact || this.menuOpen) && !this.game.complete;
    this.skip.visible = (!compact || this.menuOpen) && this.game.survival && !this.game.complete;
    this.restart.visible = !compact || this.menuOpen;
  }

  private drawNavigationIcons(): void {
    this.menuButton.clear();
    for (const y of [12, 20, 28]) this.menuButton.moveTo(10, y).lineTo(30, y);
    this.menuButton.stroke({ width: 2.5, color: THEME.ink, cap: "round" });
    this.fullscreenIcon.clear();
    for (const [x, y, dx, dy] of [[10, 10, 1, 1], [30, 10, -1, 1], [10, 30, 1, -1], [30, 30, -1, -1]]) {
      const cornerX = x + (this.fullscreenActive ? dx * 6 : 0);
      const cornerY = y + (this.fullscreenActive ? dy * 6 : 0);
      const direction = this.fullscreenActive ? -1 : 1;
      this.fullscreenIcon.moveTo(cornerX + dx * 6 * direction, cornerY)
        .lineTo(cornerX, cornerY).lineTo(cornerX, cornerY + dy * 6 * direction);
    }
    this.fullscreenIcon.stroke({ width: 2.5, color: THEME.ink, cap: "round", join: "round" });
  }

  showNotice(message: string): void {
    this.notice = { text: message.toUpperCase(), remaining: 5 };
  }

  setPaused(paused: boolean): void {
    this.pauseRequested = paused;
  }

  get manuallyPaused(): boolean {
    return this.pauseRequested;
  }

  private metaControls(): Text[] {
    return [...(this.fullscreen ? [this.fullscreen] : []), this.pause, this.skip, this.restart];
  }

  showRestartConfirmation(): void {
    this.showConfirmation("restart");
  }

  showEndlessConfirmation(): void {
    if (!this.game.survival || this.game.complete) return;
    this.showConfirmation("endless");
  }

  private showConfirmation(kind: "restart" | "endless"): void {
    if (this.confirming) return;
    this.closeMenu();
    this.confirmationKind = kind;
    this.confirmTitle.text = kind === "restart" ? "RESTART GAME?" : "EXIT SURVIVAL MODE?";
    this.confirmDetail.text = kind === "restart" ? "ALL PROGRESS WILL BE LOST." : "CONTINUE PLAYING WITHOUT PRESSURE.";
    this.confirmLabel.text = kind === "restart" ? "RESTART" : "ENDLESS";
    this.wasPaused = this.game.paused;
    this.game.paused = true;
    this.confirming = true;
  }

  cancelRestart(): void {
    if (!this.confirming) return;
    this.game.paused = this.wasPaused;
    this.confirming = false;
  }

  confirmRestart(): void {
    if (!this.confirming) return;
    this.confirming = false;
    if (this.confirmationKind === "endless") this.continueEndless();
    else this.actions.restart();
  }

  continueEndless(): void {
    if (!this.game.survival) return;
    this.game.continueEndless();
    this.pauseRequested = false;
    this.controller.cancel();
    this.hidePopup();
  }

  /** Screen-space UI areas, excluding the otherwise open world behind them. */
  blocks(point: Pt): boolean {
    return this.menuOpen || this.confirming || this.confirmationProgress > 0 || this.pauseRequested || this.pauseProgress > 0
      || this.game.complete || this.regions.some((region) => region.contains(point.x, point.y));
  }

  /** Destination for a collected reward in screen coordinates. */
  rewardTarget(choice: Powerup): Pt {
    if (choice.kind === "coins") return { x: this.coins.x, y: this.coins.y };
    if (choice.kind === "life") return this.game.survival
      ? { x: this.lives.x, y: this.lives.y } : { x: this.coins.x, y: this.coins.y };
    const tool = this.tools.find((item) => choice.kind === "kit"
      ? item.brush.kind === "kit" && item.brush.kit === choice.kit
      : item.brush.kind === choice.kind);
    return tool ? { x: tool.root.x, y: tool.root.y } : { x: this.width / 2, y: this.height - COIN_ROW };
  }

  private drawBackplates(): void {
    this.regions = [];
    this.backplates.clear();
    for (const text of [this.title, this.stats, this.meta, this.hint]) {
      if (!text.visible || !text.text) continue;
      const bounds = text.getBounds();
      const rect = new Rectangle(bounds.minX - 5, bounds.minY - 3, bounds.width + 10, bounds.height + 6);
      this.regions.push(rect);
      this.backplates.roundRect(rect.x, rect.y, rect.width, rect.height, 7).fill({ color: THEME.background, alpha: 0.94 });
    }
    if (this.deliveryIcons.visible && this.deliveryIconWidth() > 0) {
      const rect = new Rectangle(this.deliveryIcons.x - 7, this.stats.y - 8,
        this.deliveryIconWidth() + 4, this.stats.height + 16);
      this.regions.push(rect);
      this.backplates.roundRect(rect.x, rect.y, rect.width, rect.height, 7).fill({ color: THEME.background, alpha: 0.94 });
    }
    if (this.toolbar.visible) {
      for (const tool of this.tools) {
        const half = this.toolSize / 2 + 4;
        this.regions.push(new Rectangle(tool.root.x - half, tool.root.y - half, half * 2, half * 2));
      }
      for (const warning of this.warnings.values()) {
        this.regions.push(new Rectangle(warning.text.x - 11, warning.text.y - 18, 22, 36));
      }
    }
    this.regions.push(new Rectangle(this.coins.x - 24, this.coins.y - COIN_ROW / 2, this.lives.visible ? 106 : 48, COIN_ROW));
    for (const control of this.metaControls()) {
      if (!control.visible) continue;
      const box = this.controlBox(control);
      const rect = new Rectangle(control.x + box.x, control.y + box.y, box.width, box.height);
      this.regions.push(rect);
      this.backplates.roundRect(rect.x, rect.y, rect.width, rect.height, 7)
        .fill({ color: 0xe7e0dc, alpha: 0.85 }).stroke({ width: 1, color: THEME.muted, alpha: 0.4 });
    }
    for (const icon of [this.menuButton, this.fullscreenIcon]) {
      if (!icon.visible) continue;
      const rect = new Rectangle(icon.x, icon.y, META_ICON_SIZE, META_ICON_SIZE);
      this.regions.push(rect);
      this.backplates.roundRect(rect.x, rect.y, rect.width, rect.height, 7)
        .fill({ color: 0xe7e0dc, alpha: 0.85 }).stroke({ width: 1, color: THEME.muted, alpha: 0.4 });
    }
  }

  private listenForResources(game: Game): void {
    game.onDeliveries((colors) => {
      if (this.game !== game) return;
      for (const color of DELIVERY_COLORS) {
        if (!colors[color]) continue;
        this.scoredColors.add(color);
        this.deliveryBoxes.get(color)!.jumpAge = 0;
      }
    });
    game.onInsufficientCoins(() => {
      if (this.game === game) this.coinShakeAge = 0;
    });
    game.onCoins((event) => {
      if (this.game === game) {
        this.coinFlights.push({ event, age: 0 });
        this.coinMotion = { direction: event.amount > 0 ? "gain" : "loss", age: 0 };
      }
    });
    game.onLives((amount) => {
      if (this.game === game) this.lifeMotion = { direction: amount > 0 ? "gain" : "loss", age: 0 };
    });
    game.onLifeLost((position) => {
      if (this.game === game) {
        this.heartFlights.push({ position, age: 0 });
      }
    });
    game.onSinkDeath((sink) => {
      if (this.game !== game) return;
      this.flash = { color: TOKEN_COLORS[sink.color], age: 0 };
      if (game.survival && game.lives === 1) {
        const transition = game.sim.net.transitions.get(sink.sinkId);
        if (!transition) throw new Error(`Failed sink ${sink.sinkId} is missing`);
        this.fatalSink = transition;
      }
    });
  }

  private navigationKey(): string {
    return [this.title.visible ? this.title.width : 0, this.stats.width, this.deliveryIconWidth(), this.meta.width,
      this.fullscreen?.text, this.pause.text, this.pause.visible, this.skip.text, this.skip.visible,
      this.compactNavigation(), this.menuOpen].join(":");
  }

  private deliveryIconWidth(): number {
    const count = [...this.deliveryBoxes.values()].filter((box) => box.icon.visible).length;
    return this.deliveryIcons.visible && count ? (count - 1) * DELIVERY_BOX_SPACING + 10 : 0;
  }

  private updateDeliveryIcons(dt: number): void {
    this.deliveryIcons.visible = this.game.level.mode === "endless";
    const thresholds: Record<Color, number> = {
      blue: 0, red: ENDLESS_RULES.blueOnlyEpochs + 1, green: ENDLESS_RULES.greenFrom, yellow: ENDLESS_RULES.yellowFrom,
    };
    let index = 0;
    for (const color of DELIVERY_COLORS) {
      const box = this.deliveryBoxes.get(color)!;
      box.icon.visible = this.deliveryIcons.visible && (this.game.epoch >= thresholds[color] || this.scoredColors.has(color));
      if (box.icon.visible) box.icon.x = index++ * DELIVERY_BOX_SPACING;
      if (box.jumpAge !== undefined) {
        box.jumpAge += dt;
        if (box.jumpAge >= DELIVERY_JUMP_TIME) box.jumpAge = undefined;
      }
      box.icon.y = box.jumpAge === undefined ? 0 : -7 * Math.sin(Math.PI * box.jumpAge / DELIVERY_JUMP_TIME);
    }
  }

  private controlBox(control: Text): Rectangle {
    const width = this.navigationWidth ?? control.width;
    return new Rectangle(-width * control.anchor.x - 8, -6, width + 16, this.navigationHeight);
  }

  private updateWarnings(): boolean {
    const sinks = this.game.survival && !this.game.complete ? this.game.endangeredSinks() : [];
    const active = new Set(sinks.map((sink) => sink.sinkId));
    let changed = false;
    for (const [id, warning] of this.warnings) {
      if (active.has(id)) continue;
      warning.text.destroy();
      this.warnings.delete(id);
      changed = true;
    }
    for (const sink of sinks) {
      const existing = this.warnings.get(sink.sinkId);
      if (existing) {
        existing.remaining = sink.remaining;
        continue;
      }
      const warning = new Graphics();
      const top = -13, height = 17;
      sink.colors.forEach((color, index) => {
        const y0 = top + index * height / sink.colors.length;
        const y1 = top + (index + 1) * height / sink.colors.length;
        const halfWidth = (y: number) => 4.5 - (y - top) / height;
        warning.poly([-halfWidth(y0), y0, halfWidth(y0), y0, halfWidth(y1), y1, -halfWidth(y1), y1])
          .fill(TOKEN_COLORS[color]);
      });
      warning.circle(0, 9, 3.5).fill(TOKEN_COLORS[sink.colors[sink.colors.length - 1]]);
      warning.label = `danger-${sink.sinkId}`;
      warning.eventMode = "static";
      warning.cursor = "pointer";
      warning.hitArea = new Rectangle(-11, -18, 22, 36);
      warning.on("pointertap", () => {
        this.controller.cancel();
        this.controller.move();
        this.actions.focusSink(sink.sinkId);
      });
      warning.on("pointerover", () => warning.scale.set(1.15));
      warning.on("pointerout", () => warning.scale.set(1));
      this.warningLayer.addChild(warning);
      this.warnings.set(sink.sinkId, { text: warning, baseY: 0, remaining: sink.remaining });
      changed = true;
    }
    return changed;
  }

  /** Positions HUD elements and returns the screen heights reserved at the top and bottom. */
  layout(width: number, height: number): { top: number; bottom: number } {
    this.width = width;
    this.height = height;
    const portrait = this.game.portrait;
    this.lives.visible = this.game.level.mode === "endless";
    this.title.position.set(16, 10);
    this.stats.position.set(16, this.title.visible ? 34 : 8);
    this.stats.style.fontSize = 24;
    const iconWidth = this.deliveryIconWidth();
    const availableStatsWidth = Math.max(1, width - 32 - (iconWidth ? iconWidth + 9 : 0));
    if (this.stats.width > availableStatsWidth) this.stats.style.fontSize = 24 * availableStatsWidth / this.stats.width;
    this.deliveryIcons.position.set(this.stats.x + this.stats.width + 12, this.stats.y + this.stats.height / 2);
    this.deliveryIcons.hitArea = new Rectangle(-7, -this.stats.height / 2 - 8, iconWidth + 4, this.stats.height + 16);
    this.meta.position.set(16, this.title.visible ? 64 : 38);
    const resourceY = height - COIN_ROW / 2 - (portrait ? 0 : 5);
    this.resourceBaseY = resourceY;
    this.coinBaseX = portrait ? width / 2 - (this.lives.visible ? 27 : 0) : 34;
    this.lifeBaseX = portrait ? width / 2 + 27 : 88;
    this.coins.position.set(this.coinBaseX + this.coinShakeOffset(), resourceY);
    this.lives.position.set(this.lifeBaseX, resourceY);
    this.coinIcon.position.copyFrom(this.coins.position);
    this.lifeIcon.position.copyFrom(this.lives.position);
    this.skip.text = portrait ? "ENDLESS" : "SKIP TO ENDLESS";
    this.updateNavigationVisibility();
    const compact = this.compactNavigation();
    this.menuDismiss.clear().rect(0, 0, width, height).fill({ color: THEME.background, alpha: 0.001 });
    const controls = this.metaControls().filter((control) => control.visible);
    const scoreRight = 16 + Math.max(this.stats.width + (iconWidth ? 9 + iconWidth : 0),
      this.meta.width, this.title.visible ? this.title.width : 0);
    const iconLeft = width - 16 - META_ICON_SIZE * 2 - 8;
    const iconY = scoreRight + 16 <= iconLeft ? this.stats.y : this.meta.y + this.meta.height + 12;
    this.menuButton.position.set(width - 16 - META_ICON_SIZE, iconY);
    this.fullscreenIcon.position.set(iconLeft, iconY);
    const controlWidth = Math.max(0, ...controls.map((control) => control.width));
    const stacked = portrait;
    this.navigationWidth = stacked ? controlWidth : undefined;
    this.navigationHeight = Math.max(compact ? META_ICON_SIZE : 0,
      Math.max(0, ...controls.map((control) => control.height)) + 12);
    const controlsY = width < 600 ? 64 : 12;
    if (stacked) {
      const left = width - 24 - controlWidth;
      const top = compact ? iconY + META_ICON_SIZE + 8 : scoreRight + 16 <= left ? this.stats.y : this.meta.y + this.meta.height + 12;
      controls.forEach((control, i) => {
        control.anchor.set(0.5, 0);
        control.position.set(width - (compact ? 24 : 16) - controlWidth / 2, top + i * (this.navigationHeight + 4));
      });
    } else {
      let right = width - 16;
      for (const control of [...controls].reverse()) {
        control.anchor.set(1, 0);
        control.position.set(right, this.stats.y);
        right -= control.width + 20;
      }
      const left = Math.min(...controls.map((control) => control.x + this.controlBox(control).x));
      if (scoreRight + 16 > left) {
        for (const control of controls) control.y = Math.max(controlsY, this.meta.y + this.meta.height + 12);
      }
    }
    for (const control of controls) control.hitArea = this.controlBox(control);
    this.navigationState = this.navigationKey();
    if (this.shownFor === undefined) this.popup.position.set(width / 2, height / 2);
    this.shade.clear().rect(0, 0, width, height).fill(THEME.ink);
    this.pauseShade.clear().rect(0, 0, width, height).fill(THEME.ink);
    this.confirmationShade.clear().rect(0, 0, width, height).fill(THEME.ink);
    this.pauseButton.position.set(width / 2, height / 2);
    this.confirmation.position.set(width / 2, height / 2);
    this.confirmationFit = Math.max(0, Math.min(1, (width - 24) / 340, (height - 24) / 180));

    const n = this.tools.length;
    this.hint.visible = !!this.notice || (this.shownFor === undefined && (this.game.paused || this.controller.hint() !== ""));
    this.hint.style.fontSize = width > 480 ? 13 : 11;
    const sideHint = isUltraWide(width, height) && n > 1 && this.hint.visible;
    const hintWidth = sideHint ? Math.min(280, width * 0.28) : 0;
    this.hint.style.wordWrapWidth = sideHint ? hintWidth : Math.min(600, width - 32);
    this.hint.style.align = sideHint ? "left" : "center";
    const warningStart = this.lives.visible ? this.lives.x + 36 : this.coins.x + 36;
    const resourceWidth = Math.min(width / 3, (this.lives.visible ? WARNING_START : 70) + this.warnings.size * WARNING_GAP);
    const warningColumns = Math.max(1, Math.floor(((portrait ? width : resourceWidth) - warningStart - 12) / WARNING_GAP) + 1);
    const warningRows = Math.max(1, Math.ceil(this.warnings.size / warningColumns));
    const resourceHeight = COIN_ROW + (warningRows - 1) * WARNING_ROW;
    [...this.warnings.values()].forEach((warning, i) => {
      warning.baseY = resourceY - Math.floor(i / warningColumns) * WARNING_ROW;
      warning.text.position.set(warningStart + (i % warningColumns) * WARNING_GAP, warning.baseY);
    });
    const rightSpace = isUltraWide(width, height) ? (sideHint ? hintWidth + 24 : 0) : resourceWidth;
    const layout = toolbarLayout(portrait ? width : width - resourceWidth - rightSpace,
      this.tools.map((tool) => tool.brush));
    this.toolSize = layout.size;
    const size = this.toolSize;
    const toolbarH = n > 1 ? layout.rows * (size + TOOL_GAP) + 8 : 0;
    this.tools.forEach((b, i) => {
      const { x, row } = layout.positions[i];
      b.baseY = height - 8 - (portrait ? resourceHeight : 0) - size / 2 - (layout.rows - 1 - row) * (size + TOOL_GAP);
      b.root.position.set(x + (portrait ? 0 : resourceWidth), b.baseY);
      b.root.scale.set(size / TOOL_SIZE);
    });
    this.toolbar.visible = n > 1;

    const bottom = portrait ? resourceHeight + toolbarH : Math.max(resourceHeight, toolbarH);
    this.hint.position.set(sideHint ? width - 12 - hintWidth / 2 : width / 2, sideHint ? height - 8 : height - bottom - 8);
    const top = Math.max(width < 600 ? 102 : this.title.visible ? 92 : 68,
      compact ? iconY + META_ICON_SIZE + 12 : 0,
      ...(compact ? [] : controls.map((control) => control.y - 6 + this.navigationHeight + 12)));
    const reservedBottom = bottom + (this.hint.visible && !sideHint ? HINT_SPACE : 0);
    this.viewportCenter = { x: width / 2, y: top + Math.max(1, height - top - reservedBottom) / 2 };
    return { top, bottom };
  }

  private buildToolbar(): void {
    for (const c of this.toolbar.removeChildren()) c.destroy({ children: true });
    this.tools = brushesOf(this.game).map((brush) => {
      const root = new Container();
      root.label = `tool-${brush.kind}`;
      const bg = new Graphics();
      const icon = new Graphics();
      const badges = new Graphics();
      const label = () => {
        const text = new Text({ text: "", style: { fontFamily: THEME.font, fontSize: 11, fill: 0xffffff, fontWeight: "bold" } });
        text.anchor.set(0.5);
        return text;
      };
      const count = label();
      const price = label();
      count.position.set(19, -19);
      price.position.set(19, 19);
      drawToolIcon(icon, brush);
      root.addChild(bg, icon, badges, count, price);
      root.eventMode = "static";
      root.cursor = "pointer";
      root.hitArea = new Rectangle(-TOOL_SIZE / 2 - 4, -TOOL_SIZE / 2 - 4, TOOL_SIZE + 8, TOOL_SIZE + 8);
      root.on("pointertap", () => this.actions.selectBrush(brush));
      const tool: ToolButton = {
        brush, root, bg, icon, badges, count, price, baseY: 0, hovered: false,
        selected: sameBrush(brush, this.controller.brush), selectionAge: TOOL_SELECT_TIME,
      };
      root.on("pointerover", () => { tool.hovered = true; });
      root.on("pointerout", () => { tool.hovered = false; });
      this.toolbar.addChild(root);
      return tool;
    });
  }

  /** `dt` is real elapsed time; the popup keeps animating while the game is frozen. */
  update(dt: number, toScreen: (point: Pt) => Pt): boolean {
    const g = this.game;
    this.updateDeliveryIcons(dt);
    if (this.notice) {
      this.notice.remaining -= dt;
      if (this.notice.remaining <= 0) this.notice = undefined;
    }
    const brushes = brushesOf(g);
    const toolsChanged = brushes.length !== this.tools.length || brushes.some((brush, i) => !sameBrush(brush, this.tools[i].brush));
    const changed = this.updateWarnings() || toolsChanged;
    if (toolsChanged) this.buildToolbar();
    if (changed) this.layout(this.width, this.height);
    for (const warning of this.warnings.values()) {
      const jump = warning.remaining <= 15 ? Math.max(0, Math.sin(g.sim.time * Math.PI * 3)) * 8 : 0;
      warning.text.y = warning.baseY - jump;
    }
    for (const b of this.tools) {
      const unavailable = b.brush.kind === "life" && !g.buyLife({ x: 0, y: 0 }, false);
      const blocked = b.brush.kind === "life" && (g.complete || g.paused || g.lives >= MAX_LIVES);
      b.root.alpha = unavailable ? 0.45 : 1;
      b.root.eventMode = blocked ? "none" : "static";
      b.root.cursor = blocked ? "default" : "pointer";
      const active = sameBrush(b.brush, this.controller.brush);
      b.selectionAge = active && !b.selected ? 0 : Math.min(TOOL_SELECT_TIME, b.selectionAge + dt);
      b.selected = active;
      b.icon.y = active && b.selectionAge < TOOL_SELECT_TIME
        ? -3 * Math.sin(Math.PI * b.selectionAge / TOOL_SELECT_TIME) : 0;
      const h = TOOL_SIZE / 2;
      b.bg.clear().roundRect(-h, -h, 2 * h, 2 * h, 12).fill(active || b.hovered ? 0xffffff : THEME.background).stroke({
        width: active ? 3.5 : b.hovered ? 3 : 2,
        color: active || b.hovered ? THEME.ink : THEME.muted,
      });
      b.root.y = b.baseY;
      const powerup = b.brush.kind === "kit" ? g.kitPowerup(b.brush.kit) : undefined;
      const free = b.brush.kind === "auto" || b.brush.kind === "capacity" ? g.powerupStock(b.brush.kind) : 0;
      const stock = powerup ? g.powerupStock(powerup.id) : free;
      const price = b.brush.kind === "life" ? g.lifePrice
        : powerup?.price ?? ((b.brush.kind === "auto" || b.brush.kind === "capacity") && !free ? g.upgradePrice : 0);
      b.badges.clear();
      if (stock) b.badges.circle(19, -19, 10).fill(powerup ? 0x222222 : 0x32944c);
      if (price) b.badges.circle(19, 19, 10).fill(0xdd8a25);
      b.count.text = stock ? String(stock) : "";
      b.price.text = price ? String(price) : "";
    }
    const hint = this.notice?.text ?? (g.paused ? "PAUSED — TAP RESUME TO CONTINUE." : this.controller.hint().toUpperCase());
    const hintChanged = this.hint.text !== hint;
    if (hintChanged) this.hint.text = hint;
    const helpVisible = (!!this.notice || !g.complete) && hint !== "";
    const helpChanged = this.hint.visible !== helpVisible;
    this.hint.visible = helpVisible;
    const survivalResult = g.survivalResult;
    const score = survivalResult ? `${survivalResult.score} DELIVERIES [${g.score - survivalResult.score}]` : `${g.score} DELIVERIES`;
    const epoch = survivalResult ? `${survivalResult.epoch} [${g.epoch - survivalResult.epoch}]` : String(g.epoch);
    const progress = g.level.mode === "endless"
      ? score
      : `GOALS ${g.resolved.size}/${new Set(g.level.goals.map((goal) => goal.sinkId)).size}`;
    this.stats.text = progress;
    const seconds = Math.floor(g.sim.time);
    const minutes = Math.floor(seconds / 60);
    this.meta.text = `TIME ${minutes}:${String(seconds % 60).padStart(2, "0")}${g.level.mode === "endless" ? `  EPOCH ${epoch}` : ""}`;
    this.coins.text = String(g.coins);
    this.lives.text = g.survival ? String(g.lives) : "\u221e";
    this.lives.visible = g.level.mode === "endless";
    this.updateNavigationVisibility();
    const pauseLabel = g.paused ? "RESUME" : "PAUSE";
    if (this.pause.text !== pauseLabel) {
      this.pause.text = pauseLabel;
    }
    const navigationChanged = this.navigationKey() !== this.navigationState;
    if (navigationChanged) this.layout(this.width, this.height);
    if (this.coinShakeAge !== undefined) {
      this.coinShakeAge += dt;
      if (this.coinShakeAge >= COIN_SHAKE_TIME) this.coinShakeAge = undefined;
    }
    this.updateResources(dt);
    this.drawCoins(dt, toScreen);
    this.drawHearts(dt, toScreen);
    if (!g.complete) {
      this.resultDismissed = false;
      if (this.shownFor !== undefined) this.hidePopup();
    }
    if (g.complete && this.shownFor === undefined && !this.resultDismissed) this.showPopup();
    if (this.shownFor !== undefined) this.animatePopup(dt, toScreen);
    this.animateModals(dt);
    this.deathFlash.clear();
    if (this.flash) {
      this.flash.age += dt;
      const alpha = 0.18 * Math.max(0, 1 - this.flash.age / 0.22);
      if (alpha > 0) this.deathFlash.rect(0, 0, this.width, this.height).fill({ color: this.flash.color, alpha });
      else this.flash = undefined;
    }
    this.drawBackplates();
    return changed || helpChanged || navigationChanged || (hintChanged && isUltraWide(this.width, this.height));
  }

  private coinShakeOffset(): number {
    return this.coinShakeAge === undefined ? 0
      : Math.sin(this.coinShakeAge * 80) * 5 * (1 - this.coinShakeAge / COIN_SHAKE_TIME);
  }

  private updateResources(dt: number): void {
    const advance = (motion: ResourceMotion | undefined) => {
      if (!motion) return undefined;
      motion.age += dt;
      return motion.age < RESOURCE_MOTION_TIME ? motion : undefined;
    };
    this.coinMotion = advance(this.coinMotion);
    this.lifeMotion = advance(this.lifeMotion);
    const apply = (text: Text, icon: Graphics, x: number, motion?: ResourceMotion) => {
      const progress = motion ? Math.sin(Math.PI * motion.age / RESOURCE_MOTION_TIME) : 0;
      text.position.set(x, this.resourceBaseY - (motion?.direction === "gain" ? 7 * progress : 0));
      text.rotation = motion?.direction === "loss" ? 0.22 * progress : 0;
      icon.position.copyFrom(text.position);
      icon.rotation = text.rotation;
    };
    apply(this.coins, this.coinIcon, this.coinBaseX + this.coinShakeOffset(), this.coinMotion);
    apply(this.lives, this.lifeIcon, this.lifeBaseX, this.lifeMotion);
    this.lifeIcon.visible = this.lives.visible;
  }

  private animateModals(dt: number): void {
    const advance = (value: number, active: boolean) => Math.max(0, Math.min(1, value + (active ? 1 : -1) * dt / MODAL_TIME));
    this.pauseProgress = advance(this.pauseProgress, this.pauseRequested && !this.game.complete && !this.confirming);
    this.confirmationProgress = advance(this.confirmationProgress, this.confirming);
    this.pauseShade.visible = this.pauseButton.visible = this.pauseProgress > 0;
    this.pauseShade.alpha = 0.4 * this.pauseProgress;
    this.pauseButton.alpha = this.pauseProgress;
    this.pauseButton.scale.set(Math.min(1, (this.width - 24) / 144) * (0.9 + 0.1 * this.pauseProgress));
    this.pauseButton.eventMode = this.pauseRequested && !this.confirming ? "static" : "none";
    this.confirmationShade.visible = this.confirmation.visible = this.confirmationProgress > 0;
    this.confirmationShade.alpha = 0.4 * this.confirmationProgress;
    this.confirmation.alpha = this.confirmationProgress;
    this.confirmation.scale.set(this.confirmationFit * (0.9 + 0.1 * this.confirmationProgress));
    this.confirmation.eventMode = this.confirming ? "auto" : "none";
    this.confirmation.interactiveChildren = this.confirming;
  }

  private drawCoins(dt: number, toScreen: (point: Pt) => Pt): void {
    const graphics = this.coinLayer.clear();
    for (const flight of this.coinFlights) {
      flight.age += dt;
      const world = toScreen(flight.event);
      const node = {
        x: Math.max(12, Math.min(this.width - 12, world.x)),
        y: Math.max(64, Math.min(this.height - 70, world.y)),
      };
      const counter = { x: this.coins.x, y: this.coins.y };
      const from = flight.event.amount > 0 ? node : counter;
      const to = flight.event.amount > 0 ? counter : node;
      const count = Math.min(5, Math.abs(flight.event.amount));
      for (let i = 0; i < count; i++) {
        const progress = Math.max(0, Math.min(1, (flight.age - i * 0.045) / 0.65));
        if (flight.age < i * 0.045 || progress >= 1) continue;
        const x = from.x + (to.x - from.x) * progress + (i - (count - 1) / 2) * 5 * Math.sin(Math.PI * progress);
        const y = from.y + (to.y - from.y) * progress - 16 * Math.sin(Math.PI * progress);
        graphics.circle(x, y, 4).fill({ color: 0xe7b843, alpha: 0.85 }).stroke({ width: 1, color: 0xa97717, alpha: 0.85 });
      }
    }
    this.coinFlights = this.coinFlights.filter((flight) => flight.age < 0.85);
  }

  private drawHearts(dt: number, toScreen: (point: Pt) => Pt): void {
    const graphics = this.heartLayer.clear();
    for (const flight of this.heartFlights) {
      flight.age += dt;
      const progress = Math.min(1, flight.age / 0.75);
      if (progress >= 1) continue;
      const target = toScreen(flight.position);
      const x = this.lives.x + (target.x - this.lives.x) * progress;
      const y = this.lives.y + (target.y - this.lives.y) * progress - 24 * Math.sin(Math.PI * progress);
      drawHeart(graphics, x, y, 0.6 * (1 - 0.4 * progress));
    }
    this.heartFlights = this.heartFlights.filter((flight) => flight.age < 0.75);
  }

  private hidePopup(): void {
    this.shownFor = undefined;
    this.fatalSink = undefined;
    this.popupCenter = undefined;
    this.shade.visible = this.popup.visible = false;
    this.hint.visible = !!this.notice || this.game.paused || this.controller.hint() !== "";
    this.confetti = [];
    this.confettiLayer.clear();
  }

  private showPopup(): void {
    this.shownFor = 0;
    this.shade.visible = this.popup.visible = true;
    this.hint.visible = false;
    const failed = this.game.survivalFailed;
    this.heading.text = failed ? "SURVIVAL OVER" : "LEVEL COMPLETE!";
    this.heading.y = failed ? -56 : -38;
    this.detail.text = failed ? `${this.game.score} DELIVERIES` : `ALL GOALS MET IN ${this.game.completedAt!.toFixed(0)}S`;
    this.detail.y = failed ? -25 : 4;
    this.statisticsButton.visible = failed && !!this.actions.showStatistics;
    this.endlessButton.visible = failed;
    this.againButton.position.set(failed ? -77 : 0, 52);
    this.endlessButton.position.set(77, 52);
    const scale = Math.min(1, (this.width - 24) / 340);
    this.confetti = Array.from({ length: failed ? 0 : CONFETTI }, (_, i) => {
      const a = (i / CONFETTI) * Math.PI * 2 + Math.random() * 0.3;
      const v = (260 + Math.random() * 260) * scale;
      return {
        x: this.width / 2,
        y: this.height / 2,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v - 180,
        color: TOKEN_COLORS[COLORS[i % COLORS.length]],
        r: 5 + Math.random() * 3,
      };
    });
  }

  private animatePopup(dt: number, toScreen: (point: Pt) => Pt): void {
    const t = (this.shownFor! += dt);
    const k = Math.min(1, t / POP_TIME);
    const fit = popupFit(this.width, this.height);
    this.shade.alpha = 0.3 * Math.min(1, t / 0.3);
    this.popup.scale.set(Math.max(0, easeOutBack(k)) * fit);
    this.popup.alpha = Math.min(1, t / 0.15);
    // A gentle bob once the popup has settled.
    if (this.game.survivalFailed && this.fatalSink) {
      const sink = toScreen(this.fatalSink);
      const nearby = toScreen({ x: this.fatalSink.x + 44, y: this.fatalSink.y });
      const radius = Math.max(24, Math.hypot(nearby.x - sink.x, nearby.y - sink.y)) + 12;
      this.popupCenter = survivalPopupPosition(this.width, this.height,
        [{ ...sink, radius }, { ...this.viewportCenter, radius }], this.popupCenter);
    } else this.popupCenter = { x: this.width / 2, y: this.height / 2 };
    this.popup.position.set(this.popupCenter.x,
      this.popupCenter.y + (k >= 1 ? Math.sin((t - POP_TIME) * 2.5) * 4 : 0));

    const c = this.confettiLayer.clear();
    const fade = Math.max(0, 1 - Math.max(0, t - 1.2) / 0.8);
    if (fade <= 0) return;
    for (const p of this.confetti) {
      p.vy += 700 * dt;
      p.vx *= 1 - 1.5 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      c.circle(p.x, p.y, p.r).fill({ color: p.color, alpha: fade }).stroke({ width: 2, color: 0xffffff, alpha: fade });
    }
  }
}

