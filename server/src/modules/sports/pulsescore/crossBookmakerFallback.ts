import { logger } from "../../../lib/logger";
import { calculateTeamSimilarity } from "../mapping/normalize";
import type { LiveEvent, LiveOdds, LiveStatistics, LiveTeamStats, Sport } from "../types";
import { SPORT_SLUGS, bookmakerFor, fetchEventsFlat, fetchLiveEvents } from "./client";
import { MARKET_ROUTING, MARKET_ROUTING_BOOKMAKERS, VALID_SPORTS_BY_ROUTING_ID, classifyRoutingMarket, pulsescoreSlugForRoutingId, type RoutingMarketKey } from "./marketRouting";

/**
 * Preenche mercados E estatísticas em falta na bookmaker principal do evento indo buscá-los a
 * outras bookmakers — pedido explícito do utilizador ("se não temos marcador e escanteio e nem
 * cartão, alguma dessas outras casas tem, aí ela vem e preenche... também estatísticas se algum
 * modelo de estatística [estiver em falta]"). Algoritmo de mercados exatamente como especificado:
 *
 *   PARA CADA mercado em falta:
 *     PARA CADA bookmaker da lista de preferência desse mercado, pela ordem:
 *       procurar essa bookmaker, procurar o MESMO evento nela, procurar esse mercado,
 *       verificar period/line/selections/odd válida
 *       SE encontrou: usar esse mercado, PARAR (não continua a percorrer a lista)
 *     SE nenhuma bookmaker tinha: mercado continua indisponível (não inventado)
 *
 * Estatísticas (`event.statistics.home/away.{yellowCards,redCards,corners}`) seguem a mesma
 * lógica campo a campo — só futebol, único desporto onde este projeto já confirmou a Pulsescore
 * a enviar estes campos (ver `mapStatistics()` em client.ts: só populado quando o payload bruto
 * tem uma chave `football` ou `sets` — basquetebol/hóquei/beisebol/MMA/Fórmula 1 nunca os têm em
 * nenhuma amostra real vista até agora, por isso nem se tenta para esses, para não gastar pedidos
 * à toa). `sets` (ténis/voleibol) fica sempre de fora deste preenchimento: tem de estar
 * sincronizado com o placar ao vivo exibido, e misturar um snapshot de outra bookmaker (com o seu
 * próprio atraso/ciclo de sondagem) arriscava mostrar sets inconsistentes com o placar principal.
 *
 * NUNCA duplica um mercado que a bookmaker principal já tem, nem sobrescreve um campo de
 * estatística que ela já trouxe — só entra o que estava mesmo em falta. Nunca bloqueia a resposta
 * ao utilizador por uma bookmaker lenta/em baixo — qualquer falha (404, rede, forma de resposta
 * inesperada) só avança para a próxima da lista, mesmo tratamento defensivo já usado no resto do
 * client.ts.
 *
 * Só é chamado sob pedido (quando o utilizador abre o Match Tracker de um evento, ver
 * routes.ts::/events/:id/refresh) — nunca durante o polling em massa de hybridService.ts, que
 * teria de repetir isto para todos os eventos ao vivo a cada ciclo (custo de pedidos multiplicado
 * por até 30x o normal, ver docs/SPORTS_DATA.md).
 */

const CACHE_TTL_MS = 60_000;
// Duas proteções de custo distintas: um mercado/estatística sem cobertura em lado nenhum não
// pode gastar sozinho o orçamento todo (MAX_BOOKMAKERS_TRIED_PER_ITEM, aplicado individualmente
// a cada mercado/campo em falta) — sem isto, um mercado muito específico (ex: "assists", com
// poucas bookmakers reais a cobri-lo) com uma lista de preferência longa podia consumir o
// orçamento inteiro antes de sequer chegar a "Escanteios"/"Cartões"/"Marcador", que é exatamente
// o que o utilizador pediu para nunca faltar. MAX_BOOKMAKER_FETCHES_PER_CALL é só a rede de
// segurança global (raramente atingida na prática — a cache por bookmaker, abaixo, faz cada
// bookmaker distinta ser pedida no máximo uma vez por chamada, e a maioria das listas de
// preferência partilha as mesmas bookmakers populares entre si).
const MAX_BOOKMAKERS_TRIED_PER_ITEM = 6;
const MAX_BOOKMAKER_FETCHES_PER_CALL = 30; // = tamanho de MARKET_ROUTING_BOOKMAKERS — pior caso,
// tenta cada bookmaker distinta no máximo uma vez por chamada (a cache trata do resto).
const MIN_TEAM_SIMILARITY = 0.72; // mesmo patamar de confiança usado no motor de mapeamento
// (teamMatcher.ts::MIN_CONFIDENCE_TO_LINK=70%) — abaixo disto, risco real de juntar dados de um
// jogo diferente, o que é pior do que simplesmente não preencher o mercado/estatística.
const KICKOFF_TOLERANCE_MS = 20 * 60_000; // pré-jogo: bookmakers por vezes divergem alguns
// minutos no horário exato — 20 min cobre isso sem arriscar casar jogos diferentes no mesmo dia.

