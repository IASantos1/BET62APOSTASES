import { Prisma, type Bet, type Promotion, type UserPromotion } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { applyBonusLedgerMovement, applyLedgerMovement } from "../wallet/service";
import { Errors } from "../../lib/errors";

type Tx = Prisma.TransactionClient;

/**
 * Motor de promoções — Fase 1 (Bónus de Boas-Vindas + rollover), sobre a spec colada pelo
 * utilizador ("MODELO DE PROMOÇÕES BET62"). Pontos/VIP/Missões/Cashback automático ficam para
 * uma fase seguinte sobre esta mesma fundação (Wallet.bonusBalance + Promotion/UserPromotion).
 *
 * Duas decisões de produto que a spec não define explicitamente, tomadas aqui (documentadas para
 * o utilizador poder corrigir):
 * 1. Ao apostar, o saldo PROMOCIONAL é gasto primeiro; só quando não chega é que o saldo REAL é
 *    tocado (ver debitStakeWithBonusFirst) — assim o rollover avança a cada aposta.
 * 2. Ganhos de uma aposta financiada (mesmo que parcialmente) por saldo promocional voltam para
 *    o saldo promocional, não para o real, até o rollover estar completo ("sticky bonus",
 *    prática padrão do setor) — ver creditWinningsForBet em betting/service.ts (Fase 1b).
 */

// ============ CONCESSÃO ============

/** Chamado dentro da MESMA transação que credita um depósito bem-sucedido (ver
 * payments/stripe/service.ts::creditDepositFromIntent). Silencioso (não lança erro) sempre que
 * o utilizador não for elegível — um depósito nunca deve falhar por causa de uma promoção. */
export async function grantWelcomeBonusIfEligible(userId: string, walletId: string, depositAmount: Prisma.Decimal, tx: Tx): Promise<void> {
  try {
    const promo = await tx.promotion.findFirst({
      where: { type: "WELCOME_BONUS", active: true },
      orderBy: { createdAt: "asc" },
    });
    if (!promo) return;

    // "Só uma vez por utilizador" — qualquer UserPromotion anterior desta promoção (mesmo
    // EXPIRED/CANCELLED) bloqueia uma segunda concessão.
    const already = await tx.userPromotion.findFirst({ where: { userId, promotionId: promo.id } });
    if (already) return;

    if (promo.minDepositAmount && depositAmount.lessThan(promo.minDepositAmount)) return;

    const bonusAmount = computeBonusAmount(depositAmount, promo);
    if (bonusAmount.lessThanOrEqualTo(0)) return;

    const rolloverRequired = bonusAmount.mul(promo.rolloverMultiplier);
    const expiresAt = new Date(Date.now() + promo.validityDays * 24 * 60 * 60 * 1000);

    const userPromotion = await tx.userPromotion.create({
      data: {
        userId,
        walletId,
        promotionId: promo.id,
        bonusAmount,
        rolloverRequired,
        minOdd: promo.minOdd,
        expiresAt,
      },
    });

    await applyBonusLedgerMovement({
      walletId,
      type: "BONUS_GRANTED",
      amount: bonusAmount,
      referenceType: "user_promotion",
      referenceId: userPromotion.id,
      metadata: { promotionId: promo.id, promotionName: promo.name, depositAmount: depositAmount.toString() },
      tx,
    });

    logger.info({ userId, promotionId: promo.id, bonusAmount: bonusAmount.toString() }, "[PROMOTIONS] Bónus de Boas-Vindas concedido");
  } catch (err) {
    // Nunca deixar uma falha na concessão de bónus impedir o crédito do depósito em si.
    logger.error({ userId, err }, "[PROMOTIONS] falha ao conceder Bónus de Boas-Vindas — depósito continua a ser creditado normalmente");
  }
}

function computeBonusAmount(depositAmount: Prisma.Decimal, promo: Promotion): Prisma.Decimal {
  let amount: Prisma.Decimal;
  if (promo.bonusPercent) {
    amount = depositAmount.mul(promo.bonusPercent).div(100);
  } else if (promo.bonusFixedAmount) {
    amount = promo.bonusFixedAmount;
  } else {
    return new Prisma.Decimal(0);
  }
  if (promo.bonusMaxAmount && amount.greaterThan(promo.bonusMaxAmount)) amount = promo.bonusMaxAmount;
  return amount.toDecimalPlaces(2);
}

// ============ APOSTA: débito do stake (promocional primeiro) ============

export async function getActiveUserPromotion(userId: string, tx?: Tx): Promise<UserPromotion | null> {
  const client = tx ?? prisma;
  return client.userPromotion.findFirst({ where: { userId, status: "ACTIVE" }, orderBy: { createdAt: "asc" } });
}

