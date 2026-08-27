import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import { Errors } from "../../../lib/errors";
import type { LiveEvent, LiveOdds, Sport } from "../types";

/**
 * Pulsescore REST client — odds aggregator, confirmed against a real sample request/response
 * the user provided during this build:
 *
 *   GET https://api.pulsescore.net/api/10bet/soccer/leagues?page=1&limit=5
 *   Headers: accept: * / *, x-secret: <secret>, Accept-Encoding: gzip
 *
 * Confirmed facts (from that sample, not guesswork):
 *   - Base host is api.pulsescore.net (not .com as first assumed), REST — no websocket confirmed.
 *   - Auth is the "x-secret" header, not a query param.
 *   - Path shape is /{bookmaker}/{sport}/leagues — Pulsescore aggregates odds per upstream
 *     bookmaker; "10bet" was the bookmaker in the sample. A different one may exist per sport.
 *   - Paginated: ?page=&limit=, response has total/page/limit/totalPages/hasNextPage/hasPrevPage.
 *   - Response: { leagues: [{ name, sport, events: [{ sport, league, eventId, home, away, live,
 *     startTime, markets: [{ canonicalMarket, rawName, period, isActive, marketId, selections: [
 *     { canonicalOutcome, rawName, odds, isActive, selectionId, line?, metadata? } ] }] }] }] }
 *   - Each event carries a `live` boolean — that's what separates pré-jogo from ao vivo, not a
 *     separate endpoint or query flag (nothing in the sample suggests one, so we don't guess it).
 *
 * A second endpoint was also confirmed (request only, response not seen):
 *
 *   GET https://api.pulsescore.net/api/10bet/soccer/leagues/{leagueName}/events
 *
 * Fetches events for one named league directly, instead of paginating every league for a
 * sport — useful for polling a curated set of leagues cheaply. `leagueName` is the same
 * string as `league.name` from the leagues-list response, URL-encoded (e.g. "Premier League"
 * -> "Premier%20League"). The response shape wasn't provided, so `fetchLeagueEvents()` below
 * parses defensively (accepts `{ events: [...] }`, `{ league: { events: [...] } }`, or a bare
 * array) rather than assuming one exact shape — confirm and simplify once a real response is seen.
 *
 * Two more endpoints were confirmed (requests only, responses not seen):
 *
 *   GET https://api.pulsescore.net/api/10bet/soccer/events?page=1&limit=5
 *   GET https://api.pulsescore.net/api/10bet/soccer/events/{eventId}
 *
 * The first is a flat, paginated list of events for a sport — no need to walk leagues to get
 * one. The second fetches a single event by its numeric id directly, which is the interesting
 * one: it's the natural way to refresh one event's odds/detail on demand (e.g. when a user
 * opens the Match Tracker for it) instead of relying on the last bulk poll. Implemented as
 * `fetchEventsFlat()` and `fetchEventById()` below.
 *
 * The flat /events response was later confirmed with a real body (850 total soccer events,
 * page of 5 real matches, each with 5–17 markets depending on league popularity) — shape
 * matches exactly what was assumed: `{ total, page, limit, totalPages, hasNextPage,
 * hasPrevPage, events: [...PulsescoreEvent] }`. /events/{id} (single event) is still
 * unconfirmed, parsed defensively the same way as fetchLeagueEvents().
 *
 * The same endpoints were then confirmed again under /10bet/tennis/..., /10bet/volleyball/...,
 * /10bet/mma/..., /10bet/ice-hockey/..., /10bet/basketball/... and /10bet/baseball/... — same
 * shape every time, just a different sport slug, which confirms the path is uniformly
 * /{bookmaker}/{sport}/... for any sport rather than something sport-specific. The MMA,
 * basketball and baseball samples used real league names ("UFC", "NBA", "CPBL" — Chinese
 * Professional Baseball League); the volleyball and ice-hockey ones used the literal
 * placeholder text "league name" (URL-encoded), clearly a Swagger/OpenAPI "Try it out" default
 * rather than a real league. If these curl commands are being copied from a Swagger UI,
 * hitting "Execute" there would capture the real response body, which is the one thing still
 * missing to fully confirm this integration — no response body has been provided for any
 * endpoint except the very first leagues sample.
 *
 * A genuinely separate endpoint family was then confirmed for live events specifically —
 * distinct from the sport-scoped /{sport}/leagues and /{sport}/events used above, and the
 * first one since the very first sample to come with a real response body:
 *
 *   GET https://api.pulsescore.net/api/10bet/live-events/sports
 *   -> { "total": 189, "sports": [{ "name": "soccer", "eventCount": 26 }, ...] }
 *
 *   GET https://api.pulsescore.net/api/10bet/live-events?page=1&limit=5&sport=soccer
 *   GET https://api.pulsescore.net/api/10bet/live-events/events/{eventId}
 *
 * `/live-events/sports` is a cheap way to know which sports actually have live events right
 * now (and how many), before spending a request on each one — that's the polling strategy
 * hybridService.ts uses: call this once per cycle, then only fetch `/live-events` for sports
 * that came back with eventCount > 0. Its response also revealed the correct sport name is
 * "ice_hockey" (underscore, see the SPORT_SLUGS correction above), and includes sports we
 * don't model here (badminton, cricket, darts, esports, table_tennis) which are simply
 * ignored — the mapping goes through SLUG_TO_SPORT below. Note it lists which sports have
 * live events, not fixture-by-fixture data, so `/live-events?sport=` is still needed for the
 * events themselves — its response shape (and that of `/live-events/events/{id}`, which
 * unlike the sport-scoped single-event endpoint takes no sport in the path) is not confirmed
 * yet, so both are parsed defensively the same way as fetchEventsFlat()/fetchEventById().
 *
 * UPDATE — official Pulsescore documentation obtained (docs.pulsescore.net-equivalent content
 * pasted by the user), confirming/correcting several of the points above:
 *
 *   - Multiple bookmakers exist behind the same normalized schema (10bet, bet365, fanduel,
 *     bwin, unibetau, ps3838 (Pinnacle), etc.) — same paths, same response shape, just a
 *     different {bookmaker} prefix. Bet365 is the one exception: its REST/WS paths are
 *     versioned (`/api/v3/bet365/...`); every other bookmaker (including "10bet", the one this
 *     client uses) is unversioned (`/api/{bookmaker}/...`).
 *   - CONFIRMED (per-bookmaker sport list in the docs): "10bet" does NOT offer Fórmula 1 at
 *     all, but "unibetau" does. SPORT_BOOKMAKER_OVERRIDE below routes formula1 to "unibetau"
 *     while every other sport stays on the default PULSESCORE_BOOKMAKER ("10bet"). The exact
 *     slug Fórmula 1 uses under unibetau is still a guess (`formula-1`) — not in the docs' sport
 *     list wording, which spells it "Fórmula 1" (display name, not an API slug).
 *   - A WebSocket product DOES exist (this resolves the open question below): one connection
 *     per {bookmaker, sport} pair, auth via `?key=&sport=` query params (not the x-secret
 *     header used by REST), one frame per ~second with ALL live events for that sport. See
 *     wsClient.ts. Only available on PRO/MAX/ULTRA plans (not BASIC/STARTER) — MAX (€149/mo,
 *     3 simultaneous connections) matches what was mentioned when this integration started.
 *   - The WS frame's event objects include a `score` field (e.g. `"1-0"`) that the REST
 *     `/live-events` endpoints this client already uses do NOT have (confirmed absent via two
 *     real REST samples). So real live score, when available, only comes from the WS channel —
 *     REST stays odds-only. See normalizeWsEvent() in wsClient.ts.
 *   - The docs' illustrative JSON uses a different market/selection shape than the REST
 *     responses actually seen (`canonicalMarket: "match_winner"` lowercase vs. the REST
 *     sample's `"MATCH_RESULT"` uppercase; `selections: [{name, decimal}]` vs. the REST
 *     sample's `{canonicalOutcome, rawName, odds, isActive, selectionId}`). Since docs and a
 *     real captured response disagree, both response-shape assumptions are treated as
 *     unconfirmed and parsed defensively rather than picking one as authoritative.
 *
 * MIGRAÇÃO PARA "paddypower" — o utilizador comparou amostras reais de duas bookmakers e pediu
 * a troca. Confirmado via `GET /paddypower/live-events?sport=soccer` e
 * `GET /paddypower/live-events/events/{eventId}` (ambos com corpo real, vários jogos ao vivo):
 *
 *   - **Ao contrário de "10bet", o REST de `/live-events` da paddypower já traz placar,
 *     cronómetro e estatísticas diretamente** — não é preciso WebSocket para isto. Cada evento
 *     tem `matchClock: {minute, second, period}` (ex: `{minute:90, second:0, period:"2H"}`),
 *     `score: {home, away}` (strings, ex: `{home:"1", away:"1"}` — formato DIFERENTE do
 *     `score: "H-A"` string única do frame WebSocket documentado oficialmente) e
 *     `statistics: {football: {home: {yellowCards, redCards, corners}, away: {...}}}`.
 *   - Cada evento também tem um campo `country` (código ISO de 2 letras, ex: "CO", "GB", ou ""
 *     para competições internacionais/qualificação, ex: "UEFA Champions League Qualifiers").
 *   - Os `marketId` desta bookmaker vêm no formato `"927.396482091"` (com ponto) em vez do
 *     inteiro simples da 10bet — não é usado para nada além de exibição, por isso não exige
 *     alterações de tipo.
 *   - Cobertura de mercados é bem mais rica (até 47 mercados por jogo vs. 5–17 na 10bet para os
 *     mesmos jogos), com vários `canonicalMarket` novos (`ASIAN_HANDICAP`, `WIN_TO_NIL`,
 *     `CORRECT_SCORE_COMBINATIONS`, `HALF_TIME_FULL_TIME`, `RESULT_BOTH_TEAMS_TO_SCORE`,
 *     `WINNING_MARGIN`, `CORNERS_RACE_TO`, `PLAYER_CARDS`, `ANYTIME_GOALSCORER`, etc.) — nenhum
 *     exige mudanças de código porque mercados/seleções nunca passaram por uma lista fixa.
 *   - Uma amostra de `/{sport}/events` (não live-events) trouxe uma entrada promocional/lixo
 *     ("Football Boosts", `away: ""`, `startTime` de 2017) misturada com jogos reais — filtrada
 *     defensivamente em `extractEvents()` abaixo (descarta eventos sem `home`/`away`).
 *   - `PULSESCORE_BOOKMAKER` mudou de "10bet" para "paddypower" (ver `env.ts`). Continua sem
 *     confirmação se paddypower cobre basquete/hóquei de gelo/voleibol/MMA da mesma forma — só
 *     futebol, ténis, basebol, esports e ténis de mesa foram vistos com eventos ao vivo reais
 *     até agora (`/paddypower/live-events/sports`); Fórmula 1 mantém-se em `unibetau` via
 *     `SPORT_BOOKMAKER_OVERRIDE`, já que não há evidência de que a paddypower a cubra.
 */

