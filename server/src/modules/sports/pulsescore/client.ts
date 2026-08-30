import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { Errors } from "../../../lib/errors";
import type { LiveEvent, LiveOdds, Sport } from "../types";

/**
 * Pulsescore REST client — reescrito do zero (2026-08-27), a pedido explícito do utilizador,
 * depois de uma sequência de bugs reais expostos pela migração de bookmaker (paddypower →
 * onexbet). Ver docs/SPORTS_DATA.md para o histórico da descoberta destes factos.
 *
 * FACTOS CONFIRMADOS (nunca inventados — cada um veio de uma amostra real de produção):
 *   - Base: https://api.pulsescore.net/api, auth via header "x-secret" (não query param).
 *   - Path: /{bookmaker}/{sport}/... — bet365 é a ÚNICA exceção, versionada (/v3/bet365/...).
 *   - Endpoints usados: /leagues, /leagues/{name}/events, /events, /events/{id},
 *     /live-events/sports, /live-events, /live-events/events/{id}.
 *   - Evento: {sport, league, eventId, home, away, live, startTime?, country?, markets[],
 *     matchClock?, statistics?, score?, moreInfo?}.
 *   - matchClock: futebol {minute, second, period:"1H"/"2H"}; ténis só {period:"Set 2"}, sem
 *     minute/second.
 *   - score: {home, away} como STRINGS — em ténis são os pontos do jogo atual (ex: "40"/"15"),
 *     MAS a onexbet manda aqui um valor numérico ambíguo (provavelmente sets ganhos) sempre que
 *     existe; moreInfo.gamePoints é o único campo cujo NOME já garante ser os pontos do jogo
 *     atual, por isso tem sempre prioridade em ténis (ver parseScoreForSport abaixo).
 *   - statistics.football: {home,away}: {yellowCards, redCards, corners} — só futebol.
 *   - statistics.sets: {home:number[], away:number[], homeServe?} — jogos por sets (ténis,
 *     voleibol): jogos ganhos por set já fechado.
 *   - markets[]: {canonicalMarket, rawName, period, isActive, marketId, selections[], line?}.
 *   - selections[]: {rawName, name?/canonicalOutcome?, odds, isActive, line?}. O nome mais
 *     amigável (`name`/`canonicalOutcome`) vai para `canonicalName` — usado pelo frontend
 *     (web/app.js) para reconhecer jogador/equipa quando `rawName` vem truncado/abreviado.
 *   - "MATCH_RESULT" é o canonicalMarket do 1X2/moneyline principal.
 *   - Seleções/mercados inativos (isActive:false) NUNCA são descartados — passam para o
 *     frontend mostrar suspenso, em vez de desaparecer silenciosamente.
 */

export const SPORT_SLUGS: Record<Sport, string> = {
  football: "soccer",
  tennis: "tennis",
  basketball: "basketball",
  ice_hockey: "ice_hockey",
  baseball: "baseball",
  volleyball: "volleyball",
  formula1: "formula-1",
  mma: "mma",
};

export const SLUG_TO_SPORT: Partial<Record<string, Sport>> = Object.fromEntries(
  (Object.entries(SPORT_SLUGS) as [Sport, string][]).map(([sport, slug]) => [slug, sport])
);

// Todos os desportos usam a bookmaker primária global (env.PULSESCORE_BOOKMAKER, "onexbet") —
// sem desvios por desporto neste momento. "unibetau" (usado antes só para Fórmula 1) devolvia
// 401 "User is not authorized" para esta conta (confirmado nos logs do Railway) — não era falta
// de jogos, era falta de acesso à própria bookmaker, por isso não faz sentido manter o desvio.
export function bookmakerFor(_sport: Sport): string {
  return env.PULSESCORE_BOOKMAKER;
}

// bet365 é a única bookmaker com caminho versionado (/api/v3/bet365/...); todas as outras
// (incluindo a atual, "onexbet") são /api/{bookmaker}/...
function bookmakerPathSegment(bookmaker: string): string {
  return bookmaker === "bet365" ? "v3/bet365" : bookmaker;
}

function assertConfigured() {
  if (!env.PULSESCORE_API_KEY) {
    throw Errors.badRequest("Dados de desporto reais indisponíveis: PULSESCORE_API_KEY não configurada neste ambiente.");
  }
}

