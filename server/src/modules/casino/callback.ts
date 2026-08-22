import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { applyLedgerMovement } from "../wallet/service";

// Contrato de callback confirmado pelo utilizador (documentação real do goldslotpalase.com,
// colada em chat — não um curl+resposta como o resto da integração, ver docs/CASINO_SLOTS.md).
// O provedor chama POST https://bet62.plus/callback (montado na raiz em app.ts, fora de /api/,
// confirmado antes por agent/callback-test) em tempo real para autenticar, consultar saldo,
// debitar apostas, creditar ganhos, cancelar transações e consultar o estado de uma transação.
//
// Autenticado pelo header "Callback-Token" comparado com CASINO_CALLBACK_TOKEN — NÃO o campo
// "check" do corpo do pedido, cujo algoritmo o provedor não documentou aqui (parecem ser
// referências a que campos vêm preenchidos em cada comando, não uma assinatura — mas isto é só
// uma hipótese, nunca confirmada, por isso não se valida).
//
// A forma de resposta de ERRO nunca foi confirmada (só se viu `result: 0` de sucesso) — a forma
// usada abaixo (`result: 1`) é o melhor palpite, a corrigir assim que se vir um erro real do
// provedor (ex: outro operador com esta integração já em produção, ou suporte do provedor).

interface CallbackEnvelope {
  command?: string;
  data?: Record<string, unknown>;
  timestamp?: string;
  check?: string;
}

function callbackError(res: Response, status: string) {
  res.json({ result: 1, status });
}

function toProviderBalance(balance: Prisma.Decimal): number {
  // Assume a mesma unidade/escala do nosso Wallet.balance (EUR, sem multiplicador) — nunca
  // confirmado com um "authenticate" real, só com o exemplo genérico da documentação
  // (balance: 12000, que é provavelmente só um número de exemplo, não uma escala real).
  return Number(balance);
}

async function findCasinoAccount(account: string) {
  return prisma.casinoAccount.findUnique({
    where: { account },
    include: { user: { include: { wallet: true } } },
  });
}

interface BetOrWinData {
  gplay_id: string;
  account: string;
  trans_guid: string;
  round_id: string;
  provider_id: number;
  game_code: string;
  game_type: string;
  amount: number;
  type: number;
}

interface CancelData extends BetOrWinData {
  cancel_trans_guid: string;
}

async function handleAuthenticate(data: { account?: string }, res: Response) {
  const account = data.account;
  if (!account) return callbackError(res, "INVALID_ACCOUNT");
  const casinoAccount = await findCasinoAccount(account);
  if (!casinoAccount?.user.wallet) return callbackError(res, "ACCOUNT_NOT_FOUND");
  res.json({
    result: 0,
    status: "OK",
    data: { account, balance: toProviderBalance(casinoAccount.user.wallet.balance) },
  });
}

async function handleBalance(data: { account?: string }, res: Response) {
  const account = data.account;
  if (!account) return callbackError(res, "INVALID_ACCOUNT");
  const casinoAccount = await findCasinoAccount(account);
  if (!casinoAccount?.user.wallet) return callbackError(res, "ACCOUNT_NOT_FOUND");
  res.json({ result: 0, status: "OK", data: { balance: toProviderBalance(casinoAccount.user.wallet.balance) } });
}

/**
 * Processa "bet" (débito) e "win" (crédito) da mesma forma — ambos identificados por
 * `trans_guid`, ambos movem a carteira uma vez só (idempotência: se o `trans_guid` já foi
 * processado, devolve o saldo atual sem voltar a mexer na carteira, para aguentar reenvios do
 * provedor).
 */
async function handleMoneyMovement(
  data: BetOrWinData,
  command: "bet" | "win",
  ledgerType: "BET_PLACED" | "BET_WON",
  sign: 1 | -1,
  res: Response
) {
  const casinoAccount = await findCasinoAccount(data.account);
  if (!casinoAccount?.user.wallet) return callbackError(res, "ACCOUNT_NOT_FOUND");
  const walletId = casinoAccount.user.wallet.id;

  const existing = await prisma.casinoCallbackTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    return res.json({ result: 0, status: "OK", data: { balance: toProviderBalance(wallet.balance) } });
  }

  const wallet = await prisma.$transaction(async (tx) => {
    const { wallet } = await applyLedgerMovement({
      walletId,
      type: ledgerType,
      amount: new Prisma.Decimal(data.amount).mul(sign),
      referenceType: `casino_${command}`,
      referenceId: data.trans_guid,
      metadata: {
        roundId: data.round_id,
        providerId: data.provider_id,
        gameCode: data.game_code,
        gplayId: data.gplay_id,
      },
      tx,
    });
    await tx.casinoCallbackTransaction.create({
      data: {
        transGuid: data.trans_guid,
        command,
        gplayId: data.gplay_id,
        account: data.account,
        roundId: data.round_id,
        providerId: data.provider_id,
        gameCode: data.game_code,
        gameType: data.game_type,
        amount: data.amount,
        type: data.type,
      },
    });
    return wallet;
  });

  res.json({ result: 0, status: "OK", data: { balance: toProviderBalance(wallet.balance) } });
}