export const SPORT_SLUGS: Record<Sport, string> = {
  football: "soccer", // CONFIRMED
  tennis: "tennis", // CONFIRMED
  basketball: "basketball", // CONFIRMED
  // CORRECTED: was "ice-hockey" (hyphen), marked CONFIRMED from a request that worked
  // syntactically but whose response was never seen. The /live-events/sports summary (see
  // below) is a real response body and lists it as "ice_hockey" (underscore) — that's the
  // authoritative one now.
  ice_hockey: "ice_hockey", // CONFIRMED (corrected)
  baseball: "baseball", // CONFIRMED
  volleyball: "volleyball", // CONFIRMED
  formula1: "formula-1",
  mma: "mma", // CONFIRMED (also confirms MMA exists in this leagues/events shape, e.g. league "UFC")
};

export const SLUG_TO_SPORT: Partial<Record<string, Sport>> = Object.fromEntries(
  (Object.entries(SPORT_SLUGS) as [Sport, string][]).map(([sport, slug]) => [slug, sport])
);

// Configuração atual pedida pelo utilizador:
// - quase todos os desportos usam a bookmaker primária global (`onexbet`, ver env.ts)
// - futebol desvia para Sportmonks via FOOTBALL_PROVIDER=sportmonks
// - Fórmula 1 continua fora desta migração, em Unibet AU, por não haver evidência confirmada de
//   cobertura equivalente no resto da stack atual.
const SPORT_BOOKMAKER_OVERRIDE: Partial<Record<Sport, string>> = {
  formula1: "unibetau",
};

