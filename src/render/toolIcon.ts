import { Graphics } from "pixi.js";
import type { Brush } from "../input/controller";
import { THEME, TOKEN_COLORS } from "./style";

/** Icons of the toolbar, drawn around (0, 0) within 48 pixels. */
export function drawToolIcon(g: Graphics, b: Brush): void {
  const ink = THEME.ink;
  const bar = (x: number, w = 8, h = 24, color: number = ink) => g.roundRect(x - w / 2, -h / 2, w, h, 3).fill(color);
  switch (b.kind) {
    case "fire":
      bar(0);
      for (const a of [-0.6, 0, 0.6].flatMap((d) => [d, Math.PI + d])) {
        g.moveTo(Math.cos(a) * 9, Math.sin(a) * 15).lineTo(Math.cos(a) * 15, Math.sin(a) * 19).stroke({ width: 2.5, color: ink, cap: "round" });
      }
      break;
    case "kit": {
      bar(0, 6, 22);
      const side = (dir: "in" | "out", x: number) => {
        const dots = b.kit.ports.filter((p) => p.dir === dir).flatMap((p) => Array<number>(p.count ?? 1).fill(p.color ? TOKEN_COLORS[p.color] : ink));
        dots.forEach((c, i) => g.circle(x, (i - (dots.length - 1) / 2) * 11, 4.5).fill(c));
      };
      side("in", -13);
      side("out", 13);
      break;
    }
    case "remove":
      for (const s of [1, -1]) g.moveTo(-10, -10 * s).lineTo(10, 10 * s).stroke({ width: 4, color: THEME.warn, cap: "round" });
      break;
    case "auto":
      g.circle(-4, 0, 11).stroke({ width: 3, color: ink });
      g.moveTo(-4, 0).lineTo(-4, -7).moveTo(-4, 0).lineTo(1, 3).stroke({ width: 2.5, color: ink, cap: "round" });
      g.moveTo(10, -5).lineTo(15, 0).lineTo(10, 5).stroke({ width: 3, color: ink, cap: "round", join: "round" });
      break;
    case "capacity":
      g.circle(0, 0, 14).stroke({ width: 3, color: ink });
      g.moveTo(-7, 0).lineTo(7, 0).moveTo(0, -7).lineTo(0, 7).stroke({ width: 3, color: ink, cap: "round" });
      break;
  }
}
