import {
  classifyMarket,
  extractLine,
  resolveBTTS,
  resolveCorrectScore,
  resolveDoubleChance,
  resolveDrawNoBet,
  resolveMatchResult,
  type SettlementOutcome,
} from "../../betting/settlementRules";
import type { Sport } from "../../sports/types";
import type { BetResult, MarketConfig, MatchState, SettlementAdapter, SettlementVerdict } from "../types";

/**
 * Adaptador para os desportos "placar simples" (golos/pontos/corridas num único número por
 * lado) — futebol, basquetebol, hóquei no gelo, beisebol (o mesmo conjunto de
 * SCORE_SETTLEABLE_SPORTS já usado hoje em settlementRules.ts). Fase 1 do Settlement Engine (ver
 * spec do utilizador). classifyMarket()/os resolvers importados já são sport-agnósticos por
 * desenho (o próprio nome da categoria "OVER_UNDER_GOALS" cobre "total points"/"total games"/
 * "total runs" também) — este adaptador só decide QUANDO é seguro chamá-los (liquidação
 * antecipada vs. só no final) e traduz o resultado para o vocabulário novo (WON/LOST/PUSH/VOID/
 * UNRESOLVABLE em vez do SettlementOutcome antigo). Mercados de cantos/cartões só existem
 * mesmo no futebol na prática (classifyMarket nunca vai reconhecer "corner"/"card" no texto de
 * um mercado de basquetebol), por isso inofensivos para os outros desportos.
 *
 * Deliberadamente FORA da Fase 1 (ver tarefas seguintes / comentários em settlementRules.ts):
 * - Handicap/ Handicap Asiático (HALF_WIN/HALF_LOSS): o formato exato da seleção nunca foi
 *   confirmado contra uma amostra real da Pulsescore — resolver às cegas arriscaria interpretar
 *   mal o lado/sinal. Fica UNRESOLVABLE (revisão manual) até haver confirmação.
 * - HT/FT, Segundo Tempo/Quarto/Período, Resultado ao Intervalo: precisam do placar NAQUELE
 *   momento, que o LiveEvent (sports/types.ts) não guarda hoje (só o placar atual/final) — nada
 *   aqui capta esse momento. Implementar isto exigiria primeiro confirmar como/quando o feed
 *   sinaliza esses cortes, e só depois guardar esse snapshot.
 * - First Goal, Race To X, Goleador, Próximo Canto/Cartão, Player Props: precisam de eventos
 *   confirmados (quem marcou, em que minuto) que este feed (snapshots periódicos, não stream de
 *   eventos) não fornece com a granularidade necessária.
 */

function toBetResult(o: SettlementOutcome): BetResult {
  return o; // SettlementOutcome ⊂ BetResult (WON/LOST/VOID/UNRESOLVABLE) — mesmo vocabulário
}

/** Liquidação antecipada de Over/Under (golos/pontos/cantos/cartões/...): só é seguro decidir
 * MAIS CEDO quando o total JÁ ultrapassou a linha — nesse momento, tanto o Over (ganhou) como o
 * Under (perdeu) já são irreversíveis (o total nunca desce). Antes disso, qualquer lado ainda
 * pode mudar, por isso fica OPEN. Ver secções 13/14/24/25/36/41/45 da spec — exatamente o
 * comportamento descrito lá (Over 2.5: 2-0 ainda OPEN, 2-1 já WON). */
function earlyOverUnderVerdict(line: number, isOver: boolean, total: number): SettlementVerdict {
  if (total <= line) return "OPEN";
  return isOver ? "WON" : "LOST";
}

/** Liquidação antecipada de BTTS: só é seguro decidir quando AMBAS as equipas já marcaram —
 * nesse momento, tanto o Sim (ganhou) como o Não (perdeu) já são irreversíveis (não se pode
 * "desmarcar" um golo). Antes disso (só uma equipa marcou, ou nenhuma), qualquer lado ainda pode
 * mudar, por isso fica OPEN — mesmo o Não, que só é seguro confirmar como ganho no apito final
 * (secção 12 da spec: "Não liquidar como WON apenas porque existe 1-0"). */
function earlyBttsVerdict(isYes: boolean, hs: number, as: number): SettlementVerdict {
  const bothScored = hs > 0 && as > 0;
  if (!bothScored) return "OPEN";
  return isYes === bothScored ? "WON" : "LOST";
}

/** Over/Under com linha inteira empata exatamente na linha (ex: Over/Under 2.0 com total=2) —
 * secção 15 da spec: devolve PUSH (stake devolvido), distinto de VOID só para efeitos de
 * auditoria/relatório (o dinheiro é idêntico — ver payout factor em betting/settlement.ts). Só
 * decidido no final (nunca antecipado — o total ainda pode ultrapassar a linha antes do apito). */
function finalOverUnderVerdict(line: number, isOver: boolean, total: number): BetResult {
  if (total === line) return "PUSH";
  if (isOver) return total > line ? "WON" : "LOST";
  return total < line ? "WON" : "LOST";
}