export function bookmakerFor(sport: Sport): string {
  return SPORT_BOOKMAKER_OVERRIDE[sport] ?? env.PULSESCORE_BOOKMAKER;
}

// Bet365 é a única bookmaker com caminho versionado (/api/v3/bet365/... em vez de
// /api/{bookmaker}/...) — confirmado na documentação oficial e já tratado em wsClient.ts para o
// WebSocket; em falta aqui no REST até a amostra real de beisebol expor o problema (os pedidos
// para bet365 estavam a ir para /api/bet365/... em vez de /api/v3/bet365/...).
function bookmakerPathSegment(bookmaker: string): string {
  return bookmaker === "bet365" ? "v3/bet365" : bookmaker;
}

interface PulsescoreSelection {
  canonicalOutcome?: string; // campo "name" docs Pulsescore; vindo como canonicalOutcome em amostras reais — defensivo ambos
  name?: string;             // campo "name" oficial docs Pulsescore (fallback se existir)
  rawName: string;
  odds: number;
  isActive: boolean;
  // CONFIRMED ausente numa amostra real da bet365 (usa moreInfo.ID em vez disto) — opcional em
  // vez de obrigatório; nunca foi lido por normalizeMarket() abaixo, por isso não afeta nada.
  selectionId?: string;
  line?: number;
  metadata?: Record<string, unknown>;
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
// CONFIRMED via real "paddypower" /live-events samples — absent on the earlier "10bet" samples.
// Shape differs per sport: futebol traz {minute, second, period: "1H"/"2H"}; ténis traz só
// {period: "Set 2", periodId: "2"}, sem minute/second — os dois têm de ser tratados em
// formatMatchClock() abaixo, sem assumir que `minute` está sempre presente.
interface PulsescoreMatchClock {
  minute?: number;
  second?: number;
  period?: string; // futebol: "1H"/"2H"; ténis: "Set 2"
  periodId?: string;
}
interface PulsescoreTeamStatistics {
  yellowCards?: number;
  redCards?: number;
  corners?: number;
}
// Ténis: jogos ganhos por set, um índice por set (ex: home:[6,6], away:[4,6] = 1º set 6-4,
// 2º set 6-6) — CONFIRMED numa amostra real de /paddypower/live-events?sport=tennis, forma
// própria do ténis, distinta de `football` acima.
interface PulsescoreSetsStatistics {
  home: number[];
  away: number[];
  homeServe?: boolean;
}
interface PulsescoreStatistics {
  football?: { home: PulsescoreTeamStatistics; away: PulsescoreTeamStatistics };
  sets?: PulsescoreSetsStatistics;
}
// Score as separate string fields per side — CONFIRMED shape for paddypower's REST
// /live-events, distinct from the official WS docs' single "H-A" string (see wsClient.ts).
// No ténis, home/away são os pontos do jogo atual (ex: "40"/"15") — `info` (ex: "Set 1") repete
// o mesmo período de `matchClock.period`, por isso não é reaproveitado à parte.
interface PulsescoreScore {
  home: string;
  away: string;
  info?: string;
}
interface PulsescoreEvent {
  sport: string;
  league: string;
  eventId: string;
  home: string;
  away: string;
  live: boolean;
  // CONFIRMED absent on live:true events (real /live-events samples for soccer and
  // basketball had no startTime at all) — only present on pré-jogo (live:false) events.
  startTime?: string;
  markets: PulsescoreMarket[];
  country?: string; // ISO 2-letter code, or "" for international/qualifier competitions
  matchClock?: PulsescoreMatchClock;
  statistics?: PulsescoreStatistics;
  score?: PulsescoreScore;
  moreInfo?: {
    currentPeriod?: string;
    gamePoints?: string | number | { home?: string | number; away?: string | number };
  };
}
interface PulsescoreLeague {
  name: string;
  sport: string;
  events: PulsescoreEvent[];
}
interface PulsescoreLeaguesResponse {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  leagues: PulsescoreLeague[];
}

function assertConfigured() {
  if (!env.PULSESCORE_API_KEY) {
    throw Errors.badRequest("Dados de desporto reais indisponíveis: PULSESCORE_API_KEY não configurada neste ambiente.");
  }
}

async function fetchLeaguesPage(sport: Sport, page: number, limit: number): Promise<PulsescoreLeaguesResponse> {
  assertConfigured();
  const slug = SPORT_SLUGS[sport];
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerPathSegment(bookmakerFor(sport))}/${slug}/leagues?page=${page}&limit=${limit}`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, sport, slug, body: body.slice(0, 300) }, "Pulsescore: pedido falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para o desporto "${sport}"`);
  }
  return res.json() as Promise<PulsescoreLeaguesResponse>;
}

