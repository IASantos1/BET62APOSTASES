import type { MappingMethod, TeamMapping } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { logger } from "../../../lib/logger";
import { normalizeTeamName, calculateTeamSimilarity } from "./normalize";
import { findCanonicalAlias } from "./aliasStore";
import { searchTeamCandidates, type ApiFootballTeamCandidate } from "../apifootball/client";

// Abaixo disto, NUNCA associar automaticamente (spec secção 9: "abaixo de 70%: não associar
// automaticamente" — fica sem equipa ligada, para revisão manual no painel admin).
const MIN_CONFIDENCE_TO_LINK = 70;

export interface TeamMatchResult {
  id: string;
  apiFootballTeamId: number | null;
  apiFootballName: string | null;
  confidence: number;
  mappingMethod: MappingMethod;
  verified: boolean;
}

/**
 * Resolve a identidade de UMA equipa do lado Pulsescore para o seu id na API-Football, com
 * cache permanente (TeamMapping) — nunca repete a pesquisa para o mesmo par (sport,
 * normalizedPulsescoreName) depois de a primeira resolução ficar guardada, correta ou não (um
 * resultado "sem correspondência" também fica em cache, para não martelar a API-Football em
 * cada pedido por um evento que nunca vai encontrar equipa — ver docs/TEAM_MAPPING.md).
 *
 * Prioridade: 1) mapping já em cache (inclui correções manuais do admin, que este código nunca
 * sobrescreve) 2) alias conhecido (aliasStore.ts) 3) nome normalizado exato 4) semelhança de
 * texto (normalize.ts). Um mapping MANUAL tem sempre prioridade — uma vez marcado `verified`
 * pelo admin, só outra ação manual o muda.
 */
export async function findTeamMapping(pulsescoreName: string, sport: string, country?: string): Promise<TeamMatchResult> {
  const normalizedPulsescoreName = normalizeTeamName(pulsescoreName);
  if (!normalizedPulsescoreName) {
    return { id: "", apiFootballTeamId: null, apiFootballName: null, confidence: 0, mappingMethod: "SIMILARITY", verified: false };
  }

  const cached = await prisma.teamMapping.findUnique({
    where: { sport_normalizedPulsescoreName: { sport, normalizedPulsescoreName } },
  });
  if (cached) return toResult(cached);

  const alias = await findCanonicalAlias(pulsescoreName, sport);
  const searchQuery = alias ?? pulsescoreName;

  let candidates: ApiFootballTeamCandidate[] = [];
  try {
    candidates = await searchTeamCandidates(searchQuery);
  } catch (err) {
    logger.warn({ err, pulsescoreName }, "[MATCHING] equipa: falha ao pesquisar na API-Football — não fica em cache, tenta-se de novo no próximo pedido");
    // Diferente de "sem correspondência" (pesquisa correu e não achou nada, isso sim fica em
    // cache permanente por design — ver docs/TEAM_MAPPING.md): aqui a pesquisa em si falhou
    // (rede, rate limit, API-Football em baixo). Cachear isto como "sem equipa" prenderia esta
    // equipa em falha para sempre — só um Reset manual no admin desbloquearia. Devolve sem
    // gravar, para o próximo pedido tentar outra vez do zero.
    return { id: "", apiFootballTeamId: null, apiFootballName: null, confidence: 0, mappingMethod: "SIMILARITY", verified: false };
  }

  let best: { candidate: ApiFootballTeamCandidate; score: number } | null = null;
  for (const c of candidates) {
    const score = calculateTeamSimilarity(searchQuery, c.name);
    if (!best || score > best.score) best = { candidate: c, score };
  }

  const sameCountry = country && best?.candidate.country ? country === best.candidate.country : undefined;
  const { confidence, method } = scoreTeamMatch({ hasAlias: Boolean(alias), similarity: best?.score ?? 0, sameCountry });
  const linked = confidence >= MIN_CONFIDENCE_TO_LINK && Boolean(best);

  logger.info(
    {
      pulsescoreName,
      usedAlias: alias ?? undefined,
      searchQuery,
      candidatesCount: candidates.length,
      candidates: candidates.slice(0, 5).map((c) => c.name),
      bestMatch: best?.candidate.name,
      similarity: best ? Math.round(best.score * 100) : 0,
      confidence,
      method,
      linked,
    },
    linked ? "[MATCHING] equipa ligada" : "[MATCHING] equipa sem correspondência suficiente"
  );

  const saved = await prisma.teamMapping.upsert({
    where: { sport_normalizedPulsescoreName: { sport, normalizedPulsescoreName } },
    create: {
      sport,
      pulsescoreName,
      normalizedPulsescoreName,
      apiFootballTeamId: linked ? best!.candidate.id : null,
      apiFootballName: linked ? best!.candidate.name : null,
      normalizedApiName: linked ? normalizeTeamName(best!.candidate.name) : null,
      country: country ?? best?.candidate.country ?? null,
      confidence,
      mappingMethod: method,
      verified: false,
    },
    // Só chega aqui quando findUnique() acima não encontrou nada — o ramo "update" só existe
    // para o caso raro de duas chamadas concorrentes para a mesma equipa nova colidirem na
    // restrição única; nesse caso mantém-se o registo que "ganhou" a corrida em vez de o
    // reescrever, para não ficar a oscilar entre duas resoluções automáticas quase iguais.
    update: {},
  });

  return toResult(saved);
}

function scoreTeamMatch(params: { hasAlias: boolean; similarity: number; sameCountry?: boolean }): { confidence: number; method: MappingMethod } {
  const { hasAlias, similarity, sameCountry } = params;
  let confidence: number;
  let method: MappingMethod;

  if (similarity >= 0.999) {
    confidence = hasAlias ? 98 : 97;
    method = hasAlias ? "ALIAS" : "NORMALIZED";
  } else if (hasAlias && similarity >= 0.5) {
    confidence = Math.round(85 + similarity * 10);
    method = "ALIAS";
  } else {
    confidence = Math.round(similarity * 90);
    method = "SIMILARITY";
  }

  if (sameCountry === true) confidence = Math.min(100, confidence + 5);
  if (sameCountry === false) confidence = Math.max(0, confidence - 15);

  return { confidence: Math.max(0, Math.min(100, confidence)), method };
}

function toResult(row: TeamMapping): TeamMatchResult {
  return {
    id: row.id,
    apiFootballTeamId: row.apiFootballTeamId,
    apiFootballName: row.apiFootballName,
    confidence: row.confidence,
    mappingMethod: row.mappingMethod,
    verified: row.verified,
  };
}
