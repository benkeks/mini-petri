import { Container, Graphics, Rectangle, Text } from "pixi.js";
import { COLORS } from "../core/multiset";
import type { Game } from "../game/game";
import { THEME, TOKEN_COLORS } from "./style";

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

/** Back-out easing: overshoots a little before settling at 1. */
function easeOutBack(k: number): number {
  const c = 1.9;
  return 1 + (c + 1) * (k - 1) ** 3 + c * (k - 1) ** 2;
}

/** Screen-space overlay: time, goal progress, the level-won popup and restart button. */
export class Hud {
  readonly root = new Container();
  private readonly title: Text;
  private readonly stats: Text;
  private readonly restart: Text;
  private readonly hint: Text;
  /** Dims the net and swallows taps while the level-won popup is shown. */
  private readonly shade = new Graphics();
  private readonly popup = new Container();
  private readonly card = new Graphics();
  private readonly heading: Text;
  private readonly detail: Text;
  private readonly again: Text;
  private readonly confettiLayer = new Graphics();
  private confetti: Confetto[] = [];
  /** Real seconds since the popup appeared, or undefined while it is hidden. */
  private shownFor?: number;
  private width = 0;
  private height = 0;

  constructor(
    private game: Game,
    onRestart: () => void,
  ) {
    const style = { fontFamily: THEME.font, fill: THEME.ink };
    this.title = new Text({ text: game.level.name, style: { ...style, fontSize: 18, fontWeight: "bold" } });
    this.stats = new Text({ text: "", style: { ...style, fontSize: 15 } });
    this.restart = new Text({ text: "↻ restart", style: { ...style, fontSize: 16 } });
    this.restart.anchor.set(1, 0);
    this.restart.eventMode = "static";
    this.restart.cursor = "pointer";
    this.restart.on("pointertap", onRestart);
    this.hint = new Text({
      text: "Tap a dark transition to fire it. Fill the empty circles next to each goal by delivering tokens of their color.",
      style: { ...style, fontSize: 13, fill: 0x6e685e, wordWrap: true, wordWrapWidth: 600, align: "center" },
    });
    this.hint.anchor.set(0.5, 1);

    this.shade.eventMode = "static";
    this.heading = new Text({ text: "Level complete!", style: { ...style, fontSize: 32, fontWeight: "bold" } });
    this.heading.anchor.set(0.5);
    this.heading.position.set(0, -38);
    this.detail = new Text({ text: "", style: { ...style, fontSize: 17, fill: 0x6e685e } });
    this.detail.anchor.set(0.5);
    this.detail.position.set(0, 4);
    this.again = new Text({ text: "↻ play again", style: { ...style, fontSize: 18, fontWeight: "bold", fill: 0xffffff } });
    this.again.anchor.set(0.5);
    this.again.position.set(0, 52);
    const button = new Graphics().roundRect(-80, 32, 160, 40, 20).fill(THEME.ink);
    button.eventMode = "static";
    button.cursor = "pointer";
    button.hitArea = new Rectangle(-80, 32, 160, 40);
    button.on("pointertap", onRestart);
    this.card.roundRect(-170, -90, 340, 180, 18).fill(THEME.background).stroke({ width: 3, color: THEME.ink });
    this.card.eventMode = "static";
    this.popup.addChild(this.card, button, this.heading, this.detail, this.again);

    this.root.addChild(this.title, this.stats, this.shade, this.confettiLayer, this.popup, this.restart, this.hint);
    this.hidePopup();
  }

  setGame(game: Game): void {
    this.game = game;
    this.title.text = game.level.name;
    this.hidePopup();
  }

  /** Positions HUD elements and returns the height reserved at the top of the screen. */
  layout(width: number, height: number): number {
    this.width = width;
    this.height = height;
    this.title.position.set(16, 10);
    this.stats.position.set(16, 36);
    this.restart.position.set(width - 16, 12);
    this.popup.position.set(width / 2, height / 2);
    this.shade.clear().rect(0, 0, width, height).fill(THEME.ink);
    this.hint.style.wordWrapWidth = Math.min(600, width - 32);
    this.hint.position.set(width / 2, height - 10);
    this.hint.visible = width > 360 && this.shownFor === undefined;
    return 64;
  }

  /** `dt` is real elapsed time; the popup keeps animating while the game is frozen. */
  update(dt: number): void {
    const g = this.game;
    const sinks = new Set(g.level.goals.map((goal) => goal.sinkId)).size;
    this.stats.text = `goals ${g.resolved.size}/${sinks}   time ${g.sim.time.toFixed(0)}s`;
    if (g.complete && this.shownFor === undefined) this.showPopup();
    if (this.shownFor !== undefined) this.animatePopup(dt);
  }

  private hidePopup(): void {
    this.shownFor = undefined;
    this.shade.visible = this.popup.visible = false;
    this.hint.visible = this.width > 360;
    this.confetti = [];
    this.confettiLayer.clear();
  }

  private showPopup(): void {
    this.shownFor = 0;
    this.shade.visible = this.popup.visible = true;
    this.hint.visible = false;
    this.detail.text = `all goals met in ${this.game.completedAt!.toFixed(0)}s`;
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
