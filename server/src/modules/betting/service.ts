import { Prisma, type Bet } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { getWalletByUserId, applyLedgerMovement } from "../wallet/service";
import { isSelfExcluded } from "../users/service";
import { hybridSportsService } from "../sports/hybridService";
import { getPrematchEvents } from "../sports/prematch/service";
import { ALL_SPORTS, type LiveEvent, type Sport } from "../sports/types";
import { applyFinalOutcome } from "./settlement";
import { classifyForBetBuilder } from "./settlementRules";

const MIN_STAKE_EUR = 0.5;

export interface SelectionInput {
  eventId: string;
  sport: string;
  market: string;
  selection: string;
  odd: number; // odd que o utilizador viu no boletim — só usada para detetar se mudou, nunca confiada como definitiva
  stake?: number; // só usado no modo SIMPLES (cada seleção tem o seu próprio valor)
}

async function resolveCurrentEvent(sport: string, eventId: string): Promise<LiveEvent | null> {
  const live = hybridSportsService.getById(eventId);
  if (live) return live;
  if (!ALL_SPORTS.includes(sport as Sport)) return null;
  const prematch = await getPrematchEvents(sport as Sport);
  return prematch.events.find((e) => e.id === eventId) ?? null;
}

interface ValidatedSelection {
  input: SelectionInput;
  event: LiveEvent;
  odd: number;
}

/** Nunca confia na odd que o cliente mandou — vai sempre buscar o evento/mercado/seleção
 * ATUAIS (ao vivo ou pré-jogo) e compara. Só passa se o evento ainda existir, não tiver
 * terminado, o mercado não estiver suspenso, a seleção não estiver suspensa, e a odd bater
 * (tolerância mínima para arredondamento de ponto flutuante). */
async function validateSelection(input: SelectionInput): Promise<ValidatedSelection | { error: string }> {
  const event = await resolveCurrentEvent(input.sport, input.eventId);
  if (!event) return { error: `O evento já não está disponível para apostar.` };
  if (event.status === "finished") return { error: `O evento "${event.home} vs ${event.away}" já terminou.` };

  const group = event.odds.find((g) => g.market === input.market);
  if (!group || !group.isActive) return { error: `O mercado "${input.market}" (${event.home} vs ${event.away}) está suspenso.` };

  const sel = group.selections[input.selection];
  if (!sel || !sel.isActive || !Number.isFinite(sel.odd)) {
    return { error: `A seleção "${input.selection}" (${event.home} vs ${event.away}) está suspensa.` };
  }

  if (Math.abs(sel.odd - input.odd) > 0.005) {
    return { error: `A odd de "${input.selection}" (${event.home} vs ${event.away}) mudou de ${input.odd.toFixed(2)} para ${sel.odd.toFixed(2)}. Reveja o boletim e tente novamente.` };
  }

  return { input, event, odd: sel.odd };
}

function betSelectionCreateData(v: ValidatedSelection) {
  return {
    eventId: v.input.eventId,
    sport: v.input.sport,
    league: v.event.league,
    home: v.event.home,
    away: v.event.away,
    market: v.input.market,
    selection: v.input.selection,
    odd: v.odd,
    kickoffAt: v.event.startTime ? new Date(v.event.startTime) : null,
  };
}

export interface PlaceBetsParams {
  userId: string;
  mode: "SIMPLES" | "MULTIPLA" | "BET_BUILDER";
  selections: SelectionInput[];
  stake?: number; // combinado — só para MULTIPLA/BET_BUILDER
}

const BET_BUILDER_MAX_SELECTIONS = 4;

export interface PlaceBetsResult {
  bets: Bet[];
  errors: Array<{ input: SelectionInput; error: string }>;
}

/** Cria um único Bet combinado (várias seleções, um só stake, odd total = produto das odds) —
 * partilhado por MULTIPLA e BET_BUILDER, que só diferem nas regras de validação antes disto. */