function buildOverUnderConfig(sport: Sport, marketTypePrefix: string, rawMarket: string, rawSelection: string): MarketConfig | null {
  const line = extractLine(rawSelection, rawMarket);
  if (line === null) return null;
  const s = rawSelection.trim().toLowerCase();
  const isOver = /over|mais/.test(s);
  const isUnder = /under|menos/.test(s);
  if (!isOver && !isUnder) return null;
  return {
    marketType: `${marketTypePrefix}_${isOver ? "OVER" : "UNDER"}`,
    sport,
    scope: "REGULATION",
    line,
    canSettleEarly: true,
    requiresEventFinished: true, // o lado "seguro" da liquidação antecipada só cobre total>linha
    supportsPush: true,
  };
}

function evaluateOverUnder(config: MarketConfig, total: number, finished: boolean): SettlementVerdict {
  const line = config.line;
  if (line === null) return "UNRESOLVABLE";
  const isOver = config.marketType.endsWith("_OVER");
  if (!finished) return earlyOverUnderVerdict(line, isOver, total);
  return finalOverUnderVerdict(line, isOver, total);
}

export function createScoreBasedAdapter(sport: Sport): SettlementAdapter {
  return {
    sport,

    buildMarketConfig(rawMarket, rawSelection) {
      const category = classifyMarket(rawMarket);
      switch (category) {
        case "MATCH_RESULT":
          return { marketType: "MATCH_RESULT", sport, scope: "REGULATION", line: null, canSettleEarly: false, requiresEventFinished: true, supportsPush: false };
        case "DOUBLE_CHANCE":
          return { marketType: "DOUBLE_CHANCE", sport, scope: "REGULATION", line: null, canSettleEarly: false, requiresEventFinished: true, supportsPush: false };
        case "DRAW_NO_BET":
          return { marketType: "DRAW_NO_BET", sport, scope: "REGULATION", line: null, canSettleEarly: false, requiresEventFinished: true, supportsPush: true };
        case "BTTS": {
          const s = rawSelection.trim().toLowerCase();
          const isYes = /^(yes|sim)$/.test(s);
          const isNo = /^(no|não|nao)$/.test(s);
          if (!isYes && !isNo) return null;
          return { marketType: isYes ? "BTTS_YES" : "BTTS_NO", sport, scope: "REGULATION", line: null, canSettleEarly: true, requiresEventFinished: true, supportsPush: false };
        }
        case "OVER_UNDER_GOALS":
          return buildOverUnderConfig(sport, "TOTAL_GOALS", rawMarket, rawSelection);
        case "OVER_UNDER_CORNERS":
          return buildOverUnderConfig(sport, "TOTAL_CORNERS", rawMarket, rawSelection);
        case "OVER_UNDER_CARDS":
          return buildOverUnderConfig(sport, "TOTAL_CARDS", rawMarket, rawSelection);
        case "CORRECT_SCORE":
          return { marketType: "CORRECT_SCORE", sport, scope: "REGULATION", line: null, canSettleEarly: false, requiresEventFinished: true, supportsPush: false };
        default:
          return null;
      }
    },

    evaluateMarket(config, rawSelection, state) {
      const { homeScore: hs, awayScore: as } = state;
      if (hs === null || as === null) return state.finished ? "UNRESOLVABLE" : "OPEN";

      switch (config.marketType) {
        case "MATCH_RESULT":
          return state.finished ? toBetResult(resolveMatchResult(rawSelection, state.home, state.away, hs, as)) : "OPEN";
        case "DOUBLE_CHANCE":
          return state.finished ? toBetResult(resolveDoubleChance(rawSelection, state.home, state.away, hs, as)) : "OPEN";
        case "DRAW_NO_BET":
          return state.finished ? toBetResult(resolveDrawNoBet(rawSelection, state.home, state.away, hs, as)) : "OPEN";
        case "BTTS_YES":
          return !state.finished ? earlyBttsVerdict(true, hs, as) : toBetResult(resolveBTTS(rawSelection, hs, as));
        case "BTTS_NO":
          return !state.finished ? earlyBttsVerdict(false, hs, as) : toBetResult(resolveBTTS(rawSelection, hs, as));
        case "CORRECT_SCORE":
          return state.finished ? toBetResult(resolveCorrectScore(rawSelection, hs, as)) : "OPEN";
        case "TOTAL_GOALS_OVER":
        case "TOTAL_GOALS_UNDER":
          return evaluateOverUnder(config, hs + as, state.finished);
        case "TOTAL_CORNERS_OVER":
        case "TOTAL_CORNERS_UNDER":
          return state.homeCorners === undefined || state.awayCorners === undefined
            ? state.finished
              ? "UNRESOLVABLE"
              : "OPEN"
            : evaluateOverUnder(config, state.homeCorners + state.awayCorners, state.finished);
        case "TOTAL_CARDS_OVER":
        case "TOTAL_CARDS_UNDER":
          return state.homeCards === undefined || state.awayCards === undefined
            ? state.finished
              ? "UNRESOLVABLE"
              : "OPEN"
            : evaluateOverUnder(config, state.homeCards + state.awayCards, state.finished);
        default:
          return "UNRESOLVABLE";
      }
    },
  };
}
