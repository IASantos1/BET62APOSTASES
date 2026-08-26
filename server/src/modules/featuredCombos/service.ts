import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { hybridSportsService } from "../sports/hybridService";
import { getPrematchEvents } from "../sports/prematch/service";
import { ALL_SPORTS, type LiveEvent, type Sport } from "../sports/types";

/**
 * "Melhores Escolhas" — combinações curadas por um admin para UM evento específico, pedido
 * explícito do utilizador a partir de uma referência visual de uma casa de apostas grande, mas
 * com uma diferença deliberada: o "boost" aqui é SEMPRE aplicado às odds REAIS e atuais do
 * mercado no momento em que a combinação é mostrada/colocada, nunca uma percentagem cosmética
 * sobre um número inventado (ver comentário do módulo FeaturedCombo em schema.prisma). `legs`
 * guarda o mercado/seleção BRUTOS tal como o admin os escreveu — têm de bater exatamente com
 * `LiveOdds.market`/a chave de `LiveOdds.selections` do evento (mesmo texto que aparece nas
 * respostas normais de /api/sports/live e /api/sports/prematch); uma combinação cuja perna já não
 * exista ou esteja suspensa simplesmente deixa de aparecer, nunca é mostrada com dados
 * desatualizados ou inventados — mesma disciplina de validateSelection() em betting/service.ts.
 */

export interface FeaturedComboLegInput {
  market: string;
  selection: string;
}

export interface FeaturedComboInput {
  eventId: string;
  sport: string;
  legs: FeaturedComboLegInput[];
  boostPercent: number;
}

const MIN_LEGS = 2;
const MAX_LEGS = 4;
const MIN_BOOST_PERCENT = 1;
const MAX_BOOST_PERCENT = 100;

function validateComboInput(input: FeaturedComboInput) {
  if (!input.eventId) throw Errors.badRequest("eventId em falta.");
  if (!ALL_SPORTS.includes(input.sport as Sport)) throw Errors.badRequest(`Desporto "${input.sport}" desconhecido.`);
  if (input.legs.length < MIN_LEGS || input.legs.length > MAX_LEGS) {
    throw Errors.badRequest(`Uma combinação precisa de ${MIN_LEGS} a ${MAX_LEGS} pernas.`);
  }
  for (const leg of input.legs) {
    if (!leg.market?.trim() || !leg.selection?.trim()) throw Errors.badRequest("Cada perna precisa de mercado e seleção preenchidos.");
  }
  if (!Number.isInteger(input.boostPercent) || input.boostPercent < MIN_BOOST_PERCENT || input.boostPercent > MAX_BOOST_PERCENT) {
    throw Errors.badRequest(`O boost tem de ser um número inteiro entre ${MIN_BOOST_PERCENT}% e ${MAX_BOOST_PERCENT}%.`);
  }
}

export async function adminCreateFeaturedCombo(input: FeaturedComboInput, createdBy: string) {
  validateComboInput(input);
  return prisma.featuredCombo.create({
    data: {
      eventId: input.eventId,
      sport: input.sport,
      legs: input.legs as unknown as Prisma.InputJsonValue,
      boostPercent: input.boostPercent,
      createdBy,
    },
  });
}

export async function adminListFeaturedCombos(eventId?: string) {
  return prisma.featuredCombo.findMany({
    where: eventId ? { eventId } : undefined,
    orderBy: { createdAt: "desc" },
  });
}

export async function adminSetFeaturedComboActive(id: string, active: boolean) {
  return prisma.featuredCombo.update({ where: { id }, data: { active } }).catch(() => {
    throw Errors.notFound("Combinação não encontrada.");
  });
}

export async function adminDeleteFeaturedCombo(id: string) {
  await prisma.featuredCombo.delete({ where: { id } }).catch(() => {
    throw Errors.notFound("Combinação não encontrada.");
  });
}

/** Mesma resolução de evento (ao vivo primeiro, depois pré-jogo) que resolveCurrentEvent() em
 * betting/service.ts — duplicada aqui de propósito (função pura, 4 linhas) em vez de exportada de
 * lá, para este módulo não depender de internals de "betting" só para ler dados de desporto. */