async function pulsescoreGet<T>(path: string, context: Record<string, unknown>): Promise<{ ok: true; body: T } | { ok: false; status: number }> {
  assertConfigured();
  const url = `${env.PULSESCORE_REST_URL}/${path}`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (!res.ok) {
    if (res.status !== 404) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, ...context, body: body.slice(0, 300) }, "Pulsescore: pedido falhou");
    }
    return { ok: false, status: res.status };
  }
  return { ok: true, body: (await res.json()) as T };
}

// ============================== Formas cruas da API (Pulsescore) ==============================

interface PulsescoreSelection {
  canonicalOutcome?: string;
  name?: string;
  rawName: string;
  odds: number;
  isActive: boolean;
  line?: number;
}
interface PulsescoreMarket {
  canonicalMarket: string;
  rawName: string;
  period: string;
  isActive: boolean;
  marketId: string;
  selections: PulsescoreSelection[];
  line?: number;
}
interface PulsescoreMatchClock {
  minute?: number;
  second?: number;
  period?: string; // futebol: "1H"/"2H"; ténis: "Set 2"
}
interface PulsescoreTeamStatistics {
  yellowCards?: number;
  redCards?: number;
  corners?: number;
}
interface PulsescoreSetsStatistics {
  home: number[];
  away: number[];
  homeServe?: boolean;
}
interface PulsescoreStatistics {
  football?: { home: PulsescoreTeamStatistics; away: PulsescoreTeamStatistics };
  sets?: PulsescoreSetsStatistics;
}
interface PulsescoreScore {
  home: string;
  away: string;
}
interface PulsescoreEvent {
  sport: string;
  league: string;
  eventId: string;
  home: string;
  away: string;
  live: boolean;
  startTime?: string;
  markets: PulsescoreMarket[];
  country?: string;
  matchClock?: PulsescoreMatchClock;
  statistics?: PulsescoreStatistics;
  score?: PulsescoreScore;
  moreInfo?: { gamePoints?: string | number | { home?: string | number; away?: string | number } };
}
interface PulsescoreLeague {
  name: string;
  sport: string;
  events: PulsescoreEvent[];
}
interface PaginatedResponse {
  hasNextPage?: boolean;
  leagues?: PulsescoreLeague[];
  events?: PulsescoreEvent[];
}

// Descarta entradas promocionais/lixo (ex: "Football Boosts", vistas misturadas com jogos reais
// numa amostra de /{sport}/events) — não são um confronto real.
function isRealMatch(e: PulsescoreEvent): boolean {
  return typeof e.home === "string" && e.home.trim() !== "" && typeof e.away === "string" && e.away.trim() !== "";
}

function extractEvents(data: unknown): PulsescoreEvent[] {
  let events: PulsescoreEvent[] = [];
  if (Array.isArray(data)) events = data as PulsescoreEvent[];
  else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.events)) events = obj.events as PulsescoreEvent[];
    else if (obj.league && typeof obj.league === "object" && Array.isArray((obj.league as Record<string, unknown>).events)) {
      events = (obj.league as Record<string, unknown>).events as PulsescoreEvent[];
    }
  }
  return events.filter(isRealMatch);
}

function extractSingleEvent(data: unknown): PulsescoreEvent | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.eventId === "string") return obj as unknown as PulsescoreEvent;
  if (obj.event && typeof obj.event === "object") return obj.event as PulsescoreEvent;
  return null;
}

// ============================== Normalização para o contrato LiveEvent/LiveOdds ==============================

// ⚠️ Ténis: o campo genérico `score` é ambíguo (pode ser sets ganhos, não os pontos do jogo
// atual) — moreInfo.gamePoints é o único campo cujo NOME já garante ser os pontos do jogo atual
// (0/15/30/40/AD), por isso tem sempre prioridade quando existir. Bug real corrigido: com a
// onexbet, `score` vem sempre um valor numérico válido para ténis (ao contrário da paddypower,
// que costumava vir ausente), fazendo o placar mostrar "1-0" (sets) em vez dos pontos do jogo.
function parseTennisGamePoints(moreInfo: PulsescoreEvent["moreInfo"]): { homeScore?: number | string; awayScore?: number | string } {
  const gp = moreInfo?.gamePoints;
  if (gp == null) return {};
  if (typeof gp === "string" || typeof gp === "number") {
    const [homeRaw, awayRaw] = String(gp).split(":").map((p) => p.trim());
    if (!homeRaw || !awayRaw) return {};
    return {
      homeScore: Number.isNaN(Number(homeRaw)) ? homeRaw : Number(homeRaw),
      awayScore: Number.isNaN(Number(awayRaw)) ? awayRaw : Number(awayRaw),
    };
  }
  if (gp.home == null || gp.away == null) return {};
  return { homeScore: gp.home, awayScore: gp.away };
}

