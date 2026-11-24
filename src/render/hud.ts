import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { COLORS } from "../core/multiset";
import { UPGRADE_COST, type CoinEvent, type Game } from "../game/game";
import type { Powerup } from "../game/powerups";
import { brushesOf, sameBrush, type Brush, type Controller } from "../input/controller";
import type { Pt } from "./geometry";
import { THEME, TOKEN_COLORS } from "./style";
import { drawToolIcon } from "./toolIcon";

const TOOL_SIZE = 48;
const TOOL_GAP = 8;
const REMOVE_EXTRA_GAP = 8;
const COIN_ROW = 30;
/** Room for the hint line above the toolbar. */
const HINT_SPACE = 34;

export interface HudActions {
  restart(): void;
  requestRestart(): void;
  togglePause(): void;
  selectBrush(b: Brush): void;
}

interface ToolButton {
  brush: Brush;
  root: Container;
  bg: Graphics;
  badges: Graphics;
  count: Text;
  price: Text;
  baseY: number;
  hovered: boolean;
}

const POP_TIME = 0.55;
const CONFETTI = 36;

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
  private readonly meta: Text;
  private readonly coins: Text;
  private readonly pause: Text;
  private readonly restart: Text;
  private readonly hint: Text;
  private readonly toolbar = new Container();
  private readonly coinLayer = new Graphics();
  private coinFlights: CoinFlight[] = [];
  private tools: ToolButton[] = [];
  private toolSize = TOOL_SIZE;
  /** Dims the net and swallows taps while the level-won popup is shown. */
  private readonly shade = new Graphics();
  private readonly popup = new Container();
  private readonly card = new Graphics();
  private readonly heading: Text;
  private readonly detail: Text;
  private readonly againButton = new Container();
  private readonly confettiLayer = new Graphics();
  private readonly confirmationShade = new Graphics();
  private readonly confirmation = new Container();
  private wasPaused = false;
  confirming = false;
  private confetti: Confetto[] = [];
  /** Real seconds since the popup appeared, or undefined while it is hidden. */
  private shownFor?: number;
  private width = 0;
  private height = 0;

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
    this.meta = new Text({ text: "", style: { ...style, fontSize: 14 } });
    this.coins = new Text({ text: "", style: { ...style, fontSize: 16, fontWeight: "bold", fill: 0xa97717 } });
    this.restart = new Text({ text: "RESTART", style: { ...style, fontSize: 15, fontWeight: "bold" } });
    this.pause = new Text({ text: "PAUSE", style: { ...style, fontSize: 15, fontWeight: "bold" } });
    for (const control of [this.pause, this.restart]) {
      control.anchor.set(1, 0);
      control.eventMode = "static";
      control.cursor = "pointer";
      control.on("pointerover", () => { control.tint = THEME.warn; });
      control.on("pointerout", () => { control.tint = 0xffffff; });
    }
    this.restart.on("pointertap", onRestart);
    this.pause.on("pointertap", () => actions.togglePause());
    this.hint = new Text({
      text: "",
      style: { ...style, fontSize: 13, fill: 0x6e685e, wordWrap: true, wordWrapWidth: 600, align: "center" },
    });
    this.hint.anchor.set(0.5, 1);

    this.shade.eventMode = "static";
    this.heading = new Text({ text: "LEVEL COMPLETE!", style: { ...style, fontSize: 32, fontWeight: "bold" } });
    this.heading.anchor.set(0.5);
    this.heading.position.set(0, -38);
    this.detail = new Text({ text: "", style: { ...style, fontSize: 17, fill: 0x6e685e } });
    this.detail.anchor.set(0.5);
    this.detail.position.set(0, 4);
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
    };
    button(this.againButton, "AGAIN", onRestart);
    this.card.roundRect(-170, -90, 340, 180, 18).fill(THEME.background).stroke({ width: 3, color: THEME.ink });
    this.card.eventMode = "static";
    this.popup.addChild(this.card, this.againButton, this.heading, this.detail);

    this.confirmationShade.eventMode = "static";
    this.confirmationShade.alpha = 0.4;
    const confirmCard = new Graphics().roundRect(-170, -90, 340, 180, 18)
      .fill(THEME.background).stroke({ width: 3, color: THEME.ink });
    confirmCard.eventMode = "static";
    const confirmTitle = new Text({ text: "RESTART GAME?", style: { ...style, fontSize: 25, fontWeight: "bold" } });
    confirmTitle.anchor.set(0.5);
    confirmTitle.position.set(0, -48);
    const confirmDetail = new Text({ text: "ALL PROGRESS WILL BE LOST.", style: { ...style, fontSize: 14, fill: 0x6e685e } });
    confirmDetail.anchor.set(0.5);
    confirmDetail.position.set(0, -12);
    const cancelButton = new Container();
    const confirmButton = new Container();
    button(cancelButton, "CANCEL", () => this.cancelRestart());
    button(confirmButton, "RESTART", () => this.confirmRestart(), THEME.warn);
    cancelButton.position.set(-77, 50);
    confirmButton.position.set(77, 50);
    this.confirmation.addChild(confirmCard, confirmTitle, confirmDetail, cancelButton, confirmButton);
    this.confirmationShade.visible = this.confirmation.visible = false;

    this.root.addChild(
      this.backplates,
      this.title,
      this.stats,
      this.meta,
      this.coins,
      this.toolbar,
      this.hint,
      this.coinLayer,
      this.shade,
      this.confettiLayer,
      this.popup,
      this.pause,
      this.restart,
      this.confirmationShade,
      this.confirmation,
    );
    this.listenForCoins(game);
    this.buildToolbar();
    this.hidePopup();
  }

  setGame(game: Game): void {
    this.game = game;
    this.confirming = false;
    this.confirmationShade.visible = this.confirmation.visible = false;
    this.coinFlights = [];
    this.coinLayer.clear();
    this.listenForCoins(game);
    this.title.text = game.level.name.toUpperCase();
    this.title.visible = game.level.mode !== "endless";
    this.buildToolbar();
    this.hidePopup();
  }

  showRestartConfirmation(): void {
    if (this.confirming) return;
    this.wasPaused = this.game.paused;
    this.game.paused = true;
    this.confirming = true;
    this.confirmationShade.visible = this.confirmation.visible = true;
  }

  cancelRestart(): void {
    if (!this.confirming) return;
    this.game.paused = this.wasPaused;
    this.confirming = false;
    this.confirmationShade.visible = this.confirmation.visible = false;
  }

  confirmRestart(): void {
    if (!this.confirming) return;
    this.confirming = false;
    this.confirmationShade.visible = this.confirmation.visible = false;
    this.actions.restart();
  }

  /** Screen-space UI areas, excluding the otherwise open world behind them. */
  blocks(point: Pt): boolean {
    return this.confirming || this.game.complete || this.regions.some((region) => region.contains(point.x, point.y));
  }

  /** Destination for a collected reward in screen coordinates. */
  rewardTarget(choice: Powerup): Pt {
    if (choice.kind === "coins") return { x: 16 + this.coins.width / 2, y: this.height - COIN_ROW / 2 };
    const tool = this.tools.find((item) => choice.kind === "kit"
      ? item.brush.kind === "kit" && item.brush.kit === choice.kit
      : item.brush.kind === choice.kind);
    return tool ? { x: tool.root.x, y: tool.root.y } : { x: this.width / 2, y: this.height - COIN_ROW };
  }

  private drawBackplates(): void {
    this.regions = [];
    this.backplates.clear();
    for (const text of [this.title, this.stats, this.meta, this.coins, this.hint, this.pause, this.restart]) {
      if (!text.visible || !text.text) continue;
      const bounds = text.getBounds();
      const rect = new Rectangle(bounds.minX - 5, bounds.minY - 3, bounds.width + 10, bounds.height + 6);
      this.regions.push(rect);
      this.backplates.roundRect(rect.x, rect.y, rect.width, rect.height, 7).fill({ color: THEME.background, alpha: 0.94 });
    }
    if (this.toolbar.visible) {
      for (const tool of this.tools) {
        const half = this.toolSize / 2 + 4;
        this.regions.push(new Rectangle(tool.root.x - half, tool.root.y - half, half * 2, half * 2));
      }
    }
    for (const control of [this.pause, this.restart]) {
      this.regions.push(new Rectangle(control.x - control.width - 6, control.y - 10, control.width + 12, 44));
    }
  }

  private listenForCoins(game: Game): void {
    game.onCoins((event) => {
      if (this.game === game) this.coinFlights.push({ event, age: 0 });
    });
  }

  /** Positions HUD elements and returns the screen heights reserved at the top and bottom. */
  layout(width: number, height: number): { top: number; bottom: number } {
    this.width = width;
    this.height = height;
    this.title.position.set(16, 10);
    this.stats.position.set(16, this.title.visible ? 34 : 8);
    this.meta.position.set(16, this.title.visible ? 64 : 38);
    this.coins.position.set(16, height - COIN_ROW + 4);
    this.restart.position.set(width - 16, 12);
    this.pause.position.set(width - 28 - this.restart.width, 12);
    for (const control of [this.pause, this.restart]) {
      control.hitArea = new Rectangle(-control.width - 6, -10, control.width + 12, 44);
    }
    this.popup.position.set(width / 2, height / 2);
    this.shade.clear().rect(0, 0, width, height).fill(THEME.ink);
    this.confirmationShade.clear().rect(0, 0, width, height).fill(THEME.ink);
    this.confirmation.position.set(width / 2, height / 2);
    this.confirmation.scale.set(Math.max(0, Math.min(1, (width - 24) / 340, (height - 24) / 180)));

    const n = this.tools.length;
    const layout = toolbarLayout(width, this.tools.map((tool) => tool.brush));
    this.toolSize = layout.size;
    const size = this.toolSize;
    const toolbarH = n > 1 ? layout.rows * (size + TOOL_GAP) + 8 : 0;
    this.tools.forEach((b, i) => {
      const { x, row } = layout.positions[i];
      b.baseY = height - COIN_ROW - 8 - size / 2 - (layout.rows - 1 - row) * (size + TOOL_GAP);
      b.root.position.set(x, b.baseY);
      b.root.scale.set(size / TOOL_SIZE);
    });
    this.toolbar.visible = n > 1;

    this.hint.style.wordWrapWidth = Math.min(600, width - 32);
    this.hint.position.set(width / 2, height - COIN_ROW - toolbarH - 8);
    this.hint.visible = this.shownFor === undefined;
    this.hint.style.fontSize = width > 480 ? 13 : 11;
    return { top: this.title.visible ? 92 : 68, bottom: toolbarH + HINT_SPACE + COIN_ROW };
  }

  private buildToolbar(): void {
    for (const c of this.toolbar.removeChildren()) c.destroy({ children: true });
    this.tools = brushesOf(this.game).map((brush) => {
      const root = new Container();
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
      const tool: ToolButton = { brush, root, bg, badges, count, price, baseY: 0, hovered: false };
      root.on("pointerover", () => { tool.hovered = true; });
      root.on("pointerout", () => { tool.hovered = false; });
      this.toolbar.addChild(root);
      return tool;
    });
  }

  /** `dt` is real elapsed time; the popup keeps animating while the game is frozen. */
  update(dt: number, toScreen: (point: Pt) => Pt): boolean {
    const g = this.game;
    const brushes = brushesOf(g);
    const changed = brushes.length !== this.tools.length || brushes.some((brush, i) => !sameBrush(brush, this.tools[i].brush));
    if (changed) {
      this.buildToolbar();
      this.layout(this.width, this.height);
    }
    for (const b of this.tools) {
      const active = sameBrush(b.brush, this.controller.brush);
      const h = TOOL_SIZE / 2;
      b.bg.clear().roundRect(-h, -h, 2 * h, 2 * h, 12).fill(active || b.hovered ? 0xffffff : THEME.background).stroke({
        width: active ? 3.5 : b.hovered ? 3 : 2,
        color: active || b.hovered ? THEME.ink : THEME.muted,
      });
      b.root.y = b.baseY - (active ? 4 : 0);
      const powerup = b.brush.kind === "kit" ? g.kitPowerup(b.brush.kit) : undefined;
      const free = b.brush.kind === "auto" || b.brush.kind === "capacity" ? g.powerupStock(b.brush.kind) : 0;
      const stock = powerup ? g.powerupStock(powerup.id) : free;
      const price = powerup?.price ?? ((b.brush.kind === "auto" || b.brush.kind === "capacity") && !free ? UPGRADE_COST : 0);
      b.badges.clear();
      if (stock) b.badges.circle(19, -19, 10).fill(powerup ? 0x222222 : 0x32944c);
      if (price) b.badges.circle(19, 19, 10).fill(0xdd8a25);
      b.count.text = stock ? String(stock) : "";
      b.price.text = price ? String(price) : "";
    }
    const hint = g.paused ? "PAUSED — TAP RESUME TO CONTINUE." : this.controller.hint().toUpperCase();
    if (this.hint.text !== hint) this.hint.text = hint;
    const progress = g.level.mode === "endless"
      ? `SCORE ${g.score}`
      : `GOALS ${g.resolved.size}/${new Set(g.level.goals.map((goal) => goal.sinkId)).size}`;
    this.stats.text = progress;
    const seconds = Math.floor(g.sim.time);
    const minutes = Math.floor(seconds / 60);
    this.meta.text = `TIME ${minutes}:${String(seconds % 60).padStart(2, "0")}${g.level.mode === "endless" ? `  EPOCH ${g.epoch}` : ""}`;
    this.coins.text = `COINS ${g.coins}`;
    const pauseLabel = g.paused ? "RESUME" : "PAUSE";
    if (this.pause.text !== pauseLabel) {
      this.pause.text = pauseLabel;
      this.pause.hitArea = new Rectangle(-this.pause.width - 6, -10, this.pause.width + 12, 44);
    }
    this.drawCoins(dt, toScreen);
    if (g.complete && this.shownFor === undefined) this.showPopup();
    if (this.shownFor !== undefined) this.animatePopup(dt);
    this.drawBackplates();
    return changed;
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
      const counter = { x: 16 + this.coins.width / 2, y: this.height - COIN_ROW / 2 };
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

  private hidePopup(): void {
    this.shownFor = undefined;
    this.shade.visible = this.popup.visible = false;
    this.hint.visible = true;
    this.confetti = [];
    this.confettiLayer.clear();
  }

  private showPopup(): void {
    this.shownFor = 0;
    this.shade.visible = this.popup.visible = true;
    this.hint.visible = false;
    this.detail.text = `ALL GOALS MET IN ${this.game.completedAt!.toFixed(0)}S`;
    this.againButton.position.set(0, 52);
    const scale = Math.min(1, (this.width - 24) / 340);
    this.confetti = Array.from({ length: CONFETTI }, (_, i) => {
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

  private animatePopup(dt: number): void {
    const t = (this.shownFor! += dt);
    const k = Math.min(1, t / POP_TIME);
    const fit = Math.min(1, (this.width - 24) / 340);
    this.shade.alpha = 0.3 * Math.min(1, t / 0.3);
    this.popup.scale.set(Math.max(0, easeOutBack(k)) * fit);
    this.popup.alpha = Math.min(1, t / 0.15);
    // A gentle bob once the popup has settled.
    this.popup.y = this.height / 2 + (k >= 1 ? Math.sin((t - POP_TIME) * 2.5) * 4 : 0);

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

