import type { Sport } from "../sports/types";
import { createScoreBasedAdapter } from "./adapters/scoreBased";
import { createDeferredAdapter } from "./adapters/deferred";
import type { SettlementAdapter } from "./types";

export * from "./types";
export { evaluateSelection } from "./engine";

// Registo por desporto (secção 71 da spec) — futebol/basquetebol/hóquei/beisebol partilham o
// mesmo adaptador (o mesmo conjunto SCORE_SETTLEABLE_SPORTS já usado hoje, ver
// betting/settlementRules.ts); ténis/voleibol/Fórmula 1/MMA ficam com o adaptador adiado até
// haver dados confirmados para os liquidar com segurança (ver adapters/deferred.ts).
const SCORE_BASED_SPORTS: Sport[] = ["football", "basketball", "ice_hockey", "baseball"];

const ADAPTERS: Record<Sport, SettlementAdapter> = Object.fromEntries(
  (["football", "tennis", "basketball", "ice_hockey", "baseball", "volleyball", "formula1", "mma"] as Sport[]).map((sport) => [
    sport,
    SCORE_BASED_SPORTS.includes(sport) ? createScoreBasedAdapter(sport) : createDeferredAdapter(sport),
  ])
) as Record<Sport, SettlementAdapter>;

export function getSettlementAdapter(sport: Sport): SettlementAdapter {
  return ADAPTERS[sport];
}
