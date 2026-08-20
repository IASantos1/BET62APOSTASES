import type { MappingMethod, LeagueMapping } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { logger } from "../../../lib/logger";
import { normalizeTeamName, calculateTeamSimilarity } from "./normalize";
import { searchLeagueCandidates, type ApiFootballLeagueCandidate } from "../apifootball/client";

const MIN_CONFIDENCE_TO_LINK = 70;

export interface LeagueMatchResult {
  id: string;
  apiFootballLeagueId: number | null;
  apiFootballName: string | null;
  season: number | null;
  confidence: number;
  mappingMethod: MappingMethod;
  verified: boolean;
}

/** Mesma lógica de findTeamMapping() (normalize.ts::normalizeTeamName reaproveitado — o nome da
 * função é "de equipa" mas a normalização em si serve igualmente bem para nomes de liga), com
 * cache permanente própria (LeagueMapping) em vez de reaproveitar a de equipas. */
export async function findLeagueMapping(pulsescoreName: string, sport: string, country?: string): Promise<LeagueMatchResult> {
  const normalizedPulsescoreName = normalizeTeamName(pulsescoreName);
  if (!normalizedPulsescoreName) {
    return { id: "", apiFootballLeagueId: null, apiFootballName: null, season: null, confidence: 0, mappingMethod: "SIMILARITY", verified: false };
  }

  const cached = await prisma.leagueMapping.findUnique({
    where: { sport_normalizedPulsescoreName: { sport, normalizedPulsescoreName } },
  });
  if (cached) return toResult(cached);

  let candidates: ApiFootballLeagueCandidate[] = [];
  try {
    candidates = await searchLeagueCandidates(pulsescoreName);
  } catch (err) {
    logger.warn({ err, pulsescoreName }, "[MATCHING] liga: falha ao pesquisar na API-Football — não fica em cache, tenta-se de novo no próximo pedido");
    // Mesma razão que teamMatcher.ts: uma falha na PESQUISA (rede/rate limit/API-Football em
    // baixo) não é o mesmo que "pesquisou e não achou liga nenhuma" — só o segundo caso é que
    // deve ficar em cache permanente. Sem isto, uma falha transitória na primeira vez que esta
    // liga é vista prende a Classificação dela em falha para sempre (só um Reset manual no
    // admin desbloquearia).
    return { id: "", apiFootballLeagueId: null, apiFootballName: null, season: null, confidence: 0, mappingMethod: "SIMILARITY", verified: false };
  }

  let best: { candidate: ApiFootballLeagueCandidate; score: number } | null = null;
  for (const c of candidates) {
    const score = calculateTeamSimilarity(pulsescoreName, c.name);
    if (!best || score > best.score) best = { candidate: c, score };
  }

  const similarity = best?.score ?? 0;
  const confidence = Math.max(0, Math.min(100, Math.round(similarity >= 0.999 ? 97 : similarity * 90)));
  const method: MappingMethod = similarity >= 0.999 ? "NORMALIZED" : "SIMILARITY";
  const hasSeason = Boolean(best?.candidate.seasons.length);
  const linked = confidence >= MIN_CONFIDENCE_TO_LINK && Boolean(best) && hasSeason;

  logger.info(
    {
      pulsescoreName,
      candidatesCount: candidates.length,
      candidates: candidates.slice(0, 5).map((c) => c.name),
      bestMatch: best?.candidate.name,
      similarity: Math.round(similarity * 100),
      confidence,
      method,
      linked,
    },
    linked ? "[MATCHING] liga ligada" : "[MATCHING] liga sem correspondência suficiente"
  );

  const season = linked ? (best!.candidate.seasons.find((s) => s.current) ?? best!.candidate.seasons[best!.candidate.seasons.length - 1])!.year : null;

  const saved = await prisma.leagueMapping.upsert({
    where: { sport_normalizedPulsescoreName: { sport, normalizedPulsescoreName } },
    create: {
      sport,
      pulsescoreName,
      normalizedPulsescoreName,
      apiFootballLeagueId: linked ? best!.candidate.id : null,
      apiFootballName: linked ? best!.candidate.name : null,
      season,
      country: country ?? null,
      confidence,
      mappingMethod: method,
      verified: false,
    },
    update: {}, // ver comentário equivalente em teamMatcher.ts (corrida rara entre pedidos concorrentes)
  });

  return toResult(saved);
}

function toResult(row: LeagueMapping): LeagueMatchResult {
  return {
    id: row.id,
    apiFootballLeagueId: row.apiFootballLeagueId,
    apiFootballName: row.apiFootballName,
    season: row.season,
    confidence: row.confidence,
    mappingMethod: row.mappingMethod,
    verified: row.verified,
  };
}
