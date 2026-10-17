import "leaflet/dist/leaflet.css";
import L from "leaflet";
import networkData from "./data/network.json";
import { TRANSFER_CORRECTIONS } from "./data/transfers.ts";
import {
  Explorer,
  randomInt,
  weightedRandom,
  sameLineStreak,
  lineChangeWeight,
  lineFatigue,
  nameKey,
  distanceM,
  walkMinutes,
  COMPLEX_RADIUS_M,
  type Network,
  type RideOption,
  type Face,
  type TransferRide,
  type Restart,
} from "./network.ts";
import {
  loadState,
  saveState,
  newTrip,
  recordVisit,
  removeVisit,
  type AppState,
  type Trip,
  type Settings,
} from "./state.ts";
import { nearbySpots, MAP_SEARCHES, mapSearchUrl, walkingDirectionsUrl, type Spot } from "./explore.ts";
import { MESSAGES, type Lang, type Messages } from "./i18n.ts";

const explorer = new Explorer(networkData as Network, TRANSFER_CORRECTIONS);
const { stations, lines } = explorer;
const stationIndex = new Map(stations.map((s, i) => [s.id, i]));
const lineIndex = new Map(lines.map((l, i) => [l.id, i]));

const state: AppState = loadState((id) => stationIndex.has(id));
const app = document.querySelector<HTMLElement>("#app")!;
const mapSection = document.querySelector<HTMLDetailsElement>("#map-section")!;
const settingsDialog = document.querySelector<HTMLDialogElement>("#settings")!;
const settingsForm = document.querySelector<HTMLFormElement>("#settings-form")!;

let lang: Lang = state.settings.lang;
let t: Messages = MESSAGES[lang];
let rolling = false;
const spotsCache = new Map<string, Promise<Spot[]>>();
let complexCache: { areaKm: number | null; groups: number[][] } | null = null;
/** Wikipedia spots shown per "show more" page. */
const SPOTS_PAGE = 5;
/** Placeholder with the same box as a loaded spot, so the page doesn't jump when results arrive. */
const SKELETON_SPOT = `<div class="spot skeleton"><span class="noimg"></span>
  <span><span class="sk-line short"></span><span class="sk-line"></span><span class="sk-line"></span></span></div>`;

/**
 * UI state for the stop you're at: the suggestion picked per spot list, how many spots are
 * shown, and which collapsible sections the user opened or closed. Survives re-renders
 * (rolling), resets on arrival.
 */
let stop = { key: "", suggestions: {} as Record<string, number>, spotsShown: SPOTS_PAGE, open: {} as Record<string, boolean> };
/** The map's open state is not station-specific, so it persists across stops. */
let mapOpen = true;

const AREA_CHOICES = ["8", "12", "20", "35", "60", ""];
const DIE_CHOICES = [4, 6, 8, 10, 12];
const MIN_STOPS_CHOICES = [1, 2, 3, 4];

// ---------- helpers ----------

const esc = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function stationName(i: number): string {
  const s = stations[i]!;
  return lang === "ja" && s.nameJa ? s.nameJa : s.name;
}

/** The name in the other script, shown as a reading aid. */
function stationAltName(i: number): string {
  const s = stations[i]!;
  return lang === "ja" ? s.name : s.nameJa;
}

function lineBadge(index: number): string {
  const line = lines[index]!;
  const name = lang === "ja" && line.nameJa ? line.nameJa : line.name;
  const operator = lang === "ja" ? line.operatorJa : line.operator;
  return `<span class="line-badge" style="--line:${esc(line.color)}"><small>${esc(operator)}</small> ${esc(name)}</span>`;
}

function directionLabel(option: RideOption): string {
  const line = lines[option.line]!;
  if (line.loop) {
    if (lang === "ja") return option.dir === 1 ? line.ascJa : line.descJa;
    return option.dir === 1 ? line.asc : line.desc;
  }
  return t.towards(stationName(line.stations[option.dir === 1 ? line.stations.length - 1 : 0]!));
}

function walkLabel(minutes: number): string {
  return minutes < 0.5 ? t.here : t.walkMin(Math.max(1, Math.round(minutes)));
}

/** Weights carry decimals; by default the UI shows whole numbers, or two decimals for numbers fans. */
function shownWeight(weight: number): string {
  return state.settings.exactWeights ? weight.toFixed(2) : String(Math.round(weight));
}

/** Why a line + direction has no rollable face. */
function exhaustedLabel(faces: Face[]): string {
  const visited = faces.some((f) => f.blocked === "visited");
  const area = faces.some((f) => f.blocked === "area");
  if (visited && area) return t.exhausted.visitedAndArea;
  if (visited) return t.exhausted.visited;
  if (area) return t.exhausted.area;
  return t.exhausted.end;
}

function openAttr(section: string, fallback: boolean): string {
  return (stop.open[section] ?? fallback) ? " open" : "";
}

// ---------- trip model ----------

interface Choice {
  option: RideOption;
  faces: Face[];
  open: Face[];
  /** Train-die weight: line-change boost × line fatigue. */
  weight: number;
  /** Line-change boost for this option (1 if none). */
  boost: number;
  /** Line fatigue factor (1 if none) and the stations of this line visited on this trip. */
  fatigue: number;
  visitedOnLine: number;
}

/** Rides in a row on one line, and the resulting line-change weight. */
interface Streak {
  count: number;
  line: number;
  /** 1 when the nudge is off or the streak is too short. */
  weight: number;
}

interface TripView {
  /** Start plus every destination so far; the last one is where you are. */
  visited: number[];
  current: number;
  choices: Choice[];
  /** Choices with at least one rollable face. */
  open: Choice[];
  rolled: Choice | null;
  /** Stops-die weight per `rolled.open` face. */
  faceWeights: number[];
  /** The stops result; picked automatically when only one face is open. */
  face: Face | null;
  /** Stations off-limits as destinations (explored areas). */
  explored: Set<number>;
  /** Hubs from earlier trips that "only new stations" lets you land on again. */
  hubRevisits: Set<number>;
  /** Explored on this trip (a subset of `explored`; the rest comes from earlier trips). */
  tripExplored: Set<number>;
  streak: Streak;
  /** When no roll is open: rides to stations where another line still has unexplored stops. */
  transfers: TransferRide[];
  /** The rolled transfer (or the only one, picked automatically). */
  transfer: TransferRide | null;
  /** When no transfer helps either: the nearest stations to restart from. */
  restarts: Restart[];
}

