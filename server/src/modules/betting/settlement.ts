import { Prisma, type Bet, type BetSelection, type BetSelectionStatus, type BetStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { applyLedgerMovement, applyBonusLedgerMovement } from "../wallet/service";
import type { LiveEvent } from "../sports/types";
import { resolveBetSelectionOutcome, SCORE_SETTLEABLE_SPORTS, type SettlementOutcome } from "./settlementRules";
import { reverseRolloverContribution } from "../promotions/service";

/**
 * Liquidação de apostas — ver docs/BETTING.md. Disparada quando um evento desaparece do feed
 * ao vivo (hybridSportsService "remove", único momento em que o placar final ainda está
 * disponível — a Pulsescore nunca reporta um estado "finished" explícito) e por uma vassoura
 * periódica de segurança (sweepStaleBets) para o caso raro de o processo reiniciar a meio de um
 * jogo e nunca chegar a ver o "remove" desse evento em particular.
 */
export async function settleEventFinished(event: LiveEvent) {
  const pendingSelections = await prisma.betSelection.findMany({
    where: { eventId: event.id, status: "PENDING" },
  });
  if (!pendingSelections.length) return;

  const scoreSettleable = SCORE_SETTLEABLE_SPORTS.has(event.sport);
  const homeScore = typeof event.homeScore === "number" ? event.homeScore : Number(event.homeScore);
  const awayScore = typeof event.awayScore === "number" ? event.awayScore : Number(event.awayScore);
  const hasValidScore = scoreSettleable && Number.isFinite(homeScore) && Number.isFinite(awayScore);

  const stats = {
    homeScore,
    awayScore,
    homeCorners: event.statistics?.home.corners,
    awayCorners: event.statistics?.away.corners,
    homeCards: event.statistics ? (event.statistics.home.yellowCards ?? 0) + (event.statistics.home.redCards ?? 0) : undefined,
    awayCards: event.statistics ? (event.statistics.away.yellowCards ?? 0) + (event.statistics.away.redCards ?? 0) : undefined,
  };

  const affectedBetIds = new Set<string>();

  for (const sel of pendingSelections) {
    const outcome: SettlementOutcome = hasValidScore
      ? resolveBetSelectionOutcome({ market: sel.market, selection: sel.selection, home: sel.home, away: sel.away }, stats)
      : "UNRESOLVABLE";

    await prisma.betSelection.update({
      where: { id: sel.id },
      data: {
        status: outcomeToSelectionStatus(outcome),
        finalHomeScore: hasValidScore ? Math.trunc(homeScore) : null,
        finalAwayScore: hasValidScore ? Math.trunc(awayScore) : null,
        settledAt: new Date(),
      },
    });
    affectedBetIds.add(sel.betId);
  }

  logger.info(
    { eventId: event.id, sport: event.sport, selectionsSettled: pendingSelections.length, hasValidScore },
    "[BETTING] seleções liquidadas para o evento terminado"
  );

  for (const betId of affectedBetIds) {
    await finalizeBetIfComplete(betId);
  }
}

function outcomeToSelectionStatus(outcome: SettlementOutcome): BetSelectionStatus {
  if (outcome === "UNRESOLVABLE") return "NEEDS_REVIEW";
  return outcome;
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

/** Calcula o resultado final de um Bet cujas seleções estão TODAS decididas (WON/LOST/VOID,
 * nenhuma PENDING/NEEDS_REVIEW). Função pura sem efeitos secundários — extraída para testes
 * unitários sem tocar em DB. */
export function calculateBetResult(params: {
  stake: Prisma.Decimal | number | string;
  selections: Array<{ status: BetSelectionStatus; odd: Prisma.Decimal | number | string }>;
}) {
  const stake = new Prisma.Decimal(params.stake);
  const selections = params.selections.map((s) => ({
    status: s.status,
    odd: new Prisma.Decimal(s.odd),
  }));

  const anyLost = selections.some((s) => s.status === "LOST");
  const allVoid = selections.every((s) => s.status === "VOID");

  let status: BetStatus;
  let payout: Prisma.Decimal;

  if (anyLost) {
    status = "LOST";
    payout = new Prisma.Decimal(0);
  } else if (allVoid) {
    status = "VOID";
    payout = stake;
  } else {
    status = "WON";
    const effectiveOdd = selections
      .filter((s) => s.status === "WON")
      .reduce((acc, s) => acc.mul(s.odd), new Prisma.Decimal(1));
    payout = stake.mul(effectiveOdd);
  }

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
