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
See [continuous-time firing semantics](DESIGN.md#continuous-time-firing-semantics) for the full rules.

## Saved sessions

[`Saves`](../src/game/saves.ts) stores each session as a separate JSON entry in LocalStorage under `mini-petri:session:<id>`.
The save includes a format number, application version, start and save timestamps, name, epoch, delivery score, thumbnail and game snapshot.
Sessions are named by their local start day and a daily running number, starting at `01`, for example `2026-11-28::01`.
Names persist across subsequent saves; old hyphen-separated names are normalized without changing their storage IDs.
Legacy saves without start dates use their saved date as a fallback.
The picker displays save timestamps in the user's timezone as `YYYY-MM-DD HH:mm:ss`.

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
