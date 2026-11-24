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
In survival and endless modes, new sources and goals appear near the network over time, tending towards the starting source, and your score is the number of matching tokens delivered.
The starting blue source is unlimited; red sources and sinks initially supply or want five tokens.
Finite sources and sinks arrange their remaining circles in matching groups of five, mirrored on opposite sides of the node; source circles are smaller.
When all connections run up or down, a transition uses a horizontal bar, with its balance on the clear vertical side.
Connections running left/right use vertical bars even in portrait mode.
Their circles switch to the clearer side when connected arcs occupy their usual side, and gently tween into place when flipping or consuming tokens.
Later red pairs appear farther apart and can have different quantities, occasionally 10 or 15.
From epoch 25, some blue sinks consume two tokens per firing; after epoch 50, some consume three.
Green sinks appear from epoch 40, and yellow sinks from epoch 100; neither has its own source.
From epoch 75, every second red sink appears without a source.
Pan and zoom to find new arrivals, then connect them to your network.
The upper left shows your score, elapsed game time and completed epoch count.
Resource counters sit below the toolbar, centered in portrait; landscape places counters and tools alongside each other at the bottom.
Use **Pause** to freeze gameplay and **Resume** to continue. Restart opens an in-game confirmation; cancelling restores the previous pause state.

Tokens do not move on their own: **tap a transition** (the dark bars) to make it fire — taking tokens from the circles before it and sending new tokens on.
The starting relay passes a token through unchanged.
The starting source place holds 19 tokens; the destination starts at 7 and can be upgraded.
A transition can only fire when the tokens it needs are there and its output circles have room; otherwise it is greyed out.
The size of a place shows whether it holds 1, 7 or 19 tokens; the standard capacity is 7.

A sink left unfilled for three minutes starts a one-minute countdown, shown by a shrinking ring.
Each token arriving during that countdown adds ten seconds.
Yellow sinks have twice as long before and during the countdown.
Red sources start a one-minute countdown after four minutes without emitting a token; an emission resets their timer.
When a countdown runs out, the transition is crossed out and disappears.
The initial blue source never expires.

Drag empty space to move around, and use the mouse wheel, trackpad or a two-finger pinch to zoom.
Switch out of a placement tool before dragging.
The initial hint explains the source-to-sink objective until your first effective click or epoch 2.
Default tool hints stop after epoch 10; all tool hints stop after epoch 100.
Ultra-wide landscape screens place hints beside the toolbar and allow stronger zoom-in.
Likely smartphones show a fullscreen toggle before pause; browser support and permissions determine whether fullscreen is available.

### Building and upgrades
A toolbar at the bottom offers tools.
Everything works with a single tap; a tool says what a tap does where it cannot be told from what you tap.
Tapping a tool again (or pressing Escape) goes back to firing.

- **Transition** tools build new nodes inside the white area, which reaches a bit around the existing nodes; gray areas around nodes show where placement is blocked.
  The map can grow in any direction as you build.
  The transition tools show what the new transition consumes (left) and produces (right).
  A special-transition tool can also convert a highlighted normal transition, keeping its connections and firing-speed upgrades for the same kit price and stock.
  Existing connections must fit the new input/output port counts; any additional ports remain open.
- A new transition starts with **loose ends** (plugs) and cannot fire until all of them are connected: tap a plug and a place in either order.
  Some given transitions and goals have loose ends, too.
  Loose ends flip away from connected arcs on the same side; the arrow still shows whether the port consumes or produces tokens.
  Connections can only reach nearby places; a ring indicates connection range while building or connecting, reachable nodes are highlighted, and out-of-range plugs are dimmed.
  Transition-side rings stay at the primary 300-unit radius; upgraded places beyond that ring are still highlighted when connectible.
  After selecting a place, tap a transition to connect its first available input, then its first available output; tap a specific plug to choose it instead.
  Or tap empty space to build a one-to-one relay connected to that place, then connect its output.
  This ordinary relay has no separate toolbar button.
  Tapping a plug switches back to the firing tool, even if another tool was active.
  With a plug selected, tap empty space in the building area to create and connect a one-token place, which can be upgraded.
  Tapping another connector instead creates a nearby one-token place and wires both connectors when space and reach allow; tapping the selected connector creates a place for that connector alone.
  You can also tap a highlighted transition to choose its first connectible input, then output.
