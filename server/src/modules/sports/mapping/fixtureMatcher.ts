import type { MappingMethod, FixtureMapping, TeamMapping, LeagueMapping } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { logger } from "../../../lib/logger";
import type { LiveEvent } from "../types";
import { findTeamMapping } from "./teamMatcher";
import { findLeagueMapping } from "./leagueMatcher";
import { findFixtureId } from "../apifootball/client";

const MIN_CONFIDENCE_TO_LINK = 70;

export interface FixtureMatchResult {
  apiFootballFixtureId: number | null;
  homeApiFootballTeamId: number | null;
  awayApiFootballTeamId: number | null;
  apiFootballLeagueId: number | null;
  season: number | null;
  confidence: number;
  mappingMethod: MappingMethod;
  verified: boolean;
}

type FixtureRow = FixtureMapping & { homeTeamMapping: TeamMapping | null; awayTeamMapping: TeamMapping | null; leagueMapping: LeagueMapping | null };

/**
 * Liga um evento Pulsescore ao fixture correspondente na API-Football — o ponto de entrada do
 * motor de mapeamento (ver docs/TEAM_MAPPING.md). Cache permanente por evento
 * (FixtureMapping.pulsescoreEventKey = LiveEvent.id): a partir da primeira resolução, os
 * pedidos seguintes para o MESMO evento nunca voltam a chamar a API-Football para o
 * identificar — só as estatísticas/H2H/previsões em si é que continuam a pedir-se em tempo
 * real, o fixture_id fica fixo (spec secção 19 "Cache do mapping").
 *
 * Nunca duplica: uma linha por pulsescoreEventKey (spec secção 16) — se já existir mapping para
 * este evento, mesmo sem fixture encontrado, devolve-se logo essa linha em vez de tentar de
 * novo a cada pedido.
 */
export async function findFixtureMapping(event: LiveEvent): Promise<FixtureMatchResult> {
  const cached = await prisma.fixtureMapping.findUnique({
    where: { pulsescoreEventKey: event.id },
    include: { homeTeamMapping: true, awayTeamMapping: true, leagueMapping: true },
  });
  if (cached) {
    logger.info({ eventId: event.id, fixtureId: cached.apiFootballFixtureId }, "[MATCHING] fixture: cache");
    return toResult(cached);
  }

  const [home, away, league] = await Promise.all([
    findTeamMapping(event.home, event.sport, event.country),
    findTeamMapping(event.away, event.sport, event.country),
    findLeagueMapping(event.league, event.sport, event.country),
  ]);

  let apiFootballFixtureId: number | null = null;
  if (home.apiFootballTeamId && away.apiFootballTeamId) {
    // A data (dia, não hora exata) já é o segundo sinal de confirmação além dos dois ids de
    // equipa — não se pede também o fixture exato da API-Football só para comparar o horário
    // ±10min (spec secção 10): seria mais uma chamada à API por evento para um ganho marginal,
    // já que as mesmas duas equipas jogarem entre si duas vezes no mesmo dia é excecional.
    const dateISO = (event.startTime ?? new Date().toISOString()).slice(0, 10);
    try {
      apiFootballFixtureId = await findFixtureId(home.apiFootballTeamId, away.apiFootballTeamId, dateISO);
    } catch (err) {
      logger.warn({ err, eventId: event.id }, "[MATCHING] fixture: falha ao pesquisar fixture por equipas/data");
    }
  }

  const teamsConfidence = Math.min(home.confidence, away.confidence);
  const anyManual = home.mappingMethod === "MANUAL" || away.mappingMethod === "MANUAL";
  let confidence = teamsConfidence;
  if (apiFootballFixtureId) confidence = Math.min(100, confidence + 10);
  else confidence = Math.max(0, confidence - 20);
  if (league.apiFootballLeagueId) confidence = Math.min(100, confidence + 3);
  confidence = Math.max(0, Math.min(100, confidence));

  const method: MappingMethod = anyManual ? "MANUAL" : teamsConfidence >= 97 && apiFootballFixtureId ? "NORMALIZED" : "SIMILARITY";
  const linked = confidence >= MIN_CONFIDENCE_TO_LINK && Boolean(apiFootballFixtureId);
  const reason = `home=${home.mappingMethod}(${home.confidence}) away=${away.mappingMethod}(${away.confidence}) league=${league.mappingMethod}(${league.confidence}) fixtureFound=${Boolean(apiFootballFixtureId)}`;

  logger.info(
    {
      eventId: event.id,
      home: event.home,
      away: event.away,
      league: event.league,
      homeTeamId: home.apiFootballTeamId,
      awayTeamId: away.apiFootballTeamId,
      leagueId: league.apiFootballLeagueId,
      apiFootballFixtureId,
      confidence,
      method,
      linked,
    },
    linked ? "[MATCHING] fixture ligado com sucesso" : "[MATCHING] fixture não associado automaticamente"
  );

  const saved = await prisma.fixtureMapping.upsert({
    where: { pulsescoreEventKey: event.id },
    create: {
      pulsescoreEventKey: event.id,
      apiFootballFixtureId: linked ? apiFootballFixtureId : null,
      homeTeamMappingId: home.id || null,
      awayTeamMappingId: away.id || null,
      leagueMappingId: league.id || null,
      kickoffPulsescore: event.startTime ? new Date(event.startTime) : null,
      confidence,
      mappingMethod: method,
      verified: false,
      reason,
    },
    update: {}, // ver comentário equivalente em teamMatcher.ts
    include: { homeTeamMapping: true, awayTeamMapping: true, leagueMapping: true },
  });

  return toResult(saved);
}

function toResult(row: FixtureRow): FixtureMatchResult {
  return {
    apiFootballFixtureId: row.apiFootballFixtureId,
    homeApiFootballTeamId: row.homeTeamMapping?.apiFootballTeamId ?? null,
    awayApiFootballTeamId: row.awayTeamMapping?.apiFootballTeamId ?? null,
    apiFootballLeagueId: row.leagueMapping?.apiFootballLeagueId ?? null,
    season: row.leagueMapping?.season ?? null,
    confidence: row.confidence,
    mappingMethod: row.mappingMethod,
    verified: row.verified,
  };
}
