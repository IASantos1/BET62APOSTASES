import type { Sport } from "../sports/types";

/**
 * Tipos base do Settlement Engine — ver "BET62 — ESPECIFICAÇÃO COMPLETA DO SETTLEMENT ENGINE"
 * (pedido do utilizador). Fase 1: fundação + futebol (ver adapters/football.ts). Os outros 7
 * desportos usam um adaptador "stub" (adapters/stub.ts) que preserva o comportamento atual
 * (NEEDS_REVIEW sempre) mas já fica ligado à mesma interface — extensível sem tocar no núcleo,
 * exatamente como pedido na secção 82 da spec.
 *
 * Simplificação deliberada face à spec: o "scope" da Fase 1 só cobre REGULATION/FULL_GAME (jogo
 * completo, sem prorrogação/penáltis) — mercados de período específico (1º tempo, quarto, set…)
 * continuam a ir para revisão manual até haver um campo confirmado no feed com o placar NAQUELE
 * momento (ver comentário em football.ts). Mesma disciplina já usada neste projeto: nunca
 * resolver às cegas um formato/campo não confirmado contra uma amostra real.
 */

/** Resultado final de UMA seleção. "UNRESOLVABLE" nunca é gravado como está — mapeia para
 * NEEDS_REVIEW no BetSelection (o motor nunca inventa um resultado que não sabe determinar). */
export type BetResult = "WON" | "LOST" | "PUSH" | "HALF_WIN" | "HALF_LOSS" | "VOID" | "UNRESOLVABLE";

/** "OPEN" = ainda não é seguro decidir (o jogo pode mudar o resultado) — distinto de
 * UNRESOLVABLE, que significa "nunca vamos conseguir decidir isto sozinhos". */
export type SettlementVerdict = "OPEN" | BetResult;

/** Motivo do settlement — ver secção 79 da spec (auditoria). Gravado em BetSelection.settlementReason. */
export type SettlementReason =
  | "UNAMBIGUOUS_OUTCOME" // liquidação antecipada — o resultado já é matematicamente irreversível
  | "EVENT_FINISHED" // liquidado no final do evento
  | "VOID_EVENT" // evento anulado/abandonado
  | "MANUAL_CORRECTION"; // liquidado manualmente por um admin (ver betting/service.ts::manualSettleSelection)

/** Configuração de UM mercado, já resolvida a partir do texto bruto (mercado + seleção) que a
 * Pulsescore manda — ver secção 5/72 da spec. Fase 1: só os campos que o motor precisa mesmo
 * para decidir (can_settle_early / requires_event_finished / supports_push) — os restantes
 * campos da spec (includes_overtime, void_policy, rule_version…) ficam para quando houver
 * mercados que realmente os usem (prorrogação, penáltis — nenhum suportado ainda). */
export interface MarketConfig {
  marketType: string; // ex: "MATCH_RESULT", "BTTS_YES", "TOTAL_GOALS_OVER"
  sport: Sport;
  scope: "REGULATION";
  line: number | null;
  canSettleEarly: boolean;
  requiresEventFinished: boolean;
  supportsPush: boolean;
}

/** Estado do jogo tal como o motor o vê — projeção do LiveEvent (ver sports/types.ts) com só os
 * campos que os adaptadores precisam. `finished` aqui significa "o evento desapareceu do feed
 * ao vivo" (o único sinal de fim de jogo que a Pulsescore dá, ver hybridService.ts). */
export interface MatchState {
  finished: boolean;
  home: string;
  away: string;
  homeScore: number | null;
  awayScore: number | null;
  homeCorners?: number;
  awayCorners?: number;
  homeCards?: number;
  awayCards?: number;
}

/** Interface comum de adaptador por desporto — ver secção 71 da spec. Cada desporto suportado
 * implementa isto; o núcleo (engine.ts) nunca sabe nada específico de um desporto. */
export interface SettlementAdapter {
  sport: Sport;
  /** Constrói a configuração do mercado a partir do texto bruto — `null` se o mercado/seleção
   * não for um formato que este adaptador saiba interpretar com segurança (vai para revisão). */
  buildMarketConfig(rawMarket: string, rawSelection: string): MarketConfig | null;
  /** Avalia o mercado no estado atual — chamado tanto para liquidação antecipada (jogo ainda a
   * decorrer) como para liquidação final (jogo terminado). Devolve "OPEN" se ainda não for
   * seguro decidir. Função pura, sem I/O. */
  evaluateMarket(config: MarketConfig, rawSelection: string, state: MatchState): SettlementVerdict;
}
