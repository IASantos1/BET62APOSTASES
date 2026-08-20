import { prisma } from "../../lib/prisma";
import { Errors, AppError } from "../../lib/errors";
import { applyLedgerMovement } from "../wallet/service";
import { findGame } from "./catalog";
import { createOrGetProviderUser, getGameLaunchUrl } from "./apiClient";

export interface CasinoCallbackData {
  gplay_id: string;
  account: string;
  trans_guid: string;
  cancel_trans_guid?: string;
  round_id: string;
  provider_id: number;
  game_code: string;
  game_type: string;
  amount: number;
  type: number;
  call_id?: string;
}

// Tabela real de códigos de resultado, confirmada no Swagger da Agent API
// (agent.goldslotpalase.com/swagger/v4/swagger.json, secção "API Response Codes") — substitui
// os valores só assumidos anteriormente (1 não é "erro genérico", é UNDER_MAINTENANCE; 1001 não
// é "já processado", é INTERNAL_SERVER_ERROR). Não há um código dedicado a "transação já
// processada" na tabela — uma entrega repetida de callback devolve OK(0) com o saldo atual, tal
// como um pedido novo bem sucedido, que é o comportamento idempotente esperado.
export const CasinoResult = {
  OK: 0,
  UNDER_MAINTENANCE: 1,
  INTERNAL_SERVER_ERROR: 1001,
  VALIDATION_ERROR: 1002,
  TOKEN_INVALID: 1009,
  USER_NOT_FOUND: 2002,
  GAME_NOT_FOUND: 2003,
  BALANCE_NOT_ENOUGH: 2006,
} as const;

// A Agent API só aceita `name` alfanumérico (^[_a-zA-Z0-9]+$) ao criar um utilizador do lado do
// provedor — o nosso UUID interno tem hífens, por isso nunca é usado em bruto. Em vez disso,
// removemos os hífens e prefixamos com "u" (garante que começa por letra). É reversível: o
// `account` que vem nos callbacks do provedor é exatamente este valor, por isso
// userIdFromAccount() desfaz a transformação para encontrar a carteira certa.
export function accountForUser(userId: string): string {
  return `u${userId.replace(/-/g, "")}`;
}

function userIdFromAccount(account: string): string | null {
  if (!/^u[0-9a-f]{32}$/i.test(account)) return null;
  const hex = account.slice(1);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getWalletByAccount(account: string) {
  const userId = userIdFromAccount(account);
  if (!userId) return Promise.resolve(null);
  return prisma.wallet.findUnique({ where: { userId } });
}

/**
 * Callback "authenticate": o provedor confirma que a conta existe antes de aceitar uma aposta
 * (ex: ao abrir o jogo). Também é o pedido usado para testar o URL de callback configurado no
 * painel de agente — se isto não responder, o pedido de `game-url` falha com "CALLBACK_ERROR".
 */
export async function handleAuthenticateCallback(account: string) {
  const wallet = await getWalletByAccount(account);
  if (!wallet) return { result: CasinoResult.USER_NOT_FOUND, status: "USER_NOT_FOUND", data: {} };
  return { result: CasinoResult.OK, status: "OK", data: { account, balance: wallet.balance } };
}

/** Callback "balance": confirmação do saldo atual, sem alterar nada. */
export async function handleBalanceCallback(account: string) {
  const wallet = await getWalletByAccount(account);
  if (!wallet) return { result: CasinoResult.USER_NOT_FOUND, status: "USER_NOT_FOUND", data: {} };
  return { result: CasinoResult.OK, status: "OK", data: { balance: wallet.balance } };
}

/**
 * Callback "bet": debita o valor apostado na carteira do jogador. Idempotente por `trans_guid`,
 * e devolve BALANCE_NOT_ENOUGH (em vez de deixar o erro genérico escapar) quando o saldo não
 * chega — o provedor pede a validação "31: saldo" antes de aceitar a aposta.
 */
export async function handleBetCallback(data: CasinoCallbackData) {
  const existing = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: existing.walletId } });
    return { result: CasinoResult.OK, status: "OK", data: { balance: wallet.balance } };
  }

  const wallet = await getWalletByAccount(data.account);
  if (!wallet) return { result: CasinoResult.USER_NOT_FOUND, status: "USER_NOT_FOUND", data: {} };

  let entry, updated;
  try {
    ({ entry, wallet: updated } = await applyLedgerMovement({
      walletId: wallet.id,
      type: "BET_PLACED",
      amount: -data.amount,
      referenceType: "casino_slot",
      referenceId: data.trans_guid,
      metadata: {
        gplayId: data.gplay_id,
        roundId: data.round_id,
        providerId: data.provider_id,
        gameCode: data.game_code,
        gameType: data.game_type,
      },
    }));
  } catch (err) {
    if (err instanceof AppError) return { result: CasinoResult.BALANCE_NOT_ENOUGH, status: "BALANCE_NOT_ENOUGH", data: {} };
    throw err;
  }

  await prisma.casinoTransaction.create({
    data: {
      walletId: wallet.id,
      transGuid: data.trans_guid,
      type: "BET",
      gplayId: data.gplay_id,
      account: data.account,
      roundId: data.round_id,
      providerId: data.provider_id,
      gameCode: data.game_code,
      gameType: data.game_type,
      amount: data.amount,
      ledgerEntryId: entry.id,
    },
  });

  return { result: CasinoResult.OK, status: "OK", data: { balance: updated.balance } };
}