interface BookmakerEventsCacheEntry {
  expiresAt: number;
  promise: Promise<LiveEvent[]>;
}
const bookmakerEventsCache = new Map<string, BookmakerEventsCacheEntry>();

function fetchBookmakerEvents(sport: Sport, slug: string, isLive: boolean): Promise<LiveEvent[]> {
  const cacheKey = `${sport}|${slug}|${isLive ? "live" : "prematch"}`;
  const cached = bookmakerEventsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  // Uma falha aqui (404, bookmaker em baixo, sport não coberto por ela) fica em cache como []
  // durante o mesmo TTL de um sucesso — de propósito: sem isto, cada mercado/estatística em
  // falta que partilhe esta bookmaker na sua lista de preferência voltaria a pedir-lhe o mesmo
  // evento inexistente vezes sem conta dentro da mesma chamada (e outra vez em cada refresh
  // seguinte do utilizador), anulando o propósito da cache. Mesma filosofia já usada em
  // teamMatcher.ts para "sem correspondência" — só que aqui com TTL, não permanente, porque uma
  // bookmaker pode passar a cobrir um evento entretanto (ex: mercados que só abrem mais perto do
  // jogo, ou estatísticas que só chegam depois do apito inicial).
  const promise = (isLive ? fetchLiveEvents(sport, { maxPages: 1, limit: 50, bookmaker: slug }) : fetchEventsFlat(sport, { maxPages: 1, limit: 50, bookmaker: slug })).catch((err) => {
    logger.info({ err, sport, slug, isLive }, "[FALLBACK] bookmaker sem resposta válida — a saltar para a próxima da lista");
    return [];
  });
  bookmakerEventsCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  return promise;
}

/** Confiança de que `candidate` é o MESMO confronto real que `target`, noutra bookmaker. */
function matchesSameFixture(target: LiveEvent, candidate: LiveEvent): boolean {
  const homeSim = calculateTeamSimilarity(target.home, candidate.home);
  const awaySim = calculateTeamSimilarity(target.away, candidate.away);
  if (homeSim < MIN_TEAM_SIMILARITY || awaySim < MIN_TEAM_SIMILARITY) return false;

  if (target.status === "live") return candidate.status === "live";

  // Pré-jogo: exige horários de kickoff próximos, quando ambos os lados o têm — sem startTime
  // de um dos lados, cai só na confiança do nome das equipas (já exigente, ver MIN_TEAM_SIMILARITY).
  if (target.startTime && candidate.startTime) {
    const diff = Math.abs(new Date(target.startTime).getTime() - new Date(candidate.startTime).getTime());
    if (diff > KICKOFF_TOLERANCE_MS) return false;
  }
  return true;
}

function findValidMarket(event: LiveEvent, key: RoutingMarketKey): LiveOdds | null {
  for (const odds of event.odds) {
    if (classifyRoutingMarket(odds.market) !== key) continue;
    const entries = Object.entries(odds.selections ?? {});
    const hasValidSelection = entries.some(([, sel]) => sel.isActive && Number.isFinite(sel.odd));
    if (entries.length > 0 && hasValidSelection) return odds;
  }
  return null;
}

/** Estado partilhado entre o preenchimento de mercados e de estatísticas numa só chamada — a
 * mesma bookmaker já pedida para um mercado não volta a ser pedida para uma estatística, e
 * vice-versa (mesma cache, mesmo orçamento). */
interface FallbackSession {
  isLive: boolean;
  primarySlug: string;
  bookmakerFetchBudget: number;
  matchedEventCache: Map<string, LiveEvent | null>; // slug -> jogo já encontrado (ou null = já se tentou e não achou)
}

async function getMatchedEvent(sport: Sport, event: LiveEvent, session: FallbackSession, routingId: string): Promise<LiveEvent | null> {
  const slug = pulsescoreSlugForRoutingId(routingId);
  if (slug === session.primarySlug) return null; // já verificado — é de lá que `event` veio
  if (session.matchedEventCache.has(slug)) return session.matchedEventCache.get(slug)!;

  // GUARD: se esta bookmaker NÃO cobre o desporto (tabela docs "Valid Sports per Bookmaker"),
  // salta imediatamente sem gastar orçamento/pedido REST — garantidamente 0 eventos.
  const psSport = SPORT_SLUGS[sport];
  const coveredSports = VALID_SPORTS_BY_ROUTING_ID[routingId];
  if (coveredSports && !coveredSports.has(psSport)) {
    session.matchedEventCache.set(slug, null);
    return null;
  }

  if (session.bookmakerFetchBudget <= 0) return null;

  session.bookmakerFetchBudget -= 1;
  const candidates = await fetchBookmakerEvents(sport, slug, session.isLive);
  const matched = candidates.find((c) => matchesSameFixture(event, c)) ?? null;
  session.matchedEventCache.set(slug, matched);
  return matched;
}

