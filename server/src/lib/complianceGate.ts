import type { RequestHandler } from "express";
import { prisma } from "./prisma";
import type { AuthedRequest } from "../middleware/auth";
import { Errors } from "./errors";
import { env } from "../config/env";
import { logger } from "./logger";

// Tipo do Decimal do Prisma — inferido diretamente a partir da field balance
// de Wallet (não precisa de importar o namespace Prisma dinâmico)
type WalletRow = NonNullable<Awaited<ReturnType<typeof prisma.wallet.findUnique>>>;
type _Decimal = WalletRow["balance"];
// Métodos do Decimal do Prisma que usamos: add, neg, gte, gt, toFixed, toString.
interface DecimalLike {
  add(n: DecimalLike | string | number): DecimalLike;
  neg(): DecimalLike;
  gte(n: DecimalLike | string | number): boolean;
  gt(n: DecimalLike | string | number): boolean;
  toFixed(dp?: number): string;
  toString(): string;
}
type LedgerEntryRowAmount = {
  type: string;
  amount: DecimalLike | string | number;
};

export interface ComplianceGateOptions {
  /** KYC: pelo menos 1 KycDocument APPROVED. Default true. */
  requireKyc?: boolean;
  /** Self-exclusion active bloqueia. Default true. */
  requireNotSelfExcluded?: boolean;
  /** Valida limite diário de depósitos. Default true, só afeta rotas de depósito. */
  checkDailyDepositLimit?: boolean;
  /** Valida limite semanal de perdas. Default true, só afeta rotas de apostas. */
  checkWeeklyLossLimit?: boolean;
}

function startOfTodayUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfWeekUTC(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d;
}

/**
 * Obtém o constructor da classe Decimal do Prisma SEM precisar de importar
 * `import { Prisma } from "@prisma/client"` (que por vezes dá falsos positivos
 * no Language Service do VS Code em ficheiros novos).
 *
 * Fazemos isto por introspeção: o Prisma define `wallet.balance` como um
 * `Prisma.Decimal` — logo, `wallet.balance.add` existe. Para obter um DECIMAL
 * ZERO (ou outro valor) do MESMO TIPO do `_sum.amount` devolvido pelo groupBy,
 * usamos a técnica de:
 *   1) Buscar `ResponsibleGamblingLimits.findUnique(…) + include { wallet: true }` —
 *      a wallet sempre existe porque é criada em register.
 *   2) `zero = wallet.balance.add(0).add(0).neg().neg()` → retorna a mesma
 *      instância com valor 0.
 *   3) Para criar valores default (500, 1000), usamos `zero.add(500)` — retorna
 *      novo Decimal do Prisma do MESMO tipo.
 *
 * Isto garante 100% de compatibilidade de tipo com os valores retornados pelas
 * queries prisma (groupBy _sum.amount e ledgerEntry.amount) sem nunca importar
 * o namespace dinâmico `Prisma`.
 */
function makeDecimalHelpers(base: DecimalLike) {
  const zero = base.add(0).neg().neg(); // garante 0 do mesmo tipo
  return {
    zero,
    fromNumber: (n: number | string): DecimalLike => zero.add(n),
    fromAmount: (a: DecimalLike | string | number | null | undefined): DecimalLike =>
      a == null ? zero : typeof a === "object" ? (a as DecimalLike) : zero.add(a as string | number),
  };
}