/**
 * Callback "win": credita o prémio na carteira do jogador. Idempotente por `trans_guid` — uma
 * entrega repetida do mesmo trans_guid não é reaplicada, devolve o saldo atual tal como está.
 */
export async function handleWinCallback(data: CasinoCallbackData) {
  const existing = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: existing.walletId } });
    return { result: CasinoResult.OK, status: "OK", data: { balance: wallet.balance } };
  }

  const wallet = await getWalletByAccount(data.account);
  if (!wallet) return { result: CasinoResult.USER_NOT_FOUND, status: "USER_NOT_FOUND", data: {} };

  // "BonusCall(32) em vez de Win(2)" — a doc não dá um campo explícito para isto no callback,
  // por isso usa-se a presença de call_id (id da chamada de bónus) como sinal.
  const isBonusCall = !!data.call_id && data.call_id !== "0";

  const { entry, wallet: updated } = await applyLedgerMovement({
    walletId: wallet.id,
    type: "BET_WON",
    amount: data.amount,
    referenceType: "casino_slot",
    referenceId: data.trans_guid,
    metadata: {
      gplayId: data.gplay_id,
      roundId: data.round_id,
      providerId: data.provider_id,
      gameCode: data.game_code,
      gameType: data.game_type,
      callId: data.call_id,
    },
  });

  await prisma.casinoTransaction.create({
    data: {
      walletId: wallet.id,
      transGuid: data.trans_guid,
      type: isBonusCall ? "BONUS_CALL_WIN" : "WIN",
      gplayId: data.gplay_id,
      account: data.account,
      roundId: data.round_id,
      providerId: data.provider_id,
      gameCode: data.game_code,
      gameType: data.game_type,
      amount: data.amount,
      callId: data.call_id,
      ledgerEntryId: entry.id,
    },
  });

  return { result: CasinoResult.OK, status: "OK", data: { balance: updated.balance } };
}

/**
 * Callback "cancel": estorna uma transação anterior identificada por `cancel_trans_guid` — tanto
 * um BET (devolve o valor apostado) como um WIN (retira o prémio creditado). Cancelar um
 * trans_guid desconhecido devolve erro em vez de inventar um estorno.
 */
