# Mini Petri

A small Mini Metro-style browser and smartphone game built on colored Petri nets (TypeScript + PixiJS v8).

```sh
npm install
npm run dev     # play at http://localhost:5173
npm test        # unit tests (Vitest)
npm run build   # type-check + production build
```

## How to play
Colored tokens appear at sources and need to reach the goals.
Each goal shows how many tokens of which color it still wants as empty circles next to it; a circle disappears whenever a matching token arrives.
A goal that has everything it wants is checked off and vanishes from the map.
Clear all goals to win the level.

Tokens do not move on their own: **tap a transition** (the dark bars) to make it fire — taking tokens from the circles before it and sending new tokens on.
Transitions can split, merge and recolor tokens, so pick the right ones at the right time.
A transition can only fire when the tokens it needs are there and its output circles have room (at most 7 tokens each); otherwise it is greyed out.

Planned: placing extra transitions and places during a level, and upgrades that let transitions fire on their own at intervals.

## Petri nets behind the game
The map *is* a colored Petri net:

| Game | Petri net |
| --- | --- |
| circles | places |
| bars | transitions |
| lines with arrowheads | arcs; the line color is the token color it moves (black = any color), the number of arrowheads its weight |
| colored dots | colored tokens; the dots in a place are its marking |
| tapping a bar | firing an enabled transition |
| colored bars that fill up | source transitions firing on a timer |
| goals | sink transitions with a target number of tokens to consume |
| room in a circle | place capacity |

Firing follows the usual rule: a transition is enabled if every input place holds enough tokens of the arc's color; firing removes them and produces the output tokens.
Time is continuous, so produced tokens are visibly on their way and only become usable once they arrive.
Details are in [docs/DESIGN.md](docs/DESIGN.md).

## Code layout
- `src/core` — pure simulation: multisets, net model, `Simulation` (`fire`, `step(dt)`, auto-fire timers).
  No Pixi dependency.
- `src/game` — level definitions and `Game` rules (goals, source ramp, portrait transposition).
- `src/render` — Pixi views (`NetView`, `Hud`) and styling.

## License
MIT — see [LICENSE](LICENSE).
