import { env } from "../../../config/env";
import { Errors } from "../../../lib/errors";
import { logger } from "../../../lib/logger";

/**
 * API-Football (v3.football.api-sports.io) REST client — statistics enrichment layer.
 *
 * NEEDS VALIDATION against https://www.api-football.com/documentation-v3 (blocked from this
 * environment). Implemented from documented knowledge:
 *   - Auth header: "x-apisports-key: <API_FOOTBALL_KEY>" when calling the direct host
 *     (v3.football.api-sports.io). If instead subscribed via RapidAPI, swap to
 *     "x-rapidapi-key" + "x-rapidapi-host" headers and the RapidAPI base URL.
 *   - Rate limits depend on plan (requests/day + requests/minute) — respect the
 *     `x-ratelimit-requests-remaining` response header and back off before going live.
 */

async function apiFootballFetch<T>(path: string, params: Record<string, string | number>): Promise<T> {
  if (!env.API_FOOTBALL_KEY) {
    throw Errors.badRequest("Estatísticas indisponíveis: API_FOOTBALL_KEY não configurada neste ambiente.");
  }

  const url = new URL(`${env.API_FOOTBALL_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const res = await fetch(url, { headers: { "x-apisports-key": env.API_FOOTBALL_KEY } });
  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body, path }, "Erro na API-Football");
    throw Errors.internal("Falha ao obter estatísticas da API-Football");
  }
  return res.json() as Promise<T>;
}

export interface ApiFootballStatisticsResponse {
  response: Array<{
    team: { id: number; name: string };
    statistics: Array<{ type: string; value: number | string | null }>;
  }>;
}

export async function getFixtureStatistics(fixtureId: number) {
  return apiFootballFetch<ApiFootballStatisticsResponse>("/fixtures/statistics", { fixture: fixtureId });
}

export interface ApiFootballFixtureResponse {
  response: Array<{
    fixture: { id: number; status: { short: string; elapsed: number | null } };
    teams: { home: { name: string }; away: { name: string } };
    goals: { home: number | null; away: number | null };
  }>;
}

export async function getFixtureById(fixtureId: number) {
  return apiFootballFetch<ApiFootballFixtureResponse>("/fixtures", { id: fixtureId });
}