async function createCombinedBet(
  userId: string,
  walletId: string,
  type: "MULTIPLA" | "BET_BUILDER",
  validated: ValidatedSelection[],
  stake: number
): Promise<Bet> {
  const totalOdd = validated.reduce((acc, v) => acc.mul(v.odd), new Prisma.Decimal(1));
  const stakeDecimal = new Prisma.Decimal(stake);

  return prisma.$transaction(async (tx) => {
    const created = await tx.bet.create({
      data: {
        userId,
        walletId,
        type,
        stake: stakeDecimal,
        totalOdd,
        potentialReturn: stakeDecimal.mul(totalOdd),
        status: "PENDING",
        selections: { create: validated.map(betSelectionCreateData) },
      },
      include: { selections: true },
    });
    await applyLedgerMovement({
      walletId,
      type: "BET_PLACED",
      amount: stakeDecimal.neg(),
      referenceType: "bet",
      referenceId: created.id,
      metadata: { mode: type, selections: validated.length },
      tx,
    });
    return created;
  });
}

export async function placeBets(params: PlaceBetsParams): Promise<PlaceBetsResult> {
  if (await isSelfExcluded(params.userId)) throw Errors.selfExcluded();
  if (!params.selections.length) throw Errors.badRequest("O boletim está vazio.");

  const wallet = await getWalletByUserId(params.userId);

  if (params.mode === "MULTIPLA") {
    if (params.selections.length < 2) throw Errors.badRequest("Uma aposta Múltipla precisa de pelo menos 2 seleções.");
    const uniqueEvents = new Set(params.selections.map((s) => s.eventId));
    if (uniqueEvents.size !== params.selections.length) {
      throw Errors.badRequest("Uma aposta Múltipla não pode ter duas seleções do mesmo evento.");
    }
    const stake = params.stake;
    if (!stake || stake < MIN_STAKE_EUR) throw Errors.badRequest(`O valor mínimo da aposta é ${MIN_STAKE_EUR.toFixed(2)}€.`);

    const validated: ValidatedSelection[] = [];
    for (const s of params.selections) {
      const result = await validateSelection(s);
      if ("error" in result) throw Errors.badRequest(result.error);
      validated.push(result);
    }

    const bet = await createCombinedBet(params.userId, wallet.id, "MULTIPLA", validated, stake);
    return { bets: [bet], errors: [] };
  }

  if (params.mode === "BET_BUILDER") {
    if (params.selections.length < 1 || params.selections.length > BET_BUILDER_MAX_SELECTIONS) {
      throw Errors.badRequest(`O Bet Builder aceita entre 1 e ${BET_BUILDER_MAX_SELECTIONS} seleções.`);
    }
    const uniqueEvents = new Set(params.selections.map((s) => s.eventId));
    if (uniqueEvents.size !== 1) {
      throw Errors.badRequest("O Bet Builder só combina seleções do MESMO jogo.");
    }
    const stake = params.stake;
    if (!stake || stake < MIN_STAKE_EUR) throw Errors.badRequest(`O valor mínimo da aposta é ${MIN_STAKE_EUR.toFixed(2)}€.`);

    // Nunca confia na categoria que o cliente diz que cada mercado é — reclassifica aqui a
    // partir do nome bruto do mercado (mesma heurística que decide a liquidação automática),
    // exatamente como a odd nunca é confiada em validateSelection() abaixo. Duas seleções da
    // MESMA categoria (ex: "Over 2.5" e "Under 1.5" golos) seriam contraditórias — proibido.
    const usedCategories = new Set<string>();
    for (const s of params.selections) {
      const category = classifyForBetBuilder(s.market);
      if (!category) {
        throw Errors.badRequest(
          `"${s.market}" não está disponível no Bet Builder — só Resultado, Golos, Ambas Marcam, Escanteios e Cartões (mercados de jogador ainda não têm liquidação automática).`
        );
      }
      if (usedCategories.has(category)) {
        throw Errors.badRequest("O Bet Builder só permite uma seleção por categoria (ex: não pode escolher duas opções de Golos).");
      }
      usedCategories.add(category);
    }

    const validated: ValidatedSelection[] = [];
    for (const s of params.selections) {
      const result = await validateSelection(s);
      if ("error" in result) throw Errors.badRequest(result.error);
      validated.push(result);
    }

    const bet = await createCombinedBet(params.userId, wallet.id, "BET_BUILDER", validated, stake);
    return { bets: [bet], errors: [] };
  }

  // SIMPLES: cada seleção é o seu próprio Bet — uma pode falhar (odd mudou/suspensa) sem
  // impedir as outras de serem colocadas, ao contrário da Múltipla (um único bilhete).
  const errors: Array<{ input: SelectionInput; error: string }> = [];
  const toPlace: Array<{ v: ValidatedSelection; stake: Prisma.Decimal }> = [];

  for (const s of params.selections) {
    if (!s.stake || s.stake < MIN_STAKE_EUR) {
      errors.push({ input: s, error: `O valor mínimo da aposta é ${MIN_STAKE_EUR.toFixed(2)}€.` });
      continue;
    }
    const result = await validateSelection(s);
    if ("error" in result) {
      errors.push({ input: s, error: result.error });
      continue;
    }
    toPlace.push({ v: result, stake: new Prisma.Decimal(s.stake) });
  }

  if (!toPlace.length) return { bets: [], errors };

  const bets = await prisma.$transaction(async (tx) => {
    const created: Bet[] = [];
    for (const { v, stake } of toPlace) {
      const bet = await tx.bet.create({
        data: {
          userId: params.userId,
          walletId: wallet.id,
          type: "SIMPLES",
          stake,
          totalOdd: v.odd,
          potentialReturn: stake.mul(v.odd),
          status: "PENDING",
          selections: { create: [betSelectionCreateData(v)] },
        },
      });
      await applyLedgerMovement({
        walletId: wallet.id,
        type: "BET_PLACED",
        amount: stake.neg(),
        referenceType: "bet",
        referenceId: bet.id,
        metadata: { mode: "SIMPLES" },
        tx,
      });
      created.push(bet);
    }
    return created;
  });

  return { bets, errors };
}