/** Divide o stake de UMA aposta entre saldo promocional (primeiro) e saldo real (o resto) — ver
 * decisão de produto #1 no comentário do topo do ficheiro. NÃO debita nada sozinho: devolve os
 * dois valores para o chamador (betting/service.ts) debitar dentro da MESMA transação que já usa
 * para o resto da colocação da aposta (bloqueio da wallet, criação do Bet, etc.), evitando dois
 * locks separados na mesma linha. */
export function splitStakeForBonus(stake: Prisma.Decimal, bonusBalance: Prisma.Decimal): { bonusPortion: Prisma.Decimal; realPortion: Prisma.Decimal } {
  const bonusPortion = Prisma.Decimal.min(stake, bonusBalance.isNegative() ? new Prisma.Decimal(0) : bonusBalance);
  const realPortion = stake.sub(bonusPortion);
  return { bonusPortion, realPortion };
}

// ============ ROLLOVER ============

const SPORT_ELIGIBLE = (promo: { eligibleSports: string[] }, sport: string) => !promo.eligibleSports.length || promo.eligibleSports.includes(sport);

/** Decide se UMA aposta conta para o rollover da promoção ativa do utilizador — odd mínima (a
 * odd combinada da aposta: a única seleção na Simples, o total na Múltipla/Bet Builder) e
 * desporto elegível (todas as seleções têm de ser de um desporto elegível). */
export function betQualifiesForRollover(
  userPromotion: Pick<UserPromotion, "minOdd">,
  promo: Pick<Promotion, "eligibleSports">,
  totalOdd: Prisma.Decimal,
  sports: string[]
): boolean {
  if (totalOdd.lessThan(userPromotion.minOdd)) return false;
  return sports.every((s) => SPORT_ELIGIBLE(promo, s));
}

/** Chamado na colocação de uma aposta (dentro da mesma transação), depois de confirmado que a
 * aposta qualifica (ver betQualifiesForRollover). Incrementa o progresso e completa a promoção
 * (converte o saldo promocional restante para saldo real) se o requisito for atingido. */
export async function applyRolloverContribution(userPromotionId: string, stakeAmount: Prisma.Decimal, tx: Tx): Promise<void> {
  const up = await tx.userPromotion.update({
    where: { id: userPromotionId },
    data: { rolloverProgress: { increment: stakeAmount } },
  });
  if (up.status === "ACTIVE" && up.rolloverProgress.greaterThanOrEqualTo(up.rolloverRequired)) {
    await completeUserPromotion(up, tx);
  }
}

async function completeUserPromotion(up: UserPromotion, tx: Tx): Promise<void> {
  const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: up.walletId } });
  await tx.userPromotion.update({ where: { id: up.id }, data: { status: "COMPLETED", completedAt: new Date() } });
  if (wallet.bonusBalance.greaterThan(0)) {
    await applyBonusLedgerMovement({
      walletId: up.walletId,
      type: "BONUS_CONVERTED",
      amount: wallet.bonusBalance.negated(),
      referenceType: "user_promotion",
      referenceId: up.id,
      tx,
    });
    await applyLedgerMovement({
      walletId: up.walletId,
      type: "BONUS",
      amount: wallet.bonusBalance,
      referenceType: "user_promotion",
      referenceId: up.id,
      metadata: { reason: "rollover_completed" },
      tx,
    });
  }
  logger.info({ userPromotionId: up.id, userId: up.userId }, "[PROMOTIONS] rollover completo — saldo promocional convertido para saldo real");
}

/** Reverte a contribuição de rollover de uma aposta que acabou TOTALMENTE anulada (Bet.status
 * VOID) — pedido explícito da spec (secção 4: "apostas anuladas/devolvidas/canceladas" não
 * contam). Só atua enquanto a promoção ainda está ACTIVE — uma vez completa e o saldo já
 * convertido, não há retroceder (âmbito da Fase 1, ver docs). */
export async function reverseRolloverContribution(bet: Bet, tx: Tx): Promise<void> {
  if (!bet.userPromotionId) return;
  const up = await tx.userPromotion.findUnique({ where: { id: bet.userPromotionId } });
  if (!up || up.status !== "ACTIVE") return;
  const newProgress = Prisma.Decimal.max(0, up.rolloverProgress.sub(bet.stake));
  await tx.userPromotion.update({ where: { id: up.id }, data: { rolloverProgress: newProgress } });
}

// ============ EXPIRAÇÃO ============

/** Vassoura periódica (mesmo padrão de betting/settlement.ts::sweepStaleBets, ver server.ts) —
 * expira promoções cujo prazo passou sem o rollover ser cumprido, perdendo o saldo promocional
 * restante (nunca o saldo real, que nunca foi tocado pela promoção). */
