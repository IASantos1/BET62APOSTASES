/**
 * Regras puras de resolução de mercados a partir do placar final — sem I/O, sem Prisma, só
 * classificação de texto + comparação de números. Ver docs/BETTING.md para a lista completa
 * de mercados cobertos e o porquê dos que ficam de fora (heurística por palavra-chave sobre o
 * nome bruto do mercado enviado pela Pulsescore, mesma abordagem já usada em
 * web/app.js::MARKET_FILTER_CATEGORIES para os filtros — aqui para decidir quem ganhou, não só
 * para agrupar visualmente, por isso muito mais conservadora: qualquer coisa que não se consiga
 * confirmar com segurança cai em UNRESOLVABLE em vez de arriscar liquidar mal).
 */
export type SettlementOutcome = "WON" | "LOST" | "VOID" | "UNRESOLVABLE";

// Mercados de uma parte/período específico (1º Tempo, 2º Quarto, 1º Set...) NUNCA são
// resolvidos automaticamente — precisariam do placar NAQUELE momento (ex: ao intervalo), que
// este sistema não guarda, só o placar final. Tentar resolvê-los com o placar final seria
// mesmo errado (não só impreciso), por isso isto corta ANTES de qualquer outra classificação.
const PERIOD_SPECIFIC_RE =
  /1st half|first half|2nd half|second half|half.?time|\bht\b|1st quarter|first quarter|2nd quarter|3rd quarter|4th quarter|\bq[1-4]\b|1st period|first period|2nd period|3rd period|period\s*\d|1st set|first set|1st inning|\binning\b/i;

export type MarketCategory =
  | "MATCH_RESULT"
  | "DOUBLE_CHANCE"
  | "DRAW_NO_BET"
  | "OVER_UNDER_GOALS"
  | "OVER_UNDER_CORNERS"
  | "OVER_UNDER_CARDS"
  | "BTTS"
  | "CORRECT_SCORE"
  | "UNKNOWN";

export function classifyMarket(market: string): MarketCategory {
  if (PERIOD_SPECIFIC_RE.test(market)) return "UNKNOWN";
  if (/draw no bet/i.test(market)) return "DRAW_NO_BET";
  if (/double chance/i.test(market)) return "DOUBLE_CHANCE";
  const isOverUnder = /over\/?under|total/i.test(market);
  if (/corner/i.test(market)) return isOverUnder ? "OVER_UNDER_CORNERS" : "UNKNOWN";
  if (/\bcard|booking/i.test(market)) return isOverUnder ? "OVER_UNDER_CARDS" : "UNKNOWN";
  if (/both teams to score|\bbtts\b/i.test(market)) return "BTTS";
  if (/correct score|exact score/i.test(market)) return "CORRECT_SCORE";
  if (isOverUnder || /total (goals|points|games|runs)/i.test(market)) return "OVER_UNDER_GOALS";
  // Handicap/Asian handicap ficam de fora de propósito: o formato exato da seleção ("1 (-1)",
  // "Home -1.5", "-1.5 Casa"...) nunca foi confirmado contra uma amostra real da Pulsescore —
  // resolver às cegas arriscaria interpretar mal o sinal/lado. NEEDS_REVIEW até haver amostra.
  if (/handicap|spread|asian/i.test(market)) return "UNKNOWN";
  if (/match odds|\b1x2\b|to win|winner|money.?line|full time result|3.?way/i.test(market)) return "MATCH_RESULT";
  return "UNKNOWN";
}

function extractLine(...texts: string[]): number | null {
  for (const t of texts) {
    const m = t.match(/(\d+(?:\.\d+)?)/);
    if (m?.[1]) return parseFloat(m[1]);
  }
  return null;
}

function resolveMatchResult(selection: string, home: string, away: string, hs: number, as: number): SettlementOutcome {
  const s = selection.trim().toLowerCase();
  const isHome = s === "1" || s === "home" || s === home.trim().toLowerCase();
  const isAway = s === "2" || s === "away" || s === away.trim().toLowerCase();
  const isDraw = s === "x" || s === "draw" || s === "empate";
  if (!isHome && !isAway && !isDraw) return "UNRESOLVABLE";
  if (hs === as) return isDraw ? "WON" : "LOST";
  const homeWon = hs > as;
  return (isHome && homeWon) || (isAway && !homeWon) ? "WON" : "LOST";
}

function resolveDoubleChance(selection: string, hs: number, as: number): SettlementOutcome {
  const s = selection.replace(/\s+/g, "").toUpperCase();
  const draw = hs === as;
  const homeWon = hs > as;
  const awayWon = as > hs;
  if (s === "1X" || s === "X1") return homeWon || draw ? "WON" : "LOST";
  if (s === "X2" || s === "2X") return awayWon || draw ? "WON" : "LOST";
  if (s === "12") return draw ? "LOST" : "WON";
  return "UNRESOLVABLE";
}

function resolveDrawNoBet(selection: string, home: string, away: string, hs: number, as: number): SettlementOutcome {
  if (hs === as) return "VOID"; // empate devolve o stake, não conta como ganho nem perda
  return resolveMatchResult(selection, home, away, hs, as);
}

function resolveOverUnder(market: string, selection: string, total: number): SettlementOutcome {
  const line = extractLine(selection, market);
  if (line === null) return "UNRESOLVABLE";
  const s = selection.trim().toLowerCase();
  const isOver = /over|mais/.test(s);
  const isUnder = /under|menos/.test(s);
  if (!isOver && !isUnder) return "UNRESOLVABLE";
  if (total === line) return "VOID"; // push — total bateu exatamente na linha
  if (isOver) return total > line ? "WON" : "LOST";
  return total < line ? "WON" : "LOST";
}