function tripView(trip: Trip): TripView {
  const { settings } = state;
  const visited = [trip.start, ...trip.steps.map((s) => s.path.at(-1)!)].map((id) => stationIndex.get(id)!);
  const current = visited.at(-1)!;
  // With the escape hatch on, only the current station area stays off-limits.
  // "Only new stations" trips also rule out everywhere from earlier trips, except big hubs:
  // blocking those would leave few places to change lines.
  const explored = trip.allowRevisit
    ? explorer.visitedArea([current], settings.maxWalkMin)
    : explorer.visitedArea(visited, settings.maxWalkMin);
  const tripExplored = new Set(explored);
  const hubRevisits = new Set<number>();
  if (trip.onlyNew && !trip.allowRevisit) {
    const past = Object.keys(state.history).map((id) => stationIndex.get(id)!);
    for (const s of explorer.visitedArea(past, settings.maxWalkMin)) {
      if (explored.has(s)) continue;
      if (explorer.isHub(s, settings.maxWalkMin)) hubRevisits.add(s);
      else explored.add(s);
    }
  }

  // Walking to another station ends a same-line streak.
  const lastLine = trip.steps.at(-1)?.line;
  const count = lastLine ? sameLineStreak(trip.steps.map((s) => s.line ?? "")) : 0;
  const streak: Streak = {
    count,
    line: lastLine ? lineIndex.get(lastLine)! : -1,
    weight: settings.lineChangeBoost ? lineChangeWeight(count) : 1,
  };
  // Stations got off at on this trip, per line (the start and walks don't count: you didn't ride there).
  const visitedPerLine = new Map<number, number>();
  for (const step of trip.steps) {
    if (!step.line) continue;
    const line = stations[stationIndex.get(step.path.at(-1)!)!]!.line;
    visitedPerLine.set(line, (visitedPerLine.get(line) ?? 0) + 1);
  }

  const choices: Choice[] = explorer.options(current, settings.maxWalkMin).map((option) => {
    const faces = explorer.faces(option, settings, explored);
    const boost = option.line !== streak.line ? streak.weight : 1;
    const visitedOnLine = visitedPerLine.get(option.line) ?? 0;
    const fatigue = settings.preferFreshLines ? lineFatigue(visitedOnLine) : 1;
    return { option, faces, open: faces.filter((f) => !f.blocked), weight: boost * fatigue, boost, fatigue, visitedOnLine };
  });
  const open = choices.filter((c) => c.open.length > 0);
  // A single option needs no roll, same as a single stops face below.
  const rolled = open.length === 1 ? open[0]! : (open.find((c) => c.option.key === trip.rolledOption) ?? null);
  // Staying on the streak line: favour stops where you can change to another line.
  const faceWeights =
    rolled?.open.map((f) =>
      streak.weight > 1 &&
      rolled.option.line === streak.line &&
      explorer.hasOtherLine(f.path.at(-1)!, streak.line, settings.maxWalkMin)
        ? streak.weight
        : 1,
    ) ?? [];
  const face = !rolled
    ? null
    : rolled.open.length === 1
      ? rolled.open[0]!
      : (rolled.open.find((f) => f.stops === trip.rolledStops) ?? null);
  const transfers = open.length === 0 ? explorer.transfers(current, settings, explored) : [];
  const transfer =
    transfers.length === 1
      ? transfers[0]!
      : (transfers.find((tr) => transferKey(tr) === trip.rolledTransfer) ?? null);
  const restarts = open.length === 0 && transfers.length === 0 ? explorer.restarts(current, settings, explored, 3) : [];
  return {
    visited,
    current,
    choices,
    open,
    rolled,
    faceWeights,
    face,
    streak,
    explored,
    hubRevisits,
    tripExplored,
    transfers,
    transfer,
    restarts,
  };
}

function transferKey(tr: TransferRide): string {
  return `${tr.option.key}@${tr.stops}`;
}

function startTrip(station: number): void {
  const onlyNew = state.settings.onlyNew && Object.keys(state.history).length > 0;
  state.trip = newTrip(stations[station]!.id, onlyNew);
  recordVisit(state.history, state.trip.start, state.trip.startedAt);
  saveState(state);
  render();
  window.scrollTo({ top: 0 });
}

// ---------- visit history ----------

/** One real-world station in the history: same-named stations close together are one place. */
interface Place {
  stations: number[];
  /** Visit times, oldest first. */
  visits: string[];
}

function historyPlaces(): Place[] {
  const byName = new Map<string, Place[]>();
  for (const [id, visits] of Object.entries(state.history)) {
    const station = stationIndex.get(id)!;
    const key = explorer.keys[station]!;
    const sameName = byName.get(key) ?? [];
    let place = sameName.find((p) => distanceM(stations[p.stations[0]!]!, stations[station]!) <= COMPLEX_RADIUS_M);
    if (!place) {
      place = { stations: [], visits: [] };
      sameName.push(place);
      byName.set(key, sameName);
    }
    place.stations.push(station);
    place.visits.push(...visits);
  }
  const places = [...byName.values()].flat();
  for (const place of places) place.visits.sort();
  return places.sort((a, b) => b.visits.at(-1)!.localeCompare(a.visits.at(-1)!));
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", { dateStyle: "medium" }).format(new Date(iso));
}

function historyHtml(places: Place[]): string {
  const visits = places.reduce((sum, p) => sum + p.visits.length, 0);
  const rows = places
    .map(
      (p) => `<li><strong>${esc(stationName(p.stations[0]!))}</strong> <span class="ja">${esc(stationAltName(p.stations[0]!))}</span>
        <small class="muted">${t.historyRow(p.visits.length, formatDate(p.visits.at(-1)!))}</small></li>`,
    )
    .join("");
  return `
    <details class="card collapsible">
      <summary><h3>${t.history}</h3></summary>
      <p class="muted">${t.historySummary(places.length, visits)}</p>
      <ol class="history">${rows}</ol>
      <button data-action="clear-history">${t.clearHistory}</button>
    </details>`;
}

/** "New station" or "been here N× before" for where you are now. */
function visitNote(trip: Trip, current: number): string {
  const arrivedAt = trip.steps.at(-1)?.at ?? trip.startedAt;
  const here = stations[current]!;
  const place = historyPlaces().find((p) =>
    p.stations.some((s) => explorer.keys[s] === explorer.keys[current] && distanceM(stations[s]!, here) <= COMPLEX_RADIUS_M),
  );
  const before = place?.visits.filter((v) => v < arrivedAt) ?? [];
  return before.length ? t.visitedBefore(before.length, formatDate(before.at(-1)!)) : t.firstVisit;
}

// ---------- start screen ----------

function complexes(): number[][] {
  if (complexCache?.areaKm !== state.settings.areaKm) {
    complexCache = { areaKm: state.settings.areaKm, groups: explorer.complexes(state.settings.areaKm) };
  }
  return complexCache.groups;
}

function renderStart(): void {
  const places = historyPlaces();
  app.innerHTML = `
    <section class="card intro">
      <h2>${t.introTitle}</h2>
      <ol>${t.introSteps.map((step) => `<li>${step}</li>`).join("")}</ol>
    </section>
    <section class="card">
      ${places.length
        ? `<label class="check">
             <input type="checkbox" id="only-new"${state.settings.onlyNew ? " checked" : ""}>
             <span>${t.onlyNew}<br><small class="muted">${t.onlyNewHint(places.length)}</small></span>
           </label>`
        : ""}
      <label class="field">${t.startStation}
        <input id="station-search" type="search" placeholder="${esc(t.searchPlaceholder)}" autocomplete="off">
      </label>
      <div class="row">
        <button data-action="nearest">${t.nearest}</button>
        <button data-action="random-start">${t.surprise}</button>
      </div>
      <ul id="results" class="results"></ul>
    </section>
    ${places.length ? historyHtml(places) : ""}`;
  const input = app.querySelector<HTMLInputElement>("#station-search")!;
  input.addEventListener("input", () => renderResults(input.value));
  app.querySelector<HTMLInputElement>("#only-new")?.addEventListener("change", (event) => {
    state.settings.onlyNew = (event.target as HTMLInputElement).checked;
    saveState(state);
  });
}

