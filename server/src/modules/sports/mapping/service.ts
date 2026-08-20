/**
 * Ponto de entrada público do motor de mapeamento — é isto que routes.ts/hybridService.ts
 * importam, nunca diretamente teamMatcher/leagueMatcher/fixtureMatcher (ver docs/TEAM_MAPPING.md
 * para a arquitetura completa). Duas formas de resolução, conforme o que o chamador precisa:
 *
 * - resolveFixtureForEvent(): id do fixture na API-Football (estatísticas/previsões) — exige a
 *   cadeia toda (equipas + fixture do dia certo).
 * - resolveTeamsForEvent(): só os ids das duas equipas (H2H) — não exige que o fixture de hoje
 *   tenha sido encontrado, só que as equipas em si estejam identificadas.
 * - resolveLeagueForEvent(): id da liga + época (classificação).
 */
import type { LiveEvent } from "../types";
import { findFixtureMapping } from "./fixtureMatcher";
import { findTeamMapping } from "./teamMatcher";

export interface ResolvedFixture {
  fixtureId: number;
  homeTeamId: number | null;
  awayTeamId: number | null;
  leagueId: number | null;
  season: number | null;
}

export async function resolveFixtureForEvent(event: LiveEvent): Promise<ResolvedFixture | null> {
  const match = await findFixtureMapping(event);
  if (!match.apiFootballFixtureId) return null;
  return {
    fixtureId: match.apiFootballFixtureId,
    homeTeamId: match.homeApiFootballTeamId,
    awayTeamId: match.awayApiFootballTeamId,
    leagueId: match.apiFootballLeagueId,
    season: match.season,
  };
}

export async function resolveLeagueForEvent(event: LiveEvent): Promise<{ leagueId: number; season: number } | null> {
  const match = await findFixtureMapping(event);
  if (!match.apiFootballLeagueId || !match.season) return null;
  return { leagueId: match.apiFootballLeagueId, season: match.season };
}

export async function resolveTeamsForEvent(event: LiveEvent): Promise<{ homeTeamId: number; awayTeamId: number } | null> {
  const [home, away] = await Promise.all([
    findTeamMapping(event.home, event.sport, event.country),
    findTeamMapping(event.away, event.sport, event.country),
  ]);
  if (!home.apiFootballTeamId || !away.apiFootballTeamId) return null;
  return { homeTeamId: home.apiFootballTeamId, awayTeamId: away.apiFootballTeamId };
}
