// Builds src/data/network.json from the Mini Tokyo 3D open dataset (MIT License,
// https://github.com/nagix/mini-tokyo-3d). Run with `bun run data`.
import type { Network, Line, Station } from "../src/network.ts";

const COMMIT = "b5b658bed67052a38e3dd674be197c84948d78ba";
const BASE = `https://raw.githubusercontent.com/nagix/mini-tokyo-3d/${COMMIT}/data`;

// Railways that only model through-service or limited-express routings between
// stations of other lines (every station is an `alternate`); not rideable as a line.
const EXCLUDED_RAILWAYS: Record<string, true> = {
  "JR-East.YamanoteFreight": true,
  "JR-East.TokaidoFreight": true,
  "JR-East.OsakiBranch": true,
  "JR-East.MusashinoKunitachiBranch": true,
  "JR-East.MusashinoOmiyaBranch": true,
  "JR-East.MusashinoNishiUrawaBranch": true,
  "Tobu.JRTobuConnection": true,
  "Odakyu.JROdakyuConnection": true,
  "Seibu.S-Fukutoshin": true,
  "Seibu.S-Yurakucho": true,
  "Seibu.SeibuChichibuBranch": true,
};

// Mini Tokyo 3D's operators.json only covers airlines; railway ids are prefixed by operator.
const OPERATOR_NAMES: Record<string, { en: string; ja: string }> = {
  "JR-East": { en: "JR East", ja: "JR東日本" },
  "JR-Central": { en: "JR Central", ja: "JR東海" },
  TWR: { en: "TWR", ja: "東京臨海高速鉄道" },
  TokyoMetro: { en: "Tokyo Metro", ja: "東京メトロ" },
  Toei: { en: "Toei", ja: "都営" },
  YokohamaMunicipal: { en: "Yokohama Subway", ja: "横浜市営地下鉄" },
  Keio: { en: "Keio", ja: "京王" },
  Keikyu: { en: "Keikyu", ja: "京急" },
  Keisei: { en: "Keisei", ja: "京成" },
  Hokuso: { en: "Hokuso Railway", ja: "北総鉄道" },
  Shibayama: { en: "Shibayama Railway", ja: "芝山鉄道" },
  Tobu: { en: "Tobu", ja: "東武" },
  Seibu: { en: "Seibu", ja: "西武" },
  Odakyu: { en: "Odakyu", ja: "小田急" },
  OdakyuHakone: { en: "Hakone Tozan", ja: "箱根登山鉄道" },
  Tokyu: { en: "Tokyu", ja: "東急" },
  Minatomirai: { en: "Yokohama Minatomirai", ja: "横浜高速鉄道" },
  Sotetsu: { en: "Sotetsu", ja: "相鉄" },
  SaitamaRailway: { en: "Saitama Railway", ja: "埼玉高速鉄道" },
  MIR: { en: "Tsukuba Express", ja: "つくばエクスプレス" },
  ToyoRapid: { en: "Toyo Rapid", ja: "東葉高速鉄道" },
  KantoRailway: { en: "Kanto Railway", ja: "関東鉄道" },
  Ryutetsu: { en: "Ryutetsu", ja: "流鉄" },
  Yurikamome: { en: "Yurikamome", ja: "ゆりかもめ" },
  YokohamaSeaside: { en: "Yokohama Seaside Line", ja: "横浜シーサイドライン" },
  SaitamaTransit: { en: "Saitama New Urban Transit", ja: "埼玉新都市交通" },
  Yamaman: { en: "Yamaman", ja: "山万" },
  TokyoMonorail: { en: "Tokyo Monorail", ja: "東京モノレール" },
  TamaMonorail: { en: "Tama Monorail", ja: "多摩モノレール" },
  ChibaMonorail: { en: "Chiba Monorail", ja: "千葉モノレール" },
  ShonanMonorail: { en: "Shonan Monorail", ja: "湘南モノレール" },
  Enoden: { en: "Enoden", ja: "江ノ電" },
  IzuHakone: { en: "Izuhakone Railway", ja: "伊豆箱根鉄道" },
  Izukyu: { en: "Izukyu", ja: "伊豆急" },
  Fujikyu: { en: "Fujikyu", ja: "富士急" },
  Chichibu: { en: "Chichibu Railway", ja: "秩父鉄道" },
};