function parseScoreForSport(sport: Sport, score: PulsescoreScore | undefined, moreInfo: PulsescoreEvent["moreInfo"]): { homeScore?: number | string; awayScore?: number | string } {
  if (sport === "tennis") {
    const points = parseTennisGamePoints(moreInfo);
    if (points.homeScore !== undefined && points.awayScore !== undefined) return points;
  }
  if (!score || score.home == null || score.away == null) return sport === "tennis" ? parseTennisGamePoints(moreInfo) : {};
  const h = Number(score.home);
  const a = Number(score.away);
  if (Number.isNaN(h) || Number.isNaN(a)) return { homeScore: score.home, awayScore: score.away }; // ex: ténis em vantagem ("AD")
  return { homeScore: h, awayScore: a };
}

// Futebol: {minute, second, period} -> "90'". Ténis (sem minute/second): {period: "Set 2"} ->
// "Set 2". Sem nenhum dos dois, cai no fallback ("AO VIVO"/"") — o frontend destaca esse caso a
// vermelho (ver clock-missing em web/app.js) em vez de inventar um relógio.
function formatMatchClock(clock: PulsescoreMatchClock | undefined, fallback: string): string {
  if (!clock) return fallback;
  if (typeof clock.minute === "number") return `${clock.minute}'`;
  if (typeof clock.period === "string" && clock.period.trim() !== "") return clock.period;
  return fallback;
}

function mapStatistics(stats: PulsescoreStatistics | undefined) {
  if (!stats?.football && !stats?.sets) return undefined;
  return {
    home: stats?.football?.home ?? {},
    away: stats?.football?.away ?? {},
    sets: stats?.sets ? { home: stats.sets.home, away: stats.sets.away, homeServe: stats.sets.homeServe } : undefined,
  };
}

// "MATCH_RESULT" é o canonicalMarket do 1X2/moneyline principal — move-o para o topo da lista
// de mercados quando presente, para o cartão/pré-visualização (que só lê odds[0]) mostrar o
// mercado certo em vez de um qualquer. Sem mercado principal reconhecido, evita pôr por acidente
// um mercado com "Empate" em primeiro quando nenhum outro sinal existe (ex: beisebol nunca
// empata, um "Empate" ali é sempre de um mercado secundário tipo handicap).
const PRIMARY_MARKET_NAMES = new Set(["match_result", "match_winner", "1x2"]);

type MarketLike = { canonicalMarket?: string; rawName?: string; period?: string; selections?: { canonicalOutcome?: string; rawName?: string }[] };

function hasTieSelection(selections: MarketLike["selections"]): boolean {
  return (selections ?? []).some((s) => s.canonicalOutcome === "DRAW" || /\btie\b|empate/i.test(s.rawName ?? ""));
}

// Exportadas (genéricas em T): tanto o REST (PulsescoreMarket) como o WebSocket (WsMarket, ver
// wsClient.ts) partilham esta lógica de ordenação — a forma bruta difere, mas a decisão de qual
// mercado é "o principal" e como agrupar linhas numéricas é a mesma nos dois caminhos.
export function orderMarketsWithPrimaryFirst<T extends MarketLike>(markets: T[]): T[] {
  const primaryIdx = markets.findIndex((m) => m.canonicalMarket && PRIMARY_MARKET_NAMES.has(m.canonicalMarket.toLowerCase()));
  if (primaryIdx > 0) {
    const ordered = [...markets];
    const [primary] = ordered.splice(primaryIdx, 1);
    ordered.unshift(primary!);
    return ordered;
  }
  if (primaryIdx === 0) return markets;
  const withoutTie = markets.filter((m) => !hasTieSelection(m.selections));
  const withTie = markets.filter((m) => hasTieSelection(m.selections));
  return withoutTie.length ? [...withoutTie, ...withTie] : markets;
}