async function fetchLeagueEventsRaw(sport: Sport, leagueName: string): Promise<unknown> {
  assertConfigured();
  const slug = SPORT_SLUGS[sport];
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerPathSegment(bookmakerFor(sport))}/${slug}/leagues/${encodeURIComponent(leagueName)}/events`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, sport, slug, leagueName, body: body.slice(0, 300) }, "Pulsescore: pedido de liga falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para a liga "${leagueName}" (${sport})`);
  }
  return res.json();
}

// Descarta entradas promocionais/lixo (ex: "Football Boosts", vistas numa amostra real de
// /{sport}/events misturadas com jogos reais) — não são um confronto real, não têm `home`/`away`
// preenchidos com nomes de equipas.
function isRealMatch(e: PulsescoreEvent): boolean {
  return typeof e.home === "string" && e.home.trim() !== "" && typeof e.away === "string" && e.away.trim() !== "";
}

/** Extracts a PulsescoreEvent[] out of whichever response shape the API actually returns. */
function extractEvents(data: unknown): PulsescoreEvent[] {
  let events: PulsescoreEvent[] = [];
  if (Array.isArray(data)) {
    events = data as PulsescoreEvent[];
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.events)) {
      events = obj.events as PulsescoreEvent[];
    } else if (obj.league && typeof obj.league === "object" && Array.isArray((obj.league as Record<string, unknown>).events)) {
      events = (obj.league as Record<string, unknown>).events as PulsescoreEvent[];
    } else {
      logger.warn({ data }, "Pulsescore: forma de resposta de /leagues/{name}/events não reconhecida — a devolver vazio");
    }
  }
  return events.filter(isRealMatch);
}

/**
 * Fetches events for one named league directly (see the NEEDS VALIDATION note above the
 * response shape parsing). Cheaper than fetchEvents() when only a handful of leagues matter.
 */
export async function fetchLeagueEvents(sport: Sport, leagueName: string): Promise<LiveEvent[]> {
  const raw = await fetchLeagueEventsRaw(sport, leagueName);
  return extractEvents(raw).map((evt) => normalizeEvent(evt, sport));
}

interface PulsescoreFlatEventsResponse {
  total?: number;
  page?: number;
  limit?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPrevPage?: boolean;
  events?: PulsescoreEvent[];
}

async function fetchEventsFlatPage(sport: Sport, page: number, limit: number, bookmaker?: string): Promise<PulsescoreFlatEventsResponse> {
  assertConfigured();
  const slug = SPORT_SLUGS[sport];
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerPathSegment(bookmaker ?? bookmakerFor(sport))}/${slug}/events?page=${page}&limit=${limit}`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, sport, slug, body: body.slice(0, 300) }, "Pulsescore: pedido de eventos falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para os eventos de "${sport}"`);
  }
  return res.json() as Promise<PulsescoreFlatEventsResponse>;
}

/**
 * Flat, paginated event list for a sport — an alternative to fetchEvents() that skips the
 * leagues nesting. CONFIRMED via a real sample (GET /soccer/events?page=1&limit=5, 850 total
 * events, 5 real matches with 5–17 markets each): response shape is exactly
 * `{ total, page, limit, totalPages, hasNextPage, hasPrevPage, events: [...] }`, matching
 * PulsescoreFlatEventsResponse/PulsescoreEvent as coded — no changes needed. The sample also
 * surfaced canonicalMarket values not seen before (CORNERS_OVER_UNDER, CORRECT_SCORE), handled
 * fine since markets are never filtered by a fixed whitelist.
 */
export async function fetchEventsFlat(sport: Sport, opts: { maxPages?: number; limit?: number; bookmaker?: string } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 3;
  const limit = opts.limit ?? 25;
  const events: LiveEvent[] = [];

  let page = 1;
  while (page <= maxPages) {
    const data = await fetchEventsFlatPage(sport, page, limit, opts.bookmaker);
    events.push(...extractEvents(data).map((evt) => normalizeEvent(evt, sport, opts.bookmaker)));
    if (!data.hasNextPage) break;
    page += 1;
  }

  return events;
}

/** Extracts a single PulsescoreEvent out of whichever response shape /events/{id} returns. */
function extractSingleEvent(data: unknown): PulsescoreEvent | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  if (typeof obj.eventId === "string") return obj as unknown as PulsescoreEvent;
  if (obj.event && typeof obj.event === "object") return obj.event as PulsescoreEvent;
  logger.warn({ data }, "Pulsescore: forma de resposta de /events/{id} não reconhecida");
  return null;
}

/**
 * Fetches a single event by its Pulsescore eventId — the natural way to refresh one event's
 * odds on demand (e.g. when a user opens its Match Tracker) rather than waiting for the next
 * bulk poll. Returns null if the event isn't found or the response shape wasn't recognized
 * (NEEDS VALIDATION — no response body was provided for this endpoint yet).
 */
export async function fetchEventById(sport: Sport, eventId: string): Promise<LiveEvent | null> {
  assertConfigured();
  const slug = SPORT_SLUGS[sport];
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerPathSegment(bookmakerFor(sport))}/${slug}/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, sport, slug, eventId, body: body.slice(0, 300) }, "Pulsescore: pedido de evento único falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para o evento "${eventId}" (${sport})`);
  }
  const raw = extractSingleEvent(await res.json());
  return raw ? normalizeEvent(raw, sport) : null;
}

interface PulsescoreLiveSportsSummary {
  total: number;
  sports: Array<{ name: string; eventCount: number }>;
}

/**
 * GET /live-events/sports — confirmed response shape (see the class doc comment above).
 * Returns only the sports we model here (via SLUG_TO_SPORT) that currently have at least one
 * live event, so pollOnce() in hybridService.ts doesn't waste a request per sport on ones with
 * nothing live right now.
 *
 * @param bookmaker Optional — specific bookmaker to query. Defaults to env.PULSESCORE_BOOKMAKER.
 *   Use this to query the override bookmakers (unibetau for formula1, bet365 for baseball) whose
 *   live sports summary isn't included in the default bookmaker's response.
 * @param silent404 If true, return [] instead of throwing when the bookmaker returns 404
 *   (some bookmaker+sport combinations simply don't exist on the Pulsescore side).
 */
