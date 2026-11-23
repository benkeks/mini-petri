import type { Color } from "../core/multiset";

export const TOKEN_COLORS: Record<Color, number> = {
  red: 0xe0443e,
  blue: 0x2f7de1,
  green: 0x3aa856,
  yellow: 0xf2b632,
};

export const THEME = {
  background: 0xf4f1ea,
  ink: 0x2b2b2b,
  muted: 0xb8b2a7,
  arc: 0x8c867c,
  placeFill: 0xffffff,
  warn: 0xd8342c,
  enabledGlow: 0x2b2b2b,
  font: "Helvetica Neue, Arial, sans-serif",
};

export const TOKEN_RADIUS = 6;
export const TRANSITION_W = 22;
export const TRANSITION_H = 64;
