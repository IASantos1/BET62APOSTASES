import type { MappingMethod, FixtureMapping, TeamMapping, LeagueMapping } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { logger } from "../../../lib/logger";
import type { LiveEvent } from "../types";
import { findTeamMapping } from "./teamMatcher";
import { findLeagueMapping } from "./leagueMatcher";
import { findFixtureId, type FixtureIdMatch } from "../apifootball/client";

const MIN_CONFIDENCE_TO_LINK = 70;
// ±10 minutos (spec) — comparado sempre via Date/UTC (findFixtureId), nunca por string.
const KICKOFF_TOLERANCE_MS = 10 * 60 * 1000;

export interface FixtureMatchResult {
  apiFootballFixtureId: number | null;
  homeApiFootballTeamId: number | null;
  awayApiFootballTeamId: number | null;
  apiFootballLeagueId: number | null;
  season: number | null;
  invertedHomeAway: boolean | null; // true = AF tem casa/fora TROCADOS relativamente à Pulsescore (trocar estatísticas)
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

  // home.id/away.id/league.id só ficam "" quando a PESQUISA na API-Football falhou desta vez
  // (rede/rate limit) — normalizeTeamName(event.home) vazio é praticamente impossível para um
  // evento real da Pulsescore. Um miss genuíno ("pesquisou e não achou nada") sempre grava uma
  // linha e devolve um id válido. Se alguma das três falhou por motivo transitório, não vale a
  // pena gravar já este FixtureMapping — ficaria preso com homeTeamMappingId/leagueMappingId
  // nulos PARA SEMPRE (é permanente por design, ver docs/TEAM_MAPPING.md), quando a falha pode
  // desaparecer sozinha no pedido seguinte. Devolve sem gravar para se tentar tudo de novo.
  if (!home.id || !away.id || !league.id) {
    logger.warn(
      { eventId: event.id, homeFailed: !home.id, awayFailed: !away.id, leagueFailed: !league.id },
      "[MATCHING] fixture: pesquisa de equipa/liga falhou transitoriamente — não fica em cache, tenta-se de novo no próximo pedido"
    );
    return { apiFootballFixtureId: null, homeApiFootballTeamId: null, awayApiFootballTeamId: null, apiFootballLeagueId: null, season: null, confidence: 0, mappingMethod: "SIMILARITY", verified: false, invertedHomeAway: null };
  }

  let fixtureMatch: FixtureIdMatch | null = null;
  if (home.apiFootballTeamId && away.apiFootballTeamId) {
    const dateISO = (event.startTime ?? new Date().toISOString()).slice(0, 10);
    try {
      fixtureMatch = await findFixtureId(home.apiFootballTeamId, away.apiFootballTeamId, dateISO, event.startTime);
    } catch (err) {
      logger.warn({ err, eventId: event.id }, "[MATCHING] fixture: falha ao pesquisar fixture por equipas/data");
    }
  }

  const kickoffDiffMs =
    fixtureMatch && event.startTime ? Math.abs(new Date(fixtureMatch.kickoffISO).getTime() - new Date(event.startTime).getTime()) : null;
  const kickoffWithinTolerance = kickoffDiffMs === null ? null : kickoffDiffMs <= KICKOFF_TOLERANCE_MS;

  const teamsConfidence = Math.min(home.confidence, away.confidence);
  const anyManual = home.mappingMethod === "MANUAL" || away.mappingMethod === "MANUAL";
  let confidence = teamsConfidence;
  if (fixtureMatch) confidence = Math.min(100, confidence + 10);
  else confidence = Math.max(0, confidence - 20);
  if (league.apiFootballLeagueId) confidence = Math.min(100, confidence + 3);
  // Fixture encontrado (mesmas equipas, mesmo dia) mas o horário exato foge à tolerância de
  // ±10min é um sinal de alerta (pode ser outro jogo dessas equipas nesse dia — raro mas
  // possível, ex: taça a dobrar com a liga) sem chegar a anular a correspondência.
  if (kickoffWithinTolerance === false) confidence = Math.max(0, confidence - 10);
  else if (kickoffWithinTolerance === true) confidence = Math.min(100, confidence + 2);
  confidence = Math.max(0, Math.min(100, confidence));

  const method: MappingMethod = anyManual ? "MANUAL" : teamsConfidence >= 97 && fixtureMatch ? "NORMALIZED" : "SIMILARITY";
  const linked = confidence >= MIN_CONFIDENCE_TO_LINK && Boolean(fixtureMatch);
  const reason = `home=${home.mappingMethod}(${home.confidence}) away=${away.mappingMethod}(${away.confidence}) league=${league.mappingMethod}(${league.confidence}) fixtureFound=${Boolean(fixtureMatch)}${fixtureMatch?.invertedHomeAway ? " invertedHomeAway" : ""}${kickoffDiffMs !== null ? ` kickoffDiffMin=${Math.round(kickoffDiffMs / 60000)}` : ""}`;

  logger.info(
    {
      eventId: event.id,
      home: event.home,
      away: event.away,
      league: event.league,
      homeTeamId: home.apiFootballTeamId,
      awayTeamId: away.apiFootballTeamId,
      leagueId: league.apiFootballLeagueId,
      apiFootballFixtureId: fixtureMatch?.fixtureId ?? null,
      invertedHomeAway: fixtureMatch?.invertedHomeAway ?? false,
      kickoffDiffMinutes: kickoffDiffMs === null ? null : Math.round(kickoffDiffMs / 60000),
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
      apiFootballFixtureId: linked ? fixtureMatch!.fixtureId : null,
      homeTeamMappingId: home.id || null,
      awayTeamMappingId: away.id || null,
      leagueMappingId: league.id || null,
      kickoffPulsescore: event.startTime ? new Date(event.startTime) : null,
      kickoffApiFootball: fixtureMatch ? new Date(fixtureMatch.kickoffISO) : null,
      invertedHomeAway: fixtureMatch?.invertedHomeAway ?? null,
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
    invertedHomeAway: row.invertedHomeAway ?? null,
    confidence: row.confidence,
    mappingMethod: row.mappingMethod,
    verified: row.verified,
  };
}