async function fetchLiveSportsWithCounts(bookmaker?: string, silent404 = false): Promise<Array<{ sport: Sport; eventCount: number }>> {
  assertConfigured();
  const resolvedBookmaker = bookmaker ?? env.PULSESCORE_BOOKMAKER;
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerPathSegment(resolvedBookmaker)}/live-events/sports`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (res.status === 404 && silent404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, bookmaker: resolvedBookmaker, body: body.slice(0, 300) }, "Pulsescore: pedido de live-events/sports falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para live-events/sports (${resolvedBookmaker})`);
  }
  const data = (await res.json()) as PulsescoreLiveSportsSummary;
  return data.sports
    .filter((s) => s.eventCount > 0 && SLUG_TO_SPORT[s.name])
    .map((s) => ({ sport: SLUG_TO_SPORT[s.name]!, eventCount: s.eventCount }))
    .sort((a, b) => b.eventCount - a.eventCount);
}

// BUG CORRIGIDO (2026-08-24): esta função devolvia os desportos pela ordem em que a Pulsescore
// os lista em /live-events/sports — que NÃO é por eventCount, é uma ordem fixa/alfabética do
// catálogo deles. wsClient.ts faz `.slice(0, maxConnections)` a este resultado a pensar que está
// a escolher os desportos "mais movimentados agora", mas na prática escolhia sempre os mesmos 3
// primeiros da ordem fixa da Pulsescore, independentemente de quantos jogos ao vivo cada um
// tinha. Resultado: ténis/futebol/basquetebol podiam ficar permanentemente de fora das 3 vagas de
// WebSocket e cair sempre no polling REST de 25s — o delay reportado. Agora ordena-se
// explicitamente por eventCount (desc) antes de devolver.
export async function fetchLiveSportsWithEvents(bookmaker?: string, silent404 = false): Promise<Sport[]> {
  const withCounts = await fetchLiveSportsWithCounts(bookmaker, silent404);
  return withCounts.map((s) => s.sport);
}

/**
 * Fetches the union of live sports across ALL configured bookmakers — the default one
 * (PULSESCORE_BOOKMAKER, usually paddypower) plus every override in SPORT_BOOKMAKER_OVERRIDE
 * (unibetau for formula1, bet365 for baseball) — deduplicated by sport.
 *
 * This replaces the previous approach where formula1 and baseball were hardcoded blindly into
 * the live set even when those bookmakers had zero live events, wasting REST rate-limit quota
 * on fetchLiveEvents for empty sports every 25 s.
 */
export async function fetchLiveSportsUnionAllBookmakers(): Promise<Sport[]> {
  const uniqueBookmakers = new Set<string>();
  uniqueBookmakers.add(env.PULSESCORE_BOOKMAKER);
  for (const overrideBookmaker of Object.values(SPORT_BOOKMAKER_OVERRIDE)) {
    if (overrideBookmaker) uniqueBookmakers.add(overrideBookmaker);
  }

  const results = await Promise.all(
    Array.from(uniqueBookmakers).map((book) =>
      fetchLiveSportsWithCounts(book, true).catch((err): Array<{ sport: Sport; eventCount: number }> => {
        logger.warn({ bookmaker: book, err: String(err).slice(0, 200) }, "Pulsescore: live-events/sports falhou para esta bookmaker, a ignorar");
        return [];
      })
    )
  );

  // Soma o eventCount de cada desporto em todas as bookmakers (não só o máximo) — dá uma
  // medida mais fiel de "quão movimentado está este desporto agora" do que olhar só para uma
  // bookmaker, e é o que wsClient.ts usa depois para escolher a que 3 desportos ligar o
  // WebSocket real (ver comentário/fix em fetchLiveSportsWithEvents acima).
  const totalCount = new Map<Sport, number>();
  for (const sports of results) {
    for (const { sport, eventCount } of sports) {
      totalCount.set(sport, (totalCount.get(sport) ?? 0) + eventCount);
    }
  }
  return [...totalCount.entries()].sort((a, b) => b[1] - a[1]).map(([sport]) => sport);
}

async function fetchLiveEventsPage(sport: Sport, page: number, limit: number, bookmaker?: string): Promise<unknown> {
  assertConfigured();
  const slug = SPORT_SLUGS[sport];
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerPathSegment(bookmaker ?? bookmakerFor(sport))}/live-events?page=${page}&limit=${limit}&sport=${slug}`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, sport, slug, body: body.slice(0, 300) }, "Pulsescore: pedido de live-events falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para live-events de "${sport}"`);
  }
  return res.json();
}

/**
 * GET /live-events?sport= — the actual live fixtures for one sport (response shape NOT
 * confirmed, parsed defensively via extractEvents() like the other unconfirmed endpoints).
 * Every event returned here is forced to `status: "live"` regardless of what the payload's
 * own `live` field says (or doesn't say) — that's implied by which endpoint it came from.
 */
export async function fetchLiveEvents(sport: Sport, opts: { maxPages?: number; limit?: number; bookmaker?: string } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 2;
  const limit = opts.limit ?? 25;
  const events: LiveEvent[] = [];

  let page = 1;
  while (page <= maxPages) {
    const data = await fetchLiveEventsPage(sport, page, limit, opts.bookmaker);
    const batch = extractEvents(data).map((evt) => normalizeEvent({ ...evt, live: true }, sport, opts.bookmaker));
    events.push(...batch);
    const hasNextPage = (data as Record<string, unknown> | null)?.hasNextPage;
    if (!hasNextPage) break;
    page += 1;
  }

  return events;
}

