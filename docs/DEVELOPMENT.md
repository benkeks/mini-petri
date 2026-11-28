# Development notes

The [README](../README.md) introduces the game; [design notes](DESIGN.md) describe the detailed gameplay rules and Petri-net model.

## Running and building

```sh
npm install
npm run dev     # play at http://localhost:5173
npm test        # unit tests (Vitest)
npm run build   # type-check + production build
npm run preview # serve the production build locally
```

Vite builds the TypeScript and PixiJS application into `dist/`.
Asset paths are relative so deployment under a subpath, such as a GitHub Pages project site, works.

## Code layout

- [`src/core`](../src/core) implements the Petri-net structure, token binding and simulation.
- [`src/game`](../src/game) owns levels, progression, economy, statistics and saved sessions.
- [`src/input`](../src/input) implements controls, camera transforms and navigation.
- [`src/render`](../src/render) contains Pixi views, the HUD and DOM dialogs.
- [`src/main.ts`](../src/main.ts) connects these components and manages the application lifecycle.
- [`tests`](../tests) contains the Vitest regression tests.

## Simulation and rendering

The application advances gameplay in fixed 1/60-second steps, independently of rendering.
Firing atomically consumes inputs and reserves output capacity.
Consumed tokens travel into the transition; output tokens start moving only after all inputs have arrived.
Outputs count towards destination capacity immediately, but become available to other transitions only on arrival.
The simulation maintains per-place committed counts instead of scanning all travelling tokens and pending firings for each capacity check.
These counts are derived again on restore and released on arrival or transition removal.
Fire and completion subscriptions return unsubscribe functions; destroying a net view releases its subscriptions, including during orientation rebuilds.
See [continuous-time firing semantics](DESIGN.md#continuous-time-firing-semantics) for the full rules.

Arcs retain their normal solid rendering; only portions overlapped by unrelated live nodes are drawn again as dashed x-ray strokes above the node bodies at 50% opacity.
Segment clipping against place circles and oriented transition bars runs when the net's structure changes, not every frame.
Overlapping occlusion intervals are merged so the same hidden portion is not drawn twice.
X-ray dashes repeat every 12 world units, with a five-unit dash.
Travelling tokens render at 50% opacity above x-ray arcs while their actual animated centers are inside an occluding node, returning to full opacity outside it.
Occluder candidates are cached with the arc geometry; side-by-side token lanes are checked individually.
Hovering, pressing or selecting a node for wiring highlights its live incident arcs and their opposite endpoints, without following further connections; ordinary transition firing without a wiring selection does not trace connections.
Arc highlights render below node bodies; x-ray segments remain at 50% opacity and appear in saved thumbnails, while focus overlays are excluded.
Layer groups use Pixi `Container` objects; `Graphics` and `Text` remain leaf nodes, avoiding deprecated child nesting.

Visible arc routes, their bounds and weighted token-lane geometry are cached until `Net.version` changes.
Structural changes, movement, orientation changes and capacity upgrades must increment that version.
Picking uses cached routes and rejects distant arc bounds before measuring exact distances; the overlay and rewards share one pointer pick per update.
Incident-arc indexes preserve insertion order and include ghosts.
X-ray construction rejects disjoint node/arc bounds before running exact clipping.

Unchanged place graphics, stable transition graphics, HUD backplates and toolbar decorations are retained rather than cleared every frame.
Place markings are compared by value, so arrivals and direct marking mutations do not require a structural version bump.
Offscreen places, travelling-token drawings and ordinary transition bodies are culled with padding.
Sinks and finite sources still update their balance animation because travelling tokens can target those animated positions.

### Lightweight performance measurements

Run `npm run benchmark` for the opt-in [CPU benchmark](../tests/performance.measure.test.ts); it is skipped by ordinary `npm test`.
The fixture has 240 places, 240 transitions, 360 arcs and 720 travelling tokens, with three-token lanes on a deterministic grid.
Each measurement warms up first and reports the median and range of seven samples.
Frames retain the same synthetic flights rather than letting them arrive, allowing identical before/after workloads.
The reward case adds 12 offers and an active pointer; the small viewport covers only part of the grid.
Capacity/enabling measurements visit all nodes, and saving uses 20 in-memory sessions without thumbnail capture.

The following before/after medians were measured locally for this optimization pass.
They measure CPU-side work, not GPU rendering, real LocalStorage latency or phone frame rates.
Runtime warm-up, garbage collection and other work on the machine affect the absolute numbers.

| Workload | Before (ms) | After (ms) |
| --- | --- | --- |
| One pointer pick | 0.073 | 0.045 |
| Full-world view update | 8.147 | 2.335 |
| View update with rewards and pointer | 7.630 | 2.093 |
| Small-viewport view update | 6.157 | 0.304 |
| All enabling and occupancy queries | 3.068 | 0.166 |
| Structural rebuild and view update | 26.988 | 11.372 |
| Save with 20 sessions | 24.594 | 1.131 |

A separate Chromium/WebGL check measured HUD updates at 0.040 ms before and 0.013 ms after, using seven samples of 300 updates.
In that stable HUD workload, backplate and toolbar graphics clears fell from 7 per update to approximately 0.017; the remaining clears followed time-label changes.
A browser smoke check rendered 180 frames of weighted-token movement and panning, preserving all tokens and releasing all committed capacity and view listeners afterward.

The remaining static x-ray candidate scan is still quadratic in the worst case, though exact clipping is restricted to overlapping bounds.
Picking still scans live nodes; a spatial index, sprite-based token rendering or broader render caching should follow a real dense-game browser profile rather than adding complexity speculatively.

## Saved sessions

[`Saves`](../src/game/saves.ts) stores each session as a separate JSON entry in LocalStorage under `mini-petri:session:<id>`.
The save includes a format number, application version, start and save timestamps, name, epoch, delivery score, thumbnail and game snapshot.
Sessions are named by their local start day and a daily running number, starting at `01`, for example `2026-11-28::01`.
Names persist across subsequent saves; old hyphen-separated names are normalized without changing their storage IDs.
Legacy saves without start dates use their saved date as a fallback.
The picker displays save timestamps in the user's timezone as `YYYY-MM-DD HH:mm:ss`.
Updating an already named session reads only that session's previous metadata, not every saved game.
Legacy unnamed sessions still consult the list to preserve their assigned names, and loading parses the save JSON once.

The application saves once a minute, on `pagehide`, and when the document becomes hidden.
Restart saves the current session by default; opting out removes it before starting a new run.
A single compatible session loads automatically; multiple sessions, damaged saves or older major/minor versions open the picker.
Deletion requires confirmation.

[`Game.snapshot()`](../src/game/game.ts) preserves the net, progression, economy, inventory, offers, goals, countdowns and statistics.
[`Simulation.snapshot()`](../src/core/simulation.ts) preserves automatic timers, committed firings and in-flight tokens, so restoring does not duplicate or lose deliveries.
Transient rendering effects, build selections and camera positions are not serialized.
Infinite goal counts and ramp times use `null` in JSON and are restored to infinity.

Every application save captures the current game viewport as a 128x128 PNG, preserving its aspect ratio with background padding.
The HUD, build previews, range overlays and reward controls are excluded.
The picker displays smaller thumbnails for compact rows; old saves gain a thumbnail when next saved.
Capture temporarily suppresses UI layers and restores them even if extraction fails.

Older major/minor versions receive a compatibility warning; patch versions do not.
Save metadata and restored state are validated, and incompatible or damaged saves fail with a visible error rather than silently starting another game.
Storage failures are logged and reported through the HUD.
LocalStorage is specific to the browser origin and device, has limited capacity, and may be cleared or unavailable.

## Progressive web app

[`vite.config.ts`](../vite.config.ts) configures `vite-plugin-pwa`, the generated manifest and service worker.
The manifest requests fullscreen landscape display; actual support depends on the browser and platform.
The production service worker precaches application assets, including scripts, styles and fonts.
Test installation and offline behavior using a production build served over HTTPS or localhost rather than relying on the development server.
