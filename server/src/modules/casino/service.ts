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

// Códigos de resultado do CALLBACK (não confundir com os códigos da Agent API de saída em
// apiClient.ts) — confirmados pelo exemplo de implementação PHP oficial do provedor colado pelo
// utilizador: o `result` de erro é literalmente o número do item de `check` que falhou (21 =
// utilizador não encontrado, 22 = utilizador inativo, 31 = saldo insuficiente, 41 = trans_guid
// já processado, 42 = trans_guid inexistente, 43 = cancel_trans_guid inexistente), 100 = token
// de callback inválido, 99 = erro genérico ao processar. Importante: ao contrário do que se
// assumia antes, um `trans_guid` repetido em bet/win/cancel é tratado como ERRO (41), não como
// sucesso idempotente — replicado aqui fielmente a partir da amostra oficial.
export const CasinoResult = {
  OK: 0,
  USER_NOT_FOUND: 21,
  USER_INACTIVE: 22,
  BALANCE_NOT_ENOUGH: 31,
  ALREADY_PROCESSED: 41,
  TRANS_NOT_FOUND: 42,
  CANCEL_TARGET_NOT_FOUND: 43,
  BAD_TOKEN: 100,
  PROCESSING_ERROR: 99,
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

async function getWalletWithUserByAccount(account: string) {
  const userId = userIdFromAccount(account);
  if (!userId) return null;
  const wallet = await prisma.wallet.findUnique({ where: { userId }, include: { user: true } });
  if (!wallet) return null;
  const { user, ...walletFields } = wallet;
  return { wallet: walletFields, user };
}

/** Já cancelada anteriormente? (equivalente ao `sort == 'CANCEL'` da amostra PHP oficial, mas
 * sem mutar a transação original — o nosso log de CasinoTransaction é imutável). */
function findCancelOf(transGuid: string) {
  return prisma.casinoTransaction.findFirst({ where: { cancelOfTransGuid: transGuid, type: "CANCEL" } });
}

/**
 * Callback "authenticate": o provedor confirma que a conta existe antes de aceitar uma aposta
 * (ex: ao abrir o jogo). Também é o pedido usado para testar o URL de callback configurado no
 * painel de agente — se isto não responder, o pedido de `game-url` falha com "CALLBACK_ERROR".
 */
export async function handleAuthenticateCallback(account: string) {
  const found = await getWalletWithUserByAccount(account);
  if (!found) return { result: CasinoResult.USER_NOT_FOUND, status: "ERROR", data: {} };
  if (found.user.status !== "ACTIVE") return { result: CasinoResult.USER_INACTIVE, status: "ERROR", data: {} };
  return { result: CasinoResult.OK, status: "OK", data: { account, balance: found.wallet.balance } };
}

/** Callback "balance": confirmação do saldo atual, sem alterar nada. */
export async function handleBalanceCallback(account: string) {
  const found = await getWalletWithUserByAccount(account);
  if (!found) return { result: CasinoResult.USER_NOT_FOUND, status: "ERROR", data: {} };
  if (found.user.status !== "ACTIVE") return { result: CasinoResult.USER_INACTIVE, status: "ERROR", data: {} };
  return { result: CasinoResult.OK, status: "OK", data: { balance: found.wallet.balance } };
}

/**
 * Callback "bet": debita o valor apostado na carteira do jogador. Um `trans_guid` repetido é
 * ERRO (41, "já processado"), não sucesso idempotente — conforme a amostra oficial. Saldo
 * insuficiente devolve 31 (BALANCE_NOT_ENOUGH) em vez de deixar escapar um erro genérico.
 */
export async function handleBetCallback(data: CasinoCallbackData) {
  const found = await getWalletWithUserByAccount(data.account);
  if (!found) return { result: CasinoResult.USER_NOT_FOUND, status: "ERROR", data: {} };
  if (found.user.status !== "ACTIVE") return { result: CasinoResult.USER_INACTIVE, status: "ERROR", data: {} };

  const existing = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) return { result: CasinoResult.ALREADY_PROCESSED, status: "ERROR", data: { balance: found.wallet.balance } };

  let entry, updated;
  try {
    ({ entry, wallet: updated } = await applyLedgerMovement({
      walletId: found.wallet.id,
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
    if (err instanceof AppError) return { result: CasinoResult.BALANCE_NOT_ENOUGH, status: "ERROR", data: { balance: found.wallet.balance } };
    throw err;
  }

  await prisma.casinoTransaction.create({
    data: {
      walletId: found.wallet.id,
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
 * Callback "win": credita o prémio na carteira do jogador. Um `trans_guid` repetido é ERRO (41),
 * não sucesso idempotente.
 */
export async function handleWinCallback(data: CasinoCallbackData) {
  const found = await getWalletWithUserByAccount(data.account);
  if (!found) return { result: CasinoResult.USER_NOT_FOUND, status: "ERROR", data: {} };
  if (found.user.status !== "ACTIVE") return { result: CasinoResult.USER_INACTIVE, status: "ERROR", data: {} };

  const existing = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) return { result: CasinoResult.ALREADY_PROCESSED, status: "ERROR", data: { balance: found.wallet.balance } };

  // "BonusCall(32) em vez de Win(2)" — a doc não dá um campo explícito para isto no callback,
  // por isso usa-se a presença de call_id (id da chamada de bónus) como sinal.
  const isBonusCall = !!data.call_id && data.call_id !== "0";

  const { entry, wallet: updated } = await applyLedgerMovement({
    walletId: found.wallet.id,
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
      walletId: found.wallet.id,
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
 * um BET (devolve o valor apostado) como um WIN (retira o prémio creditado). Um `trans_guid`
 * repetido (do próprio "cancel") é ERRO (41); um `cancel_trans_guid` já estornado antes devolve
 * OK com o saldo atual sem reaplicar (equivalente ao guard `sort != 'CANCEL'` da amostra
 * oficial). `cancel_trans_guid` inexistente é ERRO (43).
 */
export async function handleCancelCallback(data: CasinoCallbackData) {
  const found = await getWalletWithUserByAccount(data.account);
  if (!found) return { result: CasinoResult.USER_NOT_FOUND, status: "ERROR", data: {} };
  if (found.user.status !== "ACTIVE") return { result: CasinoResult.USER_INACTIVE, status: "ERROR", data: {} };

  const existing = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) return { result: CasinoResult.ALREADY_PROCESSED, status: "ERROR", data: { balance: found.wallet.balance } };

  if (!data.cancel_trans_guid) return { result: CasinoResult.CANCEL_TARGET_NOT_FOUND, status: "ERROR", data: { balance: found.wallet.balance } };

  const original = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.cancel_trans_guid } });
  if (!original) return { result: CasinoResult.CANCEL_TARGET_NOT_FOUND, status: "ERROR", data: { balance: found.wallet.balance } };

  const alreadyCancelled = await findCancelOf(data.cancel_trans_guid);
  if (alreadyCancelled) return { result: CasinoResult.OK, status: "OK", data: { balance: found.wallet.balance } };

  const isCredit = original.type === "WIN" || original.type === "BONUS_CALL_WIN";
  const reversalAmount = isCredit ? -original.amount.toNumber() : original.amount.toNumber();

  const { entry, wallet: updated } = await applyLedgerMovement({
    walletId: found.wallet.id,
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
      walletId: found.wallet.id,
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
  const found = await getWalletWithUserByAccount(account);
  if (!found) return { result: CasinoResult.USER_NOT_FOUND, status: "ERROR", data: {} };

  const tx = await prisma.casinoTransaction.findUnique({ where: { transGuid } });
  if (!tx) return { result: CasinoResult.TRANS_NOT_FOUND, status: "ERROR", data: {} };

  const cancelled = await findCancelOf(transGuid);
  return {
    result: CasinoResult.OK,
    status: "OK",
    data: { account, trans_guid: transGuid, trans_status: cancelled ? "CANCELED" : "OK" },
  };
}

/**
 * Traduz um AppError (ex: Callback-Token inválido) para a forma {result,status,data} que este
 * contrato de callback espera, em vez de deixar escapar o formato HTTP genérico de erro.
 */
export function toCallbackErrorResponse(err: unknown) {
  if (err instanceof AppError && err.code === "UNAUTHORIZED") {
    return { result: CasinoResult.BAD_TOKEN, status: "ERROR", data: {} };
  }
  return { result: CasinoResult.PROCESSING_ERROR, status: "ERROR", data: {} };
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
