import type { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/errors";
import { applyLedgerMovement } from "../wallet/service";
import { getRedisClient, isRedisReady } from "../../lib/redis";

// ---------- F2-4 IP whitelist ----------
function parseIpWhitelist(): string[] {
  if (!env.CASINO_CALLBACK_IP_WHITELIST) return [];
  return env.CASINO_CALLBACK_IP_WHITELIST
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}
function ipMatchesWhitelist(reqIp: string): boolean {
  const list = parseIpWhitelist();
  if (list.length === 0) return true;
  const a = normalizeIp(reqIp);
  const b = reqIp;
  return list.some((entry) => {
    const e = normalizeIp(entry);
    return e === a || e === b;
  });
}

// ---------- F2-4 Nonce replay prevention (Redis SET NX EX 24h + fallback mem) ----------
const memNonceStore = new Map<string, number>();
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

function cleanupMemNonce() {
  const now = Date.now();
  for (const [k, exp] of memNonceStore.entries()) {
    if (exp < now) memNonceStore.delete(k);
  }
}
async function consumeNonce(command: string, body: CallbackEnvelope): Promise<boolean> {
  const data = body.data ?? ({} as Record<string, unknown>);
  const parts: string[] = [];
  if (typeof data.nonce === "string" && data.nonce) parts.push(data.nonce);
  if (typeof body.check === "string" && body.check) parts.push(body.check);
  if (typeof body.timestamp === "string" && body.timestamp) parts.push(body.timestamp);
  if (typeof data.trans_guid === "string" && data.trans_guid) parts.push(`tx:${data.trans_guid}`);
  if (typeof data.cancel_trans_guid === "string" && data.cancel_trans_guid)
    parts.push(`ctx:${data.cancel_trans_guid}`);
  parts.push(`cmd:${command}`);
  const nonceKey = "bet62:casino:callback_nonce:" + parts.join("|");
  if (parts.length <= 1) {
    logger.warn({ command }, "Cassino: callback sem nonce identificável; a aceitar (sem replay prevention)");
    return true;
  }
  const r = getRedisClient();
  if (r && isRedisReady()) {
    try {
      const res = await r.set(nonceKey, "1", "EX", 86400, "NX");
      if (res === "OK") return true;
      logger.warn({ command, nonceKey }, "Cassino: nonce duplicado detetado via Redis");
      return false;
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200) }, "Cassino: Redis nonce falhou, a usar fallback mem");
    }
  }
  cleanupMemNonce();
  const now = Date.now();
  const existing = memNonceStore.get(nonceKey);
  if (existing && existing > now) {
    logger.warn({ command, nonceKey }, "Cassino: nonce duplicado detetado via fallback mem");
    return false;
  }
  memNonceStore.set(nonceKey, now + NONCE_TTL_MS);
  return true;
}
async function idempotentBalanceResponse(accountId: unknown, res: Response) {
  const account = typeof accountId === "string" ? accountId : undefined;
  if (!account) return callbackError(res, "INVALID_ACCOUNT");
  const casinoAccount = await findCasinoAccount(account);
  if (!casinoAccount?.user.wallet) return callbackError(res, "ACCOUNT_NOT_FOUND");
  res.json({ result: 0, status: "OK", data: { balance: toProviderBalance(casinoAccount.user.wallet.balance) } });
}

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
    logger.warn({ path: req.path, ip: req.ip }, "Cassino: callback rejeitado — Callback-Token inválido ou não configurado");
    return callbackError(res, "UNAUTHORIZED");
  }

  // F2-4: IP whitelist. Se CASINO_CALLBACK_IP_WHITELIST vazio, ignora (só confia no token).
  if (!ipMatchesWhitelist(req.ip ?? "")) {
    logger.warn({ ip: req.ip, whitelist: env.CASINO_CALLBACK_IP_WHITELIST }, "Cassino: callback rejeitado — IP não whitelistado");
    return callbackError(res, "IP_BLOCKED");
  }

  const body = req.body as CallbackEnvelope;
  const command = body?.command;
  const data = body?.data ?? {};

  try {
    // F2-4: Nonce replay prevention para comandos mutantes (bet/win/cancel).
    // Se nonce duplicado → responde idempotentemente com saldo atual, sem transação.
    if (command === "bet" || command === "win" || command === "cancel") {
      const nonceFresh = await consumeNonce(command, body);
      if (!nonceFresh) {
        return await idempotentBalanceResponse(data.account, res);
      }
    }

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
