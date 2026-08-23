import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { LedgerEntryType } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  walletFindUniqueOrThrow: vi.fn(),
  walletUpdate: vi.fn(),
  ledgerEntryCreate: vi.fn(),
  prismaTransaction: vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    return await fn({
      wallet: {
        findUniqueOrThrow: mocks.walletFindUniqueOrThrow,
        update: mocks.walletUpdate,
      },
      ledgerEntry: { create: mocks.ledgerEntryCreate },
    });
  }),
}));

vi.mock("@/lib/prisma", () => {
  const walletMock = {
    findUniqueOrThrow: mocks.walletFindUniqueOrThrow,
    update: mocks.walletUpdate,
  };
  const ledgerEntryMock = {
    create: mocks.ledgerEntryCreate,
  };
  return {
    prisma: {
      wallet: walletMock,
      ledgerEntry: ledgerEntryMock,
      $transaction: mocks.prismaTransaction,
    },
  };
});

import { applyLedgerMovement } from "@/modules/wallet/service";

function setupWallet(startingBalance: string | number, startingLocked = 0) {
  mocks.walletFindUniqueOrThrow.mockImplementation(() =>
    Promise.resolve({
      id: "w-1",
      userId: "u-1",
      currency: "EUR",
      balance: new Prisma.Decimal(startingBalance),
      lockedBalance: new Prisma.Decimal(startingLocked),
    })
  );
  mocks.walletUpdate.mockImplementation((args: any) => {
    const bal = args?.data?.balance;
    return Promise.resolve({
      id: "w-1",
      userId: "u-1",
      currency: "EUR",
      balance: bal ? new Prisma.Decimal(bal) : new Prisma.Decimal(0),
      lockedBalance: new Prisma.Decimal(0),
    });
  });
  mocks.ledgerEntryCreate.mockImplementation((args: any) => {
    const data = args.data;
    return Promise.resolve({
      id: "e-1",
      walletId: "w-1",
      ...data,
      createdAt: new Date(),
    });
  });
}

describe("applyLedgerMovement — invariantes de saldo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("DEPOSIT +100€: newBalance = old + 100; entry.balanceAfter = newBalance", async () => {
    setupWallet(50);
    const { entry, wallet } = await applyLedgerMovement({
      walletId: "w-1",
      type: "DEPOSIT" as LedgerEntryType,
      amount: "100.00",
      referenceType: "stripe_intent",
      referenceId: "pi_123",
    });
    expect(mocks.walletUpdate).toHaveBeenCalledTimes(1);
    const balanceArg = mocks.walletUpdate.mock.calls[0][0]?.data?.balance;
    expect(new Prisma.Decimal(balanceArg).toNumber()).toBeCloseTo(150);
    expect(mocks.ledgerEntryCreate).toHaveBeenCalledTimes(1);
    const entryBalanceAfter = mocks.ledgerEntryCreate.mock.calls[0][0]?.data?.balanceAfter;
    expect(new Prisma.Decimal(entryBalanceAfter).toNumber()).toBeCloseTo(150);
    expect(new Prisma.Decimal(entry.amount).toNumber()).toBeCloseTo(100);
    expect(entry.type).toBe("DEPOSIT");
    expect(wallet.balance.toNumber()).toBeCloseTo(150);
  });

  it("WITHDRAWAL -50€ com saldo 150: newBalance = 100, balanceAfter=100", async () => {
    setupWallet(150);
    await applyLedgerMovement({
      walletId: "w-1",
      type: "WITHDRAWAL" as LedgerEntryType,
      amount: "-50.00",
      referenceType: "revolut_payout",
      referenceId: "rvt_456",
    });
    const balanceArg = mocks.walletUpdate.mock.calls[0][0]?.data?.balance;
    expect(new Prisma.Decimal(balanceArg).toNumber()).toBeCloseTo(100);
    const entryBalanceAfter = mocks.ledgerEntryCreate.mock.calls[0][0]?.data?.balanceAfter;
    expect(new Prisma.Decimal(entryBalanceAfter).toNumber()).toBeCloseTo(100);
  });

  it("WITHDRAWAL que levaria saldo a negativo é rejeitado", async () => {
    setupWallet(10);
    let thrown: any = null;
    try {
      await applyLedgerMovement({
        walletId: "w-1",
        type: "WITHDRAWAL" as LedgerEntryType,
        amount: "-100.00",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(mocks.walletUpdate).not.toHaveBeenCalled();
    expect(mocks.ledgerEntryCreate).not.toHaveBeenCalled();
  });

  it("amount ZERO passa mas sem efeito (mantém saldo)", async () => {
    setupWallet(100);
    const r = await applyLedgerMovement({
      walletId: "w-1",
      type: "BET_WON" as LedgerEntryType,
      amount: new Prisma.Decimal("0.00"),
    });
    expect(r.wallet.balance.toNumber()).toBeCloseTo(100);
    expect(new Prisma.Decimal(r.entry.amount).toNumber()).toBeCloseTo(0);
  });

  it("movimento DEPOSIT deve usar transação atómica ($transaction 1 vez)", async () => {
    setupWallet(200);
    await applyLedgerMovement({ walletId: "w-1", type: "DEPOSIT" as LedgerEntryType, amount: "50" });
    expect(mocks.prismaTransaction).toHaveBeenCalledTimes(1);
  });
});