export async function sweepExpiredPromotions(): Promise<void> {
  const expired = await prisma.userPromotion.findMany({ where: { status: "ACTIVE", expiresAt: { lt: new Date() } } });
  if (!expired.length) return;

  for (const up of expired) {
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.userPromotion.findUniqueOrThrow({ where: { id: up.id } });
      if (fresh.status !== "ACTIVE") return; // idempotência
      await tx.userPromotion.update({ where: { id: up.id }, data: { status: "EXPIRED" } });
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: up.walletId } });
      if (wallet.bonusBalance.greaterThan(0)) {
        await applyBonusLedgerMovement({
          walletId: up.walletId,
          type: "BONUS_EXPIRED",
          amount: wallet.bonusBalance.negated(),
          referenceType: "user_promotion",
          referenceId: up.id,
          tx,
        });
      }
    });
  }
  logger.info({ count: expired.length }, "[PROMOTIONS] vassoura: promoções expiradas");
}

// ============ CONSULTA (jogador) ============

export async function listMyPromotions(userId: string) {
  return prisma.userPromotion.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: { promotion: true },
  });
}

export async function listActivePromotionsPublic() {
  // Mostrado ANTES de aderir (pedido explícito — secção 21: todas as regras visíveis antes da
  // adesão) — não exige login, é informativo.
  return prisma.promotion.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } });
}

// ============ ADMIN ============

export async function adminListPromotions() {
  return prisma.promotion.findMany({ orderBy: { createdAt: "desc" } });
}

export interface PromotionInput {
  type: "WELCOME_BONUS" | "DEPOSIT_BONUS" | "CASHBACK" | "FREEBET";
  name: string;
  active?: boolean;
  bonusPercent?: number | null;
  bonusFixedAmount?: number | null;
  bonusMaxAmount?: number | null;
  minDepositAmount?: number | null;
  rolloverMultiplier?: number;
  minOdd?: number;
  validityDays?: number;
  eligibleSports?: string[];
}

export async function adminCreatePromotion(input: PromotionInput) {
  if (!input.bonusPercent && !input.bonusFixedAmount) {
    throw Errors.badRequest("Indique bonusPercent ou bonusFixedAmount");
  }
  return prisma.promotion.create({
    data: {
      type: input.type,
      name: input.name,
      active: input.active ?? true,
      bonusPercent: input.bonusPercent ?? null,
      bonusFixedAmount: input.bonusFixedAmount ?? null,
      bonusMaxAmount: input.bonusMaxAmount ?? null,
      minDepositAmount: input.minDepositAmount ?? null,
      rolloverMultiplier: input.rolloverMultiplier ?? 5,
      minOdd: input.minOdd ?? 1.5,
      validityDays: input.validityDays ?? 7,
      eligibleSports: input.eligibleSports ?? [],
    },
  });
}

// ============ SEED (arranque do servidor) ============

/**
 * Garante que a promoção de lançamento recomendada (secções 2/19/22 da spec "MODELO DE
 * PROMOÇÕES BET62" colada pelo utilizador) existe assim que o servidor arranca — em vez de
 * depender de alguém preencher o formulário em Admin → Promoções, que nunca chegou a acontecer
 * na prática. Idempotente (mesmo padrão de seedDefaultAliases em sports/mapping/aliasStore.ts,
 * chamado a par disto em server.ts): só cria se ainda não existir NENHUMA promoção WELCOME_BONUS
 * (de qualquer estado, ativa ou não) — nunca duplica, nunca reescreve uma que o admin já tenha
 * editado à mão. Valores exatos da secção 22 ("Configuração Inicial Recomendada").
 */
export async function seedRecommendedLaunchPromotion(): Promise<void> {
  const already = await prisma.promotion.findFirst({ where: { type: "WELCOME_BONUS" } });
  if (already) return;

  await adminCreatePromotion({
    type: "WELCOME_BONUS",
    name: "Bónus de Boas-Vindas",
    active: true,
    bonusPercent: 50,
    bonusMaxAmount: 20,
    minDepositAmount: 10,
    rolloverMultiplier: 5,
    minOdd: 1.5,
    validityDays: 7,
    eligibleSports: [],
  });
  logger.info("[PROMOTIONS] promoção de lançamento (Bónus de Boas-Vindas) semeada automaticamente");
}

export async function adminUpdatePromotion(id: string, input: Partial<PromotionInput>) {
  return prisma.promotion.update({
    where: { id },
    data: {
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.bonusPercent !== undefined ? { bonusPercent: input.bonusPercent } : {}),
      ...(input.bonusFixedAmount !== undefined ? { bonusFixedAmount: input.bonusFixedAmount } : {}),
      ...(input.bonusMaxAmount !== undefined ? { bonusMaxAmount: input.bonusMaxAmount } : {}),
      ...(input.minDepositAmount !== undefined ? { minDepositAmount: input.minDepositAmount } : {}),
      ...(input.rolloverMultiplier !== undefined ? { rolloverMultiplier: input.rolloverMultiplier } : {}),
      ...(input.minOdd !== undefined ? { minOdd: input.minOdd } : {}),
      ...(input.validityDays !== undefined ? { validityDays: input.validityDays } : {}),
      ...(input.eligibleSports !== undefined ? { eligibleSports: input.eligibleSports } : {}),
    },
  });
}
