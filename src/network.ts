// Train network model and the dice-trip rules. Pure logic, no DOM.

export interface Station {
  id: string;
  name: string;
  nameJa: string;
  lat: number;
  lng: number;
  /** Index into Network.lines. */
  line: number;
  /** Platform below ground (Mini Tokyo 3D altitude -1). */
  underground?: boolean;
}

export interface Line {
  id: string;
  name: string;
  nameJa: string;
  operator: string;
  operatorJa: string;
  color: string;
  /** Loop lines (Yamanote) wrap around; `stations` does not repeat the first station. */
  loop: boolean;
  /** Direction names when riding towards higher / lower indexes. */
  asc: string;
  ascJa: string;
  desc: string;
  descJa: string;
  /** Station indexes in riding order. */
  stations: number[];
}

export interface Network {
  source: { name: string; url: string; commit: string; license: string };
  lines: Line[];
  stations: Station[];
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface RuleSettings {
  /** Lines at stations within this casual walk count as "at this station". */
  maxWalkMin: number;
  /** Destinations further than this from Tokyo Station are out of bounds; null = no limit. */
  areaKm: number | null;
  /** Faces on the stops die (ride 1..dieSides stations). */
  dieSides: number;
  /**
   * Shorter rides are blocked, unless no ride of at least this length is open
   * (line ends, explored, out of area); then the minimum is ignored for that option.
   */
  minStops: number;
}

export interface Nearby {
  station: number;
  walkMin: number;
}

/** One line + direction you can board from the current station area. */
export interface RideOption {
  key: string;
  line: number;
  /** Station you board at (may be a short walk away). */
  board: number;
  /** Position of `board` within the line. */
  pos: number;
  dir: 1 | -1;
  walkMin: number;
}

export type BlockReason = "end" | "area" | "visited" | "short";

export interface Face {
  stops: number;
  /** Stations passed, ending at the destination. Empty when the line ends first. */
  path: number[];
  blocked: BlockReason | null;
}

export const TOKYO_STATION: LatLng = { lat: 35.68124, lng: 139.76712 };

// Casual pace; real walking routes run ~25% longer than the straight line.
const WALK_M_PER_MIN = 75;
const ROUTE_DETOUR = 1.25;
// Stairs or escalators between a street-level and an underground platform.
const LEVEL_CHANGE_MIN = 0.5;
// Same-named stations this close form one station complex
// (e.g. Meiji-jingumae on the Chiyoda and Fukutoshin lines).
export const COMPLEX_RADIUS_M = 700;

/** Equirectangular approximation; accurate to well under 1% at city scale. */
export function distanceM(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return 6_371_000 * Math.hypot(x, y);
}

export function walkMinutes(a: LatLng, b: LatLng): number {
  return (distanceM(a, b) * ROUTE_DETOUR) / WALK_M_PER_MIN;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Comparable station name: "Keiō-hachiōji" → "keiohachioji", "Oshiage (SKYTREE)" → "oshiage". */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Uniform integer in [0, n) from the platform CSPRNG (no modulo bias). */
export function randomInt(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % n;
}

/** Index chosen by `roll` ∈ [0, sum of weights) over integer weights. */
export function weightedIndex(weights: number[], roll: number): number {
  let rest = roll;
  for (let i = 0; i < weights.length; i++) {
    rest -= weights[i]!;
    if (rest < 0) return i;
  }
  throw new RangeError(`roll ${roll} outside total weight`);
}

/** Random index with probability proportional to its weight (resolution 0.1). */
export function weightedRandom(weights: number[]): number {
  const tenths = weights.map((w) => Math.round(w * 10));
  return weightedIndex(tenths, randomInt(tenths.reduce((sum, w) => sum + w, 0)));
}

/** Rides in a row on the same line at the end of the trip so far. */
export function sameLineStreak(lineIds: string[]): number {
  const last = lineIds.at(-1);
  let streak = 0;
  for (let i = lineIds.length - 1; i >= 0 && lineIds[i] === last; i--) streak++;
  return streak;
}

/** Rides in a row before changing lines gets nudged. */
export const STREAK_THRESHOLD = 3;

const MAX_LINE_CHANGE_WEIGHT = 4;
/** Streak at which the weight reaches its maximum. */
const MAX_WEIGHT_STREAK = 8;

/** Weight for line-changing outcomes: 2× after 3 rides on one line, rising evenly to 4× after 8. */
export function lineChangeWeight(streak: number): number {
  if (streak < STREAK_THRESHOLD) return 1;
  const step = (MAX_LINE_CHANGE_WEIGHT - 2) / (MAX_WEIGHT_STREAK - STREAK_THRESHOLD);
  return Math.min(MAX_LINE_CHANGE_WEIGHT, Math.round((2 + (streak - STREAK_THRESHOLD) * step) * 10) / 10);
}

/** Platform pair → hand-estimated minutes; see src/data/transfers.ts. */
export interface TransferCorrection {
  from: string[];
  to: string[];
  minutes: number;
}

export class Explorer {
  readonly lines: Line[];
  readonly stations: Station[];
  /** nameKey per station. */
  readonly keys: string[];
  /** Positions of each station within its own line (usually one). */
  private readonly positions: number[][];
  /** "a|b" (station indexes, a < b) → corrected walking minutes. */
  private readonly corrections = new Map<string, number>();

  constructor(network: Network, corrections: TransferCorrection[] = []) {
    this.lines = network.lines;
    this.stations = network.stations;
    this.keys = network.stations.map((s) => nameKey(s.name));
    this.positions = network.stations.map(() => []);
    for (const line of network.lines) {
      line.stations.forEach((station, pos) => this.positions[station]!.push(pos));
    }
    const index = new Map(network.stations.map((s, i) => [s.id, i]));
    const resolve = (id: string) => {
      const i = index.get(id);
      if (i === undefined) throw new Error(`Transfer correction: unknown station ${id}`);
      return i;
    };
    for (const { from, to, minutes } of corrections) {
      for (const a of from.map(resolve)) for (const b of to.map(resolve)) this.corrections.set(pairKey(a, b), minutes);
    }
  }

  inArea(station: number, areaKm: number | null): boolean {
    return areaKm === null || distanceM(TOKYO_STATION, this.stations[station]!) <= areaKm * 1000;
  }

  /**
   * Casual walking minutes between two platforms: a hand-estimated correction if there is
   * one, else the straight-line estimate plus a level change between ground and underground.
   */
  walk(a: number, b: number): number {
    if (a === b) return 0;
    const corrected = this.corrections.get(pairKey(a, b));
    if (corrected !== undefined) return corrected;
    const sa = this.stations[a]!;
    const sb = this.stations[b]!;
    return walkMinutes(sa, sb) + (Boolean(sa.underground) !== Boolean(sb.underground) ? LEVEL_CHANGE_MIN : 0);
  }

  /** Whether a line other than `line` can be boarded around `station`. */
  hasOtherLine(station: number, line: number, maxWalkMin: number): boolean {
    return this.nearby(station, maxWalkMin).some((n) => this.stations[n.station]!.line !== line);
  }

  /**
   * Stations reachable on foot from `from`, including `from` itself. Stations within
   * `maxWalkMin` count, plus same-named members of their station complex (shown with
   * their own walking time).
   */
  nearby(from: number, maxWalkMin: number): Nearby[] {
    const origin = this.stations[from]!;
    const walks = this.stations.map((_, i) => this.walk(from, i));
    const reachableNames = new Set(this.keys.filter((_, i) => walks[i]! <= maxWalkMin));
    const result: Nearby[] = [];
    this.stations.forEach((s, i) => {
      const sameStation = reachableNames.has(this.keys[i]!) && distanceM(origin, s) <= COMPLEX_RADIUS_M;
      if (walks[i]! <= maxWalkMin || sameStation) result.push({ station: i, walkMin: walks[i]! });
    });
    return result.sort((a, b) => a.walkMin - b.walkMin);
  }

  /** Every line + direction boardable around `from`, nearest first. */
  options(from: number, maxWalkMin: number): RideOption[] {
    const result: RideOption[] = [];
    for (const { station, walkMin } of this.nearby(from, maxWalkMin)) {
      const lineIndex = this.stations[station]!.line;
      const line = this.lines[lineIndex]!;
      for (const pos of this.positions[station]!) {
        for (const dir of [1, -1] as const) {
          if (!line.loop && line.stations[pos + dir] === undefined) continue;
          result.push({ key: `${line.id}:${pos}:${dir}`, line: lineIndex, board: station, pos, dir, walkMin });
        }
      }
    }
    return result;
  }

  /** Stations passed riding `stops` stations from the option's boarding point; null past the terminus. */
  ride(option: RideOption, stops: number): number[] | null {
    const line = this.lines[option.line]!;
    const count = line.stations.length;
    const path: number[] = [];
    for (let i = 1; i <= stops; i++) {
      let pos = option.pos + option.dir * i;
      if (line.loop) pos = ((pos % count) + count) % count;
      const station = line.stations[pos];
      if (station === undefined) return null;
      path.push(station);
    }
    return path;
  }

  /** Station areas already explored: every station walkable from a visited one. */
  visitedArea(visited: number[], maxWalkMin: number): Set<number> {
    const area = new Set<number>();
    for (const v of visited) for (const { station } of this.nearby(v, maxWalkMin)) area.add(station);
    return area;
  }

  /** The stops die for one option; blocked faces get re-rolled, so the roll picks among open faces. */
  faces(option: RideOption, rules: RuleSettings, visitedArea: Set<number>): Face[] {
    const faces: Face[] = [];
    for (let stops = 1; stops <= rules.dieSides; stops++) {
      const path = this.ride(option, stops);
      if (!path) {
        faces.push({ stops, path: [], blocked: "end" });
        continue;
      }
      const dest = path[path.length - 1]!;
      const blocked = !this.inArea(dest, rules.areaKm) ? "area" : visitedArea.has(dest) ? "visited" : null;
      faces.push({ stops, path, blocked });
    }
    if (faces.some((f) => !f.blocked && f.stops >= rules.minStops)) {
      for (const f of faces) if (!f.blocked && f.stops < rules.minStops) f.blocked = "short";
    }
    return faces;
  }

  /** Station complexes for picking a start: same-named stations within walking range, grouped. */
  complexes(areaKm: number | null): number[][] {
    const groups = new Map<string, number[][]>();
    this.stations.forEach((s, i) => {
      if (!this.inArea(i, areaKm)) return;
      const key = this.keys[i]!;
      const sameName = groups.get(key) ?? [];
      const group = sameName.find((g) => distanceM(this.stations[g[0]!]!, s) <= COMPLEX_RADIUS_M);
      if (group) group.push(i);
      else sameName.push([i]);
      groups.set(key, sameName);
    });
    return [...groups.values()].flat();
  }
}
