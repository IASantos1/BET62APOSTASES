import { DepositProvider, DepositStatus } from "@prisma/client";
import type Stripe from "stripe";
import { prisma } from "../../../lib/prisma";
import { Errors } from "../../../lib/errors";
import { getStripeClient } from "./client";
import { getWalletByUserId } from "../../wallet/service";
import { applyLedgerMovement } from "../../wallet/service";
import { isSelfExcluded } from "../../users/service";
import { grantWelcomeBonusIfEligible } from "../../promotions/service";
import { logger } from "../../../lib/logger";

/**
 * Depósitos confirmados dentro do próprio layout da BET62 — nunca uma segunda página (pedido
 * explícito do utilizador: "não quero que abra outra página"). PaymentIntents diretas, não
 * Checkout Sessions (a versão anterior, ver git history) — cada método é tratado de forma
 * diferente consoante o que realmente precisa de acontecer no browser:
 *
 * - CARTÃO: os dados do cartão têm de nascer e morrer num campo da Stripe (iframe do Stripe.js
 *   Card Element, exigência de PCI-DSS — nunca no nosso servidor/JS), mas esse campo fica
 *   MONTADO dentro do nosso próprio modal, não numa página à parte. Um eventual desafio 3DS
 *   aparece como sobreposição na mesma página (`stripe.confirmCardPayment`), sem navegar para
 *   lado nenhum. `confirm:false` aqui — a confirmação final acontece no browser com o
 *   `clientSecret` devolvido.
 * - MB WAY: não precisa de nada no browser — o "desafio" é a app MB WAY no telemóvel do
 *   cliente, não o browser. Por isso confirma-se aqui mesmo no servidor
 *   (`confirm:true` + `billing_details.phone`), sem Stripe.js nenhum: o telemóvel só pede o
 *   número, nunca abre nada.
 * - MULTIBANCO: mesma lógica — é um voucher estático (entidade+referência), não precisa de
 *   nenhuma interação no browser para "confirmar". Confirma-se no servidor
 *   (`confirm:true` + `billing_details.email`) e a entidade/referência (`next_action
 *   .multibanco_display_details`) volta na própria resposta, para o frontend mostrar no seu
 *   próprio layout — nunca o modal automático que `stripe.confirmMultibancoPayment` (função de
 *   Stripe.js) abriria se fosse usada no cliente, propositadamente evitada aqui.
 *
 * O crédito da carteira nunca acontece nestas funções — mesmo quando o estado devolvido já é
 * "succeeded" — só o webhook (`handleStripeWebhookEvent`) credita, para manter uma única fonte
 * de verdade idempotente (ver `creditDepositFromIntent`), a mesma regra que já existia com
 * Checkout Sessions.
 */
const MIN_DEPOSIT_EUR = 10;
const MAX_DEPOSIT_EUR = 5000;

async function validateAndCreateDepositRow(params: { userId: string; provider: DepositProvider; amountEur: number }) {
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
  return prisma.deposit.create({
    data: { userId: params.userId, walletId: wallet.id, provider: params.provider, amount: params.amountEur, currency: "EUR", status: "PENDING" },
  });
}

// PaymentIntent.status -> DepositStatus. "succeeded" cai em PROCESSING de propósito (não
// SUCCEEDED) — o crédito da carteira só acontece no webhook (creditDepositFromIntent), nunca
// aqui, para não haver dois sítios a decidir "já paguei" (risco de crédito duplicado se algum
// dia os dois caminhos discordarem). "requires_payment_method" logo na confirmação síncrona
// (mb_way/multibanco) normalmente significa que a Stripe rejeitou de imediato (ex: número de
// telefone não é MB WAY, conta não ativada).
function mapIntentStatusToDepositStatus(status: Stripe.PaymentIntent.Status): DepositStatus {
  if (status === "canceled") return "CANCELLED";
  if (status === "requires_payment_method") return "FAILED";
  return "PROCESSING";
}

// Aceita "912345678" (assume Portugal, prefixo do mercado desta plataforma), "351912345678" ou
// já em E.164 ("+351912345678", formato exigido pela Stripe para MB WAY — confirmado via
// documentação pública, exemplo real "+351911111111"). Sem tentar validar operadoras/prefixos
// específicos — só a forma (código de país + dígitos), a Stripe é quem valida se é mesmo MB WAY.
function normalizePhoneToE164(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
  if (digits.startsWith("351") && digits.length === 12) return `+${digits}`;
  if (/^\d{9}$/.test(digits)) return `+351${digits}`;
  return null;
}

export async function createCardDepositIntent(params: { userId: string; amountEur: number }) {
  const deposit = await validateAndCreateDepositRow({ userId: params.userId, amountEur: params.amountEur, provider: "STRIPE_CARD" });
  const stripe = getStripeClient();
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(params.amountEur * 100),
    currency: "eur",
    payment_method_types: ["card"],
    metadata: { depositId: deposit.id, userId: params.userId },
  });
  await prisma.deposit.update({ where: { id: deposit.id }, data: { stripePaymentIntentId: intent.id, status: "PROCESSING" } });
  return { depositId: deposit.id, clientSecret: intent.client_secret };
}