async function handleCancel(data: CancelData, res: Response) {
  const casinoAccount = await findCasinoAccount(data.account);
  if (!casinoAccount?.user.wallet) return callbackError(res, "ACCOUNT_NOT_FOUND");
  const walletId = casinoAccount.user.wallet.id;

  const existing = await prisma.casinoCallbackTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
    return res.json({ result: 0, status: "OK", data: { balance: toProviderBalance(wallet.balance) } });
  }

  const original = await prisma.casinoCallbackTransaction.findUnique({
    where: { transGuid: data.cancel_trans_guid },
  });
  if (!original) return callbackError(res, "ORIGINAL_TRANSACTION_NOT_FOUND");

  // Reverte o efeito da transação original: um "bet" (débito) devolve o dinheiro (crédito); um
  // "win" (crédito) tira o dinheiro de volta (débito).
  const sign = original.command === "bet" ? 1 : -1;

  const wallet = await prisma.$transaction(async (tx) => {
    const { wallet } = await applyLedgerMovement({
      walletId,
      type: "BET_REFUND",
      amount: original.amount.mul(sign),
      referenceType: "casino_cancel",
      referenceId: data.trans_guid,
      metadata: { cancelledTransGuid: data.cancel_trans_guid, roundId: data.round_id },
      tx,
    });
    await tx.casinoCallbackTransaction.create({
      data: {
        transGuid: data.trans_guid,
        command: "cancel",
        gplayId: data.gplay_id,
        account: data.account,
        roundId: data.round_id,
        providerId: data.provider_id,
        gameCode: data.game_code,
        gameType: data.game_type,
        amount: data.amount,
        type: data.type,
      },
    });
    return wallet;
  });

  res.json({ result: 0, status: "OK", data: { balance: toProviderBalance(wallet.balance) } });
}

async function handleStatus(data: { account?: string; trans_guid?: string }, res: Response) {
  if (!data.account || !data.trans_guid) return callbackError(res, "INVALID_REQUEST");
  const casinoAccount = await findCasinoAccount(data.account);
  if (!casinoAccount) return callbackError(res, "ACCOUNT_NOT_FOUND");
  const transaction = await prisma.casinoCallbackTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  // "trans_status" só se confirmou o valor "OK" no exemplo do provedor — "NOT_FOUND" é um
  // palpite para quando não temos registo desse trans_guid.
  res.json({
    result: 0,
    status: "OK",
    data: { account: data.account, trans_guid: data.trans_guid, trans_status: transaction ? "OK" : "NOT_FOUND" },
  });
}

export async function casinoCallbackHandler(req: Request, res: Response) {
  const token = req.header("Callback-Token");
  if (!env.CASINO_CALLBACK_TOKEN || token !== env.CASINO_CALLBACK_TOKEN) {
    logger.warn({ path: req.path }, "Cassino: callback rejeitado — Callback-Token inválido ou não configurado");
    return callbackError(res, "UNAUTHORIZED");
  }

  const body = req.body as CallbackEnvelope;
  const command = body?.command;
  const data = body?.data ?? {};

  try {
    switch (command) {
      case "authenticate":
        return await handleAuthenticate(data, res);
      case "balance":
        return await handleBalance(data, res);
      case "bet":
        return await handleMoneyMovement(data as unknown as BetOrWinData, "bet", "BET_PLACED", -1, res);
      case "win":
        return await handleMoneyMovement(data as unknown as BetOrWinData, "win", "BET_WON", 1, res);
      case "cancel":
        return await handleCancel(data as unknown as CancelData, res);
      case "status":
        return await handleStatus(data, res);
      default:
        logger.warn({ command }, "Cassino: callback com command desconhecido");
        return callbackError(res, "UNKNOWN_COMMAND");
    }
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn({ command, message: err.message }, "Cassino: callback falhou");
      return callbackError(res, err.code);
    }
    logger.error({ command, err }, "Cassino: erro inesperado a processar callback");
    return callbackError(res, "INTERNAL_ERROR");
  }
}