function renderResults(query: string): void {
  const results = app.querySelector<HTMLElement>("#results")!;
  const key = nameKey(query);
  const raw = query.trim();
  if (!key && !raw) {
    results.innerHTML = "";
    return;
  }
  const matches = complexes()
    .map((group) => {
      const station = stations[group[0]!]!;
      const k = explorer.keys[group[0]!]!;
      const rank = key && k.startsWith(key) ? 0 : key && k.includes(key) ? 1 : station.nameJa.includes(raw) ? 2 : -1;
      return { group, station, rank };
    })
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.station.name.length - b.station.name.length)
    .slice(0, 15);
  results.innerHTML = matches.length
    ? matches
        .map(({ group }) => {
          const lineDots = [...new Set(group.map((i) => stations[i]!.line))]
            .map((l) => `<span class="dot" style="--line:${esc(lines[l]!.color)}"></span>`)
            .join("");
          return `<li><button data-action="start" data-station="${group[0]}">
            <span><strong>${esc(stationName(group[0]!))}</strong> <span class="ja">${esc(stationAltName(group[0]!))}</span></span>
            <span class="dots">${lineDots}</span></button></li>`;
        })
        .join("")
    : `<li class="muted">${t.noStationFound}</li>`;
}

// ---------- trip screen ----------

function renderTrip(trip: Trip): void {
  const view = tripView(trip);
  const stopKey = `${trip.startedAt}:${trip.steps.length}`;
  if (stop.key !== stopKey) stop = { key: stopKey, suggestions: {}, spotsShown: SPOTS_PAGE, open: {} };
  const stopNumber = trip.steps.length;

  app.innerHTML = `
    <section class="card here">
      <div class="eyebrow">${stopNumber ? t.stopNumber(stopNumber) : t.start} · ${t.explored(view.visited.length)}</div>
      <h2>${esc(stationName(view.current))} <span class="ja">${esc(stationAltName(view.current))}</span></h2>
      <div class="visit-note">${visitNote(trip, view.current)}</div>
    </section>
    ${exploreHtml(view, stopNumber === 0)}
    <div id="map-slot"></div>
    ${walkHtml(trip)}
    ${lineRollHtml(trip, view)}
    ${view.rolled ? stopsRollHtml(view, view.rolled, view.face) : ""}
    ${view.rolled && view.face ? goHtml(view.rolled, view.face) : ""}
    ${journeyHtml(trip)}`;

  app.querySelector("#map-slot")!.replaceWith(mapSection);
  const walkSearch = app.querySelector<HTMLInputElement>("#walk-search");
  if (walkSearch) {
    walkSearch.addEventListener("input", () => renderWalkResults(view, walkSearch.value));
    renderWalkResults(view, "");
  }
  mapSection.hidden = false;
  mapSection.open = mapOpen;
  loadSpots(view.current);
  updateMap(trip, view);
}

/** "Walked to another station": continue from a different station before rolling. */
function walkHtml(trip: Trip): string {
  // Once a roll is made and re-rolls are off, walking away would be a way to dodge it.
  const rollMade = trip.rolledOption !== null || trip.rolledStops !== null || Boolean(trip.rolledTransfer);
  if (rollMade && !state.settings.allowRerolls) return "";
  return `
    <details class="card collapsible walk" data-section="walk"${openAttr("walk", false)}>
      <summary><h3>${t.walkTitle}</h3></summary>
      <p class="muted small">${t.walkHint}</p>
      <input id="walk-search" class="search" type="search" placeholder="${esc(t.searchPlaceholder)}" autocomplete="off">
      <ul id="walk-results" class="results"></ul>
    </details>`;
}

let historyAreaCache: { key: string; area: Set<number> } | null = null;

/** Every station area in the visit history (all trips), for "earlier trip" tags. */
function historyArea(): Set<number> {
  const ids = Object.keys(state.history);
  const key = `${state.settings.maxWalkMin}:${ids.sort().join(",")}`;
  if (historyAreaCache?.key !== key) {
    const area = explorer.visitedArea(ids.map((id) => stationIndex.get(id)!), state.settings.maxWalkMin);
    historyAreaCache = { key, area };
  }
  return historyAreaCache.area;
}

/** Nearest stations first; with a query, matching stations (nearest first among equal matches). */
function renderWalkResults(view: TripView, query: string): void {
  const results = app.querySelector<HTMLElement>("#walk-results");
  if (!results) return;
  const here = stations[view.current]!;
  const pastArea = historyArea();
  const key = nameKey(query);
  const raw = query.trim();
  const hereGroup = (g: number[]) => g.some((i) => explorer.keys[i] === explorer.keys[view.current]) && distanceM(stations[g[0]!]!, here) <= COMPLEX_RADIUS_M;
  const matches = complexes()
    .filter((g) => !hereGroup(g))
    .map((group) => {
      const k = explorer.keys[group[0]!]!;
      const rank = !key && !raw ? 0 : key && k.startsWith(key) ? 0 : key && k.includes(key) ? 1 : stations[group[0]!]!.nameJa.includes(raw) ? 2 : -1;
      return { group, rank, distance: distanceM(here, stations[group[0]!]!) };
    })
    .filter((m) => m.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance)
    .slice(0, key || raw ? 10 : 8);
  results.innerHTML = matches.length
    ? matches
        .map(({ group, distance }) => {
          const lineDots = [...new Set(group.map((i) => stations[i]!.line))]
            .map((l) => `<span class="dot" style="--line:${esc(lines[l]!.color)}"></span>`)
            .join("");
          const tag = group.some((i) => view.tripExplored.has(i))
            ? ` <span class="tag">${t.exploredTag}</span>`
            : group.some((i) => pastArea.has(i))
              ? ` <span class="tag past">${t.exploredPastTag}</span>`
              : "";
          const minutes = Math.max(1, Math.round(walkMinutes(here, stations[group[0]!]!)));
          return `<li><button data-action="walk" data-station="${group[0]}">
            <span><strong>${esc(stationName(group[0]!))}</strong> <span class="ja">${esc(stationAltName(group[0]!))}</span>${tag}
              <br><small class="muted">${t.walkMin(minutes)} · ${(distance / 1000).toFixed(1)} km</small></span>
            <span class="dots">${lineDots}</span></button></li>`;
        })
        .join("")
    : `<li class="muted">${t.noStationFound}</li>`;
}

