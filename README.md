# Mini Petri

A small Mini Metro-style browser and smartphone game built on colored Petri nets (TypeScript + PixiJS v8).

```sh
npm install
npm run dev     # play at http://localhost:5173
npm test        # unit tests (Vitest)
npm run build   # type-check + production build
```

The current build of `main` is deployed to <https://benkeks.github.io/mini-petri/>.

## How to play
Colored tokens appear at sources and need to reach the goals.
Each goal shows how many tokens of which color it still wants as empty circles next to it; a circle disappears whenever a matching token arrives.
A goal that has everything it wants is checked off and vanishes from the map.
Clear all goals to win the level.

Tokens do not move on their own: **tap a transition** (the dark bars) to make it fire — taking tokens from the circles before it and sending new tokens on.
Transitions can split, merge and recolor tokens, so pick the right ones at the right time.
A transition can only fire when the tokens it needs are there and its output circles have room; otherwise it is greyed out.
The size of a place shows whether it holds 1, 7 or 19 tokens; the standard capacity is 7.

Some sources only hold a limited number of tokens, shown as dots behind them; once they are used up the source is checked off and disappears.

Drag empty space to move around, and use the mouse wheel, trackpad or a two-finger pinch to zoom.
Switch out of a placement tool before dragging.

### Building and upgrades
A toolbar at the bottom offers tools.
Everything works with a single tap; a tool says what a tap does where it cannot be told from what you tap.
Tapping a tool again (or pressing Escape) goes back to firing.

- **Place** and **transition** tools build new nodes inside the white area, which reaches a bit around the existing nodes; nodes need some room around them.
  The map can grow in any direction as you build.
  The transition tools show what the new transition consumes (left) and produces (right).
- A new transition starts with **loose ends** (plugs) and cannot fire until all of them are connected: tap a plug and a place in either order.
  Some given transitions and goals have loose ends, too.
  Connections can only reach nearby places; a ring shows their maximum range while building or connecting, and reachable nodes are highlighted.
  After selecting a place, tap a transition to connect its first available input, then its first available output; tap a specific plug to choose it instead.
  Tapping a plug switches back to the firing tool, even if another tool was active.
  With a plug selected, tap empty space in the building area to create and connect a one-token place, which can be upgraded.
- **Remove** (red cross) takes away an arc, place or transition; sources and sinks cannot be removed.
  Removed things fade out but finish what they are doing; a removed place loses its tokens.
  Cutting an arc leaves a loose end that can be connected elsewhere.
- **Auto** (clock) makes a transition fire on its own; tap it again with the same tool to make it faster.
- **Capacity** (plus) grows a place to the next size, allowing it to hold more tokens.

Levels can be picked with the numbered buttons at the top; `#2` in the URL opens level 2.

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
| dots behind a source | a bounded number of firings |
| building, connecting and removing | editing the net's structure while it runs |

Firing follows the usual rule: a transition is enabled if every input place holds enough tokens of the arc's color; firing removes them and produces the output tokens.
Time is continuous, so produced tokens are visibly on their way and only become usable once they arrive.
Details are in [docs/DESIGN.md](docs/DESIGN.md).

## Code layout
- `src/core` — pure simulation: multisets, net model, `Simulation` (`fire`, `step(dt)`, auto-fire timers).
  No Pixi dependency.
- `src/game` — level definitions and `Game` rules (goals, source ramp, portrait transposition), plus building, removal and upgrade rules.
- `src/input` — `Controller`: brushes and taps to game actions.
- `src/render` — Pixi views (`NetView` with picking, `Hud` with toolbar) and styling.

## License
MIT — see [LICENSE](LICENSE).