export async function createMbWayDeposit(params: { userId: string; amountEur: number; phone: string }) {
  const phone = normalizePhoneToE164(params.phone);
  if (!phone) throw Errors.badRequest("Número de telemóvel inválido. Use o formato 9XXXXXXXX ou +351XXXXXXXXX.");

  const deposit = await validateAndCreateDepositRow({ userId: params.userId, amountEur: params.amountEur, provider: "STRIPE_MBWAY" });
  const stripe = getStripeClient();
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: Math.round(params.amountEur * 100),
      currency: "eur",
      payment_method_types: ["mb_way"],
      payment_method_data: { type: "mb_way", billing_details: { phone } },
      confirm: true,
      metadata: { depositId: deposit.id, userId: params.userId },
    });
  } catch (err) {
    await prisma.deposit.update({ where: { id: deposit.id }, data: { status: "FAILED" } });
    throw err;
  }
  await prisma.deposit.update({ where: { id: deposit.id }, data: { stripePaymentIntentId: intent.id, status: mapIntentStatusToDepositStatus(intent.status) } });
  // status "processing" é o caminho normal: o pedido já foi enviado à app MB WAY do cliente,
  // falta ele aprovar no telemóvel — o frontend passa a sondar GET /deposits/:id.
  return { depositId: deposit.id, status: intent.status };
}

export async function createMultibancoDeposit(params: { userId: string; amountEur: number }) {
  const deposit = await validateAndCreateDepositRow({ userId: params.userId, amountEur: params.amountEur, provider: "STRIPE_MULTIBANCO" });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: params.userId } });
  const stripe = getStripeClient();
  let intent: Stripe.PaymentIntent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: Math.round(params.amountEur * 100),
      currency: "eur",
      payment_method_types: ["multibanco"],
      payment_method_data: { type: "multibanco", billing_details: { email: user.email } },
      confirm: true,
      metadata: { depositId: deposit.id, userId: params.userId },
    });
  } catch (err) {
    await prisma.deposit.update({ where: { id: deposit.id }, data: { status: "FAILED" } });
    throw err;
  }
  const details = intent.next_action?.multibanco_display_details;
  await prisma.deposit.update({
    where: { id: deposit.id },
    data: {
      stripePaymentIntentId: intent.id,
      status: mapIntentStatusToDepositStatus(intent.status),
      multibancoEntity: details?.entity ?? null,
      multibancoReference: details?.reference ?? null,
    },
  });
  if (!details?.entity || !details?.reference) {
    logger.error({ depositId: deposit.id, intentId: intent.id, status: intent.status }, "Multibanco: PaymentIntent confirmada sem next_action.multibanco_display_details");
    throw Errors.internal("Não foi possível gerar a entidade/referência Multibanco. Tente novamente.");
  }
  return {
    depositId: deposit.id,
    entity: details.entity,
    reference: details.reference,
    expiresAt: details.expires_at ? new Date(details.expires_at * 1000).toISOString() : null,
  };
}

/** Estado atual de um depósito (sondado pelo frontend enquanto espera aprovação MB WAY, ou só
 * para reler entidade/referência Multibanco depois de fechar e reabrir o modal). */
export async function getDepositStatus(userId: string, depositId: string) {
  const deposit = await prisma.deposit.findUnique({ where: { id: depositId } });
  if (!deposit || deposit.userId !== userId) throw Errors.notFound("Depósito não encontrado");
  return {
    depositId: deposit.id,
    status: deposit.status,
    entity: deposit.multibancoEntity,
    reference: deposit.multibancoReference,
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
      const intent = event.data.object as Stripe.PaymentIntent;
      await creditDepositFromIntent(intent);
      break;
    }
    case "payment_intent.payment_failed": {
      const intent = event.data.object as Stripe.PaymentIntent;
      await prisma.deposit.updateMany({
        where: { stripePaymentIntentId: intent.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "FAILED" },
      });
      break;
    }
    case "payment_intent.canceled": {
      const intent = event.data.object as Stripe.PaymentIntent;
      await prisma.deposit.updateMany({
        where: { stripePaymentIntentId: intent.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "CANCELLED" },
      });
      break;
    }
    default:
      logger.debug({ type: event.type }, "Stripe webhook event ignorado");
  }

  return { received: true };
}

async function creditDepositFromIntent(intent: Stripe.PaymentIntent) {
  const deposit = await prisma.deposit.findUnique({ where: { stripePaymentIntentId: intent.id } });
  if (!deposit) {
    logger.warn({ intentId: intent.id }, "Webhook Stripe: depósito não encontrado para esta PaymentIntent");
    return;
  }
  // Idempotência (a Stripe pode reenviar o mesmo evento — retry por timeout da nossa parte, ou
  // reenvio manual pelo dashboard) — nunca creditar duas vezes o mesmo depósito.
  if (deposit.status === "SUCCEEDED") return;

  // Confere valor e moeda do evento contra o que a BET62 pediu, antes de creditar — defesa
  // extra além da verificação de assinatura do webhook (que garante que o evento é mesmo da
  // Stripe, mas não que corresponde ao depósito certo).
  const expectedCents = Math.round(Number(deposit.amount) * 100);
  if (intent.amount !== expectedCents) {
    logger.error(
      { intentId: intent.id, depositId: deposit.id, expectedCents, gotCents: intent.amount },
      "Webhook Stripe: valor da PaymentIntent não corresponde ao depósito — a NÃO creditar"
    );
    return;
  }
  if (intent.currency && intent.currency.toUpperCase() !== deposit.currency) {
    logger.error(
      { intentId: intent.id, depositId: deposit.id, expected: deposit.currency, got: intent.currency },
      "Webhook Stripe: moeda da PaymentIntent não corresponde ao depósito — a NÃO creditar"
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
      metadata: { provider: deposit.provider, stripePaymentIntentId: intent.id },
      tx,
    });
    await grantWelcomeBonusIfEligible(deposit.userId, deposit.walletId, deposit.amount, tx);
  });
}