function exploreHtml(view: TripView, atStart: boolean): string {
  const here = stations[view.current]!;
  return `
    <details class="card collapsible explore" data-section="explore"${openAttr("explore", !atStart)}>
      <summary><h3>${esc(t.explore(stationName(view.current)))}</h3></summary>
      <div id="suggestion">
        <div class="suggestion" aria-busy="true">
          <div class="suggestion-head"><strong>${t.suggestion}</strong><span class="spinner" aria-label="${esc(t.loadingSpots)}"></span></div>
          ${SKELETON_SPOT}
          <span class="chip skeleton-chip">${t.loadingSpots}</span>
        </div>
      </div>
      <div class="chips">${MAP_SEARCHES.map(
        (s) => `<a class="chip" target="_blank" rel="noopener" href="${esc(mapSearchUrl(s.query, here))}">${s[lang]}</a>`,
      ).join("")}</div>
      <h4 class="spots-head">${t.nearbyWiki}</h4>
      <div id="spots" class="spots" aria-busy="true">${SKELETON_SPOT.repeat(SPOTS_PAGE)}</div>
    </details>`;
}

/** Train-die weight markers: ×N boost and ↓ fatigue icons, or one exact ×0.00 badge. */
function weightBadges(choice: Choice): string {
  const fatigueTitle = esc(t.fatigueTitle(choice.visitedOnLine, choice.fatigue.toFixed(2)));
  if (state.settings.exactWeights) {
    if (choice.weight === 1) return "";
    const cls = choice.weight < 1 ? "boost fatigue" : "boost";
    return ` <span class="${cls}"${choice.fatigue < 1 ? ` title="${fatigueTitle}"` : ""}>×${shownWeight(choice.weight)}</span>`;
  }
  return (
    (choice.boost > 1 ? ` <span class="boost">×${shownWeight(choice.boost)}</span>` : "") +
    (choice.fatigue < 1 ? ` <span class="fatigue-icon" title="${fatigueTitle}">↓</span>` : "")
  );
}

function optionCard(choice: Choice, face: number, extraClass = ""): string {
  const { option } = choice;
  const next = explorer.ride(option, 1)![0]!;
  return `<div class="option ${extraClass}">
    <span class="num">${face}</span>
    <span class="body">${lineBadge(option.line)}${weightBadges(choice)}<br>
      ${esc(directionLabel(option))} · ${t.next(esc(stationName(next)))}
      ${option.walkMin >= 0.5 ? `<br><small class="muted">${esc(t.from(stationName(option.board)))}</small>` : ""}</span>
    <span class="walk">${walkLabel(option.walkMin)}</span>
  </div>`;
}

function lineRollHtml(trip: Trip, view: TripView): string {
  const total = view.open.length;
  const rolledIndex = view.rolled ? view.open.indexOf(view.rolled) : -1;
  const slot = view.rolled
    ? optionCard(view.rolled, rolledIndex + 1, "chosen")
    : `<div class="option placeholder"><span class="num">?</span><span class="body">${t.rollPrompt(total)}</span></div>`;

  const items = view.open
    .map((choice, i) => `<li>${optionCard(choice, i + 1, i === rolledIndex ? "chosen" : "")}</li>`)
    .join("");
  const blockedItems = view.choices
    .filter((c) => c.open.length === 0)
    .map(
      ({ option, faces }) => `<li><div class="option blocked">
        <span class="num">✕</span>
        <span class="body">${lineBadge(option.line)}<br>${esc(directionLabel(option))}</span>
        <span class="walk">${exhaustedLabel(faces)}</span>
      </div></li>`,
    )
    .join("");

  if (total === 0) return stuckHtml(trip, view, blockedItems);

  return `
    <section class="card">
      <h3><span class="step">1</span> ${t.whichTrain}</h3>
      <p class="muted">${t.rollSummary(total, state.settings.maxWalkMin)}${trip.onlyNew ? t.onlyNewActive : ""}${trip.allowRevisit ? t.revisitsAllowed : ""}</p>
      <div id="line-slot" class="roll-slot">${slot}</div>
      ${total > 1 && view.open.some((c) => c.boost > 1)
        ? `<p class="boost-note">${t.boostTrains(view.streak.count, lineBadge(view.streak.line), shownWeight(view.streak.weight))}</p>`
        : ""}
      ${total > 1 && view.open.some((c) => c.fatigue < 1) ? `<p class="boost-note">${t.fatigueNote}</p>` : ""}
      ${total === 1 ? `<p class="muted small">${t.onlyOneTrain}</p>` : ""}
      ${total > 1 && (!view.rolled || state.settings.allowRerolls)
        ? `<button class="primary" data-action="roll-line">${view.rolled ? t.rerollTrain : t.rollTrain}</button>`
        : ""}
      ${view.choices.length
        ? `<details class="all-options" data-section="lines"${openAttr("lines", false)}>
             <summary>${t.showAll(view.choices.length)}</summary>
             <ol class="options">${items}${blockedItems}</ol>
           </details>`
        : ""}
    </section>`;
}

/** A transfer ride: line, how far, where, and (in lists) which lines you can change to there. */
function transferCard(tr: TransferRide, extraClass = "", withOnward = true): string {
  const dest = tr.path.at(-1)!;
  const onward = [...new Set(tr.onward.map((o) => o.line))].map(lineBadge).join(" ");
  return `<div class="option stop-card ${extraClass}">
    <span class="num">${tr.stops}</span>
    <span class="body">${lineBadge(tr.option.line)} ${esc(directionLabel(tr.option))}<br>
      → <strong>${esc(stationName(dest))}</strong> <span class="ja">${esc(stationAltName(dest))}</span>
      <small class="muted">(${t.stops(tr.stops)})</small>
      ${withOnward ? `<br><small class="muted">${t.transferOnward}</small> ${onward}` : ""}</span>
  </div>`;
}

/** Shortest direct ride from here to `station` (or its same-named platforms), if any line goes there. */
function directRide(view: TripView, station: number): { option: RideOption; stops: number } | null {
  const target = stations[station]!;
  let best: { option: RideOption; stops: number } | null = null;
  for (const { option } of view.choices) {
    const line = lines[option.line]!;
    for (let stops = 1; stops < line.stations.length && stops < (best?.stops ?? Infinity); stops++) {
      const s = explorer.ride(option, stops)?.at(-1);
      if (s === undefined) break; // past the terminus
      if (explorer.keys[s] === explorer.keys[station] && distanceM(stations[s]!, target) <= COMPLEX_RADIUS_M) {
        best = { option, stops };
        break;
      }
    }
  }
  return best;
}

/**
 * Every roll from here is explored. Replaces the normal "Which train?" card with a clearly
 * different one: roll for a transfer, or walk to a nearby station, or (last) allow revisits.
 */
