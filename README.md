# 🎲 Tokyo Random Train

A dice game for exploring parts of Tokyo you'd never pick yourself.

1. Pick a start station (search, 📍 nearest, or 🎲 random).
2. **Roll 1 – which train:** a die picks one line + direction boardable from your station, including lines at stations within a short walk (default 5 min). At Asakusabashi you get the JR Chūō-Sōbu Line and the Ōedo Line, but not the Tōzai Line at Bakurocho (~9 min). The full option list is collapsed under the roll button; only the rolled train is shown. If only one train is possible, it is picked without a roll.
3. **Roll 2 – how far:** a d6 (configurable) picks how many stops to ride. The roll flickers through the reachable destination stations, then shows the stop count and destination. If only one stop count is possible, it is picked without a roll.
4. Get off, explore, repeat. Explore picks a random nearby Wikipedia place to go see (↻ for another, with walking directions), offers Google Maps searches around the station, and lists nearby Wikipedia articles (5 at a time, "Show more" for the next 5). Station/railway and school articles are skipped. If Wikipedia has nothing nearby, the suggestion is a random map search instead (e.g. 🍜 Ramen).
5. **🚶 Walked to another station?** Exploring often ends closer to a different station. Before rolling, open this section to pick the station you're at now. It lists the nearest stations by default (explored ones are tagged); search finds any station in the play area. The walk is recorded as its own step (dotted line on the map, "🚶 Walked to …" in the journey) and as a visit. It ends any same-line streak and doesn't count towards line fatigue. With re-rolls off, it's hidden once you've rolled, so it can't be used to dodge a roll. Undo removes it.

Screen order: current station, Explore (collapsed at the start station), map, then the rolls and the journey log. Explore reserves its height and shows placeholders plus a spinner while Wikipedia loads, so the roll button doesn't move when results arrive. Sections you open or close stay that way while rolling; Explore and the option list reset on arrival at a new station, while the map remembers its state.

The **EN / 日本語** toggle in the header switches the whole app: UI text, station and line names, directions, and the Wikipedia language (Japanese Wikipedia has far more local coverage). It defaults to the browser language.

Every station you land on is marked as explored for the rest of the trip, along with every station within the same walking distance. Faces that would land in an explored area, outside the play area, or past the end of the line are crossed out and re-rolled; lines with no open faces drop out of roll 1. If you get boxed in, the app offers a one-time "allow revisits" roll.

## Visit history and "only new stations"

Every station you start from or get off at is recorded with its date, across all trips (undo removes the visit again). The start screen shows **📊 Your stations**: each station with visit count and last visit, newest first, plus a "Clear history" button. Same-named platforms of one station (e.g. JR and Ōedo Asakusabashi) count as one station. During a trip, the station card says "✨ New station" or "Been here 2× before · last …".

Once there is history, the start screen offers **Only new stations**: for that trip, every station area from earlier trips counts as explored, with the same walking-distance rule as in-trip visits. On the stops die, these faces are filled grey ("explored on an earlier trip"), while stations explored on this trip keep the dashed crossed-out look. The walk list tags them "earlier trip" vs "explored". Exception: big hubs, stations with 5+ lines within the walk limit (about 29 in the default area, e.g. Tokyo, Shinjuku, Shibuya, Ikebukuro), stay open even if visited before, because blocking them would leave few places to change lines. They're tagged "🔁 hub" on the stops die. Hubs visited on the current trip are still blocked. The choice is remembered for the next trip.

The trip and history are saved in `localStorage` (per browser and device), so they survive closing the tab on your phone.

## Running

```sh
bun install
bun run dev        # dev server at http://localhost:3000
bun run build      # static site in dist/ (host anywhere, e.g. GitHub Pages)
bun test           # rule tests against the real network data
bun run typecheck
```

## Settings (⚙️)

- **Walk limit** (0–10 min): which nearby lines count as "at this station". This setting also controls how far around a visited station counts as explored.
- **Play area**: destinations further than this from Tokyo Station are out of bounds (default 20 km, roughly the 23 wards).
- **Stops die**: d4 to d12.
- **Minimum ride** (none, or at least 2–4 stops): shorter faces are skipped and shown hatched with a dotted border, unlike explored/out-of-area faces, which are crossed out. Explored wins: a short face that's also explored shows as explored. If a line can't go that far (terminus, explored stations, play area), the minimum is ignored for that line, so you're never stuck because of it.
- **Allow re-rolls** (off by default): when off, every roll is final; the re-roll buttons are hidden once a train or stop count is rolled. Turning it on doesn't cancel a pending roll. Changing the walk limit, play area or die does.
- **Nudge towards changing lines** (on by default): after 3 rides in a row on the same line, the dice favour changing. The train die gives other lines extra weight. If you stay on that line anyway (or it's the only one), the stops die gives extra weight to stops where another line is within walking distance. The weight starts at 2× after 3 rides and rises by 0.4 per ride to 4× after 8 (2×, 2.4×, 2.8×, 3.2×, 3.6×, 4×). The dice use these exact weights; badges and notes round to whole numbers (2.4× shows as ×2). Weighted options carry a ×N badge, and a note under the die explains why. Nothing is ever excluded, only made more likely.
- **Prefer less-visited lines** (on by default): every station you got off at on a line during this trip makes that line slightly less likely on the train die: 0.87×, 0.77×, 0.69×, … never below 0.5×, so long lines stay rollable. It multiplies with the line-change boost (e.g. after 3 Yamanote rides: other lines 2×, Yamanote 0.69×). Marked with ↓ (hover for details).
- **Show exact dice weights** (off by default): replaces the ↓ icons and whole-number badges with the exact combined weight, two decimals (×2.40, ×0.69).

## How "a short walk" is estimated

Each line's platform has its own coordinate. Walking time is straight-line distance × 1.25 (route detour) at 75 m/min (casual pace), plus 0.5 min when changing between a street-level and an underground platform.

Some big stations are badly off with that formula (deep platforms, long passages, or several platforms sharing one coordinate in the data). `src/data/transfers.ts` lists hand-estimated times for those platform pairs, which replace the formula: currently Tokyo (e.g. JR → Keiyō 12 min) and Shinjuku (e.g. JR → Ōedo 8 min). They're rough estimates. Edit the file to correct or extend it; an unknown station id fails the tests.

Same-named stations within 700 m always count as one station complex, whatever the walking time. The time shown is each platform's own estimate. For example, if Meiji-jingūmae's Chiyoda platform is within reach of Harajuku (5 min), its Fukutoshin platform is included too, shown as ~7 min.

## Data

- Network: [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d) (MIT), pinned to a commit in `scripts/build-data.ts`. It covers 168 lines across Tokyo Metro, Toei, JR East, the private railways, monorails, and trams. `bun run data` regenerates `src/data/network.json`. Through-service stops that belong to another line (e.g. Chiyoda Line trains continuing to Odakyu's Machida) are removed, so each line counts only its own stations.
- Nearby places: Wikipedia geosearch in the app language.
- Map: OpenStreetMap tiles via Leaflet.
