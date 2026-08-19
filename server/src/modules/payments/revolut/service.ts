import { prisma } from "../../../lib/prisma";
import { Errors } from "../../../lib/errors";
import { isSelfExcluded } from "../../users/service";
import { applyLedgerMovement } from "../../wallet/service";
import { sendPayout } from "./client";
import { logger } from "../../../lib/logger";

const MIN_WITHDRAWAL_EUR = 10;

export async function requestWithdrawal(params: { userId: string; amountEur: number; bankAccountId: string }) {
  if (await isSelfExcluded(params.userId)) throw Errors.selfExcluded();

  if (params.amountEur < MIN_WITHDRAWAL_EUR) {
    throw Errors.badRequest(`O levantamento mínimo é de ${MIN_WITHDRAWAL_EUR}€`);
  }

  const latestKyc = await prisma.kycSubmission.findFirst({
    where: { userId: params.userId },
    orderBy: { createdAt: "desc" },
  });
  if (latestKyc?.status !== "APPROVED") {
    throw Errors.kycRequired("É necessário ter a verificação de identidade (KYC) aprovada para levantar fundos");
  }

  const bankAccount = await prisma.bankAccount.findUnique({ where: { id: params.bankAccountId } });
  if (!bankAccount || bankAccount.userId !== params.userId) {
    throw Errors.notFound("Conta bancária não encontrada");
  }

  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: params.userId } });
  const available = wallet.balance.sub(wallet.lockedBalance);
  if (available.lessThan(params.amountEur)) {
    throw Errors.badRequest("Saldo disponível insuficiente");
  }

  const withdrawal = await prisma.$transaction(async (tx) => {
    await tx.wallet.update({
      where: { id: wallet.id },
      data: { lockedBalance: wallet.lockedBalance.add(params.amountEur) },
    });

    return tx.withdrawal.create({
      data: {
        userId: params.userId,
        walletId: wallet.id,
        bankAccountId: bankAccount.id,
        amount: params.amountEur,
        currency: "EUR",
        method: "REVOLUT_PAYOUT",
        status: "REQUESTED",
      },
    });
  });

  await prisma.auditLog.create({
    data: { userId: params.userId, action: "WITHDRAWAL_REQUESTED", metadata: { withdrawalId: withdrawal.id, amount: params.amountEur } },
  });

  return withdrawal;
}

export async function listWithdrawals(userId: string) {
  return prisma.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 50 });
}

/**
 * Approves a REQUESTED withdrawal and dispatches the Revolut Business payout.
 * Restricted to SUPPORT/ADMIN roles (see routes.ts) — this is the manual AML review
 * gate a licensed operator's compliance process requires before funds leave the platform.
 */
export async function approveAndPayWithdrawal(withdrawalId: string, reviewerUserId: string) {
  const withdrawal = await prisma.withdrawal.findUniqueOrThrow({
    where: { id: withdrawalId },
    include: { bankAccount: true },
  });

  if (withdrawal.status !== "REQUESTED" && withdrawal.status !== "UNDER_REVIEW") {
    throw Errors.conflict("Este levantamento já foi processado");
  }
  if (!withdrawal.bankAccount) throw Errors.badRequest("Levantamento sem conta bancária associada");

  await prisma.withdrawal.update({
    where: { id: withdrawal.id },
    data: { status: "PROCESSING", reviewedByUserId: reviewerUserId, reviewedAt: new Date() },
  });

  try {
    const payout = await sendPayout({
      reference: withdrawal.id,
      amount: Number(withdrawal.amount),
      currency: withdrawal.currency,
      accountHolder: withdrawal.bankAccount.accountHolder,
      iban: withdrawal.bankAccount.iban,
      bic: withdrawal.bankAccount.bic,
    });

    if (payout.state === "failed") {
      return failWithdrawal(withdrawal.id, "Provedor de pagamento recusou a transferência");
    }

    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: withdrawal.id },
        data: { status: "PAID", revolutPaymentId: payout.providerPaymentId },
      });
      await tx.wallet.update({
        where: { id: withdrawal.walletId },
        data: {
          balance: { decrement: withdrawal.amount },
          lockedBalance: { decrement: withdrawal.amount },
        },
      });
      await applyLedgerMovement({
        walletId: withdrawal.walletId,
        type: "WITHDRAWAL",
        amount: Number(withdrawal.amount) * -1,
        referenceType: "withdrawal",
        referenceId: withdrawal.id,
        tx,
      });
    });

    return prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawal.id } });
  } catch (err) {
    logger.error({ err, withdrawalId }, "Erro ao processar payout Revolut");
    return failWithdrawal(withdrawal.id, "Erro ao contactar o provedor de pagamento");
  }
}

async function failWithdrawal(withdrawalId: string, reason: string) {
  const withdrawal = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  await prisma.$transaction([
    prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: "FAILED", rejectionReason: reason },
    }),
    prisma.wallet.update({
      where: { id: withdrawal.walletId },
      data: { lockedBalance: { decrement: withdrawal.amount } },
    }),
  ]);
  return prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
}

export async function rejectWithdrawal(withdrawalId: string, reviewerUserId: string, reason: string) {
  const withdrawal = await prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
  if (withdrawal.status !== "REQUESTED" && withdrawal.status !== "UNDER_REVIEW") {
    throw Errors.conflict("Este levantamento já foi processado");
  }

  await prisma.$transaction([
    prisma.withdrawal.update({
      where: { id: withdrawalId },
      data: { status: "REJECTED", rejectionReason: reason, reviewedByUserId: reviewerUserId, reviewedAt: new Date() },
    }),
    prisma.wallet.update({
      where: { id: withdrawal.walletId },
      data: { lockedBalance: { decrement: withdrawal.amount } },
    }),
  ]);

  return prisma.withdrawal.findUniqueOrThrow({ where: { id: withdrawalId } });
}
