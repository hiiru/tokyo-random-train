// Hand-estimated walking minutes (casual pace) for transfers the straight-line estimate
// gets badly wrong: deep platforms, long underground passages, or platforms that share one
// coordinate in the source data. These replace the estimate for the listed platform pairs
// (both directions). Rough estimates, not official figures: adjust freely.
//
// Same-named stations still always count as one station, so a long correction here changes
// the walk time shown (and whether differently-named stations are reachable), never removes
// a platform of the station you're at.

import type { TransferCorrection } from "../network.ts";

const TOKYO_JR = [
  "JR-East.Yamanote.Tokyo",
  "JR-East.KeihinTohokuNegishi.Tokyo",
  "JR-East.ChuoRapid.Tokyo",
  "JR-East.Tokaido.Tokyo",
  "JR-East.Utsunomiya.Tokyo",
  "JR-East.Takasaki.Tokyo",
  "JR-East.JobanRapid.Tokyo",
];
const TOKYO_SOBU_RAPID = ["JR-East.SobuRapid.Tokyo", "JR-East.Yokosuka.Tokyo"];
const TOKYO_KEIYO = ["JR-East.Keiyo.Tokyo", "JR-East.KeiyoFutamataBranch.Tokyo"];
const TOKYO_MARUNOUCHI = ["TokyoMetro.Marunouchi.Tokyo"];

const SHINJUKU_JR = [
  "JR-East.Yamanote.Shinjuku",
  "JR-East.ChuoRapid.Shinjuku",
  "JR-East.ChuoSobuLocal.Shinjuku",
  "JR-East.SaikyoKawagoe.Shinjuku",
  "JR-East.ShonanShinjuku.Shinjuku",
];

export const TRANSFER_CORRECTIONS: TransferCorrection[] = [
  // Tokyo: the Keiyō platforms are far south-east and deep; Sōbu Rapid is 5 floors down.
  { from: TOKYO_JR, to: TOKYO_KEIYO, minutes: 12 },
  { from: TOKYO_JR, to: TOKYO_SOBU_RAPID, minutes: 6 },
  { from: TOKYO_SOBU_RAPID, to: TOKYO_KEIYO, minutes: 12 },
  { from: TOKYO_JR, to: TOKYO_MARUNOUCHI, minutes: 5 },
  { from: TOKYO_KEIYO, to: TOKYO_MARUNOUCHI, minutes: 10 },

  // Shinjuku
  { from: SHINJUKU_JR, to: ["Odakyu.Odawara.Shinjuku"], minutes: 3 },
  { from: SHINJUKU_JR, to: ["Keio.Keio.Shinjuku"], minutes: 4 },
  { from: SHINJUKU_JR, to: ["TokyoMetro.Marunouchi.Shinjuku"], minutes: 5 },
  { from: SHINJUKU_JR, to: ["Toei.Oedo.Shinjuku"], minutes: 8 },
  { from: SHINJUKU_JR, to: ["Toei.Shinjuku.Shinjuku", "Keio.KeioNew.Shinjuku"], minutes: 8 },
  { from: SHINJUKU_JR, to: ["Toei.Oedo.ShinjukuNishiguchi"], minutes: 6 },
  { from: SHINJUKU_JR, to: ["Seibu.Shinjuku.SeibuShinjuku"], minutes: 9 },
];
