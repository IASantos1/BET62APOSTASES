import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";

const mocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
  depositFindUnique: vi.fn(),
  depositUpdate: vi.fn(),
  walletFindUniqueOrThrow: vi.fn(),
  walletUpdate: vi.fn(),
  ledgerEntryCreate: vi.fn(),
  prismaTransaction: vi.fn(async <T>(fn: (tx: any) => Promise<T>): Promise<T> => {
    return await fn({
      deposit: {
        findUnique: mocks.depositFindUnique,
        update: mocks.depositUpdate,
      },
      wallet: {
        findUniqueOrThrow: mocks.walletFindUniqueOrThrow,
        update: mocks.walletUpdate,
      },
      ledgerEntry: {
        create: mocks.ledgerEntryCreate,
      },
    });
  }),
}));

vi.mock("@/modules/payments/stripe/client", () => {
  return {
    getStripeClient: () => {
      return {
        webhooks: {
          constructEvent: mocks.constructEvent,
        },
      };
    },
  };
});

vi.mock("@/lib/prisma", () => {
  const depositMock = {
    findUnique: mocks.depositFindUnique,
    update: mocks.depositUpdate,
  };
  const walletMock = {
    findUniqueOrThrow: mocks.walletFindUniqueOrThrow,
    update: mocks.walletUpdate,
  };
  const ledgerMock = {
    create: mocks.ledgerEntryCreate,
  };
  return {
    prisma: {
      deposit: depositMock,
      wallet: walletMock,
      ledgerEntry: ledgerMock,
      $transaction: mocks.prismaTransaction,
    },
  };
});

import { handleStripeWebhookEvent } from "@/modules/payments/stripe/service";

function buildIntent(params: {
  id: string;
  amountCents: number;
  currency: string;
  status: "succeeded" | "processing" | "requires_payment_method";
}) {
  return {
    id: params.id,
    amount: params.amountCents,
    currency: params.currency,
    status: params.status,
  };
}

function makeSucceededEvent(intent: any) {
  return {
    type: "payment_intent.succeeded",
    data: { object: intent },
  };
}

describe("creditDepositFromIntent — idempotência via status SUCCEEDED", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.walletFindUniqueOrThrow.mockImplementation(() =>
      Promise.resolve({
        id: "w-1",
        userId: "u-1",
        currency: "EUR",
        balance: new Prisma.Decimal("0"),
        lockedBalance: new Prisma.Decimal("0"),
      })
    );
    mocks.walletUpdate.mockImplementation((args: any) =>
      Promise.resolve({
        id: "w-1",
        userId: "u-1",
        currency: "EUR",
        balance: new Prisma.Decimal(args?.data?.balance ?? "0"),
        lockedBalance: new Prisma.Decimal(0),
      })
    );
    mocks.ledgerEntryCreate.mockImplementation((args: any) =>
      Promise.resolve({
        id: "e-1",
        walletId: "w-1",
        ...args.data,
        createdAt: new Date(),
      })
    );
    mocks.depositUpdate.mockImplementation((args: any) =>
      Promise.resolve({
        id: "dep-1",
        walletId: "w-1",
        status: args?.data?.status ?? "PROCESSING",
      })
    );
  });

  it("2x webhook idêntico com PI succeeded só credita uma vez (idempotência por status=SUCCEEDED)", async () => {
    const intent = buildIntent({
      id: "pi_same_1",
      amountCents: 10000,
      currency: "eur",
      status: "succeeded",
    });
    let depositStatus: string = "PROCESSING";
    mocks.depositFindUnique.mockImplementation(() => {
      return Promise.resolve({
        id: "dep-1",
        walletId: "w-1",
        status: depositStatus,
        amount: new Prisma.Decimal("100.00"),
        currency: "EUR",
        provider: "STRIPE_CARD",
      });
    });
    mocks.depositUpdate.mockImplementation((args: any) => {
      if (args?.data?.status === "SUCCEEDED") depositStatus = "SUCCEEDED";
      return Promise.resolve({ id: "dep-1", status: depositStatus });
    });

    mocks.constructEvent.mockReturnValue(makeSucceededEvent(intent));
    await handleStripeWebhookEvent(Buffer.from("{}"), "sig1");
    await handleStripeWebhookEvent(Buffer.from("{}"), "sig2");

    expect(mocks.depositFindUnique).toHaveBeenCalledTimes(2);
    const updateSucceededCalls = mocks.depositUpdate.mock.calls.filter(
      (c: any) => c[0]?.data?.status === "SUCCEEDED"
    );
    expect(updateSucceededCalls.length).toBe(1);
    expect(mocks.ledgerEntryCreate).toHaveBeenCalledTimes(1);
  });

  it("mismatch amount: PI.amount (9999 cêntimos) != deposit.amount (100.00 EUR) → NÃO credita", async () => {
    const intent = buildIntent({
      id: "pi_mismatch_amount",
      amountCents: 9999,
      currency: "eur",
      status: "succeeded",
    });
    mocks.depositFindUnique.mockResolvedValue({
      id: "dep-2",
      walletId: "w-1",
      status: "PROCESSING",
      amount: new Prisma.Decimal("100.00"),
      currency: "EUR",
      provider: "STRIPE_CARD",
    });
    mocks.constructEvent.mockReturnValue(makeSucceededEvent(intent));
    await handleStripeWebhookEvent(Buffer.from("{}"), "sig3");

    expect(mocks.depositFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.depositUpdate).not.toHaveBeenCalled();
    expect(mocks.ledgerEntryCreate).not.toHaveBeenCalled();
    expect(mocks.walletUpdate).not.toHaveBeenCalled();
  });

  it("mismatch moeda: PI.currency 'usd' vs deposit.currency 'EUR' → NÃO credita", async () => {
    const intent = buildIntent({
      id: "pi_mismatch_ccy",
      amountCents: 10000,
      currency: "usd",
      status: "succeeded",
    });
    mocks.depositFindUnique.mockResolvedValue({
      id: "dep-3",
      walletId: "w-1",
      status: "PROCESSING",
      amount: new Prisma.Decimal("100.00"),
      currency: "EUR",
      provider: "STRIPE_CARD",
    });
    mocks.constructEvent.mockReturnValue(makeSucceededEvent(intent));
    await handleStripeWebhookEvent(Buffer.from("{}"), "sig4");

    expect(mocks.depositFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.depositUpdate).not.toHaveBeenCalled();
    expect(mocks.ledgerEntryCreate).not.toHaveBeenCalled();
    expect(mocks.walletUpdate).not.toHaveBeenCalled();
  });
});
