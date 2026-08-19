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

// CONFIRMED via a documentação oficial da Pulsescore ("Esportes válidos por casa de apostas"):
// a 10Bet(CO.UK) não lista Fórmula 1 entre os desportos suportados, mas a Unibet AU lista — daí
// a Fórmula 1 usar um bookmaker diferente de todos os outros 7 desportos (que ficam em 10bet).
const SPORT_BOOKMAKER_OVERRIDE: Partial<Record<Sport, string>> = {
  formula1: "unibetau",
};

export function bookmakerFor(sport: Sport): string {
  return SPORT_BOOKMAKER_OVERRIDE[sport] ?? env.PULSESCORE_BOOKMAKER;
}

interface PulsescoreSelection {
  canonicalOutcome: string;
  rawName: string;
  odds: number;
  isActive: boolean;
  selectionId: string;
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
interface PulsescoreStatistics {
  football?: { home: PulsescoreTeamStatistics; away: PulsescoreTeamStatistics };
}
// Score as separate string fields per side — CONFIRMED shape for paddypower's REST
// /live-events, distinct from the official WS docs' single "H-A" string (see wsClient.ts).
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
  // CONFIRMED absent on live:true events (real /live-events samples for soccer and
  // basketball had no startTime at all) — only present on pré-jogo (live:false) events.
  startTime?: string;
  markets: PulsescoreMarket[];
  country?: string; // ISO 2-letter code, or "" for international/qualifier competitions
  matchClock?: PulsescoreMatchClock;
  statistics?: PulsescoreStatistics;
  score?: PulsescoreScore;
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
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerFor(sport)}/${slug}/leagues?page=${page}&limit=${limit}`;
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
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerFor(sport)}/${slug}/leagues/${encodeURIComponent(leagueName)}/events`;
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

async function fetchEventsFlatPage(sport: Sport, page: number, limit: number): Promise<PulsescoreFlatEventsResponse> {
  assertConfigured();
  const slug = SPORT_SLUGS[sport];
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerFor(sport)}/${slug}/events?page=${page}&limit=${limit}`;
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
export async function fetchEventsFlat(sport: Sport, opts: { maxPages?: number; limit?: number } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 3;
  const limit = opts.limit ?? 25;
  const events: LiveEvent[] = [];

  let page = 1;
  while (page <= maxPages) {
    const data = await fetchEventsFlatPage(sport, page, limit);
    events.push(...extractEvents(data).map((evt) => normalizeEvent(evt, sport)));
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
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerFor(sport)}/${slug}/events/${encodeURIComponent(eventId)}`;
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
 */
export async function fetchLiveSportsWithEvents(): Promise<Sport[]> {
  assertConfigured();
  const url = `${env.PULSESCORE_REST_URL}/${env.PULSESCORE_BOOKMAKER}/live-events/sports`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, body: body.slice(0, 300) }, "Pulsescore: pedido de live-events/sports falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para live-events/sports`);
  }
  const data = (await res.json()) as PulsescoreLiveSportsSummary;
  return data.sports.filter((s) => s.eventCount > 0 && SLUG_TO_SPORT[s.name]).map((s) => SLUG_TO_SPORT[s.name]!);
}

async function fetchLiveEventsPage(sport: Sport, page: number, limit: number): Promise<unknown> {
  assertConfigured();
  const slug = SPORT_SLUGS[sport];
  const url = `${env.PULSESCORE_REST_URL}/${bookmakerFor(sport)}/live-events?page=${page}&limit=${limit}&sport=${slug}`;
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
export async function fetchLiveEvents(sport: Sport, opts: { maxPages?: number; limit?: number } = {}): Promise<LiveEvent[]> {
  const maxPages = opts.maxPages ?? 2;
  const limit = opts.limit ?? 25;
  const events: LiveEvent[] = [];

  let page = 1;
  while (page <= maxPages) {
    const data = await fetchLiveEventsPage(sport, page, limit);
    const batch = extractEvents(data).map((evt) => normalizeEvent({ ...evt, live: true }, sport));
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
 */
export async function fetchLiveEventById(eventId: string): Promise<LiveEvent | null> {
  assertConfigured();
  const url = `${env.PULSESCORE_REST_URL}/${env.PULSESCORE_BOOKMAKER}/live-events/events/${encodeURIComponent(eventId)}`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, eventId, body: body.slice(0, 300) }, "Pulsescore: pedido de live-events/events/{id} falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para o evento ao vivo "${eventId}"`);
  }
  const raw = extractSingleEvent(await res.json());
  if (!raw) return null;
  const sport = SLUG_TO_SPORT[raw.sport];
  if (!sport) {
    logger.warn({ rawSport: raw.sport, eventId }, "Pulsescore: live-events/events devolveu um sport não reconhecido");
    return null;
  }
  return normalizeEvent({ ...raw, live: true }, sport);
}

function normalizeMarket(m: PulsescoreMarket): LiveOdds {
  return {
    market: m.rawName,
    selections: Object.fromEntries(m.selections.filter((s) => s.isActive).map((s) => [s.rawName, s.odds])),
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

export function orderMarketsWithPrimaryFirst<T extends { canonicalMarket?: string }>(markets: T[]): T[] {
  const primaryIdx = markets.findIndex((m) => m.canonicalMarket && PRIMARY_MARKET_NAMES.has(m.canonicalMarket.toLowerCase()));
  if (primaryIdx <= 0) return markets;
  const ordered = [...markets];
  const [primary] = ordered.splice(primaryIdx, 1);
  ordered.unshift(primary!);
  return ordered;
}

// "H"/"A" score strings -> number, only when both sides parse cleanly — otherwise undefined
// rather than a fabricated "0". CONFIRMED shape for paddypower: { home: "1", away: "1" }.
function parsePulsescoreScore(score: PulsescoreScore | undefined): { homeScore?: number; awayScore?: number } {
  if (!score) return {};
  const h = Number(score.home);
  const a = Number(score.away);
  if (Number.isNaN(h) || Number.isNaN(a)) return {};
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
  if (!stats?.football) return undefined;
  return { home: stats.football.home ?? {}, away: stats.football.away ?? {} };
}

function normalizeEvent(e: PulsescoreEvent, sport: Sport): LiveEvent {
  const activeMarkets = orderMarketsWithPrimaryFirst(e.markets.filter((m) => m.isActive));
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
    ...parsePulsescoreScore(e.score),
    minuteOrPeriod: formatMatchClock(e.matchClock, e.live ? "AO VIVO" : ""),
    status: e.live ? "live" : "scheduled",
    odds: activeMarkets.map(normalizeMarket),
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
