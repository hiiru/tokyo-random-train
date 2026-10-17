import { describe, expect, test } from "bun:test";
import network from "./data/network.json";
import { TRANSFER_CORRECTIONS } from "./data/transfers.ts";
import {
  Explorer,
  lineChangeWeight,
  lineFatigue,
  sameLineStreak,
  weightedIndex,
  type Network,
  type RideOption,
  type RuleSettings,
} from "./network.ts";

const explorer = new Explorer(network as Network, TRANSFER_CORRECTIONS);
const rules: RuleSettings = { maxWalkMin: 5, areaKm: 20, dieSides: 6, minStops: 1 };

function station(name: string, lineId: string): number {
  const index = explorer.stations.findIndex(
    (s) => s.name.toLowerCase() === name.toLowerCase() && explorer.lines[s.line]!.id === lineId,
  );
  if (index < 0) throw new Error(`no ${name} on ${lineId}`);
  return index;
}

function option(from: number, lineId: string, next: string): RideOption {
  const found = explorer
    .options(from, rules.maxWalkMin)
    .find((o) => explorer.lines[o.line]!.id === lineId && explorer.stations[explorer.ride(o, 1)![0]!]!.name === next);
  if (!found) throw new Error(`no ${lineId} towards ${next}`);
  return found;
}

const names = (path: number[]) => path.map((i) => explorer.stations[i]!.name);
const lineIds = (from: number, maxWalkMin: number) =>
  new Set(explorer.options(from, maxWalkMin).map((o) => explorer.lines[o.line]!.id));

describe("lines at a station", () => {
  test("include lines within a casual walk, not further", () => {
    // Bakurocho (Tozai Line, underground) is ~9 min away from the street-level JR platform.
    const asakusabashi = station("Asakusabashi", "JR-East.ChuoSobuLocal");
    expect(lineIds(asakusabashi, 5)).toEqual(new Set(["JR-East.ChuoSobuLocal", "Toei.Oedo"]));
    expect(lineIds(asakusabashi, 10).has("TokyoMetro.Tozai")).toBe(true);
  });

  test("same-named stations count as one station even with no walking allowed", () => {
    const asakusabashi = station("Asakusabashi", "JR-East.ChuoSobuLocal");
    expect(lineIds(asakusabashi, 0)).toEqual(new Set(["JR-East.ChuoSobuLocal", "Toei.Oedo"]));
    expect(lineIds(station("Kanda", "JR-East.Yamanote"), 0).has("TokyoMetro.Ginza")).toBe(true);
  });

  test("hand-estimated transfers replace the straight-line estimate", () => {
    // Both are at one coordinate in the data; the real walk is long.
    const tokyo = station("Tokyo", "JR-East.Yamanote");
    expect(explorer.walk(tokyo, station("Tokyo", "JR-East.Keiyo"))).toBe(12);
    // Same-named platforms still count as part of the station, with the corrected time shown.
    const keiyo = explorer.nearby(tokyo, 5).find((n) => n.station === station("Tokyo", "JR-East.Keiyo"));
    expect(keiyo?.walkMin).toBe(12);
  });

  test("changing between street level and underground adds time", () => {
    const jr = station("Asakusabashi", "JR-East.ChuoSobuLocal");
    const oedo = station("Asakusabashi", "Toei.Oedo");
    expect(explorer.walk(jr, oedo)).toBeCloseTo(3.4 + 0.5, 1);
    expect(explorer.walk(jr, oedo)).toBeLessThanOrEqual(5);
  });

  test("a walkable station brings its same-named complex along", () => {
    // Meiji-jingumae's Fukutoshin platform is past the walk limit, its Chiyoda platform is not.
    const lines = lineIds(station("Harajuku", "JR-East.Yamanote"), 5);
    expect(lines.has("TokyoMetro.Chiyoda")).toBe(true);
    expect(lines.has("TokyoMetro.Fukutoshin")).toBe(true);
  });

  test("terminals only offer the one direction", () => {
    const hikarigaoka = station("Hikarigaoka", "Toei.Oedo");
    expect(explorer.options(hikarigaoka, 0).map((o) => o.dir)).toEqual([-1]);
  });

  test("through-service stops are not part of the line", () => {
    const chiyoda = explorer.lines.find((l) => l.id === "TokyoMetro.Chiyoda")!;
    expect(explorer.stations[chiyoda.stations[0]!]!.name).toBe("Yoyogi-uehara");
  });
});

describe("riding", () => {
  test("loop lines wrap around", () => {
    const osaki = station("Osaki", "JR-East.Yamanote");
    expect(names(explorer.ride(option(osaki, "JR-East.Yamanote", "Shinagawa"), 3)!)).toEqual([
      "Shinagawa",
      "Takanawa Gateway",
      "Tamachi",
    ]);
  });

  test("the Oedo Line's loop runs through Tochomae towards Hikarigaoka", () => {
    const shinjuku = station("Shinjuku", "Toei.Oedo");
    expect(names(explorer.ride(option(shinjuku, "Toei.Oedo", "Tochomae"), 3)!)).toEqual([
      "Tochomae",
      "Nishi-shinjuku-gochome",
      "Kasuga",
    ]);
  });

  test("faces past the terminus are blocked", () => {
    const tokyo = station("Tokyo", "JR-East.ChuoRapid");
    const faces = explorer.faces(option(tokyo, "JR-East.Yamanote", "Kanda"), rules, new Set());
    expect(faces.every((f) => f.blocked === null)).toBe(true);
    const shinjuku = station("Shinjuku", "JR-East.ChuoRapid");
    const toTokyo = explorer.faces(option(shinjuku, "JR-East.ChuoRapid", "Yotsuya"), rules, new Set());
    expect(toTokyo.map((f) => f.blocked)).toEqual([null, null, null, null, "end", "end"]);
    expect(names(toTokyo[3]!.path).at(-1)).toBe("Tokyo");
  });
});

