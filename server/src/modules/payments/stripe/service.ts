import { DepositProvider } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { Errors } from "../../../lib/errors";
import { getStripeClient } from "./client";
import { getWalletByUserId } from "../../wallet/service";
import { applyLedgerMovement } from "../../wallet/service";
import { isSelfExcluded } from "../../users/service";
import { logger } from "../../../lib/logger";

/**
 * Deposit methods offered to PT users, mapped to Stripe payment_method_types.
 *
 * NEEDS VALIDATION against https://docs.stripe.com (blocked from this environment):
 *  - "card": standard, requires SCA/3DS handling on the frontend via Stripe.js confirmCardPayment.
 *  - "multibanco": voucher-based method, EUR only, delayed settlement (customer pays at an ATM/
 *    home banking using entity+reference within ~7 days); PaymentIntent must be confirmed
 *    server-side with `confirm: true` and a `return_url`, then read
 *    `next_action.multibanco_display_details` for the entity/reference to show the user.
 *  - "mb_way": push-payment to the customer's phone via the MB WAY app; requires the customer's
 *    phone number. Confirm availability/exact param shape for your Stripe account & country
 *    before enabling in production (payment method support varies by Stripe account config).
 */
const PROVIDER_TO_STRIPE_TYPE: Record<DepositProvider, string> = {
  STRIPE_CARD: "card",
  STRIPE_MBWAY: "mb_way",
  STRIPE_MULTIBANCO: "multibanco",
};

const MIN_DEPOSIT_EUR = 5;
const MAX_DEPOSIT_EUR = 5000;

export async function createDepositIntent(params: {
  userId: string;
  provider: DepositProvider;
  amountEur: number;
  phone?: string; // required for MB WAY
}) {
  if (await isSelfExcluded(params.userId)) throw Errors.selfExcluded();

  if (params.amountEur < MIN_DEPOSIT_EUR || params.amountEur > MAX_DEPOSIT_EUR) {
    throw Errors.badRequest(`O depósito deve estar entre ${MIN_DEPOSIT_EUR}€ e ${MAX_DEPOSIT_EUR}€`);
  }

  const limits = await prisma.responsibleGamblingLimits.findUniqueOrThrow({ where: { userId: params.userId } });
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const depositedToday = await prisma.deposit.aggregate({
    where: { userId: params.userId, status: "SUCCEEDED", createdAt: { gte: since } },
    _sum: { amount: true },
  });
  const todayTotal = Number(depositedToday._sum.amount ?? 0);
  if (todayTotal + params.amountEur > Number(limits.dailyDepositLimit)) {
    throw Errors.badRequest("Este depósito excede o seu limite diário de depósito. Ajuste o limite em Jogo Responsável.");
  }

  if (params.provider === "STRIPE_MBWAY" && !params.phone) {
    throw Errors.badRequest("Número de telemóvel obrigatório para MB WAY");
  }

  const wallet = await getWalletByUserId(params.userId);
  const stripe = getStripeClient();
  const amountCents = Math.round(params.amountEur * 100);

  const deposit = await prisma.deposit.create({
    data: {
      userId: params.userId,
      walletId: wallet.id,
      provider: params.provider,
      amount: params.amountEur,
      currency: "EUR",
      status: "PENDING",
    },
  });

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountCents,
    currency: "eur",
    payment_method_types: [PROVIDER_TO_STRIPE_TYPE[params.provider]],
    metadata: { depositId: deposit.id, userId: params.userId },
    ...(params.provider === "STRIPE_MBWAY" && params.phone
      ? { payment_method_data: { type: "mb_way", mb_way: {} } as any, payment_method_options: { mb_way: { phone: params.phone } } as any }
      : {}),
  });

  await prisma.deposit.update({
    where: { id: deposit.id },
    data: { stripePaymentIntentId: paymentIntent.id, status: "PROCESSING" },
  });

  return {
    depositId: deposit.id,
    clientSecret: paymentIntent.client_secret,
    status: paymentIntent.status,
  };
}

export async function handleStripeWebhookEvent(rawBody: Buffer, signature: string) {
  const stripe = getStripeClient();
  const { env } = await import("../../../config/env");
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw Errors.internal("STRIPE_WEBHOOK_SECRET não configurado");
  }

  const event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as { id: string };
      await creditDeposit(pi.id);
      break;
    }
    case "payment_intent.payment_failed":
    case "payment_intent.canceled": {
      const pi = event.data.object as { id: string };
      await prisma.deposit.updateMany({
        where: { stripePaymentIntentId: pi.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED" },
      });
      break;
    }
    default:
      logger.debug({ type: event.type }, "Stripe webhook event ignorado");
  }

  return { received: true };
}

async function creditDeposit(paymentIntentId: string) {
  const deposit = await prisma.deposit.findUnique({ where: { stripePaymentIntentId: paymentIntentId } });
  if (!deposit) {
    logger.warn({ paymentIntentId }, "Webhook Stripe: depósito não encontrado para este PaymentIntent");
    return;
  }
  if (deposit.status === "SUCCEEDED") return; // idempotência: evento já processado

  await prisma.$transaction(async (tx) => {
    await tx.deposit.update({ where: { id: deposit.id }, data: { status: "SUCCEEDED" } });
    await applyLedgerMovement({
      walletId: deposit.walletId,
      type: "DEPOSIT",
      amount: deposit.amount,
      referenceType: "deposit",
      referenceId: deposit.id,
      metadata: { provider: deposit.provider, stripePaymentIntentId: paymentIntentId },
      tx,
    });
  });
}