function stuckHtml(trip: Trip, view: TripView, blockedItems: string): string {
  const revisitHelps = view.choices.some((c) => c.faces.some((f) => f.blocked === "visited"));
  const revisit = revisitHelps
    ? `<p class="muted small fallback">${t.revisitFallback} <button data-action="allow-revisit">${t.allowRevisit}</button></p>`
    : "";
  const why = view.choices.length
    ? `<details class="all-options" data-section="lines"${openAttr("lines", false)}>
         <summary>${t.whyStuck(view.choices.length)}</summary>
         <ol class="options">${blockedItems}</ol>
       </details>`
    : "";

  let body: string;
  if (view.transfers.length) {
    const tr = view.transfer;
    const single = view.transfers.length === 1;
    const slot = tr
      ? transferCard(tr, "chosen", false)
      : `<div class="option placeholder"><span class="num">?</span><span class="body">${t.transferPrompt(view.transfers.length)}</span></div>`;
    const canRoll = !single && (!tr || state.settings.allowRerolls);
    const list = view.transfers.map((x) => `<li>${transferCard(x, x === tr ? "chosen" : "")}</li>`).join("");
    const go = tr
      ? `<p class="transfer-go">${t.transferGo({
          badge: lineBadge(tr.option.line),
          direction: esc(directionLabel(tr.option)),
          stops: tr.stops,
          dest: esc(stationName(tr.path.at(-1)!)),
          onward: [...new Set(tr.onward.map((o) => o.line))].map(lineBadge).join(" "),
        })}</p>
         <button class="primary big" data-action="arrive-transfer">${esc(t.gotOffTransfer(stationName(tr.path.at(-1)!)))}</button>`
      : "";
    body = `
      <p class="stuck-what">${t.stuckWhat}</p>
      <p class="stuck-now">${t.transferPlan}</p>
      <div id="transfer-slot" class="roll-slot">${slot}</div>
      ${single ? `<p class="muted small">${t.onlyOneTransfer}</p>` : ""}
      ${canRoll ? `<button class="primary" data-action="roll-transfer">${tr ? t.rerollTransfer : t.rollTransfer}</button>` : ""}
      ${go}
      <details class="all-options" data-section="transfers"${openAttr("transfers", false)}>
        <summary>${t.showAllTransfers(view.transfers.length)}</summary>
        <ol class="options">${list}</ol>
      </details>`;
  } else if (view.restarts.length) {
    const here = stations[view.current]!;
    const rows = view.restarts
      .map(({ station, distanceM: d }) => {
        const ride = directRide(view, station);
        const minutes = Math.max(1, Math.round(walkMinutes(here, stations[station]!)));
        const rideButton = ride
          ? `<button data-action="ride-to" data-option="${esc(ride.option.key)}" data-stops="${ride.stops}">
               ${lineBadge(ride.option.line)} ${t.rideThere(ride.stops)}</button>`
          : "";
        return `<li class="restart">
          <span><strong>${esc(stationName(station))}</strong> <span class="ja">${esc(stationAltName(station))}</span>
            <br><small class="muted">${(d / 1000).toFixed(1)} km</small></span>
          <span class="row">
            <button data-action="walk" data-station="${station}">${t.walkThere(minutes)}</button>
            ${rideButton}
          </span></li>`;
      })
      .join("");
    body = `
      <p class="stuck-what">${t.restartWhat}</p>
      <p class="stuck-now">${t.restartPlan}</p>
      <ol class="restarts">${rows}</ol>`;
  } else {
    body = `<p class="stuck-what">${t.stuckSettings}</p>`;
  }

  return `
    <section class="card stuck">
      <h3><span class="step">!</span> ${t.stuckTitle}</h3>
      ${body}
      ${revisit}
      ${why}
    </section>`;
}

/** The stops result: the count, big, and where it takes you. */
function stopCard(face: Face, hubRevisits: Set<number>, extraClass = ""): string {
  const dest = face.path.at(-1)!;
  const hub = hubRevisits.has(dest) ? ` <span class="tag" title="${esc(t.hubTitle)}">${t.hubTag}</span>` : "";
  return `<div class="option stop-card ${extraClass}">
    <span class="num">${face.stops}</span>
    <span class="body"><strong>${esc(stationName(dest))}</strong> <span class="ja">${esc(stationAltName(dest))}</span>${hub}<br>
      <small class="muted">${t.stops(face.stops)}</small></span>
  </div>`;
}

function stopsRollHtml(view: TripView, choice: Choice, face: Face | null): string {
  const weightByStops = new Map(choice.open.map((f, i) => [f.stops, view.faceWeights[i]!]));
  const faces = choice.faces
    .map((f) => {
      const weight = weightByStops.get(f.stops) ?? 1;
      const past = f.blocked === "visited" && !view.tripExplored.has(f.path.at(-1)!);
      const cls = [f.blocked ? `blocked ${f.blocked}` : "open", past ? "past" : "", face?.stops === f.stops ? "chosen" : "", weight > 1 ? "boosted" : ""];
      const dest = f.path.length ? stationName(f.path.at(-1)!) : "";
      const hub = !f.blocked && view.hubRevisits.has(f.path.at(-1)!) ? ` (${t.hubTag})` : "";
      const reason = past ? t.blockedPast : f.blocked ? t.blocked[f.blocked] : "";
      const title = f.blocked ? `${dest ? `${dest}: ` : ""}${reason}` : dest + hub;
      const boost = weight > 1 ? ` data-boost="×${shownWeight(weight)}"` : "";
      return `<div class="face ${cls.join(" ")}" title="${esc(title)}"${boost}>${f.stops}</div>`;
    })
    .join("");
  const single = choice.open.length === 1;
  const boosted = !single && view.faceWeights.some((w) => w > 1);
  const hasShort = choice.faces.some((f) => f.blocked === "short");
  const hasPast = choice.faces.some((f) => f.blocked === "visited" && !view.tripExplored.has(f.path.at(-1)!));
  const slot = face
    ? stopCard(face, view.hubRevisits, "chosen")
    : `<div class="option placeholder"><span class="num">?</span><span class="body">${t.stopsPrompt(choice.open.length)}</span></div>`;
  return `
    <section class="card" id="step-stops">
      <h3><span class="step">2</span> ${t.howFar}</h3>
      <p>${lineBadge(choice.option.line)} ${esc(directionLabel(choice.option))}</p>
      <div id="stops-slot" class="roll-slot">${slot}</div>
      ${boosted ? `<p class="boost-note">${t.boostStops(view.streak.count, lineBadge(view.streak.line), shownWeight(view.streak.weight))}</p>` : ""}
      <div class="dice">${faces}</div>
      <p class="muted small legend">
        ${single ? t.onlyOneFace : `<span class="face mini blocked visited">✕</span> ${t.legendBlocked}`}
        ${hasShort && !single ? `<span class="face mini blocked short">·</span> ${t.legendShort}` : ""}
        ${hasPast && !single ? `<span class="face mini blocked visited past">✕</span> ${t.legendPast}` : ""}
        ${boosted ? `<span class="face mini boosted-mini">×</span> ${t.legendBoost(shownWeight(view.streak.weight))}` : ""}
      </p>
      ${single || (face && !state.settings.allowRerolls)
        ? ""
        : `<button class="primary" data-action="roll-stops">${face ? t.rerollStops : t.rollStops}</button>`}
    </section>`;
}

function goHtml(choice: Choice, face: Face): string {
  const { option } = choice;
  const stops = face.path
    .map(
      (i, n) =>
        `<li class="${n === face.path.length - 1 ? "dest" : ""}">${esc(stationName(i))} <span class="ja">${esc(stationAltName(i))}</span></li>`,
    )
    .join("");
  return `
    <section class="card go" id="step-go">
      <h3><span class="step">3</span> ${t.go}</h3>
      <p>${t.goSentence({
        walkMin: option.walkMin >= 0.5 ? Math.max(1, Math.round(option.walkMin)) : null,
        board: esc(stationName(option.board)),
        badge: lineBadge(option.line),
        direction: esc(directionLabel(option)),
        stops: face.stops,
      })}</p>
      <ol class="stops">${stops}</ol>
      <button class="primary big" data-action="arrive">${esc(t.gotOff(stationName(face.path.at(-1)!)))}</button>
    </section>`;
}

