import { Prisma, type Bet, type BetSelection, type BetSelectionStatus, type BetStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { applyLedgerMovement, applyBonusLedgerMovement } from "../wallet/service";
import type { LiveEvent } from "../sports/types";
import { reverseRolloverContribution } from "../promotions/service";
import { getSettlementAdapter, evaluateSelection, type MatchState, type SettlementVerdict } from "../settlement";

/**
 * Liquidação de apostas — ver docs/BETTING.md e server/src/modules/settlement/ (Settlement
 * Engine, Fase 1). Dois caminhos, o mesmo motor por baixo (evaluateSelection):
 *
 * 1. checkEarlySettlement — chamado a CADA snapshot ao vivo (hybridSportsService "event"), com
 *    o jogo ainda a decorrer. Só liquida os mercados que o adaptador do desporto marcar como
 *    canSettleEarly E cujo resultado já seja matematicamente irreversível (ex: BTTS Sim depois
 *    de ambas equipas marcarem) — a esmagadora maioria das seleções continua "OPEN" e não é
 *    tocada. Nunca marca nada como NEEDS_REVIEW aqui (um mercado ainda por decidir não é o mesmo
 *    que um mercado que o motor não sabe resolver — só o "remove" abaixo tem essa palavra final).
 * 2. settleEventFinished — disparado quando um evento desaparece do feed ao vivo
 *    (hybridSportsService "remove", único momento em que o placar final ainda está disponível —
 *    a Pulsescore nunca reporta um estado "finished" explícito) e por uma vassoura periódica de
 *    segurança (sweepStaleBets) para o caso raro de o processo reiniciar a meio de um jogo e
 *    nunca chegar a ver o "remove" desse evento em particular. Liquida tudo o que ainda está
 *    PENDING (a maioria dos mercados, que não são early-settleable) e manda para NEEDS_REVIEW o
 *    que o motor não souber decidir com segurança.
 */

function buildMatchState(event: LiveEvent, finished: boolean): MatchState {
  const homeScore = typeof event.homeScore === "number" ? event.homeScore : Number(event.homeScore);
  const awayScore = typeof event.awayScore === "number" ? event.awayScore : Number(event.awayScore);
  const hasValidScore = Number.isFinite(homeScore) && Number.isFinite(awayScore);
  return {
    finished,
    home: event.home,
    away: event.away,
    homeScore: hasValidScore ? homeScore : null,
    awayScore: hasValidScore ? awayScore : null,
    homeCorners: event.statistics?.home.corners,
    awayCorners: event.statistics?.away.corners,
    homeCards: event.statistics ? (event.statistics.home.yellowCards ?? 0) + (event.statistics.home.redCards ?? 0) : undefined,
    awayCards: event.statistics ? (event.statistics.away.yellowCards ?? 0) + (event.statistics.away.redCards ?? 0) : undefined,
  };
}

function verdictToSelectionStatus(verdict: SettlementVerdict): BetSelectionStatus {
  if (verdict === "OPEN" || verdict === "UNRESOLVABLE") return "NEEDS_REVIEW";
  return verdict;
}

/** Liquidação antecipada — ver cabeçalho do ficheiro. Chamado a cada snapshot ao vivo, para
 * TODOS os desportos (o adaptador de cada um decide se sabe fazer alguma coisa — os desportos
 * "adiados", ver settlement/adapters/deferred.ts, nunca liquidam nada aqui). */
export async function checkEarlySettlement(event: LiveEvent) {
  const pendingSelections = await prisma.betSelection.findMany({
    where: { eventId: event.id, status: "PENDING" },
  });
  if (!pendingSelections.length) return;

  const adapter = getSettlementAdapter(event.sport);
  const state = buildMatchState(event, false);
  const affectedBetIds = new Set<string>();

  for (const sel of pendingSelections) {
    const { verdict, reason } = evaluateSelection(adapter, sel.market, sel.selection, state);
    if (verdict === "OPEN" || verdict === "UNRESOLVABLE") continue; // a maioria — nada a fazer ainda

    // Idempotência: só atualiza se a seleção AINDA estiver PENDING — protege contra corrida com
    // outra chamada concorrente (o próximo snapshot, ou settleEventFinished a decorrer ao mesmo
    // tempo se o jogo terminar entre dois polls). updateMany devolve count 0 se já não estiver.
    const updated = await prisma.betSelection.updateMany({
      where: { id: sel.id, status: "PENDING" },
      data: {
        status: verdictToSelectionStatus(verdict),
        settlementReason: reason,
        finalHomeScore: state.homeScore !== null ? Math.trunc(state.homeScore) : null,
        finalAwayScore: state.awayScore !== null ? Math.trunc(state.awayScore) : null,
        settledAt: new Date(),
      },
    });
    if (updated.count > 0) {
      affectedBetIds.add(sel.betId);
      logger.info({ selectionId: sel.id, eventId: event.id, verdict, reason }, "[BETTING] liquidação antecipada");
    }
  }

  for (const betId of affectedBetIds) {
    await finalizeBetIfComplete(betId);
  }
}

export async function settleEventFinished(event: LiveEvent) {
  const pendingSelections = await prisma.betSelection.findMany({
    where: { eventId: event.id, status: "PENDING" },
  });
  if (!pendingSelections.length) return;

  const adapter = getSettlementAdapter(event.sport);
  const state = buildMatchState(event, true);
  const affectedBetIds = new Set<string>();

  for (const sel of pendingSelections) {
    const { verdict, reason } = evaluateSelection(adapter, sel.market, sel.selection, state);
    await prisma.betSelection.update({
      where: { id: sel.id },
      data: {
        status: verdictToSelectionStatus(verdict),
        settlementReason: reason,
        finalHomeScore: state.homeScore !== null ? Math.trunc(state.homeScore) : null,
        finalAwayScore: state.awayScore !== null ? Math.trunc(state.awayScore) : null,
        settledAt: new Date(),
      },
    });
    affectedBetIds.add(sel.betId);
  }

  logger.info(
    { eventId: event.id, sport: event.sport, selectionsSettled: pendingSelections.length, hasValidScore: state.homeScore !== null },
    "[BETTING] seleções liquidadas para o evento terminado"
  );

  for (const betId of affectedBetIds) {
    await finalizeBetIfComplete(betId);
  }
}

/** Reavalia um Bet depois de uma ou mais das suas seleções terem sido liquidadas — só decide
 * algo quando TODAS as seleções já saíram de PENDING (numa Múltipla, os outros jogos podem
 * ainda estar a decorrer). Idempotente: só mexe num Bet que ainda esteja PENDING. */
async function finalizeBetIfComplete(betId: string) {
  await prisma.$transaction(async (tx) => {
    const bet = await tx.bet.findUniqueOrThrow({ where: { id: betId }, include: { selections: true } });
    if (bet.status !== "PENDING") return; // já liquidado (idempotência) ou já em NEEDS_REVIEW

    const stillPending = bet.selections.some((s) => s.status === "PENDING");
    if (stillPending) return;

    const anyNeedsReview = bet.selections.some((s) => s.status === "NEEDS_REVIEW");
    if (anyNeedsReview) {
      await tx.bet.update({ where: { id: bet.id }, data: { status: "NEEDS_REVIEW" } });
      return;
    }

    await applyFinalOutcome(tx, bet, bet.selections);
  });
}

/** Fator de payout de UMA seleção decidida — o quanto o stake "vale" depois desta seleção,
 * multiplicado no produto de todas as seleções do Bet (ver calculateBetResult). WON usa a odd
 * inteira, LOST anula tudo (fator 0 — zera o produto do Bet inteiro, como uma Múltipla exige),
 * VOID/PUSH devolvem o stake sem alterar (fator 1, financeiramente idênticos — só o rótulo
 * difere, ver secção 15/79 da spec do Settlement Engine), HALF_WIN/HALF_LOSS dividem a aposta ao
 * meio (Handicap Asiático fracionado — ainda não emitido por nenhum adaptador, ver
 * settlement/adapters/scoreBased.ts, mas o cálculo já está pronto para quando estiver). */
function outcomeFactor(status: BetSelectionStatus, odd: Prisma.Decimal): Prisma.Decimal {
  switch (status) {
    case "WON":
      return odd;
    case "LOST":
      return new Prisma.Decimal(0);
    case "VOID":
    case "PUSH":
      return new Prisma.Decimal(1);
    case "HALF_WIN":
      return odd.add(1).div(2);
    case "HALF_LOSS":
      return new Prisma.Decimal(0.5);
    default:
      // PENDING/NEEDS_REVIEW nunca deviam chegar aqui — o chamador só invoca isto depois de
      // confirmar que TODAS as seleções do Bet já saíram desses dois estados.
      throw new Error(`calculateBetResult: seleção com estado inesperado "${status}" (devia estar decidida)`);
  }
}

/** Calcula o resultado final de um Bet cujas seleções estão TODAS decididas (nenhuma PENDING/
 * NEEDS_REVIEW). Função pura sem efeitos secundários — extraída para testes unitários sem tocar
 * em DB. O payout é sempre o produto dos fatores de cada seleção (ver outcomeFactor) vezes o
 * stake — generaliza a fórmula antiga (que só sabia WON/LOST/VOID) para também suportar PUSH/
 * HALF_WIN/HALF_LOSS, produzindo exatamente o mesmo resultado que antes para os três estados
 * originais (uma seleção LOST zera tudo, VOID não muda nada, só WON multiplica a odd). */
export function calculateBetResult(params: {
  stake: Prisma.Decimal | number | string;
  selections: Array<{ status: BetSelectionStatus; odd: Prisma.Decimal | number | string }>;
}) {
  const stake = new Prisma.Decimal(params.stake);
  const selections = params.selections.map((s) => ({
    status: s.status,
    odd: new Prisma.Decimal(s.odd),
  }));

  const effectiveOdd = selections.reduce((acc, s) => acc.mul(outcomeFactor(s.status, s.odd)), new Prisma.Decimal(1));
  const payout = stake.mul(effectiveOdd);

  let status: BetStatus;
  if (payout.isZero()) status = "LOST";
  else if (payout.equals(stake)) status = "VOID";
  else status = "WON";

  const netResult = payout.sub(stake);
  return { status, payout, netResult, stake };
}

/** Calcula e aplica o resultado final de um Bet cujas seleções estão TODAS decididas (WON/LOST/
 * VOID, nenhuma PENDING/NEEDS_REVIEW) — usado tanto pela liquidação automática como pela
 * correção manual do admin depois de resolver uma seleção NEEDS_REVIEW à mão. */
export async function applyFinalOutcome(tx: Prisma.TransactionClient, bet: Bet, selections: BetSelection[]) {
  const result = calculateBetResult({ stake: bet.stake, selections });
  const status = result.status;
  const payout = result.payout;
  const usedBonus = bet.bonusStakeAmount.greaterThan(0);

  await tx.bet.update({ where: { id: bet.id }, data: { status, payout, settledAt: new Date() } });

  if (status === "WON") {
    // Ganho de uma aposta financiada (mesmo que parcialmente) por saldo promocional volta
    // INTEIRO para o saldo promocional ("sticky bonus", decisão de produto #2 — ver
    // promotions/service.ts), não para o real, até o rollover estar completo.
    if (usedBonus) {
      await applyBonusLedgerMovement({
        walletId: bet.walletId,
        type: "BONUS_WON",
        amount: payout,
        referenceType: "bet",
        referenceId: bet.id,
        metadata: { betType: bet.type, stake: bet.stake.toString() },
        tx,
      });
    } else {
      await applyLedgerMovement({
        walletId: bet.walletId,
        type: "BET_WON",
        amount: payout,
        referenceType: "bet",
        referenceId: bet.id,
        metadata: { betType: bet.type, stake: bet.stake.toString() },
        tx,
      });
    }
  } else if (status === "VOID") {
    // Devolve o stake na mesma proporção em que foi debitado — a parte promocional volta para o
    // saldo promocional (não é dinheiro real), a parte real volta para o saldo real.
    const bonusPortion = usedBonus ? Prisma.Decimal.min(bet.bonusStakeAmount, payout) : new Prisma.Decimal(0);
    const realPortion = payout.sub(bonusPortion);
    if (realPortion.greaterThan(0)) {
      await applyLedgerMovement({
        walletId: bet.walletId,
        type: "BET_REFUND",
        amount: realPortion,
        referenceType: "bet",
        referenceId: bet.id,
        metadata: { betType: bet.type, stake: bet.stake.toString() },
        tx,
      });
    }
    if (bonusPortion.greaterThan(0)) {
      await applyBonusLedgerMovement({
        walletId: bet.walletId,
        type: "BONUS_STAKE",
        amount: bonusPortion,
        referenceType: "bet",
        referenceId: bet.id,
        metadata: { betType: bet.type, reason: "void_refund" },
        tx,
      });
    }
    if (bet.userPromotionId) await reverseRolloverContribution(bet, tx);
  }

  logger.info({ betId: bet.id, userId: bet.userId, status, payout: payout.toString(), usedBonus }, "[BETTING] aposta liquidada");
}

/**
 * Vassoura de segurança — corre periodicamente (ver server.ts). Cobre o caso raro de o processo
 * reiniciar a meio de um jogo (perde o evento "remove" desse jogo específico para sempre, já
 * que hybridSportsService reconstrói o seu mapa em memória do zero). Nunca inventa um
 * resultado: só marca para revisão manual do admin as seleções cujo evento já devia ter
 * terminado há muito (kickoff + margem generosa) e continuam PENDING sem que o caminho normal
 * as tenha liquidado.
 */
const STALE_GRACE_HOURS = 6;

export async function sweepStaleBets() {
  const cutoff = new Date(Date.now() - STALE_GRACE_HOURS * 60 * 60 * 1000);
  const stale = await prisma.betSelection.findMany({
    where: { status: "PENDING", kickoffAt: { not: null, lt: cutoff } },
  });
  if (!stale.length) return;

  logger.warn(
    { count: stale.length, eventIds: stale.map((s) => s.eventId) },
    "[BETTING] vassoura: seleções presas em PENDING muito depois do kickoff — a marcar para revisão manual"
  );

  const affectedBetIds = new Set<string>();
  for (const sel of stale) {
    await prisma.betSelection.update({ where: { id: sel.id }, data: { status: "NEEDS_REVIEW", settledAt: new Date() } });
    affectedBetIds.add(sel.betId);
  }
  for (const betId of affectedBetIds) {
    await finalizeBetIfComplete(betId);
  }
}
