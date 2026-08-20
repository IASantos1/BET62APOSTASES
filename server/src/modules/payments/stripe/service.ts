import { DepositProvider } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "../../../lib/prisma";
import { Errors } from "../../../lib/errors";
import { getStripeClient } from "./client";
import { getWalletByUserId } from "../../wallet/service";
import { applyLedgerMovement } from "../../wallet/service";
import { isSelfExcluded } from "../../users/service";
import { logger } from "../../../lib/logger";

/**
 * Deposit methods offered to PT users, mapped to Stripe Checkout `payment_method_types`.
 *
 * Checkout Sessions (not raw PaymentIntents) on purpose — the previous PaymentIntent-based
 * flow left a placeholder alert on the frontend ("requires Stripe.js/Elements... not yet
 * configured", see git history) because finishing it means building custom card Elements +
 * 3DS handling, and manually reading `next_action.multibanco_display_details` to show the
 * voucher. Checkout Sessions is Stripe's own hosted page: it already handles all of that
 * (3DS challenge, the MB WAY phone-number prompt, the Multibanco entity/reference display)
 * without the frontend touching Stripe.js at all — the app only needs to redirect to
 * `checkoutUrl` and read the webhook. Confirmed viable: all three of card/mb_way/multibanco
 * are supported `payment_method_types` on a single Checkout Session in Stripe's public docs
 * knowledge; exact hosted-page behavior per method still needs a real test payment before
 * going live (NEEDS VALIDATION — docs.stripe.com is blocked from this build environment).
 */
const PROVIDER_TO_STRIPE_TYPE: Record<DepositProvider, string> = {
  STRIPE_CARD: "card",
  STRIPE_MBWAY: "mb_way",
  STRIPE_MULTIBANCO: "multibanco",
};

const MIN_DEPOSIT_EUR = 5;
const MAX_DEPOSIT_EUR = 5000;

export async function createDepositCheckout(params: {
  userId: string;
  provider: DepositProvider;
  amountEur: number;
  origin: string; // ex: "https://bet62.plus" — de req.protocol+req.get("host"), nunca fixo no código
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

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: [PROVIDER_TO_STRIPE_TYPE[params.provider] as Stripe.Checkout.SessionCreateParams.PaymentMethodType],
    locale: "pt",
    line_items: [
      {
        price_data: {
          currency: "eur",
          unit_amount: amountCents,
          product_data: { name: "Depósito Bet62" },
        },
        quantity: 1,
      },
    ],
    metadata: { depositId: deposit.id, userId: params.userId },
    // {CHECKOUT_SESSION_ID} é substituído pela própria Stripe no redirecionamento — não é um
    // placeholder nosso. A SPA lê ?deposit=success|cancel no arranque (ver web/app.js) em vez
    // de haver páginas /payment/success|cancel dedicadas — mantém o depósito dentro da mesma
    // app em vez de saltar para outra página só para mostrar uma mensagem.
    success_url: `${params.origin}/?deposit=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${params.origin}/?deposit=cancel`,
  });

  await prisma.deposit.update({
    where: { id: deposit.id },
    data: { stripeSessionId: session.id, status: "PROCESSING" },
  });

  return { depositId: deposit.id, checkoutUrl: session.url };
}

export async function handleStripeWebhookEvent(rawBody: Buffer, signature: string) {
  const stripe = getStripeClient();
  const { env } = await import("../../../config/env");
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw Errors.internal("STRIPE_WEBHOOK_SECRET não configurado");
  }

  const event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);

  switch (event.type) {
    // Dispara sempre que o checkout termina. Para "card"/"mb_way" isto já costuma vir com
    // payment_status:"paid" (crédito imediato); para "multibanco" (o cliente só paga depois,
    // num multibanco/ATM/homebanking, até ~7 dias) vem "unpaid" — nesse caso NÃO se credita
    // aqui, espera-se pelo evento async_payment_succeeded abaixo.
    case "checkout.session.completed": {
      const session = event.data.object as { id: string; payment_status: string; amount_total: number | null; currency: string | null };
      if (session.payment_status === "paid") {
        await creditDepositFromSession(session);
      } else {
        logger.info({ sessionId: session.id, paymentStatus: session.payment_status }, "Stripe webhook: checkout completo, pagamento ainda pendente (ex: Multibanco)");
      }
      break;
    }
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object as { id: string; payment_status: string; amount_total: number | null; currency: string | null };
      await creditDepositFromSession(session);
      break;
    }
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const session = event.data.object as { id: string };
      await prisma.deposit.updateMany({
        where: { stripeSessionId: session.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: event.type === "checkout.session.expired" ? "CANCELLED" : "FAILED" },
      });
      break;
    }
    default:
      logger.debug({ type: event.type }, "Stripe webhook event ignorado");
  }

  return { received: true };
}

async function creditDepositFromSession(session: { id: string; amount_total: number | null; currency: string | null }) {
  const deposit = await prisma.deposit.findUnique({ where: { stripeSessionId: session.id } });
  if (!deposit) {
    logger.warn({ sessionId: session.id }, "Webhook Stripe: depósito não encontrado para este Checkout Session");
    return;
  }
  // Idempotência (spec: "NÃO creditar novamente se já estiver succeeded") — a Stripe pode
  // reenviar o mesmo evento (retry em caso de timeout da nossa parte, ou um operador a
  // reenviar manualmente pelo dashboard).
  if (deposit.status === "SUCCEEDED") return;

  // Confere valor e moeda do evento contra o que a BET62 pediu, antes de creditar — defesa
  // extra além da verificação de assinatura do webhook (que já garante que o evento é mesmo
  // da Stripe, mas não que corresponde ao depósito certo).
  const expectedCents = Math.round(Number(deposit.amount) * 100);
  if (session.amount_total !== null && session.amount_total !== expectedCents) {
    logger.error(
      { sessionId: session.id, depositId: deposit.id, expectedCents, gotCents: session.amount_total },
      "Webhook Stripe: valor do Checkout Session não corresponde ao depósito — a NÃO creditar"
    );
    return;
  }
  if (session.currency && session.currency.toUpperCase() !== deposit.currency) {
    logger.error(
      { sessionId: session.id, depositId: deposit.id, expected: deposit.currency, got: session.currency },
      "Webhook Stripe: moeda do Checkout Session não corresponde ao depósito — a NÃO creditar"
    );
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.deposit.update({ where: { id: deposit.id }, data: { status: "SUCCEEDED" } });
    await applyLedgerMovement({
      walletId: deposit.walletId,
      type: "DEPOSIT",
      amount: deposit.amount,
      referenceType: "deposit",
      referenceId: deposit.id,
      metadata: { provider: deposit.provider, stripeSessionId: session.id },
      tx,
    });
  });
}