function resolveBTTS(selection: string, hs: number, as: number): SettlementOutcome {
  const s = selection.trim().toLowerCase();
  const yes = /^(yes|sim)$/.test(s);
  const no = /^(no|não|nao)$/.test(s);
  if (!yes && !no) return "UNRESOLVABLE";
  const bothScored = hs > 0 && as > 0;
  return yes === bothScored ? "WON" : "LOST";
}

function resolveCorrectScore(selection: string, hs: number, as: number): SettlementOutcome {
  const m = selection.replace(/\s+/g, "").match(/^(\d+)[-:](\d+)$/);
  if (!m) return "UNRESOLVABLE";
  return Number(m[1]) === hs && Number(m[2]) === as ? "WON" : "LOST";
}

export interface SelectionContext {
  market: string;
  selection: string;
  home: string;
  away: string;
}

export interface FinalStats {
  homeScore: number;
  awayScore: number;
  homeCorners?: number;
  awayCorners?: number;
  homeCards?: number;
  awayCards?: number;
}

/** Ponto de entrada — devolve UNRESOLVABLE (nunca inventa) sempre que o mercado, a seleção, ou
 * os dados finais necessários não sejam suficientes para decidir com segurança. */
export function resolveBetSelectionOutcome(sel: SelectionContext, stats: FinalStats): SettlementOutcome {
  const category = classifyMarket(sel.market);
  switch (category) {
    case "MATCH_RESULT":
      return resolveMatchResult(sel.selection, sel.home, sel.away, stats.homeScore, stats.awayScore);
    case "DOUBLE_CHANCE":
      return resolveDoubleChance(sel.selection, stats.homeScore, stats.awayScore);
    case "DRAW_NO_BET":
      return resolveDrawNoBet(sel.selection, sel.home, sel.away, stats.homeScore, stats.awayScore);
    case "OVER_UNDER_GOALS":
      return resolveOverUnder(sel.market, sel.selection, stats.homeScore + stats.awayScore);
    case "OVER_UNDER_CORNERS":
      return stats.homeCorners !== undefined && stats.awayCorners !== undefined
        ? resolveOverUnder(sel.market, sel.selection, stats.homeCorners + stats.awayCorners)
        : "UNRESOLVABLE";
    case "OVER_UNDER_CARDS":
      return stats.homeCards !== undefined && stats.awayCards !== undefined
        ? resolveOverUnder(sel.market, sel.selection, stats.homeCards + stats.awayCards)
        : "UNRESOLVABLE";
    case "BTTS":
      return resolveBTTS(sel.selection, stats.homeScore, stats.awayScore);
    case "CORRECT_SCORE":
      return resolveCorrectScore(sel.selection, stats.homeScore, stats.awayScore);
    default:
      return "UNRESOLVABLE";
  }
}

// ============ Bet Builder (server/src/modules/betting/service.ts) ============
// As 5 categorias do Bet Builder mapeiam diretamente para as categorias de MarketCategory que o
// motor de liquidação automática já sabe resolver sozinho (classifyMarket() acima) — pedido
// explícito do utilizador: só entram no Bet Builder mercados que já liquidam sozinhos, nunca os
// de jogador (remates, assistências, faltas, impedimentos, passes), para os quais este projeto
// nunca recebeu, em nenhuma amostra real, dados por jogador que permitissem decidir o resultado
// sem inventar. CORRECT_SCORE fica de fora do Bet Builder por não estar na lista das 5
// categorias pedidas (Resultado/Golos/BTTS/Escanteios/Cartões), mesmo já sabendo liquidar-se.
export type BetBuilderCategory = "RESULTADO" | "GOLS" | "BTTS" | "ESCANTEIOS" | "CARTOES";

const BET_BUILDER_CATEGORY_BY_MARKET: Partial<Record<MarketCategory, BetBuilderCategory>> = {
  MATCH_RESULT: "RESULTADO",
  DOUBLE_CHANCE: "RESULTADO",
  DRAW_NO_BET: "RESULTADO",
  OVER_UNDER_GOALS: "GOLS",
  BTTS: "BTTS",
  OVER_UNDER_CORNERS: "ESCANTEIOS",
  OVER_UNDER_CARDS: "CARTOES",
};

/** Classifica um mercado bruto numa categoria de Bet Builder, ou `null` se não for permitido
 * (fora das 5 categorias aprovadas, ou período específico — ver PERIOD_SPECIFIC_RE acima). */
export function classifyForBetBuilder(market: string): BetBuilderCategory | null {
  return BET_BUILDER_CATEGORY_BY_MARKET[classifyMarket(market)] ?? null;
}

// Desportos onde homeScore/awayScore do LiveEvent é diretamente o resultado final do jogo
// (golos/pontos/corridas) — condição para sequer tentar liquidar automaticamente. Ténis e
// voleibol contam por sets (não por homeScore/awayScore, que ali seguem os pontos do jogo
// atual), Fórmula 1/MMA não têm um "placar" nesta forma — todos ficam sempre para revisão
// manual (NEEDS_REVIEW) em vez de arriscar interpretar mal os dados que temos.
export const SCORE_SETTLEABLE_SPORTS = new Set(["football", "basketball", "ice_hockey", "baseball"]);