- **Remove** (red cross, just after the other tools) takes away an arc, place or transition; sources and sinks cannot be removed.
  Removed things fade out but finish what they are doing; a removed place loses its tokens.
  Cutting an arc leaves a loose end that can be connected elsewhere.
- **Auto** (clock) makes a transition fire on its own; tap it again with the same tool to make it faster. Small bars on the transition show the upgrades applied.
- **Capacity** (plus) grows a place to the next size, allowing it to hold more tokens, extending its build range (220, 264, then 308) and its arc reach (300, 360, then 420 units).
  The tool and free capacity rewards unlock at epoch 10.

You start in survival mode with 10 lives and 40 coins, shown as a heart and coin circle.
Each timed-out sink costs a life; at zero lives, the game freezes and shows your score.
Restart starts a fresh survival run, or choose endless to keep your network and score without life limits.
The `SKIP TO ENDLESS` button (`ENDLESS` in portrait) next to restart also lets you continue without lives after confirmation.
Endless mode keeps the heart counter, showing infinity instead of limited lives.
After leaving survival, the main score and epoch retain your survival totals; bracketed numbers show tokens delivered and epochs completed since switching.
Lost hearts fly from the HUD to the timed-out sink.
In survival mode, each sink in its countdown adds a colored exclamation mark beside the heart; tap it for a quick, smooth camera scroll to that sink.
The warning jumps during its final 15 seconds, and losing your last life triggers a slightly slower scroll to the dying sink.
Sink deaths briefly tint the screen in the sink's color.
The toolbar heart buys a life for 50 coins initially, rising by 10 per purchase, up to a maximum of 10 lives.
It appears only after your first lost life, then stays available in survival even if you recover to 10 lives.
From epoch 50, hearts rarely appear among rewards (2% of selections, doubled when you have 3 lives or fewer).

Paid automation, speed and capacity upgrades share a price starting at 5 coins; each successful paid upgrade increases the next price by 1 for the rest of the run.
If a build, conversion, upgrade or life purchase fails because you lack coins, the coin counter briefly shakes.
Exhausting a finite source earns 5 coins; removing a place earns one coin per settled token on it.
Removing an upgraded node refunds half its total upgrade costs, rounded to the nearest coin.
Flying coins show spending and earnings; ordinary building and wiring are free.

When a filled sink disappears, choose one of the two rewards at its position within two minutes.
Rewards include coins, free upgrades and limited-use transition tools; the selection grows as epochs progress.
From epoch 150, rewards can include 20 coins; below 50 coins, coin rewards have triple their normal selection weight.
The generic 2-to-3 transition preserves both input colors and duplicates the oldest token's color.
Free upgrades are used before paid upgrades. Limited transition tools still cost their displayed coin price when placed.
Tool badges show remaining free uses in green, limited paid uses in black, and the current coin price in orange.

An unconnected one-token place disappears after two minutes without interaction or token arrivals.
Connecting it or upgrading it to a larger size prevents this.

Restarting begins a fresh run and resets the endless score.

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
The [epoch overview](docs/DESIGN.md#epoch-progression) lists all progression thresholds.

## Code layout
- `src/core` — pure simulation: multisets, net model, `Simulation` (`fire`, `step(dt)`, auto-fire timers).
  No Pixi dependency.
- `src/game` — level definitions and `Game` rules (goals, source ramp, portrait transposition), plus building, removal and upgrade rules.
- `src/input` — `Controller`: brushes and taps to game actions.
- `src/render` — Pixi views (`NetView` with picking, `Hud` with toolbar) and styling.

## License
MIT — see [LICENSE](LICENSE).