// Ténis: prioriza o mercado principal de tempo inteiro sobre variantes de período/linhas
// secundárias (total de games, handicap de games) — sem isto, um mercado de 1º set podia ficar
// à frente do "Vencedor" do jogo inteiro.
function isFullTimePeriod(period?: string): boolean {
  const normalized = String(period ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "" || normalized === "full_time" || normalized === "fulltime" || normalized === "ft";
}
function tennisMarketPriority(market: MarketLike): number {
  const canonical = String(market.canonicalMarket ?? "").trim().toLowerCase();
  const fullTimeBonus = isFullTimePeriod(market.period) ? 100 : 0;
  if (PRIMARY_MARKET_NAMES.has(canonical)) return fullTimeBonus + 30;
  if (canonical === "total_games") return fullTimeBonus + 20;
  if (canonical === "game_handicap") return fullTimeBonus + 10;
  return fullTimeBonus;
}

export function orderMarketsForSport<T extends MarketLike>(sport: Sport, markets: T[]): T[] {
  if (sport !== "tennis") return orderMarketsWithPrimaryFirst(markets);
  return markets
    .map((market, index) => ({ market, index }))
    .sort((a, b) => tennisMarketPriority(b.market) - tennisMarketPriority(a.market) || a.index - b.index)
    .map(({ market }) => market);
}

// A ordem de uma "família" de mercados (a mesma linha de Mais/Menos repetida para vários
// valores) vinda da bookmaker é arbitrária — agrupa mercados com o mesmo nome (número removido)
// e ordena cada grupo pelo número ascendente, mantendo a posição do grupo onde apareceu primeiro.
function extractMarketLine(name: string): number | null {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ? parseFloat(m[1]) : null;
}
export function sortNumericMarketFamilies<T extends { rawName?: string; canonicalMarket?: string }>(markets: T[]): T[] {
  const baseNameOf = (name: string) => name.replace(/\d+(?:\.\d+)?/, "").trim();
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const m of markets) {
    const base = baseNameOf(m.rawName ?? m.canonicalMarket ?? "");
    if (!groups.has(base)) {
      groups.set(base, []);
      order.push(base);
    }
    groups.get(base)!.push(m);
  }
  const result: T[] = [];
  for (const base of order) {
    const group = groups.get(base)!;
    if (group.length > 1) {
      group.sort((a, b) => {
        const la = extractMarketLine(a.rawName ?? "");
        const lb = extractMarketLine(b.rawName ?? "");
        return la === null || lb === null ? 0 : la - lb;
      });
    }
    result.push(...group);
  }
  return result;
}

function normalizeMarket(m: PulsescoreMarket, bookmakerSlug: string): LiveOdds {
  return {
    market: m.rawName,
    isActive: m.isActive,
    canonicalMarket: m.canonicalMarket,
    period: m.period,
    line: m.line,
    sourceBookmaker: bookmakerSlug,
    selections: Object.fromEntries(
      m.selections.map((s) => [
        s.rawName,
        { odd: s.odds, isActive: s.isActive, canonicalName: s.name ?? s.canonicalOutcome, sourceBookmaker: bookmakerSlug },
      ])
    ),
  };
}

function normalizeEvent(e: PulsescoreEvent, sport: Sport, bookmakerSlug?: string): LiveEvent {
  const bm = bookmakerSlug ?? bookmakerFor(sport);
  const orderedMarkets = sortNumericMarketFamilies(orderMarketsForSport(sport, e.markets ?? []));
  return {
    id: `pulsescore:${e.eventId}`,
    sport,
    league: e.league,
    home: e.home,
    away: e.away,
    ...parseScoreForSport(sport, e.score, e.moreInfo),
    minuteOrPeriod: formatMatchClock(e.matchClock, e.live ? "AO VIVO" : ""),
    status: e.live ? "live" : "scheduled",
    odds: orderedMarkets.map((m) => normalizeMarket(m, bm)),
    updatedAt: new Date().toISOString(),
    source: "pulsescore",
    startTime: e.startTime,
    country: e.country,
    statistics: mapStatistics(e.statistics),
  };
}

// ============================== Endpoints públicos ==============================

export async function fetchEvents(sport: Sport, opts: { maxPages?: number; limit?: number } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 3;
  const limit = opts.limit ?? 25;
  const slug = SPORT_SLUGS[sport];
  const events: LiveEvent[] = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await pulsescoreGet<PaginatedResponse>(`${bookmakerPathSegment(bookmakerFor(sport))}/${slug}/leagues?page=${page}&limit=${limit}`, { sport, page });
    if (!res.ok) break;
    for (const league of res.body.leagues ?? []) {
      for (const evt of league.events.filter(isRealMatch)) events.push(normalizeEvent(evt, sport));
    }
    if (!res.body.hasNextPage) break;
    page += 1;
  }
  return events;
}

export async function fetchLeagueEvents(sport: Sport, leagueName: string): Promise<LiveEvent[]> {
  const slug = SPORT_SLUGS[sport];
  const res = await pulsescoreGet<unknown>(`${bookmakerPathSegment(bookmakerFor(sport))}/${slug}/leagues/${encodeURIComponent(leagueName)}/events`, { sport, leagueName });
  if (!res.ok) return [];
  return extractEvents(res.body).map((evt) => normalizeEvent(evt, sport));
}

