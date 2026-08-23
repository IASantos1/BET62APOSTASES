import type { Sport } from "../../sports/types";
import type { SettlementAdapter } from "../types";

/**
 * Adaptador "adiado" — ténis, voleibol, Fórmula 1, MMA (Fase 1 do Settlement Engine). Nenhum
 * mercado destes desportos tem, hoje, um formato de placar/seleção confirmado contra uma amostra
 * real da Pulsescore que permita liquidar com segurança:
 * - Ténis/Voleibol: contam por sets, não por homeScore/awayScore (que ali seguem os pontos do
 *   jogo/rally atual) — usar esses campos diretamente seria simplesmente errado.
 * - Fórmula 1/MMA: não têm um "placar" nesta forma — precisam de classificação oficial (F1) ou
 *   resultado oficial do combate (MMA), nenhum dos quais este feed fornece ainda.
 *
 * Mesmo comportamento de hoje (fica sempre para revisão manual, ver SCORE_SETTLEABLE_SPORTS em
 * betting/settlementRules.ts) — já ligado à interface nova, pronto a trocar por um adaptador
 * real (TennisSettlementAdapter, MotorsportSettlementAdapter, etc., ver secção 71 da spec) numa
 * fase seguinte sem tocar no núcleo (engine.ts) nem em quem o chama.
 */
export function createDeferredAdapter(sport: Sport): SettlementAdapter {
  return {
    sport,
    buildMarketConfig() {
      return null;
    },
    evaluateMarket() {
      return "UNRESOLVABLE";
    },
  };
}
