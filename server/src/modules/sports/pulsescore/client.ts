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
 * `fetchEventsFlat()` and `fetchEventById()` below, both parsed defensively for the same
 * reason as fetchLeagueEvents() — no response body was provided for either yet.
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
 * NEEDS VALIDATION — not covered by any sample yet, still assumptions:
 *   - The sport slug is confirmed for every sport except Fórmula 1 — football ("soccer"),
 *     tennis ("tennis"), volleyball ("volleyball"), MMA ("mma"), ice hockey ("ice_hockey"),
 *     basketball ("basketball") and baseball ("baseball") have all been seen in real requests
 *     or in the /live-events/sports response. `formula1: "formula-1"` below is still a guess;
 *     if wrong, that sport's fetch just comes back empty/404, which fetchEvents() below
 *     swallows per-sport rather than failing the whole poll cycle. Fórmula 1 is also simply
 *     absent from the live-events/sports sample, which — given it only lists sports with a
 *     live event *right now* — doesn't confirm or rule it out either way.
 *   - Whether Fórmula 1 exists under this bookmaker in this leagues/home-away shape at all — 7
 *     out of 8 sports turned out to fit fine (even MMA, fighter vs fighter), but motorsport
 *     still doesn't map cleanly to a two-competitor model, so this one specifically stays open.
 *   - What a `live:true` event's payload adds for score/clock — the sample only shows
 *     `live:false` (pré-jogo) events, so homeScore/awayScore/minuteOrPeriod are best-effort
 *     defaults for live events until a live sample is seen.
 *   - Whether a websocket product exists at all for this account/plan — this client only
 *     implements what was demonstrated (REST + polling).
 */

const SPORT_SLUGS: Record<Sport, string> = {
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

const SLUG_TO_SPORT: Partial<Record<string, Sport>> = Object.fromEntries(
  (Object.entries(SPORT_SLUGS) as [Sport, string][]).map(([sport, slug]) => [slug, sport])
);

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
interface PulsescoreEvent {
  sport: string;
  league: string;
  eventId: string;
  home: string;
  away: string;
  live: boolean;
  startTime: string;
  markets: PulsescoreMarket[];
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
  const url = `${env.PULSESCORE_REST_URL}/${env.PULSESCORE_BOOKMAKER}/${slug}/leagues?page=${page}&limit=${limit}`;
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
  const url = `${env.PULSESCORE_REST_URL}/${env.PULSESCORE_BOOKMAKER}/${slug}/leagues/${encodeURIComponent(leagueName)}/events`;
  const res = await fetch(url, { headers: { accept: "*/*", "x-secret": env.PULSESCORE_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn({ status: res.status, sport, slug, leagueName, body: body.slice(0, 300) }, "Pulsescore: pedido de liga falhou");
    throw Errors.internal(`Pulsescore devolveu ${res.status} para a liga "${leagueName}" (${sport})`);
  }
  return res.json();
}

/** Extracts a PulsescoreEvent[] out of whichever response shape the API actually returns. */
function extractEvents(data: unknown): PulsescoreEvent[] {
  if (Array.isArray(data)) return data as PulsescoreEvent[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.events)) return obj.events as PulsescoreEvent[];
    if (obj.league && typeof obj.league === "object" && Array.isArray((obj.league as Record<string, unknown>).events)) {
      return (obj.league as Record<string, unknown>).events as PulsescoreEvent[];
    }
  }
  logger.warn({ data }, "Pulsescore: forma de resposta de /leagues/{name}/events não reconhecida — a devolver vazio");
  return [];
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
  const url = `${env.PULSESCORE_REST_URL}/${env.PULSESCORE_BOOKMAKER}/${slug}/events?page=${page}&limit=${limit}`;
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
 * leagues nesting. NEEDS VALIDATION: response shape assumed to mirror the leagues endpoint's
 * pagination fields with an `events` array instead of `leagues`; parsed defensively via
 * extractEvents() so a slightly different shape (or a bare array) still works.
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
  const url = `${env.PULSESCORE_REST_URL}/${env.PULSESCORE_BOOKMAKER}/${slug}/events/${encodeURIComponent(eventId)}`;
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
  const url = `${env.PULSESCORE_REST_URL}/${env.PULSESCORE_BOOKMAKER}/live-events?page=${page}&limit=${limit}&sport=${slug}`;
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

function normalizeEvent(e: PulsescoreEvent, sport: Sport): LiveEvent {
  return {
    id: `pulsescore:${e.eventId}`,
    sport,
    league: e.league,
    home: e.home,
    away: e.away,
    homeScore: 0, // NEEDS VALIDATION: not present in the confirmed (pré-jogo) sample
    awayScore: 0,
    minuteOrPeriod: e.live ? "AO VIVO" : "",
    status: e.live ? "live" : "scheduled",
    odds: e.markets.filter((m) => m.isActive).map(normalizeMarket),
    updatedAt: new Date().toISOString(),
    source: "pulsescore",
    startTime: e.startTime,
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