export async function resolveEventForPricing(sport: string, eventId: string): Promise<LiveEvent | null> {
  const live = hybridSportsService.getById(eventId);
  if (live) return live;
  if (!ALL_SPORTS.includes(sport as Sport)) return null;
  const prematch = await getPrematchEvents(sport as Sport);
  return prematch.events.find((e) => e.id === eventId) ?? null;
}

export interface PricedLeg {
  market: string;
  selection: string;
  realOdd: number;
}

/** Confirma cada perna contra as odds REAIS e atuais do evento — mercado ativo, seleção ativa e
 * com odd válida. Devolve null (não um erro) assim que UMA perna falhar — a combinação inteira
 * fica de fora em vez de aparecer parcial ou com um "buraco". */
export function priceLegsAgainstEvent(event: LiveEvent, legs: FeaturedComboLegInput[]): PricedLeg[] | null {
  const priced: PricedLeg[] = [];
  for (const leg of legs) {
    const group = event.odds.find((g) => g.market === leg.market);
    if (!group || !group.isActive) return null;
    const sel = group.selections[leg.selection];
    if (!sel || !sel.isActive || !Number.isFinite(sel.odd)) return null;
    priced.push({ market: leg.market, selection: leg.selection, realOdd: sel.odd });
  }
  return priced;
}

export interface PricedFeaturedCombo {
  id: string;
  boostPercent: number;
  legs: Array<PricedLeg & { boostedOdd: number }>;
  realCombinedOdd: number;
  boostedCombinedOdd: number;
}

/** O boost é distribuído GEOMETRICAMENTE por todas as pernas (cada odd real vezes a mesma raiz-n
 * do fator de boost) em vez de despejado inteiro numa só — assim o produto final bate exatamente
 * com realCombinedOdd × fator de boost, e nenhuma perna individual fica com uma odd visivelmente
 * fora do mercado quando o utilizador a vir isolada (ex: no histórico "Minhas Apostas"). Função
 * pura e partilhada entre a pré-visualização (aqui) e a colocação real (placeFeaturedComboBet em
 * betting/service.ts) — as duas têm de usar exatamente a mesma fórmula, ou o preço mostrado ao
 * utilizador podia não bater com o que fica gravado. */
export function applyBoost(pricedLegs: PricedLeg[], boostPercent: number): { legs: Array<PricedLeg & { boostedOdd: number }>; realCombinedOdd: number; boostedCombinedOdd: number } {
  const boostFactor = 1 + boostPercent / 100;
  const perLegFactor = Math.pow(boostFactor, 1 / pricedLegs.length);
  const realCombinedOdd = pricedLegs.reduce((acc, l) => acc * l.realOdd, 1);
  return {
    legs: pricedLegs.map((l) => ({ ...l, boostedOdd: l.realOdd * perLegFactor })),
    realCombinedOdd,
    boostedCombinedOdd: realCombinedOdd * boostFactor,
  };
}

export async function getPricedFeaturedCombosForEvent(eventId: string): Promise<PricedFeaturedCombo[]> {
  const combos = await prisma.featuredCombo.findMany({ where: { eventId, active: true }, orderBy: { createdAt: "desc" } });
  if (!combos.length) return [];

  const sport = combos[0]!.sport;
  const event = await resolveEventForPricing(sport, eventId);
  if (!event || event.status === "finished") return [];

  const priced: PricedFeaturedCombo[] = [];
  for (const combo of combos) {
    const legs = combo.legs as unknown as FeaturedComboLegInput[];
    const pricedLegs = priceLegsAgainstEvent(event, legs);
    if (!pricedLegs) continue;
    const { legs: boostedLegs, realCombinedOdd, boostedCombinedOdd } = applyBoost(pricedLegs, combo.boostPercent);
    priced.push({ id: combo.id, boostPercent: combo.boostPercent, legs: boostedLegs, realCombinedOdd, boostedCombinedOdd });
  }
  return priced;
}

export async function getActiveFeaturedComboById(id: string) {
  const combo = await prisma.featuredCombo.findUnique({ where: { id } });
  if (!combo || !combo.active) return null;
  return combo;
}