export async function handleCancelCallback(data: CasinoCallbackData) {
  const existingCancel = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existingCancel) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: existingCancel.walletId } });
    return { result: CasinoResult.OK, status: "OK", data: { balance: wallet.balance } };
  }

  if (!data.cancel_trans_guid) return { result: CasinoResult.VALIDATION_ERROR, status: "MISSING_CANCEL_TRANS_GUID", data: {} };

  const original = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.cancel_trans_guid } });
  if (!original) return { result: CasinoResult.VALIDATION_ERROR, status: "ORIGINAL_TRANSACTION_NOT_FOUND", data: {} };

  const wallet = await getWalletByAccount(data.account);
  if (!wallet) return { result: CasinoResult.USER_NOT_FOUND, status: "USER_NOT_FOUND", data: {} };

  // Um WIN estornado debita o que foi creditado; um BET estornado (ainda não suportado, ver
  // nota acima) devolveria o que foi debitado — mantido pronto para quando esse callback existir.
  const isCredit = original.type === "WIN" || original.type === "BONUS_CALL_WIN";
  const reversalAmount = isCredit ? -original.amount.toNumber() : original.amount.toNumber();

  const { entry, wallet: updated } = await applyLedgerMovement({
    walletId: wallet.id,
    type: "BET_REFUND",
    amount: reversalAmount,
    referenceType: "casino_slot",
    referenceId: data.trans_guid,
    metadata: {
      gplayId: data.gplay_id,
      roundId: data.round_id,
      providerId: data.provider_id,
      gameCode: data.game_code,
      gameType: data.game_type,
      cancelOfTransGuid: data.cancel_trans_guid,
    },
  });

  await prisma.casinoTransaction.create({
    data: {
      walletId: wallet.id,
      transGuid: data.trans_guid,
      cancelOfTransGuid: data.cancel_trans_guid,
      type: "CANCEL",
      gplayId: data.gplay_id,
      account: data.account,
      roundId: data.round_id,
      providerId: data.provider_id,
      gameCode: data.game_code,
      gameType: data.game_type,
      amount: original.amount,
      ledgerEntryId: entry.id,
    },
  });

  return { result: CasinoResult.OK, status: "OK", data: { balance: updated.balance } };
}

/** Callback "status": consulta o estado de uma transação sem alterar nada. */
export async function handleStatusCallback(account: string, transGuid: string) {
  const wallet = await getWalletByAccount(account);
  if (!wallet) return { result: CasinoResult.USER_NOT_FOUND, status: "USER_NOT_FOUND", data: {} };

  const tx = await prisma.casinoTransaction.findUnique({ where: { transGuid } });
  if (!tx) return { result: CasinoResult.VALIDATION_ERROR, status: "NOT_FOUND", data: { account, trans_guid: transGuid } };

  return { result: CasinoResult.OK, status: "OK", data: { account, trans_guid: transGuid, trans_status: "OK" } };
}

/**
 * Traduz um AppError (ex: saldo insuficiente ao estornar) para a forma {result,status,data} que
 * este contrato de callback espera, em vez de deixar escapar o formato HTTP genérico de erro.
 */
export function toCallbackErrorResponse(err: unknown) {
  if (err instanceof AppError) return { result: CasinoResult.INTERNAL_SERVER_ERROR, status: err.code, data: {} };
  return { result: CasinoResult.INTERNAL_SERVER_ERROR, status: "INTERNAL_ERROR", data: {} };
}

/**
 * Pedido de lançamento de um jogo — confirmado via Swagger real
 * (agent.goldslotpalase.com/swagger/v4/swagger.json): `POST /v4/user/create` para obter o
 * `user_code` do jogador no sistema do provedor (idempotente — cria só se ainda não existir),
 * depois `POST /v4/game/game-url` para o URL de lançamento (válido 10min, uso único).
 */
export async function requestGameLaunch(userId: string, gameCode: string): Promise<string> {
  const game = findGame(gameCode);
  if (!game) throw Errors.notFound("Jogo não encontrado no catálogo");

  const { userCode } = await createOrGetProviderUser(accountForUser(userId));
  return getGameLaunchUrl({ userCode, providerId: game.provider_id, gameSymbol: game.game_code });
}