type Titles = { en?: string; ja?: string };
interface RawRailway { id: string; title: Titles; stations: string[]; ascending?: string; descending?: string; color?: string }
interface RawStation { id: string; railway: string; coord?: [number, number]; title: Titles; alternate?: string; altitude?: number }
interface RawDirection { id: string; title: Titles }

async function get<T>(name: string): Promise<T> {
  const res = await fetch(`${BASE}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const [railways, rawStations, directions] = await Promise.all([
  get<RawRailway[]>("railways"),
  get<RawStation[]>("stations"),
  get<RawDirection[]>("rail-directions"),
]);

const stationById = new Map(rawStations.map((s) => [s.id, s]));
const directionTitle = new Map(directions.map((d) => [d.id, d.title]));

// Coordinates are rounded to 5 decimals (~1 m), plenty for walking estimates.
const round = (n: number) => Math.round(n * 1e5) / 1e5;

const lines: Line[] = [];
const stations: Station[] = [];
const stationIndexById = new Map<string, number>();

for (const railway of railways) {
  if (EXCLUDED_RAILWAYS[railway.id]) continue;
  // Alternates are through-service stops borrowed from a connecting line
  // (e.g. Chiyoda Line "Machida"); the real line ends before them.
  let ids = railway.stations.filter((id) => {
    const s = stationById.get(id);
    return s?.coord && !s.alternate;
  });
  const loop = ids.length > 2 && ids[0] === ids[ids.length - 1];
  if (loop) ids = ids.slice(0, -1);
  if (ids.length < 2) continue;

  const lineIndex = lines.length;
  const stationIndexes = ids.map((id) => {
    const known = stationIndexById.get(id);
    if (known !== undefined) return known;
    const s = stationById.get(id)!;
    stations.push({
      id,
      // Mini Tokyo 3D marks aliases like "Meiji-jingumae<Harajuku>".
      name: (s.title.en ?? s.title.ja ?? id).replace(/\s*<([^>]+)>/, " ($1)"),
      nameJa: s.title.ja ?? "",
      lat: round(s.coord![1]),
      lng: round(s.coord![0]),
      ...(s.altitude === -1 ? { underground: true } : {}),
      line: lineIndex,
    });
    stationIndexById.set(id, stations.length - 1);
    return stations.length - 1;
  });

  const operatorId = railway.id.split(".")[0]!;
  const operator = OPERATOR_NAMES[operatorId] ?? { en: operatorId, ja: operatorId };
  const asc = directionTitle.get(railway.ascending ?? "");
  const desc = directionTitle.get(railway.descending ?? "");
  lines.push({
    id: railway.id,
    name: railway.title.en ?? railway.id,
    nameJa: railway.title.ja ?? "",
    operator: operator.en,
    operatorJa: operator.ja,
    color: railway.color ?? "#888888",
    loop,
    asc: asc?.en ?? "",
    ascJa: asc?.ja ?? "",
    desc: desc?.en ?? "",
    descJa: desc?.ja ?? "",
    stations: stationIndexes,
  });
}

const network: Network = {
  source: { name: "Mini Tokyo 3D", url: "https://github.com/nagix/mini-tokyo-3d", commit: COMMIT, license: "MIT" },
  lines,
  stations,
};

const out = new URL("../src/data/network.json", import.meta.url);
await Bun.write(out, JSON.stringify(network));
console.log(`Wrote ${lines.length} lines, ${stations.length} stations to ${out.pathname}`);