export async function fetchEventsFlat(sport: Sport, opts: { maxPages?: number; limit?: number; bookmaker?: string } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 3;
  const limit = opts.limit ?? 25;
  const slug = SPORT_SLUGS[sport];
  const bm = opts.bookmaker ?? bookmakerFor(sport);
  const events: LiveEvent[] = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await pulsescoreGet<PaginatedResponse>(`${bookmakerPathSegment(bm)}/${slug}/events?page=${page}&limit=${limit}`, { sport, page, bookmaker: bm });
    if (!res.ok) break;
    events.push(...extractEvents(res.body).map((evt) => normalizeEvent(evt, sport, opts.bookmaker)));
    if (!res.body.hasNextPage) break;
    page += 1;
  }
  return events;
}

export async function fetchEventById(sport: Sport, eventId: string): Promise<LiveEvent | null> {
  const slug = SPORT_SLUGS[sport];
  const res = await pulsescoreGet<unknown>(`${bookmakerPathSegment(bookmakerFor(sport))}/${slug}/events/${encodeURIComponent(eventId)}`, { sport, eventId });
  if (!res.ok) return null;
  const raw = extractSingleEvent(res.body);
  return raw ? normalizeEvent(raw, sport) : null;
}

interface PulsescoreLiveSportsSummary {
  sports: Array<{ name: string; eventCount: number }>;
}

async function fetchLiveSportsWithCounts(bookmaker?: string): Promise<Array<{ sport: Sport; eventCount: number }>> {
  const resolvedBookmaker = bookmaker ?? env.PULSESCORE_BOOKMAKER;
  const res = await pulsescoreGet<PulsescoreLiveSportsSummary>(`${bookmakerPathSegment(resolvedBookmaker)}/live-events/sports`, { bookmaker: resolvedBookmaker });
  if (!res.ok) return [];
  return res.body.sports
    .filter((s) => s.eventCount > 0 && SLUG_TO_SPORT[s.name])
    .map((s) => ({ sport: SLUG_TO_SPORT[s.name]!, eventCount: s.eventCount }))
    .sort((a, b) => b.eventCount - a.eventCount);
}

// Ordenado por eventCount (desc), NUNCA pela ordem em que a Pulsescore lista os desportos (que é
// fixa/alfabética do catálogo deles, não "quão movimentado está agora") — wsClient.ts corta esta
// lista às primeiras `maxConnections` vagas de WebSocket, por isso a ordem aqui decide a que
// desportos o WS liga.
export async function fetchLiveSportsWithEvents(bookmaker?: string): Promise<Sport[]> {
  const withCounts = await fetchLiveSportsWithCounts(bookmaker);
  return withCounts.map((s) => s.sport);
}

export async function fetchLiveEvents(sport: Sport, opts: { maxPages?: number; limit?: number; bookmaker?: string } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 2;
  const limit = opts.limit ?? 25;
  const slug = SPORT_SLUGS[sport];
  const bm = opts.bookmaker ?? bookmakerFor(sport);
  const events: LiveEvent[] = [];
  let page = 1;
  while (page <= maxPages) {
    const res = await pulsescoreGet<PaginatedResponse>(`${bookmakerPathSegment(bm)}/live-events?page=${page}&limit=${limit}&sport=${slug}`, { sport, page, bookmaker: bm });
    if (!res.ok) break;
    events.push(...extractEvents(res.body).map((evt) => normalizeEvent({ ...evt, live: true }, sport, opts.bookmaker)));
    if (!res.body.hasNextPage) break;
    page += 1;
  }
  return events;
}

export async function fetchLiveEventById(eventId: string, sport?: Sport): Promise<LiveEvent | null> {
  const resolvedBookmaker = sport ? bookmakerFor(sport) : env.PULSESCORE_BOOKMAKER;
  const res = await pulsescoreGet<unknown>(`${bookmakerPathSegment(resolvedBookmaker)}/live-events/events/${encodeURIComponent(eventId)}`, { eventId, bookmaker: resolvedBookmaker });
  if (!res.ok) return null;
  const raw = extractSingleEvent(res.body);
  if (!raw) return null;
  const detectedSport = SLUG_TO_SPORT[raw.sport];
  if (!detectedSport) {
    logger.warn({ rawSport: raw.sport, eventId }, "Pulsescore: live-events/events devolveu um sport não reconhecido");
    return null;
  }
  return normalizeEvent({ ...raw, live: true }, detectedSport, resolvedBookmaker);
}
