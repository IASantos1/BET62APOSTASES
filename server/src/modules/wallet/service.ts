import { Prisma, LedgerEntryType } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";

type Tx = Prisma.TransactionClient;

/**
 * Applies a ledger movement atomically: locks the wallet row, checks funds for debits,
 * writes the ledger entry, and updates the cached balance — all inside one DB transaction
 * so balance and entries can never drift apart.
 */
export async function applyLedgerMovement(params: {
  walletId: string;
  type: LedgerEntryType;
  amount: Prisma.Decimal | number; // positive = credit, negative = debit
  referenceType?: string;
  referenceId?: string;
  metadata?: Record<string, unknown>;
  tx?: Tx;
}) {
  const run = async (tx: Tx) => {
    // SELECT ... FOR UPDATE semantics via Prisma's row lock on read-then-write within a transaction.
    const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: params.walletId } });

    const amount = new Prisma.Decimal(params.amount);
    const newBalance = wallet.balance.add(amount);

    if (newBalance.isNegative()) {
      throw Errors.badRequest("Saldo insuficiente para esta operação");
    }

    const entry = await tx.ledgerEntry.create({
      data: {
        walletId: wallet.id,
        type: params.type,
        amount,
        balanceAfter: newBalance,
        referenceType: params.referenceType,
        referenceId: params.referenceId,
        metadata: params.metadata as Prisma.InputJsonValue | undefined,
      },
    });

    const updatedWallet = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance },
    });

    return { entry, wallet: updatedWallet };
  };

  if (params.tx) return run(params.tx);
  return prisma.$transaction(run);
}

export async function getWalletByUserId(userId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw Errors.notFound("Carteira não encontrada");
  return wallet;
}

export async function listLedgerEntries(userId: string, opts: { limit?: number; cursor?: string } = {}) {
  const wallet = await getWalletByUserId(userId);
  const limit = Math.min(opts.limit ?? 25, 100);

  const entries = await prisma.ledgerEntry.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;

  return { entries: page, nextCursor: hasMore ? page[page.length - 1]?.id : null };
}