/**
 * GET /live-events/events/{eventId} — a single live event, with no sport in the path (unlike
 * the sport-scoped fetchEventById()). Sport is instead read from the event payload's own
 * `sport` field and mapped back through SLUG_TO_SPORT; if that field is missing or unrecognized
 * the event is dropped (logged) rather than guessed at. Response shape NOT confirmed.
 *
 * @param eventId The numeric/id string of the live event (the "rawId" after stripping pulsescore: prefix)
 * @param sport Optional — when the caller already knows the sport, we use bookmakerFor(sport) to
 *   route the request to the correct override bookmaker (formula1→unibetau, baseball→bet365) instead
 *   of always using the default PULSESCORE_BOOKMAKER (paddypower), which would 404 for F1/baseball.
 */
export async function fetchLiveEventById(eventId: string, sport?: Sport): Promise<LiveEvent | null> {
  assertConfigured();
  const resolvedBookmaker = sport ? bookmakerFor(sport) : env.PULSESCORE_BOOKMAKER;
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerPathSegment(resolvedBookmaker)}/live-events/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, eventId, bookmaker: resolvedBookmaker, body: body.slice(0, 300) }, "Pulsescore: pedido de live-events/events/{id} falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para o evento ao vivo "${eventId}" (${resolvedBookmaker})`);
  }
  const raw = extractSingleEvent(await res.json());
  if (!raw) return null;
  const detectedSport = SLUG_TO_SPORT[raw.sport];
  if (!detectedSport) {
    logger.warn({ rawSport: raw.sport, eventId }, "Pulsescore: live-events/events devolveu um sport não reconhecido");
    return null;
  }
  return normalizeEvent({ ...raw, live: true }, detectedSport, resolvedBookmaker);
}

// Mantém as seleções inativas em vez de as descartar (o bookmaker desativa-as temporariamente,
// ex: durante uma revisão VAR — ver LiveSelection em types.ts) para a UI as mostrar suspensas
// em vez de as fazer desaparecer.
// `bookmakerSlug` opcional: quando passado, grava qual casa forneceu este mercado (fonte de
// auditoria para UI poder exibir "Odds fornecidas por Bet365" quando o mercado vem de fallback
// cross-bookmaker). Valores possíveis = output de `bookmakerFor()` (paddypower / unibetau / bet365).
function normalizeMarket(m: PulsescoreMarket, bookmakerSlug?: string): LiveOdds {
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
        {
          odd: s.odds,
          isActive: s.isActive,
          canonicalName: s.name ?? s.canonicalOutcome,
          sourceBookmaker: bookmakerSlug,
        },
      ]),
    ),
  };
}

// "MATCH_RESULT" is the canonicalMarket value for the main 1X2/moneyline market — confirmed
// from a real /leagues sample (soccer, REST). The official Pulsescore docs' illustrative
// example instead shows "match_winner" (lowercase, different naming altogether) — since the
// two disagree and we only have real evidence for the REST one, this checks both, case
// insensitively, rather than trusting either single spelling. Bookmaker market ordering is
// arbitrary otherwise (a real sample had "Total Points Group 10 Points" as the very first
// market for an NBA game), so without this the card's quick-odds preview (which just reads
// odds[0]) could show an unrelated market. Moves the primary market to the front when present.
const PRIMARY_MARKET_NAMES = new Set(["match_result", "match_winner", "1x2"]);

// CONFIRMED numa amostra real de beisebol (bet365): o evento não tinha NENHUM mercado
// MATCH_RESULT — o moneyline vinha só como duas seleções soltas dentro de um mercado misto
// ("Game Lines"). Sem mercado principal reconhecido, o primeiro mercado do array acabava por ser
// escolhido às cegas para a pré-visualização do cartão (que não mostra o nome do mercado) — e
// calhou ser "3-Way Handicap" com uma seleção "Tie - ...", fazendo o cartão parecer um 1X2 com
// empate, o que não existe no beisebol (é sempre casa/fora, um jogo de beisebol não empata).
function hasTieSelection(selections: { canonicalOutcome?: string; rawName?: string }[] | undefined): boolean {
  return (selections ?? []).some((s) => s.canonicalOutcome === "DRAW" || /\btie\b|empate/i.test(s.rawName ?? ""));
}

export function orderMarketsWithPrimaryFirst<T extends { canonicalMarket?: string; selections?: { canonicalOutcome?: string; rawName?: string }[] }>(
  markets: T[]
): T[] {
  const primaryIdx = markets.findIndex((m) => m.canonicalMarket && PRIMARY_MARKET_NAMES.has(m.canonicalMarket.toLowerCase()));
  if (primaryIdx > 0) {
    const ordered = [...markets];
    const [primary] = ordered.splice(primaryIdx, 1);
    ordered.unshift(primary!);
    return ordered;
  }
  if (primaryIdx === 0) return markets;

  // Nenhum mercado principal reconhecido: evita que um mercado com empate fique por acidente em
  // primeiro — passa para trás os que têm empate, mantendo a ordem original dentro de cada grupo.
  const withoutTie = markets.filter((m) => !hasTieSelection(m.selections));
  const withTie = markets.filter((m) => hasTieSelection(m.selections));
  return withoutTie.length ? [...withoutTie, ...withTie] : markets;
}