/** Marker label for the n-th visited station: "S" for the start, then the stop number. */
function stopLabel(n: number): string {
  return n === 0 ? "S" : String(n);
}

function journeyHtml(trip: Trip): string {
  const timeFormat = new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", { hour: "2-digit", minute: "2-digit" });
  const steps = trip.steps
    .map((step, i) => {
      const dest = stationIndex.get(step.path.at(-1)!)!;
      const label = `<span class="stop-marker inline"><span>${stopLabel(i + 1)}</span></span>`;
      const time = `<small class="muted">${timeFormat.format(new Date(step.at))}</small>`;
      if (!step.line) return `<li>${label} ${t.walkedTo(esc(stationName(dest)))} ${time}</li>`;
      return `<li>${label}
        ${lineBadge(lineIndex.get(step.line)!)} ${t.stops(step.stops)} → <strong>${esc(stationName(dest))}</strong> ${time}</li>`;
    })
    .join("");
  return `
    <section class="card">
      <h3>${t.journey}</h3>
      <ol class="journey"><li><span class="stop-marker inline"><span>${stopLabel(0)}</span></span>
        ${t.journeyStart} <strong>${esc(stationName(stationIndex.get(trip.start)!))}</strong></li>${steps}</ol>
      <div class="row">
        ${trip.steps.length ? `<button data-action="undo">${t.undo}</button>` : ""}
        <button data-action="end-trip">${t.endTrip}</button>
      </div>
    </section>`;
}

function spotHtml(s: Spot): string {
  return `<a class="spot" href="${esc(s.url)}" target="_blank" rel="noopener">
    ${s.thumbnail ? `<img src="${esc(s.thumbnail)}" alt="" loading="lazy">` : `<span class="noimg">📍</span>`}
    <span><span class="title-line"><strong>${esc(s.title)}</strong> <small class="muted">${Math.round(s.distanceM / 50) * 50} m</small></span>
    <small class="snippet">${esc(s.description || s.extract)}</small></span></a>`;
}

/**
 * A random place to head for: one of the nearby articles, or a map search when
 * Wikipedia has nothing (or is unreachable).
 */
function suggestionHtml(key: string, station: number, spots: Spot[]): string {
  const count = spots.length || MAP_SEARCHES.length;
  const index = (stop.suggestions[key] ??= randomInt(count));
  const another =
    count > 1 ? `<button class="icon" data-action="new-suggestion" title="${esc(t.anotherSuggestion)}">↻</button>` : "";
  const here = stations[station]!;
  const spot = spots[index];
  if (!spot) {
    const search = MAP_SEARCHES[index]!;
    return `<div class="suggestion"><div class="suggestion-head"><strong>${t.suggestSearch}</strong>${another}</div>
      <a class="chip" target="_blank" rel="noopener" href="${esc(mapSearchUrl(search.query, here))}">${search[lang]}</a></div>`;
  }
  return `<div class="suggestion"><div class="suggestion-head"><strong>${t.suggestion}</strong>${another}</div>
    ${spotHtml(spot)}
    <a class="chip" target="_blank" rel="noopener" href="${esc(walkingDirectionsUrl(here, spot.at))}">${t.directions}</a></div>`;
}

function loadSpots(station: number): void {
  const key = `${lang}:${station}`;
  let promise = spotsCache.get(key);
  if (!promise) {
    promise = nearbySpots(stations[station]!, lang);
    spotsCache.set(key, promise);
    promise.catch(() => spotsCache.delete(key));
  }
  const container = app.querySelector<HTMLElement>("#spots")!;
  const suggestion = app.querySelector<HTMLElement>("#suggestion")!;
  container.dataset.key = key;
  // Stale if the user moved on (or switched language) before Wikipedia answered.
  const stale = () => container.dataset.key !== key || !container.isConnected;
  promise.then(
    (spots) => {
      if (stale()) return;
      suggestion.innerHTML = suggestionHtml(key, station, spots);
      container.removeAttribute("aria-busy");
      const remaining = spots.length - stop.spotsShown;
      container.innerHTML = spots.length
        ? spots.slice(0, stop.spotsShown).map(spotHtml).join("") +
          (remaining > 0 ? `<button data-action="more-spots">${t.showMoreSpots(Math.min(SPOTS_PAGE, remaining))}</button>` : "")
        : `<p class="muted">${t.noSpots}</p>`;
    },
    () => {
      if (stale()) return;
      suggestion.innerHTML = suggestionHtml(key, station, []);
      container.removeAttribute("aria-busy");
      container.innerHTML = `<p class="muted">${t.wikiError}</p>`;
    },
  );
}

// ---------- map ----------

let map: L.Map | null = null;
let mapLayer: L.LayerGroup | null = null;
/** Framing for the current route; applied once per route change, and only while the map is visible. */
let framing: { key: string; bounds: L.LatLngBounds | null; center: L.LatLngTuple } | null = null;
let framedKey = "";
/** Zoom level from which stop markers show their numbers. */
const NUMBER_ZOOM = 14;

function frameMap(): void {
  if (!map || !framing || !mapSection.open || framing.key === framedKey) return;
  map.invalidateSize();
  framedKey = framing.key;
  if (framing.bounds) map.fitBounds(framing.bounds, { padding: [30, 30], maxZoom: 15 });
  else map.setView(framing.center, 14);
}

