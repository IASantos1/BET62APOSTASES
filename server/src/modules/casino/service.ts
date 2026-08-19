import { prisma } from "../../lib/prisma";
import { Errors, AppError } from "../../lib/errors";
import { applyLedgerMovement } from "../wallet/service";
import { findGame } from "./catalog";

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

// Códigos de resultado citados na doc do provedor ("0, 1, 1001 — Consulte Códigos de
// Resultado") sem a tabela de significados em si. 0 = sucesso está confirmado pelo exemplo de
// resposta dado; 1 = erro genérico e 1001 = transação já processada são a leitura padrão deste
// tipo de contrato de casino seamless — NÃO confirmado com uma resposta real de erro do
// provedor, apenas assumido por convenção do setor até vermos uma amostra real.
export const CasinoResult = {
  OK: 0,
  ERROR: 1,
  ALREADY_PROCESSED: 1001,
} as const;

function getWalletByAccount(account: string) {
  return prisma.wallet.findUnique({ where: { userId: account } });
}

/**
 * Callback "win": credita o prémio na carteira do jogador. Idempotente por `trans_guid` — uma
 * entrega repetida do mesmo trans_guid não é reaplicada, devolve o saldo atual tal como está.
 */
export async function handleWinCallback(data: CasinoCallbackData) {
  const existing = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existing) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: existing.walletId } });
    return { result: CasinoResult.ALREADY_PROCESSED, status: "OK", data: { balance: wallet.balance } };
  }

  const wallet = await getWalletByAccount(data.account);
  if (!wallet) return { result: CasinoResult.ERROR, status: "ACCOUNT_NOT_FOUND", data: {} };

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
 * Callback "cancel": estorna uma transação anterior identificada por `cancel_trans_guid`. Como
 * a doc fornecida só documenta os callbacks Win/Cancel/Status (não há um callback "bet"/débito
 * documentado ainda), na prática isto só sabe estornar um WIN que passou por aqui — cancelar um
 * trans_guid desconhecido devolve erro em vez de inventar um estorno.
 */
export async function handleCancelCallback(data: CasinoCallbackData) {
  const existingCancel = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.trans_guid } });
  if (existingCancel) {
    const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: existingCancel.walletId } });
    return { result: CasinoResult.ALREADY_PROCESSED, status: "OK", data: { balance: wallet.balance } };
  }

  if (!data.cancel_trans_guid) return { result: CasinoResult.ERROR, status: "MISSING_CANCEL_TRANS_GUID", data: {} };

  const original = await prisma.casinoTransaction.findUnique({ where: { transGuid: data.cancel_trans_guid } });
  if (!original) return { result: CasinoResult.ERROR, status: "ORIGINAL_TRANSACTION_NOT_FOUND", data: {} };

  const wallet = await getWalletByAccount(data.account);
  if (!wallet) return { result: CasinoResult.ERROR, status: "ACCOUNT_NOT_FOUND", data: {} };

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
  if (!wallet) return { result: CasinoResult.ERROR, status: "ACCOUNT_NOT_FOUND", data: {} };

  const tx = await prisma.casinoTransaction.findUnique({ where: { transGuid } });
  if (!tx) return { result: CasinoResult.ERROR, status: "NOT_FOUND", data: { account, trans_guid: transGuid } };

  return { result: CasinoResult.OK, status: "OK", data: { account, trans_guid: transGuid, trans_status: "OK" } };
}

/**
 * Traduz um AppError (ex: saldo insuficiente ao estornar) para a forma {result,status,data} que
 * este contrato de callback espera, em vez de deixar escapar o formato HTTP genérico de erro.
 */
export function toCallbackErrorResponse(err: unknown) {
  if (err instanceof AppError) return { result: CasinoResult.ERROR, status: err.code, data: {} };
  return { result: CasinoResult.ERROR, status: "INTERNAL_ERROR", data: {} };
}

/**
 * Pedido de lançamento de um jogo — NÃO confirmado: a documentação recebida só cobre os
 * callbacks Win/Cancel/Status (o provedor a chamar-nos), não o endpoint para NÓS pedirmos uma
 * sessão/URL de jogo ao provedor (base URL + credenciais de agente). Falha de propósito com uma
 * mensagem clara em vez de inventar uma chamada HTTP para um endpoint que nunca foi confirmado.
 */
export async function requestGameLaunch(gameCode: string) {
  const game = findGame(gameCode);
  if (!game) throw Errors.notFound("Jogo não encontrado no catálogo");

  throw Errors.badRequest(
    "Lançamento de jogo ainda não disponível: falta confirmar o endpoint real de sessão/URL de jogo do Cassino Gold Palace (base URL e credenciais de agente). Os callbacks Win/Cancel/Status já estão prontos para quando esse endpoint for confirmado.",
    { game_code: game.game_code, game_name: game.game_name }
  );
}