function normalizePeriod(period?: string): string {
  return String(period ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function isFullTimePeriod(period?: string): boolean {
  const normalized = normalizePeriod(period);
  return normalized === "" || normalized === "full_time" || normalized === "fulltime" || normalized === "ft";
}

function tennisMarketPriority(market: { canonicalMarket?: string; period?: string }): number {
  const canonical = String(market.canonicalMarket ?? "").trim().toLowerCase();
  const fullTimeBonus = isFullTimePeriod(market.period) ? 100 : 0;
  if (PRIMARY_MARKET_NAMES.has(canonical)) return fullTimeBonus + 30;
  if (canonical === "total_games") return fullTimeBonus + 20;
  if (canonical === "game_handicap") return fullTimeBonus + 10;
  return fullTimeBonus;
}

export function orderMarketsForSport<
  T extends {
    canonicalMarket?: string;
    selections?: { canonicalOutcome?: string; rawName?: string }[];
    period?: string;
  },
>(sport: Sport, markets: T[]): T[] {
  if (sport !== "tennis") return orderMarketsWithPrimaryFirst(markets);
  return markets
    .map((market, index) => ({ market, index }))
    .sort((a, b) => {
      const scoreDiff = tennisMarketPriority(b.market) - tennisMarketPriority(a.market);
      if (scoreDiff !== 0) return scoreDiff;
      return a.index - b.index;
    })
    .map(({ market }) => market);
}

// A ordem dos mercados dentro de uma "família" (a mesma linha de Mais/Menos repetida para
// vários valores, ex: "Over/Under 0.5 Goals"/"Over/Under 1.5 Goals"/...) vinda da bookmaker é
// arbitrária — CONFIRMADO numa captura real: chegou "0.5, 1.5, 4.5, 2.5, 3.5", fora de ordem.
// Agrupa mercados que têm o mesmo nome com o número removido (ex: "Over/Under X Goals") e
// ordena cada grupo pelo número ascendente — mantém o grupo na posição onde o seu primeiro
// membro apareceu, nunca reordena mercados sem número nem os move para perto de outra família.
function extractMarketLine(name: string): number | null {
  const m = name.match(/(\d+(?:\.\d+)?)/);
  return m?.[1] ? parseFloat(m[1]) : null;
}

export function sortNumericMarketFamilies<T extends { rawName?: string; canonicalMarket?: string }>(markets: T[]): T[] {
  const nameOf = (m: T) => m.rawName ?? m.canonicalMarket ?? "";
  const baseNameOf = (name: string) => name.replace(/\d+(?:\.\d+)?/, "").trim();

  const groups = new Map<string, T[]>();
  const firstIndexByBaseName: string[] = [];
  markets.forEach((m) => {
    const base = baseNameOf(nameOf(m));
    if (!groups.has(base)) {
      groups.set(base, []);
      firstIndexByBaseName.push(base);
    }
    groups.get(base)!.push(m);
  });

  const result: T[] = [];
  for (const base of firstIndexByBaseName) {
    const group = groups.get(base)!;
    if (group.length > 1) {
      group.sort((a, b) => {
        const la = extractMarketLine(nameOf(a));
        const lb = extractMarketLine(nameOf(b));
        if (la === null || lb === null) return 0;
        return la - lb;
      });
    }
    result.push(...group);
  }
  return result;
}

// "H"/"A" score strings -> number when both sides parse cleanly (futebol, basquetebol, etc.).
// CONFIRMED shape for paddypower: { home: "1", away: "1" }. No ténis, os pontos do jogo atual
// nem sempre são numéricos (ex: esperava-se "AD" em vantagem) — nesse caso passa-se a string tal
// como veio, em vez de descartar o placar inteiro (bug real: "40"/"15" apareciam, o placar
// desaparecia por completo ao entrar em vantagem). O valor real que a Pulsescore envia nesse
// momento **ainda não foi confirmado** com uma amostra real — só se sabe que o placar continuava
// a desaparecer mesmo depois deste "fallback string" ser adicionado, o que sugere que `e.score`
// pode estar totalmente ausente nesse instante (não apenas não-numérico). O log abaixo, com o
// `sport === "tennis"`, serve para capturar a forma real na próxima vez que acontecer.
function parseTennisGamePoints(
  sport: Sport,
  moreInfo: PulsescoreEvent["moreInfo"] | undefined
): { homeScore?: number | string; awayScore?: number | string } {
  if (sport !== "tennis") return {};
  const gp = moreInfo?.gamePoints;
  if (gp == null) return {};
  if (typeof gp === "string" || typeof gp === "number") {
    const [homeRaw, awayRaw] = String(gp)
      .split(":")
      .map((part) => part.trim());
    if (!homeRaw || !awayRaw) return {};
    const homeScore = Number.isNaN(Number(homeRaw)) ? homeRaw : Number(homeRaw);
    const awayScore = Number.isNaN(Number(awayRaw)) ? awayRaw : Number(awayRaw);
    return { homeScore, awayScore };
  }
  if (gp.home == null || gp.away == null) return {};
  return { homeScore: gp.home, awayScore: gp.away };
}

// ⚠️ CORREÇÃO (2026-08-27, migração para bookmaker "onexbet"): `score` genérico é AMBÍGUO para
// ténis — nada na Pulsescore garante que este campo carregue os pontos do jogo atual (0/15/30/
// 40/AD, o que o cartão mostra em .event-points, ver renderSetsCard em app.js) em vez do placar
// de SETS ganhos (0/1/2), que é um conceito totalmente diferente e já vem à parte em
// `statistics.sets`. Com a paddypower, `score` vinha quase sempre ausente/não numérico em ténis,
// por isso caía quase sempre no fallback `parseTennisGamePoints` (que lê moreInfo.gamePoints, o
// único campo cujo NOME já garante ser os pontos do jogo atual) — mascarando esta ambiguidade.
// Bug real reportado com print depois da migração para "onexbet": o placar grande do cartão
// passou a mostrar "1 - 0" / "0 - 1" (valores pequenos, típicos de sets ganhos) em vez de "15 -
// 30"/"40 - AD", porque a onexbet aparentemente DEVOLVE um `score` numérico válido para ténis
// (ao contrário da paddypower) — só que esse valor não são os pontos do jogo. Por isso, em ténis,
// `moreInfo.gamePoints` passa a ter SEMPRE prioridade; `score` só serve de recurso se
// gamePoints não vier.
function parsePulsescoreScore(
  score: PulsescoreScore | undefined,
  sport: Sport,
  moreInfo?: PulsescoreEvent["moreInfo"]
): { homeScore?: number | string; awayScore?: number | string } {
  if (sport === "tennis") {
    const points = parseTennisGamePoints(sport, moreInfo);
    if (points.homeScore !== undefined && points.awayScore !== undefined) return points;
  }
  if (!score || score.home == null || score.away == null) {
    if (sport === "tennis") logger.info({ score }, "Pulsescore: ténis sem score.home/away nem gamePoints parseável (possível estado de vantagem)");
    return parseTennisGamePoints(sport, moreInfo);
  }
  const h = Number(score.home);
  const a = Number(score.away);
  if (Number.isNaN(h) || Number.isNaN(a)) {
    if (sport === "tennis") logger.info({ score }, "Pulsescore: ténis com score.home/away não-numérico (possível estado de vantagem)");
    return { homeScore: score.home, awayScore: score.away };
  }
  return { homeScore: h, awayScore: a };
}

// Futebol: {minute, second, period} -> "90'". Ténis (sem minute/second, CONFIRMADO num exemplo
// real): {period: "Set 2"} -> "Set 2". Sem nenhum dos dois campos, cai no fallback (o frontend
// destaca esse caso a vermelho — ver clock-missing em web/app.js).
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

// CONFIRMED em 5 eventos reais de beisebol na bet365 (Nicaragua CNBS, MLB x3, Triple A Minor
// League): quando não há mercado MATCH_RESULT, o moneyline aparece sempre com seleções chamadas
// exatamente "Money" (nome consistente nos 5), misturado dentro de um mercado "Game Lines" junto
// com Run Line (handicap) e Total. Isso fazia o cartão mostrar "Run Line 1.63 / Total 1.80 /
// Money 1.04" em vez de um casa/fora limpo — confirmado pelo utilizador a ver isto na app real.
// Extrai as seleções "Money" para o seu próprio mercado (sem inventar nada, só reagrupa odds
// reais que já vinham na resposta) e remove-as do mercado misto original, para não aparecerem
// duplicadas na lista completa de mercados do Match Tracker.
//
// DELIBERADAMENTE não trocado o rótulo "Money" pelo nome da equipa (casa/fora): confirmado no
// mesmo evento que `canonicalOutcome: "HOME"` da bet365 aponta para o Arizona Diamondbacks, que
// o próprio evento (`event.home`) diz ser a equipa VISITANTE (Boston Red Sox é a casa) — os
// campos HOME/AWAY/OR desta bookmaker não são fiáveis para saber qual "Money" pertence a qual
// equipa. Atribuir a odd à equipa errada seria pior do que mostrar "Money" duas vezes, por isso
// mantém-se o nome real da seleção tal como veio, sem adivinhar.
function withSyntheticMoneyline(markets: PulsescoreMarket[]): PulsescoreMarket[] {
  const hasMatchResult = markets.some((m) => m.canonicalMarket && PRIMARY_MARKET_NAMES.has(m.canonicalMarket.toLowerCase()));
  if (hasMatchResult) return markets;

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i]!;
    const moneySelections = m.selections.filter((s) => /^money$/i.test(s.rawName));
    if (moneySelections.length < 2) continue;

    const rest = m.selections.filter((s) => !/^money$/i.test(s.rawName));
    const synthetic: PulsescoreMarket = {
      canonicalMarket: "MATCH_RESULT",
      rawName: "Moneyline",
      period: m.period,
      isActive: true,
      marketId: `${m.marketId}.money`,
      selections: moneySelections,
    };
    const withoutMoney = markets.filter((_, idx) => idx !== i);
    if (rest.length > 0) withoutMoney.splice(i, 0, { ...m, selections: rest });
    return [synthetic, ...withoutMoney];
  }
  return markets;
}