describe("exploration rules", () => {
  test("stations in an explored area are blocked, including other lines there", () => {
    const ryogoku = station("Ryogoku", "JR-East.ChuoSobuLocal");
    const explored = explorer.visitedArea([station("Asakusabashi", "JR-East.ChuoSobuLocal")], rules.maxWalkMin);
    expect(explored.has(station("Asakusabashi", "Toei.Oedo"))).toBe(true);
    const eastbound = explorer.faces(option(ryogoku, "JR-East.ChuoSobuLocal", "Asakusabashi"), rules, explored);
    expect(eastbound[0]!.blocked).toBe("visited");
    expect(eastbound[1]!.blocked).toBe(null);
  });

  test("destinations outside the play area are blocked", () => {
    const tokyo = station("Tokyo", "JR-East.Tokaido");
    const faces = explorer.faces(option(tokyo, "JR-East.Tokaido", "Shimbashi"), { ...rules, areaKm: 8 }, new Set());
    expect(faces.map((f) => f.blocked)).toEqual([null, null, "area", "area", "area", "area"]);
    const unlimited = explorer.faces(option(tokyo, "JR-East.Tokaido", "Shimbashi"), { ...rules, areaKm: null }, new Set());
    expect(unlimited.every((f) => f.blocked === null)).toBe(true);
  });

  test("rides shorter than the minimum are blocked", () => {
    const shinjuku = station("Shinjuku", "JR-East.ChuoRapid");
    const faces = explorer.faces(option(shinjuku, "JR-East.ChuoRapid", "Yotsuya"), { ...rules, minStops: 3 }, new Set());
    expect(faces.map((f) => f.blocked)).toEqual(["short", "short", null, null, "end", "end"]);
  });

  test("the minimum is ignored when the line can't reach it", () => {
    // Kanda → Tokyo is the last stop of the Chūō Rapid Line.
    const kanda = station("Kanda", "JR-East.ChuoRapid");
    const faces = explorer.faces(option(kanda, "JR-East.ChuoRapid", "Tokyo"), { ...rules, minStops: 3 }, new Set());
    expect(faces.map((f) => f.blocked)).toEqual([null, "end", "end", "end", "end", "end"]);
  });

  test("the minimum is ignored when only shorter rides are unexplored", () => {
    const ryogoku = station("Ryogoku", "JR-East.ChuoSobuLocal");
    // Explore everything 2–6 stops eastbound, so only Asakusabashi (1 stop) stays open.
    const explored = new Set(
      ["Okubo", "Shinjuku", "Yoyogi", "Sendagaya", "Shinanomachi"].map((n) => station(n, "JR-East.ChuoSobuLocal")),
    );
    const eastbound = explorer.faces(option(ryogoku, "JR-East.ChuoSobuLocal", "Asakusabashi"), { ...rules, minStops: 3 }, explored);
    expect(eastbound.map((f) => f.blocked)).toEqual([null, "visited", "visited", "visited", "visited", "visited"]);
  });
});

describe("hubs", () => {
  test("big interchanges count as hubs, ordinary transfer stations don't", () => {
    expect(explorer.isHub(station("Shinjuku", "JR-East.Yamanote"), 5)).toBe(true);
    expect(explorer.isHub(station("Asakusabashi", "JR-East.ChuoSobuLocal"), 5)).toBe(false);
  });
});

describe("line fatigue", () => {
  test("each visited station lowers the weight a little, never below half", () => {
    expect([0, 1, 2, 3, 5, 7, 20].map((n) => Number(lineFatigue(n).toFixed(2)))).toEqual([1, 0.87, 0.77, 0.69, 0.57, 0.5, 0.5]);
  });
});

describe("line-change nudge", () => {
  test("counts only the trailing rides on one line", () => {
    expect(sameLineStreak([])).toBe(0);
    expect(sameLineStreak(["A", "B", "B", "B"])).toBe(3);
    expect(sameLineStreak(["B", "B", "A"])).toBe(1);
  });

  test("weight starts at 2× after 3 rides and rises evenly to a 4× cap after 8", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 12].map(lineChangeWeight)).toEqual([1, 1, 2, 2.4, 2.8, 3.2, 3.6, 4, 4]);
  });

  test("weighted index covers each weight's share of rolls", () => {
    const weights = [1, 3, 1];
    expect([0, 1, 2, 3, 4].map((roll) => weightedIndex(weights, roll))).toEqual([0, 1, 1, 1, 2]);
    expect(() => weightedIndex(weights, 5)).toThrow(RangeError);
  });

  test("transfer stations are told apart from single-line stops", () => {
    const seibu = explorer.lines.findIndex((l) => l.id === "Seibu.Ikebukuro");
    expect(explorer.hasOtherLine(station("Nerima", "Seibu.Ikebukuro"), seibu, 5)).toBe(true);
    expect(explorer.hasOtherLine(station("Fujimidai", "Seibu.Ikebukuro"), seibu, 5)).toBe(false);
  });
});
