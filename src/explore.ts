// "What to do here": nearby Wikipedia articles, a random pick among them, and map searches.
import { distanceM, type LatLng } from "./network.ts";
import type { Lang } from "./i18n.ts";

export interface Spot {
  title: string;
  description: string;
  extract: string;
  url: string;
  thumbnail: string | null;
  at: LatLng;
  distanceM: number;
}

interface WikiPage {
  pageid: number;
  title: string;
  description?: string;
  extract?: string;
  fullurl: string;
  thumbnail?: { source: string };
  coordinates?: { lat: number; lon: number }[];
}

interface WikiResponse {
  query?: { pages?: WikiPage[] };
  continue?: Record<string, string>;
}

// Station and railway articles describe the trains, not the neighbourhood.
const TRANSPORT_ARTICLE = /\b(station|railway|line|subway|metro|depot|interchange|expressway)\b|駅|線|鉄道|車庫/i;
// Schools aren't somewhere a visitor can go see.
const SCHOOL_ARTICLE = /\b(school|university|college|kindergarten|nursery|academy)\b|学校|高校|中学|小学|大学|学園|幼稚園|保育園|学院/i;
const SEARCH_RADIUS_M = 1200;
const MAX_ARTICLES = 50;
// The API returns intro extracts for at most 20 pages per request; the rest come via `continue`.
const MAX_REQUESTS = 4;

/** Nearby Wikipedia articles, nearest first (up to ~50, minus transport and school articles). */
export async function nearbySpots(at: LatLng, lang: Lang, signal?: AbortSignal): Promise<Spot[]> {
  const params = {
    action: "query",
    format: "json",
    formatversion: "2",
    origin: "*",
    generator: "geosearch",
    ggscoord: `${at.lat}|${at.lng}`,
    ggsradius: String(SEARCH_RADIUS_M),
    ggslimit: String(MAX_ARTICLES),
    prop: "coordinates|pageimages|description|extracts|info",
    inprop: "url",
    exintro: "1",
    explaintext: "1",
    exsentences: "2",
    exlimit: "20",
    piprop: "thumbnail",
    pithumbsize: "160",
    pilimit: String(MAX_ARTICLES),
    colimit: String(MAX_ARTICLES),
  };
  const pages = new Map<number, WikiPage>();
  let next: Record<string, string> = {};
  for (let i = 0; i < MAX_REQUESTS; i++) {
    const query = new URLSearchParams({ ...params, ...next });
    const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?${query}`, { signal });
    if (!res.ok) throw new Error(`Wikipedia: HTTP ${res.status}`);
    const body = (await res.json()) as WikiResponse;
    // Continuation batches repeat every page but only fill in the properties they cover.
    for (const page of body.query?.pages ?? []) pages.set(page.pageid, { ...pages.get(page.pageid), ...page });
    if (!body.continue) break;
    next = body.continue;
  }

  return [...pages.values()]
    .filter((p) => {
      const text = `${p.title} ${p.description ?? ""}`;
      return p.coordinates?.[0] && !TRANSPORT_ARTICLE.test(text) && !SCHOOL_ARTICLE.test(text);
    })
    .map((p) => {
      const coord = p.coordinates![0]!;
      const spot = { lat: coord.lat, lng: coord.lon };
      return {
        title: p.title,
        description: p.description ?? "",
        extract: p.extract ?? "",
        url: p.fullurl,
        thumbnail: p.thumbnail?.source ?? null,
        at: spot,
        distanceM: distanceM(at, spot),
      };
    })
    .sort((a, b) => a.distanceM - b.distanceM);
}

// Japanese queries find more local places on Google Maps regardless of UI language.
export const MAP_SEARCHES = [
  { en: "☕ Kissaten & cafés", ja: "☕ 喫茶店・カフェ", query: "喫茶店 カフェ" },
  { en: "🍜 Ramen", ja: "🍜 ラーメン", query: "ラーメン" },
  { en: "🏮 Izakaya", ja: "🏮 居酒屋", query: "居酒屋" },
  { en: "⛩️ Shrines & temples", ja: "⛩️ 神社・寺", query: "神社 寺" },
  { en: "🌳 Parks", ja: "🌳 公園", query: "公園" },
  { en: "🛍️ Shōtengai", ja: "🛍️ 商店街", query: "商店街" },
  { en: "♨️ Sentō", ja: "♨️ 銭湯", query: "銭湯" },
  { en: "📚 Second-hand shops", ja: "📚 古本・古着", query: "古本屋 古着 リサイクルショップ" },
];

export function mapSearchUrl(query: string, at: LatLng): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/@${at.lat},${at.lng},16z`;
}

/** Google Maps directions; a place is either coordinates or a search string (e.g. "浅草橋駅"). */
export function directionsUrl(from: LatLng | string, to: LatLng | string, mode: "walking" | "transit"): string {
  const place = (p: LatLng | string) => (typeof p === "string" ? encodeURIComponent(p) : `${p.lat},${p.lng}`);
  return `https://www.google.com/maps/dir/?api=1&origin=${place(from)}&destination=${place(to)}&travelmode=${mode}`;
}