function normalizeEvent(e: PulsescoreEvent, sport: Sport, bookmakerSlug?: string): LiveEvent {
  const bm = bookmakerSlug ?? bookmakerFor(sport);
  // Já não filtra mercados inativos aqui — passam para o frontend com isActive:false para
  // aparecerem suspensos (não clicáveis) em vez de desaparecerem silenciosamente.
  const orderedMarkets = sortNumericMarketFamilies(orderMarketsForSport(sport, withSyntheticMoneyline(e.markets)));
  const scoreData = parsePulsescoreScore(e.score, sport, e.moreInfo);
  if (sport === "tennis" && e.statistics?.sets && (scoreData.homeScore == null || scoreData.awayScore == null)) {
    logger.info(
      {
        eventId: e.eventId,
        league: e.league,
        home: e.home,
        away: e.away,
        score: e.score,
        gamePoints: e.moreInfo?.gamePoints,
        currentPeriod: e.moreInfo?.currentPeriod,
        matchClock: e.matchClock,
        sets: e.statistics.sets,
      },
      "Pulsescore REST: ténis sem pontos do game atual; cartão ficará só com sets"
    );
  }
  return {
    id: `pulsescore:${e.eventId}`,
    sport,
    league: e.league,
    home: e.home,
    away: e.away,
    // CONFIRMED presente para a bookmaker "paddypower" (matchClock/score/statistics no
    // próprio REST /live-events) — indefinido se a bookmaker atual não os devolver (ex: a
    // anterior "10bet"), caso em que o frontend esconde a linha de placar em vez de inventar
    // um "0-0".
    ...scoreData,
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

/**
 * Fetches up to `maxPages` pages of leagues for one sport and flattens them into normalized
 * events. Errors and unknown sport slugs are the caller's problem to catch — this throws.
 */
export async function fetchEvents(sport: Sport, opts: { maxPages?: number; limit?: number } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 3;
  const limit = opts.limit ?? 25;
  const events: LiveEvent[] = [];

  let page = 1;
  while (page <= maxPages) {
    const data = await fetchLeaguesPage(sport, page, limit);
    for (const league of data.leagues) {
      for (const evt of league.events) {
        events.push(normalizeEvent(evt, sport));
      }
    }
    if (!data.hasNextPage) break;
    page += 1;
  }

  return events;
}