export async function listMyBets(userId: string, opts: { limit?: number; cursor?: string } = {}) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const bets = await prisma.bet.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { selections: true },
  });
  const hasMore = bets.length > limit;
  const page = hasMore ? bets.slice(0, limit) : bets;
  return { bets: page, nextCursor: hasMore ? page[page.length - 1]?.id : null };
}

// --- Admin: fila de revisão manual (mercados que o motor automático não sabe resolver) --------

export async function listBetsNeedingReview() {
  return prisma.bet.findMany({
    where: { status: "NEEDS_REVIEW" },
    orderBy: { createdAt: "asc" },
    include: { selections: true, user: { select: { id: true, username: true, email: true, publicId: true } } },
    take: 200,
  });
}

/** O admin decide manualmente o resultado de UMA seleção presa em NEEDS_REVIEW (ex: um mercado
 * de handicap que o motor não tentou resolver sozinho) — depois disso, se todas as seleções do
 * Bet já estiverem decididas, o mesmo cálculo de payout da liquidação automática aplica-se. */
export async function manualSettleSelection(selectionId: string, outcome: "WON" | "LOST" | "VOID", adminUserId: string) {
  await prisma.$transaction(async (tx) => {
    const sel = await tx.betSelection.findUniqueOrThrow({ where: { id: selectionId } });
    if (sel.status !== "NEEDS_REVIEW" && sel.status !== "PENDING") {
      throw Errors.conflict("Esta seleção já foi liquidada.");
    }
    await tx.betSelection.update({ where: { id: sel.id }, data: { status: outcome, settledAt: new Date() } });

    const bet = await tx.bet.findUniqueOrThrow({ where: { id: sel.betId }, include: { selections: true } });
    const stillUndecided = bet.selections.some((s) => (s.id === sel.id ? false : s.status === "PENDING" || s.status === "NEEDS_REVIEW"));
    if (stillUndecided) return; // outras seleções desta Múltipla ainda por resolver

    const refreshedSelections = bet.selections.map((s) => (s.id === sel.id ? { ...s, status: outcome } : s));
    await applyFinalOutcome(tx, bet, refreshedSelections);
  });

  await prisma.auditLog.create({
    data: { userId: adminUserId, action: "BET_MANUAL_SETTLE", metadata: { selectionId, outcome } },
  });
}