function updateMap(trip: Trip, view: TripView): void {
  const latlng = (i: number): L.LatLngTuple => [stations[i]!.lat, stations[i]!.lng];
  if (!map) {
    map = L.map("map").setView(latlng(view.current), 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    mapLayer = L.layerGroup().addTo(map);
    // Numbers only from street level; zoomed out they'd clutter the route.
    const syncZoom = () => map!.getContainer().classList.toggle("show-numbers", map!.getZoom() >= NUMBER_ZOOM);
    map.on("zoomend", syncZoom);
    syncZoom();
  }
  map.invalidateSize();
  mapLayer!.clearLayers();
  const points: L.LatLngTuple[] = [];

  let previous = stationIndex.get(trip.start)!;
  const walkStyle: L.PolylineOptions = { color: "#666", dashArray: "2 6", weight: 3 };
  for (const step of trip.steps) {
    const board = stationIndex.get(step.board)!;
    const path = step.path.map((id) => stationIndex.get(id)!);
    if (!step.line) {
      // Walked to another station: a dotted line, like the short walk to a nearby platform.
      L.polyline([latlng(previous), latlng(path[0]!)], walkStyle).addTo(mapLayer!);
      points.push(latlng(path[0]!));
      previous = path[0]!;
      continue;
    }
    const color = lines[lineIndex.get(step.line)!]!.color;
    if (board !== previous) L.polyline([latlng(previous), latlng(board)], walkStyle).addTo(mapLayer!);
    const coords = [board, ...path].map(latlng);
    L.polyline(coords, { color, weight: 6, opacity: 0.9 }).addTo(mapLayer!);
    points.push(...coords);
    previous = path.at(-1)!;
  }
  const pending = view.rolled && view.face
    ? { option: view.rolled.option, path: view.face.path }
    : view.transfer;
  if (pending) {
    const coords = [pending.option.board, ...pending.path].map(latlng);
    L.polyline(coords, { color: lines[pending.option.line]!.color, weight: 5, dashArray: "8 8", opacity: 0.8 }).addTo(mapLayer!);
    points.push(...coords);
  }
  // Numbered in travel order: S for the start, then the stop number (same as "Stop N" and the journey log).
  // Repeat visits to one station (any of its platforms) share a marker that lists every visit.
  const places: { station: number; labels: string[]; current: boolean }[] = [];
  view.visited.forEach((v, i) => {
    let place = places.find(
      (p) => explorer.keys[p.station] === explorer.keys[v] && distanceM(stations[p.station]!, stations[v]!) <= COMPLEX_RADIUS_M,
    );
    if (!place) places.push((place = { station: v, labels: [], current: false }));
    place.labels.push(stopLabel(i));
    place.current ||= i === view.visited.length - 1;
  });
  places.forEach((p, i) => {
    const multi = p.labels.length > 1;
    const icon = L.divIcon({
      className: `stop-marker${p.current ? " current" : ""}${multi ? " multi" : ""}`,
      html: `<span>${p.labels.at(-1)}</span>`,
      iconSize: [28, 28],
    });
    const name = esc(p.current ? t.youAreHere(stationName(p.station)) : stationName(p.station));
    L.marker(latlng(p.station), { icon, zIndexOffset: p.current ? 1000 : i })
      .bindTooltip(multi ? `${name}<br>${t.visitedAtStops(p.labels.join(", "))}` : name)
      .addTo(mapLayer!);
    points.push(latlng(p.station));
  });

  // Re-frame only when the route changes, so manual panning sticks between renders.
  framing = {
    key: `${trip.startedAt}:${trip.steps.length}:${pending ? pending.option.key + pending.path.length : ""}`,
    bounds: points.length > 1 ? L.latLngBounds(points) : null,
    center: latlng(view.current),
  };
  frameMap();
}

// ---------- dice animation ----------

/** Flicker through `count` candidates via `show`, decelerating onto `final`. */
async function spin(count: number, final: number, show: (i: number) => void): Promise<void> {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || count < 2) return;
  const steps = 14 + count;
  for (let k = 0; k <= steps; k++) {
    show((((final - steps + k) % count) + count) % count);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 45 + 260 * (k / steps) ** 3);
    await promise;
  }
}

// ---------- actions ----------

function clearRolls(trip: Trip): void {
  trip.rolledOption = null;
  trip.rolledStops = null;
  trip.rolledTransfer = null;
}

/** Travel a ride: log it, record the visit, and start fresh at the destination. */
function recordStep(trip: Trip, option: RideOption, stops: number, path: number[]): void {
  const at = new Date().toISOString();
  const ids = path.map((i) => stations[i]!.id);
  trip.steps.push({ line: lines[option.line]!.id, board: stations[option.board]!.id, stops, path: ids, at });
  recordVisit(state.history, ids.at(-1)!, at);
  clearRolls(trip);
  trip.allowRevisit = false;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function handleAction(action: string, target: HTMLElement): Promise<void> {
  const trip = state.trip;
  switch (action) {
    case "start":
      startTrip(Number(target.dataset.station));
      return;
    case "clear-history":
      if (!confirm(t.confirmClearHistory)) return;
      state.history = {};
      saveState(state);
      render();
      return;
    case "random-start": {
      const groups = complexes();
      startTrip(groups[randomInt(groups.length)]![0]!);
      return;
    }
    case "nearest":
      if (!navigator.geolocation) return alert(t.locationUnavailable);
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          const me = { lat: coords.latitude, lng: coords.longitude };
          let best = -1;
          let bestDistance = Infinity;
          stations.forEach((s, i) => {
            const d = distanceM(me, s);
            if (d < bestDistance && explorer.inArea(i, state.settings.areaKm)) [best, bestDistance] = [i, d];
          });
          if (best >= 0) startTrip(best);
        },
        (error) => alert(t.locationError(error.message)),
        { enableHighAccuracy: true, timeout: 10_000 },
      );
      return;
  }

  if (!trip) return;
  let reveal: string | null = null;
  switch (action) {
    case "roll-line": {
      const view = tripView(trip);
      if (!view.open.length || (view.rolled && !state.settings.allowRerolls)) return;
      const pick = weightedRandom(view.open.map((c) => c.weight));
      const slot = app.querySelector<HTMLElement>("#line-slot")!;
      const cards = view.open.map((choice, i) => optionCard(choice, i + 1, "spinning"));
      await spin(cards.length, pick, (i) => (slot.innerHTML = cards[i]!));
      trip.rolledOption = view.open[pick]!.option.key;
      trip.rolledStops = null;
      reveal = view.open[pick]!.open.length === 1 ? "#step-go" : "#step-stops";
      break;
    }
    case "roll-stops": {
      const { rolled, face, faceWeights, hubRevisits } = tripView(trip);
      if (!rolled || (face && !state.settings.allowRerolls)) return;
      const pick = weightedRandom(faceWeights);
      const slot = app.querySelector<HTMLElement>("#stops-slot")!;
      const faces = [...app.querySelectorAll<HTMLElement>(".face.open")];
      const cards = rolled.open.map((f) => stopCard(f, hubRevisits, "spinning"));
      await spin(cards.length, pick, (i) => {
        slot.innerHTML = cards[i]!;
        faces.forEach((el, j) => el.classList.toggle("spinning", i === j));
      });
      trip.rolledStops = rolled.open[pick]!.stops;
      reveal = "#step-go";
      break;
    }
    case "arrive": {
      const { rolled, face } = tripView(trip);
      if (!rolled || !face) return;
      recordStep(trip, rolled.option, face.stops, face.path);
      break;
    }
    case "roll-transfer": {
      const { transfers, transfer } = tripView(trip);
      if (transfers.length < 2 || (transfer && !state.settings.allowRerolls)) return;
      const pick = randomInt(transfers.length);
      const slot = app.querySelector<HTMLElement>("#transfer-slot")!;
      const cards = transfers.map((tr) => transferCard(tr, "spinning", false));
      await spin(cards.length, pick, (i) => (slot.innerHTML = cards[i]!));
      trip.rolledTransfer = transferKey(transfers[pick]!);
      break;
    }
    case "arrive-transfer": {
      const { transfer } = tripView(trip);
      if (!transfer) return;
      recordStep(trip, transfer.option, transfer.stops, transfer.path);
      break;
    }
    case "ride-to": {
      // A chosen (not rolled) ride to a suggested restart station, offered only when stuck.
      const view = tripView(trip);
      if (view.open.length || view.transfers.length) return;
      const option = view.choices.find((c) => c.option.key === target.dataset.option)?.option;
      const stops = Number(target.dataset.stops);
      const path = option && explorer.ride(option, stops);
      if (!option || !path) return;
      recordStep(trip, option, stops, path);
      break;
    }
    case "walk": {
      const from = tripView(trip).current;
      const dest = stations[Number(target.dataset.station)]!.id;
      const at = new Date().toISOString();
      trip.steps.push({ line: null, board: stations[from]!.id, stops: 0, path: [dest], at });
      recordVisit(state.history, dest, at);
      clearRolls(trip);
      trip.allowRevisit = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
      break;
    }
    case "allow-revisit":
      trip.allowRevisit = true;
      clearRolls(trip);
      break;
    case "undo": {
      if (!confirm(t.confirmUndo)) return;
      const undone = trip.steps.pop();
      if (undone) removeVisit(state.history, undone.path.at(-1)!, undone.at);
      clearRolls(trip);
      break;
    }
    case "end-trip":
      if (!confirm(t.confirmEnd)) return;
      state.trip = null;
      break;
    case "more-spots":
      // Reveal in place; a full re-render would flash the list back to "loading".
      stop.spotsShown += SPOTS_PAGE;
      loadSpots(tripView(trip).current);
      return;
    case "new-suggestion": {
      const current = tripView(trip).current;
      const key = `${lang}:${current}`;
      const spots = (await spotsCache.get(key)?.catch(() => [])) ?? [];
      const count = spots.length || MAP_SEARCHES.length;
      // Shift by 1..count-1 so the new pick always differs.
      if (count > 1) stop.suggestions[key] = ((stop.suggestions[key] ?? 0) + 1 + randomInt(count - 1)) % count;
      loadSpots(current);
      return;
    }
    default:
      return;
  }
  saveState(state);
  render();
  if (reveal) document.querySelector(reveal)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

