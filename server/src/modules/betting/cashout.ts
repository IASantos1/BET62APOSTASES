import { Prisma, type Bet, type BetSelection } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { applyLedgerMovement } from "../wallet/service";
import { hybridSportsService } from "../sports/hybridService";
import type { LiveEvent } from "../sports/types";

/**
 * Cash Out — encerrar uma aposta PENDING antes do fim, recebendo agora um valor calculado a
 * partir das odds AO VIVO atuais em vez de esperar pelo resultado final.
 *
 * Fórmula (valor justo, descrição padrão do setor de apostas): valor = stake × (odd total na
 * colocação ÷ odd total atual). Se as odds da(s) seleção(ões) encurtaram desde a aposta (posição
 * agora mais provável de ganhar), o valor de cash out sobe acima do stake; se alongaram, desce
 * abaixo. CASHOUT_MARGIN é um parâmetro de PRODUTO nosso (não confirmado contra nenhuma casa de
 * apostas real) — ajustável livremente, não uma constante que precise de confirmação externa.
 *
 * Âmbito mínimo viável, conservador de propósito: só oferece cash out quando TODAS as seleções
 * ainda estão PENDING e TODAS têm o evento AO VIVO neste preciso momento, com o mesmo mercado e
 * seleção (texto exato tal como gravado na colocação) ainda ativos no snapshot em memória —
 * qualquer seleção sem correspondência exata (evento já não está ao vivo, ainda não começou,
 * mercado suspenso ou desapareceu) bloqueia o cash out da aposta INTEIRA em vez de arriscar um
 * valor calculado com dados parciais/desatualizados. Sem isto para apostas Simples/Múltiplas
 * ainda em pré-jogo (nunca chegaram a ficar "live") — decisão deliberada: as odds pré-jogo não
 * são transmitidas continuamente neste projeto (só via polling do catálogo), por isso não há uma
 * fonte de odds "agora mesmo" fiável fora do feed ao vivo.
 */
const CASHOUT_MARGIN = new Prisma.Decimal("0.92"); // 8% de margem — decisão de produto, ajustável

export interface CashOutOffer {
  eligible: boolean;
  value?: number;
  currentTotalOdd?: number;
  reason?: string;
}

function findLiveSelectionOdd(sel: BetSelection, liveEvents: LiveEvent[]): number | null {
  const event = liveEvents.find((e) => e.id === sel.eventId);
  if (!event || event.status !== "live") return null;
  const group = event.odds?.find((g) => g.market === sel.market);
  if (!group || !group.isActive) return null;
  const selection = group.selections?.[sel.selection];
  if (!selection || !selection.isActive || !Number.isFinite(selection.odd)) return null;
  return selection.odd;
}

export function computeCashOutOffer(bet: Bet, selections: BetSelection[], liveEvents: LiveEvent[]): CashOutOffer {
  if (bet.status !== "PENDING") {
    return { eligible: false, reason: "Esta aposta já foi liquidada e não pode ser encerrada por cash out." };
  }
  if (selections.some((s) => s.status !== "PENDING")) {
    return { eligible: false, reason: "Uma ou mais seleções desta aposta já foram decididas." };
  }
  if (!selections.length) {
    return { eligible: false, reason: "Aposta sem seleções." };
  }

  let currentTotalOdd = new Prisma.Decimal(1);
  for (const sel of selections) {
    const liveOdd = findLiveSelectionOdd(sel, liveEvents);
    if (liveOdd === null) {
      return { eligible: false, reason: "Sem odds ao vivo disponíveis para todas as seleções neste momento." };
    }
    currentTotalOdd = currentTotalOdd.mul(liveOdd);
  }

  const fairValue = bet.stake.mul(bet.totalOdd).div(currentTotalOdd);
  const marginedValue = fairValue.mul(CASHOUT_MARGIN);
  // Nunca oferece mais do que o retorno potencial máximo da aposta (o cash out é sempre uma
  // saída ANTECIPADA, nunca deveria valer mais do que ganhar a aposta inteira).
  const capped = marginedValue.lessThan(bet.potentialReturn) ? marginedValue : bet.potentialReturn;
  const value = Math.max(0, Number(capped.toFixed(2)));

  return { eligible: true, value, currentTotalOdd: Number(currentTotalOdd.toFixed(3)) };
}

export async function getCashOutOffer(userId: string, betId: string): Promise<CashOutOffer> {
  const bet = await prisma.bet.findFirst({ where: { id: betId, userId }, include: { selections: true } });
  if (!bet) throw Errors.notFound("Aposta não encontrada");
  const liveEvents = hybridSportsService.snapshot();
  return computeCashOutOffer(bet, bet.selections, liveEvents);
}

/** Reavalia tudo dentro da transação — nunca confia num valor de cash out vindo do cliente
 *  (o pedido de POST não recebe/aceita nenhum "value", só o id da aposta). */
export async function executeCashOut(userId: string, betId: string): Promise<{ betId: string; value: number }> {
  return prisma.$transaction(async (tx) => {
    const bet = await tx.bet.findFirst({ where: { id: betId, userId }, include: { selections: true } });
    if (!bet) throw Errors.notFound("Aposta não encontrada");

    const liveEvents = hybridSportsService.snapshot();
    const offer = computeCashOutOffer(bet, bet.selections, liveEvents);
    if (!offer.eligible || offer.value === undefined) {
      throw Errors.badRequest(offer.reason ?? "Cash out não disponível para esta aposta neste momento.");
    }

    await tx.bet.update({
      where: { id: bet.id },
      data: { status: "CASHED_OUT", payout: offer.value, settledAt: new Date() },
    });

    await applyLedgerMovement({
      walletId: bet.walletId,
      type: "BET_CASHOUT",
      amount: offer.value,
      referenceType: "bet",
      referenceId: bet.id,
      metadata: { betType: bet.type, stake: bet.stake.toString(), currentTotalOdd: offer.currentTotalOdd },
      tx,
    });

    return { betId: bet.id, value: offer.value };
  });
}