async function fillMissingMarketsInto(sport: Sport, event: LiveEvent, session: FallbackSession): Promise<LiveOdds[]> {
  const existingKeys = new Set(event.odds.map((o) => classifyRoutingMarket(o.market)).filter((k): k is RoutingMarketKey => k !== null));
  const missingKeys = (Object.keys(MARKET_ROUTING) as RoutingMarketKey[]).filter((k) => !existingKeys.has(k));
  const filled: LiveOdds[] = [];

  for (const key of missingKeys) {
    if (session.bookmakerFetchBudget <= 0) break;
    let triedNewFetches = 0;

    for (const routingId of MARKET_ROUTING[key] ?? []) {
      if (session.bookmakerFetchBudget <= 0 || triedNewFetches >= MAX_BOOKMAKERS_TRIED_PER_ITEM) break;
      const alreadyCached = session.matchedEventCache.has(pulsescoreSlugForRoutingId(routingId));
      const matched = await getMatchedEvent(sport, event, session, routingId);
      if (!alreadyCached) triedNewFetches += 1; // só conta tentativas que gastaram um pedido novo
      if (!matched) continue;

      const market = findValidMarket(matched, key);
      if (!market) continue;

      market.sourceBookmaker = routingId;
      for (const sel of Object.values(market.selections ?? {})) {
        sel.sourceBookmaker = routingId;
      }
      filled.push(market);
      logger.info({ eventId: event.id, market: key, bookmaker: routingId }, "[FALLBACK] mercado preenchido por outra bookmaker");
      break; // achou nesta bookmaker — para de percorrer a lista deste mercado
    }
  }

  return filled;
}

// Só futebol tem `statistics.home/away.{yellowCards,redCards,corners}` confirmado em amostras
// reais de mais do que uma bookmaker — ver comentário no topo do ficheiro.
const STATS_FALLBACK_SPORTS = new Set<Sport>(["football"]);
const STAT_FIELDS: (keyof LiveTeamStats)[] = ["yellowCards", "redCards", "corners"];

async function fillMissingStatisticsInto(sport: Sport, event: LiveEvent, session: FallbackSession): Promise<LiveStatistics | undefined> {
  if (!STATS_FALLBACK_SPORTS.has(sport)) return undefined;

  const missingFields: { side: "home" | "away"; field: keyof LiveTeamStats }[] = [];
  for (const side of ["home", "away"] as const) {
    for (const field of STAT_FIELDS) {
      if (event.statistics?.[side]?.[field] === undefined) missingFields.push({ side, field });
    }
  }
  if (!missingFields.length) return undefined;

  const patch: LiveStatistics = {
    home: { ...event.statistics?.home },
    away: { ...event.statistics?.away },
    sets: event.statistics?.sets, // nunca preenchido por fallback — ver nota no topo do ficheiro
  };
  let anyFilled = false;
  let triedNewFetches = 0;

  for (const routingId of MARKET_ROUTING_BOOKMAKERS) {
    if (session.bookmakerFetchBudget <= 0 || triedNewFetches >= MAX_BOOKMAKERS_TRIED_PER_ITEM) break;
    if (!missingFields.some(({ side, field }) => patch[side][field] === undefined)) break; // já tudo preenchido

    const alreadyCached = session.matchedEventCache.has(pulsescoreSlugForRoutingId(routingId));
    const matched = await getMatchedEvent(sport, event, session, routingId);
    if (!alreadyCached) triedNewFetches += 1;
    if (!matched?.statistics) continue;

    for (const { side, field } of missingFields) {
      if (patch[side][field] !== undefined) continue;
      const value = matched.statistics[side]?.[field];
      if (typeof value === "number") {
        patch[side][field] = value;
        anyFilled = true;
      }
    }
  }

  if (anyFilled) logger.info({ eventId: event.id }, "[FALLBACK] estatísticas preenchidas por outra bookmaker");
  return anyFilled ? patch : undefined;
}

export async function enrichEventFromOtherBookmakers(sport: Sport, event: LiveEvent): Promise<LiveEvent> {
  const session: FallbackSession = {
    isLive: event.status === "live",
    primarySlug: bookmakerFor(sport), // varia por desporto (SPORT_BOOKMAKER_OVERRIDE em client.ts)
    bookmakerFetchBudget: MAX_BOOKMAKER_FETCHES_PER_CALL,
    matchedEventCache: new Map(),
  };

  const filledMarkets = await fillMissingMarketsInto(sport, event, session);
  const filledStatistics = await fillMissingStatisticsInto(sport, event, session);

  if (!filledMarkets.length && !filledStatistics) return event;
  return {
    ...event,
    odds: filledMarkets.length ? [...event.odds, ...filledMarkets] : event.odds,
    statistics: filledStatistics ?? event.statistics,
  };
}
