import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { hybridSportsService } from "../sports/hybridService";
import { getPrematchEvents } from "../sports/prematch/service";
import { ALL_SPORTS, type LiveEvent, type LiveOdds, type Sport } from "../sports/types";
import { classifyMarket, type MarketCategory } from "../betting/settlementRules";
// Reconhece o mercado "Marcador a Qualquer Momento" pelo NOME bruto — antes vinha de
// classifyRoutingMarket() (pulsescore/marketRouting.ts, removido na reescrita da integração
// Pulsescore/Sportmonks de 2026-08-27); esta é a única classificação desse módulo que este
// ficheiro realmente usava, por isso fica só o essencial em vez de reimportar o módulo inteiro.
function isAnytimeGoalscorerMarket(rawName: string): boolean {
  return /goalscorer|\bscorer\b|player.*(to score|goals)/i.test(rawName);
}

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

// ====================== GERAÇÃO AUTOMÁTICA ("Melhores Escolhas" sem curadoria manual por evento) ======================
// Pedido explícito do utilizador (depois de já ter pedido antes o oposto — combinações curadas à
// mão — e agora a mudar de ideias com "quero que seja gerado automaticamente"): o sistema monta
// as combinações sozinho, seguindo os MESMOS 4 modelos das imagens de referência que enviou
// (Resultado Final + Golos [+ Marcador], BTTS + Resultado, Resultado + Cantos). O admin continua a
// poder criar combinações à mão (ver adminCreateFeaturedCombo acima) — isto só PREENCHE quando não
// há combinações ativas suficientes para o evento, nunca substitui/apaga o que um admin criou.
//
// Identifica os mercados certos com classifyMarket()/isAnytimeGoalscorerMarket() — as MESMAS
// categorias já usadas e confirmadas em produção para o Bet Builder e o motor de liquidação
// automática (settlementRules.ts), nunca uma heurística nova inventada aqui. Toda perna escolhida
// passa pela MESMA validação real (priceLegsAgainstEvent) que as combinações manuais — se não
// existir com odd válida, não entra, nunca aparece inventada.
const AUTO_CREATED_BY = "auto:v1";
// 3 dos 4 modelos reais enviados pelo utilizador usam 10% de boost (o 4º usa 20%, mas sem nenhuma
// regra explicada para quando é 20% em vez de 10% — em vez de adivinhar uma fórmula, fica-se pelo
// valor confirmado na maioria dos exemplos).
const AUTO_BOOST_PERCENT = 10;
const AUTO_TARGET_COMBO_COUNT = 2;

// "Marcar em qualquer altura" só entra numa combinação automática se a seleção parecer mesmo um
// nome de jogador — cautela direta de um bug real já visto nesta app: uma amostra anterior
// mostrou rótulos como "Anytime"/"First"/"Last"/"Score" em vez de nomes de jogadores, e a
// estrutura exata deste mercado nunca foi confirmada com uma amostra bruta real. Isto é só uma
// segunda barreira (a primeira é sempre priceLegsAgainstEvent) contra mostrar um rótulo confuso.
const NON_PLAYER_LABELS = new Set(["anytime", "first", "last", "yes", "no", "sim", "não", "nao", "score", "score or assist", "to score", "home", "away", "draw", "empate"]);
export function looksLikePlayerName(label: string, home: string, away: string): boolean {
  const s = label.trim();
  if (s.length < 4 || s.length > 40) return false;
  if (NON_PLAYER_LABELS.has(s.toLowerCase())) return false;
  if (s.toLowerCase() === home.trim().toLowerCase() || s.toLowerCase() === away.trim().toLowerCase()) return false;
  if (/^\d+(\.\d+)?$/.test(s)) return false;
  return /[a-zà-ÿ]/i.test(s);
}

function groupsByCategory(event: LiveEvent, category: MarketCategory): LiveOdds[] {
  return event.odds.filter((g) => g.isActive && classifyMarket(g.market) === category);
}
function goalscorerGroups(event: LiveEvent): LiveOdds[] {
  return event.odds.filter((g) => g.isActive && isAnytimeGoalscorerMarket(g.market));
}

/** Escolhe o lado favorito (nunca o empate) do Resultado Final pela odd real mais baixa. */
function pickFavoriteResult(event: LiveEvent): FeaturedComboLegInput | null {
  for (const group of groupsByCategory(event, "MATCH_RESULT")) {
    let best: { selection: string; odd: number } | null = null;
    for (const [selection, sel] of Object.entries(group.selections)) {
      if (!sel.isActive || !Number.isFinite(sel.odd)) continue;
      const s = selection.trim().toLowerCase();
      if (s === "x" || s === "draw" || s === "empate") continue;
      if (!best || sel.odd < best.odd) best = { selection, odd: sel.odd };
    }
    if (best) return { market: group.market, selection: best.selection };
  }
  return null;
}

/** Escolhe a linha "Mais de X" cuja odd real está mais perto de 2.0 — nem quase certa demais para
 * não valer o boost, nem tão arriscada que pareça só sorte. Usado para Golos e Cantos. */
