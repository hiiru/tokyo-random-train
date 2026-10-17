// Persisted app state. Stations and lines are stored by their stable data ids,
// so a regenerated network.json does not corrupt saved trips.
import type { RuleSettings } from "./network.ts";
import type { Lang } from "./i18n.ts";

export interface Settings extends RuleSettings {
  /** When off (default), a roll can't be redone before travelling it. */
  allowRerolls: boolean;
  /** Last choice of the "only new stations" option on the start screen. */
  onlyNew: boolean;
  /** Weight the dice towards changing lines after several rides on the same one. */
  lineChangeBoost: boolean;
  lang: Lang;
}

export interface Step {
  /** Line id and travel details, for the log and the map. */
  line: string;
  board: string;
  stops: number;
  /** Station ids passed, ending at the destination. */
  path: string[];
  at: string;
}

export interface Trip {
  start: string;
  startedAt: string;
  steps: Step[];
  /** Roll results not yet travelled. */
  rolledOption: string | null;
  rolledStops: number | null;
  /** Escape hatch when every option is exhausted; resets after the next arrival. */
  allowRevisit: boolean;
  /** Treat every station area from earlier trips as explored too. */
  onlyNew: boolean;
}

/** Every station ever landed on (trip starts and arrivals), across all trips: station id → visit times. */
export type History = Record<string, string[]>;

export interface AppState {
  settings: Settings;
  trip: Trip | null;
  history: History;
}

const STORAGE_KEY = "tokyo-random-train:v1";

export const DEFAULT_SETTINGS: Settings = {
  maxWalkMin: 5,
  areaKm: 20,
  dieSides: 6,
  minStops: 1,
  allowRerolls: false,
  onlyNew: false,
  lineChangeBoost: true,
  lang: navigator.language.startsWith("ja") ? "ja" : "en",
};

export function loadState(knownStation: (id: string) => boolean): AppState {
  let saved: Partial<AppState> = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    // Corrupt storage: start fresh.
  }
  const settings = { ...DEFAULT_SETTINGS, ...saved.settings };
  const trip = saved.trip;
  const tripValid =
    trip && knownStation(trip.start) && trip.steps.every((s) => s.path.length > 0 && s.path.every(knownStation));
  const history: History = {};
  if (saved.history) {
    for (const [id, visits] of Object.entries(saved.history)) if (knownStation(id)) history[id] = visits;
  } else if (tripValid) {
    // Saved before history existed: seed it from the trip in progress.
    recordVisit(history, trip.start, trip.startedAt);
    for (const step of trip.steps) recordVisit(history, step.path.at(-1)!, step.at);
  }
  return { settings, trip: tripValid ? trip : null, history };
}

export function saveState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function newTrip(start: string, onlyNew: boolean): Trip {
  return {
    start,
    startedAt: new Date().toISOString(),
    steps: [],
    rolledOption: null,
    rolledStops: null,
    allowRevisit: false,
    onlyNew,
  };
}

export function recordVisit(history: History, station: string, at: string): void {
  (history[station] ??= []).push(at);
}

/** Undo a visit recorded by `recordVisit`. */
export function removeVisit(history: History, station: string, at: string): void {
  const visits = history[station];
  if (!visits) return;
  const index = visits.lastIndexOf(at);
  if (index >= 0) visits.splice(index, 1);
  if (visits.length === 0) delete history[station];
}
