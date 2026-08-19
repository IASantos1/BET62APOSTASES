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
 * NEEDS VALIDATION — not covered by the sample, still assumptions:
 *   - The sport slug is only confirmed for football ("soccer"). Slugs below for the other 7
 *     sports are best-effort guesses; if wrong, that sport's fetch just comes back empty/404,
 *     which fetchEvents() below swallows per-sport rather than failing the whole poll cycle.
 *   - Whether Fórmula 1 / MMA exist at all under this bookmaker in this leagues/home-away shape
 *     — motorsport in particular may not fit a two-team model the way this API is structured.
 *   - What a `live:true` event's payload adds for score/clock — the sample only shows
 *     `live:false` (pré-jogo) events, so homeScore/awayScore/minuteOrPeriod are best-effort
 *     defaults for live events until a live sample is seen.
 *   - Whether a websocket product exists at all for this account/plan — this client only
 *     implements what was demonstrated (REST + polling).
 */

const SPORT_SLUGS: Record<Sport, string> = {
  football: "soccer", // CONFIRMED by the sample
  tennis: "tennis",
  basketball: "basketball",
  ice_hockey: "ice-hockey",
  baseball: "baseball",
  volleyball: "volleyball",
  formula1: "formula-1",
  mma: "mma",
};

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
