import type { MatchState, SettlementAdapter, SettlementReason, SettlementVerdict } from "./types";

/**
 * Algoritmo universal (ver secção 67/68 da spec) — versão real dos passos que este motor
 * consegue mesmo executar hoje. Os passos 1-7 (buscar mercado/evento/estado, validar) e 14-18
 * (ledger/saldo/histórico/notificação) são responsabilidade do chamador (betting/settlement.ts);
 * esta função cobre só os passos 8-13 (determinação antecipada ou final + motivo do settlement),
 * a parte que é igual para qualquer desporto/mercado — daí "universal".
 *
 * REGRA DE OURO (secção 80 da spec): nunca liquidar só porque o evento terminou, nunca liquidar
 * só porque o placar mudou — só quando o ADAPTADOR do mercado especificamente confirmar que dá.
 */
export function evaluateSelection(
  adapter: SettlementAdapter,
  rawMarket: string,
  rawSelection: string,
  state: MatchState
): { verdict: SettlementVerdict; reason: SettlementReason | null } {
  const config = adapter.buildMarketConfig(rawMarket, rawSelection);
  if (!config) return { verdict: "UNRESOLVABLE", reason: null };

  // Liquidação antecipada (secção 8): só tentada enquanto o evento ainda está a decorrer, e só
  // se o PRÓPRIO mercado disser que é seguro (ex: BTTS Sim depois de ambas equipas marcarem,
  // Over já ultrapassado) — nunca por omissão. Uma vez o evento terminado, cai sempre no caminho
  // final abaixo (mesmo para mercados canSettleEarly) — importante para o motivo do settlement
  // ficar correto: um resultado só é "antecipado" (UNAMBIGUOUS_OUTCOME) se o evento ainda não
  // tinha terminado quando foi decidido, senão é "EVENT_FINISHED" como qualquer outro.
  if (!state.finished) {
    if (config.canSettleEarly) {
      const early = adapter.evaluateMarket(config, rawSelection, state);
      if (early !== "OPEN") return { verdict: early, reason: "UNAMBIGUOUS_OUTCOME" };
    }
    return { verdict: "OPEN", reason: null };
  }

  // Alguns mercados (ex: Resultado Exato) NUNCA se determinam antecipadamente — só chegam aqui.
  const final = adapter.evaluateMarket(config, rawSelection, state);
  return { verdict: final, reason: final === "UNRESOLVABLE" ? null : "EVENT_FINISHED" };
}