app.addEventListener("click", async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target || rolling) return;
  rolling = true;
  app.classList.add("rolling");
  try {
    await handleAction(target.dataset.action!, target);
  } finally {
    rolling = false;
    app.classList.remove("rolling");
  }
});

// `toggle` doesn't bubble; capture it to remember what the user opened or closed.
document.addEventListener(
  "toggle",
  (event) => {
    const details = event.target as HTMLDetailsElement;
    const section = details.dataset.section;
    if (!section) return;
    if (section === "map") {
      mapOpen = details.open;
      frameMap();
    } else {
      stop.open[section] = details.open;
    }
  },
  true,
);

// ---------- language ----------

function applyChrome(): void {
  document.documentElement.lang = lang;
  document.title = t.appTitle;
  document.querySelector("#app-title")!.textContent = t.appTitle;
  document.querySelector("#map-title")!.textContent = t.map;
  document.querySelector("#footer")!.innerHTML = t.footer;
  const settingsButton = document.querySelector<HTMLElement>("#settings-button")!;
  settingsButton.title = t.settings;
  settingsButton.setAttribute("aria-label", t.settings);
  for (const button of document.querySelectorAll<HTMLElement>("#lang-toggle button")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
  }
}

document.querySelector("#lang-toggle")!.addEventListener("click", (event) => {
  const choice = (event.target as HTMLElement).closest<HTMLElement>("[data-lang]")?.dataset.lang;
  if (rolling || (choice !== "en" && choice !== "ja") || choice === lang) return;
  lang = state.settings.lang = choice;
  t = MESSAGES[lang];
  saveState(state);
  applyChrome();
  render();
});

// ---------- settings ----------

document.querySelector("#settings-button")!.addEventListener("click", () => {
  const s = state.settings;
  const area = s.areaKm === null ? "" : String(s.areaKm);
  settingsForm.innerHTML = `
    <h2>${t.settingsTitle}</h2>
    <label class="field">
      <span>${t.walkLimit} <output>${s.maxWalkMin}</output> ${t.minutes}</span>
      <input type="range" name="maxWalkMin" min="0" max="10" step="1" value="${s.maxWalkMin}">
    </label>
    <label class="field">${t.area}
      <select name="areaKm">${AREA_CHOICES.map(
        (value) => `<option value="${value}"${value === area ? " selected" : ""}>${t.areaOptions[value]}</option>`,
      ).join("")}</select>
    </label>
    <label class="field">${t.stopsDie}
      <select name="dieSides">${DIE_CHOICES.map(
        (n) => `<option value="${n}"${n === s.dieSides ? " selected" : ""}>${t.dieOption(n)}</option>`,
      ).join("")}</select>
    </label>
    <label class="field">${t.minStops}
      <select name="minStops">${MIN_STOPS_CHOICES.map(
        (n) => `<option value="${n}"${n === s.minStops ? " selected" : ""}>${t.minStopsOption(n)}</option>`,
      ).join("")}</select>
      <small class="muted">${t.minStopsHint}</small>
    </label>
    <label class="check">
      <input type="checkbox" name="allowRerolls"${s.allowRerolls ? " checked" : ""}>
      <span>${t.allowRerolls}<br><small class="muted">${t.allowRerollsHint}</small></span>
    </label>
    <label class="check">
      <input type="checkbox" name="lineChangeBoost"${s.lineChangeBoost ? " checked" : ""}>
      <span>${t.lineChangeBoost}<br><small class="muted">${t.lineChangeBoostHint}</small></span>
    </label>
    <label class="check">
      <input type="checkbox" name="preferFreshLines"${s.preferFreshLines ? " checked" : ""}>
      <span>${t.preferFreshLines}<br><small class="muted">${t.preferFreshLinesHint}</small></span>
    </label>
    <label class="check">
      <input type="checkbox" name="exactWeights"${s.exactWeights ? " checked" : ""}>
      <span>${t.exactWeights}<br><small class="muted">${t.exactWeightsHint}</small></span>
    </label>
    <p class="muted small">${t.settingsNote}</p>
    <menu>
      <button value="cancel" formnovalidate>${t.cancel}</button>
      <button value="save" class="primary">${t.save}</button>
    </menu>`;
  settingsDialog.showModal();
});

settingsForm.addEventListener("input", () => {
  const walk = settingsForm.elements.namedItem("maxWalkMin") as HTMLInputElement;
  settingsForm.querySelector("output")!.textContent = walk.value;
});

settingsDialog.addEventListener("close", () => {
  if (settingsDialog.returnValue !== "save") return;
  const data = new FormData(settingsForm);
  const area = String(data.get("areaKm"));
  const updated: Settings = {
    ...state.settings,
    maxWalkMin: Number(data.get("maxWalkMin")),
    areaKm: area ? Number(area) : null,
    dieSides: Number(data.get("dieSides")),
    minStops: Number(data.get("minStops")),
    allowRerolls: data.get("allowRerolls") === "on",
    lineChangeBoost: data.get("lineChangeBoost") === "on",
    preferFreshLines: data.get("preferFreshLines") === "on",
    exactWeights: data.get("exactWeights") === "on",
  };
  // Pending rolls were made under the old rules; toggling re-rolls alone must not reset them.
  const rulesChanged = (["maxWalkMin", "areaKm", "dieSides", "minStops"] as const).some(
    (k) => updated[k] !== state.settings[k],
  );
  state.settings = updated;
  if (state.trip && rulesChanged) {
    clearRolls(state.trip);
  }
  saveState(state);
  render();
});

function render(): void {
  if (state.trip) renderTrip(state.trip);
  else renderStart();
}

applyChrome();
render();