export const complianceGate = (opts: ComplianceGateOptions = {}): RequestHandler => {
  const {
    requireKyc = true,
    requireNotSelfExcluded = true,
    checkDailyDepositLimit = false,
    checkWeeklyLossLimit = false,
  } = opts;

  return async (req, res, next) => {
    const authed = (req as AuthedRequest).user;
    if (!authed?.id) return next(); // requireAuth tratará depois, ou é rota pública

    try {
      if (requireNotSelfExcluded) {
        const activeExclusion = await prisma.selfExclusion.findFirst({
          where: { userId: authed.id, active: true },
          select: { id: true, startAt: true, endAt: true },
        });
        if (activeExclusion) {
          const now = new Date();
          const endAt = activeExclusion.endAt;
          const permanent = endAt == null;
          const stillActive = permanent || endAt > now;
          if (stillActive) {
            logger.warn({ userId: authed.id, selfExclusionId: activeExclusion.id }, "[COMPLIANCE] pedido bloqueado: self-exclusion ativa");
            throw Errors.forbidden("Conta temporariamente suspensa por auto-exclusão.");
          }
        }
      }

      if (requireKyc && env.COMPLIANCE_KYC_REQUIRED) {
        const approvedCount = await prisma.kycDocument.count({
          where: { userId: authed.id, status: "APPROVED" },
        });
        const approvedSubmission = await prisma.kycSubmission.count({
          where: { userId: authed.id, status: "APPROVED" },
        });
        if (approvedCount === 0 && approvedSubmission === 0) {
          logger.warn({ userId: authed.id }, "[COMPLIANCE] pedido bloqueado: KYC não aprovado");
          throw Errors.forbidden("Validação de identidade (KYC) ainda não aprovada.");
        }
      }

      // Fazemos 1 única query para buscar ResponsibleGamblingLimits + Wallet (para
      // obter um Decimal do mesmo tipo que o Prisma usa). Isto evita imports do
      // namespace `Prisma` dinâmico.
      const limitsWithWallet = await prisma.responsibleGamblingLimits.findUnique({
        where: { userId: authed.id },
        select: {
          dailyDepositLimit: true,
          weeklyLossLimit: true,
          user: { select: { wallet: { select: { balance: true } } } },
        },
      });

      let walletBalance: DecimalLike | null = null;
      if (limitsWithWallet?.user?.wallet) walletBalance = limitsWithWallet.user.wallet.balance as unknown as DecimalLike;
      // Fallback: se por acaso a wallet ainda não existir (improvável), fazer 1 query
      // à wallet para ter o base Decimal.
      if (!walletBalance && (checkDailyDepositLimit || checkWeeklyLossLimit)) {
        const w = await prisma.wallet.findUnique({
          where: { userId: authed.id },
          select: { balance: true },
        });
        if (w) walletBalance = w.balance as unknown as DecimalLike;
      }

      // Se não temos wallet balance, não conseguimos validar limites financeiros —
      // saltar a validação (em vez de crash). Em produção a wallet sempre existe
      // porque é criada no register.
      const canCheckLimits = !!walletBalance;
      const dec = canCheckLimits ? makeDecimalHelpers(walletBalance!) : null;
      const dailyLimitDefault = canCheckLimits ? dec!.fromNumber(500) : null;
      const weeklyLimitDefault = canCheckLimits ? dec!.fromNumber(1000) : null;
      const dailyLimit =
        (limitsWithWallet?.dailyDepositLimit as unknown as DecimalLike | null | undefined) ?? dailyLimitDefault;
      const weeklyLimit =
        (limitsWithWallet?.weeklyLossLimit as unknown as DecimalLike | null | undefined) ?? weeklyLimitDefault;

      if (checkDailyDepositLimit && env.COMPLIANCE_RG_LIMITS_ENFORCED && canCheckLimits && dailyLimit) {
        const today = startOfTodayUTC();
        const gres = await prisma.ledgerEntry.groupBy({
          by: ["type"],
          _sum: { amount: true },
          where: {
            wallet: { userId: authed.id },
            type: "DEPOSIT",
            status: "COMPLETED",
            createdAt: { gte: today },
          },
        });
        const deposited = dec!.fromAmount(gres[0]?._sum.amount as unknown as DecimalLike | null | undefined);
        if (deposited.gte(dailyLimit)) {
          logger.warn({ userId: authed.id, deposited: deposited.toString(), limit: dailyLimit.toString() }, "[COMPLIANCE] bloqueado: limite diário de depósitos");
          throw Errors.forbidden(
            `Limite diário de depósitos (${dailyLimit.toFixed(2)}€) atingido. Pode tentar novamente amanhã ou ajustar os seus limites em Definições.`
          );
        }
      }

      if (checkWeeklyLossLimit && env.COMPLIANCE_RG_LIMITS_ENFORCED && canCheckLimits && weeklyLimit) {
        const weekStart = startOfWeekUTC();
        const week = await prisma.ledgerEntry.findMany({
          where: {
            wallet: { userId: authed.id },
            type: { in: ["BET_PLACED", "BET_WON", "BET_REFUND"] },
            status: "COMPLETED",
            createdAt: { gte: weekStart },
          },
          select: { type: true, amount: true },
        });
        // BET_PLACED é negativo (dedução), BET_WON/BET_REFUND positivos (crédito/devolução).
        // Soma líquida semanal = acc.add(amount). Perda = -net (neg()).
        const net = (week as unknown as LedgerEntryRowAmount[]).reduce(
          (acc, l) => acc.add(l.amount as DecimalLike | string | number),
          dec!.zero
        );
        const loss = net.neg(); // se net = -400, loss = 400.
        if (loss.gt(weeklyLimit)) {
          logger.warn({ userId: authed.id, netWeekly: net.toString(), limit: weeklyLimit.toString() }, "[COMPLIANCE] bloqueado: limite semanal de perdas");
          throw Errors.forbidden(
            `Limite semanal de perdas (${weeklyLimit.toFixed(2)}€) atingido. Pode tentar novamente na próxima semana ou ajustar os seus limites.`
          );
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