function pickBestOverLeg(event: LiveEvent, category: MarketCategory): FeaturedComboLegInput | null {
  let best: { market: string; selection: string; odd: number } | null = null;
  for (const group of groupsByCategory(event, category)) {
    for (const [selection, sel] of Object.entries(group.selections)) {
      if (!sel.isActive || !Number.isFinite(sel.odd)) continue;
      if (!/over|mais/i.test(selection)) continue;
      if (!best || Math.abs(sel.odd - 2.0) < Math.abs(best.odd - 2.0)) best = { market: group.market, selection, odd: sel.odd };
    }
  }
  return best ? { market: best.market, selection: best.selection } : null;
}

function pickBttsYes(event: LiveEvent): FeaturedComboLegInput | null {
  for (const group of groupsByCategory(event, "BTTS")) {
    for (const selection of Object.keys(group.selections)) {
      const sel = group.selections[selection]!;
      if (!sel.isActive || !Number.isFinite(sel.odd)) continue;
      if (/^(yes|sim)$/i.test(selection.trim())) return { market: group.market, selection };
    }
  }
  return null;
}

/** O goleador com a odd real mais baixa entre seleções que passam looksLikePlayerName. */
function pickTopScorer(event: LiveEvent): FeaturedComboLegInput | null {
  let best: { market: string; selection: string; odd: number } | null = null;
  for (const group of goalscorerGroups(event)) {
    for (const [selection, sel] of Object.entries(group.selections)) {
      if (!sel.isActive || !Number.isFinite(sel.odd)) continue;
      if (!looksLikePlayerName(selection, event.home, event.away)) continue;
      if (!best || sel.odd < best.odd) best = { market: group.market, selection, odd: sel.odd };
    }
  }
  return best ? { market: best.market, selection: best.selection } : null;
}

/** Monta até 2 combinações (2-3 pernas) a partir das pernas reais encontradas, espelhando os 4
 * modelos de referência — só usa pernas que foram mesmo encontradas, nunca inventa uma em falta. */
export function buildAutoTemplates(event: LiveEvent): FeaturedComboLegInput[][] {
  const result = pickFavoriteResult(event);
  const goals = pickBestOverLeg(event, "OVER_UNDER_GOALS");
  const btts = pickBttsYes(event);
  const corners = pickBestOverLeg(event, "OVER_UNDER_CORNERS");
  const scorer = pickTopScorer(event);

  const templates: FeaturedComboLegInput[][] = [];
  if (result && goals) templates.push(scorer ? [scorer, result, goals] : [result, goals]);
  if (result && btts) templates.push([btts, result]);
  else if (result && corners) templates.push([result, corners]);
  return templates.filter((t) => t.length >= MIN_LEGS);
}

/** Reconfirma as combinações automáticas já existentes deste evento (desativa as que já não têm
 * uma perna válida) e gera as que faltarem até AUTO_TARGET_COMBO_COUNT — só para futebol, os
 * outros desportos não têm os mercados (Cantos/BTTS/Marcador) usados nos modelos de referência. */
async function ensureAutoFeaturedCombos(event: LiveEvent): Promise<void> {
  if (event.sport !== "football") return;
  const existing = await prisma.featuredCombo.findMany({ where: { eventId: event.id, createdBy: AUTO_CREATED_BY, active: true } });
  let validCount = 0;
  for (const combo of existing) {
    const legs = combo.legs as unknown as FeaturedComboLegInput[];
    if (priceLegsAgainstEvent(event, legs)) {
      validCount++;
    } else {
      await prisma.featuredCombo.update({ where: { id: combo.id }, data: { active: false } }).catch(() => {});
    }
  }
  if (validCount >= AUTO_TARGET_COMBO_COUNT) return;
  const templates = buildAutoTemplates(event);
  for (const legs of templates.slice(0, AUTO_TARGET_COMBO_COUNT - validCount)) {
    if (!priceLegsAgainstEvent(event, legs)) continue; // dupla confirmação antes de gravar
    await prisma.featuredCombo
      .create({
        data: {
          eventId: event.id,
          sport: event.sport,
          legs: legs as unknown as Prisma.InputJsonValue,
          boostPercent: AUTO_BOOST_PERCENT,
          createdBy: AUTO_CREATED_BY,
        },
      })
      .catch(() => {});
  }
}

export async function getPricedFeaturedCombosForEvent(eventId: string): Promise<PricedFeaturedCombo[]> {
  let combos = await prisma.featuredCombo.findMany({ where: { eventId, active: true }, orderBy: { createdAt: "desc" } });

  const event = combos.length
    ? await resolveEventForPricing(combos[0]!.sport, eventId)
    : await resolveEventForPricing("football", eventId); // geração automática só existe para futebol
  if (!event || event.status === "finished") return [];

  await ensureAutoFeaturedCombos(event);
  combos = await prisma.featuredCombo.findMany({ where: { eventId, active: true }, orderBy: { createdAt: "desc" } });
  if (!combos.length) return [];

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
