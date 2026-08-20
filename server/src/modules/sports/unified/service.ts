import { prisma } from "../../../lib/prisma";
import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import { resolveFixtureForEvent } from "../mapping/service";
import { getFixtureStatistics, getFixtureById, type ApiFootballStatisticsResponse } from "../apifootball/client";
import type { LiveEvent } from "../types";
import type { SourcedPair, UnifiedMatchData } from "./types";

// Nomes exatos que a API-Football usa em `statistics[].type` (CONFIRMADO via amostra real
// colada pelo utilizador, ver TEAM_STAT_LABELS em web/app.js) -> campo correspondente em
// UnifiedMatchData.statistics. "attacks"/"dangerousAttacks"/"momentum" não têm entrada aqui de
// propósito — não são um tipo de estatística que a API-Football devolva (nem a Pulsescore, em
// nenhuma amostra real confirmada) — ficam sempre `{home:null,away:null,source:null}` em vez de
// inventados, ver docs/UNIFIED_MATCH_DATA.md.
const AF_TYPE_TO_FIELD: Record<string, keyof Omit<UnifiedMatchData["statistics"], "attacks" | "dangerousAttacks" | "momentum">> = {
  "Ball Possession": "possession",
  "Total Shots": "shots",
  "Shots on Goal": "shotsOnTarget",
  "Shots off Goal": "shotsOffTarget",
  "Blocked Shots": "blockedShots",
  "Corner Kicks": "corners",
  Fouls: "fouls",
  Offsides: "offsides",
  "Yellow Cards": "yellowCards",
  "Red Cards": "redCards",
  "Total passes": "passes",
  "Passes %": "passAccuracy",
  "Goalkeeper Saves": "saves",
};

function parseStatValue(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const n = Number(raw.replace("%", "").trim());
  return Number.isFinite(n) ? n : null;
}

function apiFootballStatsByField(resp: ApiFootballStatisticsResponse | null): Partial<Record<string, { home: number | null; away: number | null }>> {
  if (!resp?.response?.length) return {};
  const [homeTeam, awayTeam] = resp.response;
  const out: Record<string, { home: number | null; away: number | null }> = {};
  for (const s of homeTeam?.statistics ?? []) {
    const field = AF_TYPE_TO_FIELD[s.type];
    if (!field) continue;
    (out[field] ??= { home: null, away: null }).home = parseStatValue(s.value);
  }
  for (const s of awayTeam?.statistics ?? []) {
    const field = AF_TYPE_TO_FIELD[s.type];
    if (!field) continue;
    (out[field] ??= { home: null, away: null }).away = parseStatValue(s.value);
  }
  return out;
}

// Pulsescore-primeiro, API-Football como reserva (spec secções 2/18) — decide por PAR (nunca
// mistura casa da Pulsescore com fora da API-Football para a mesma estatística): se a
// Pulsescore tiver valor válido para pelo menos um dos dois lados, essa é a fonte da dupla
// inteira; senão tenta a API-Football; senão fica null nos dois lados.
function pickPair(ps: { home: number | null; away: number | null } | undefined, af: { home: number | null; away: number | null } | undefined): SourcedPair {
  if (ps && (ps.home !== null || ps.away !== null)) return { home: ps.home, away: ps.away, source: "pulsescore" };
  if (af && (af.home !== null || af.away !== null)) return { home: af.home, away: af.away, source: "api-football" };
  return { home: null, away: null, source: null };
}
const NEVER_AVAILABLE: SourcedPair = { home: null, away: null, source: null };

async function buildFromLiveEvent(event: LiveEvent): Promise<UnifiedMatchData> {
  const psStats = event.statistics;
  let afStats: Partial<Record<string, { home: number | null; away: number | null }>> = {};
  let mapping = { apiFootballFixtureId: null as number | null, confidence: 0, verified: false };

  if (event.sport === "football") {
    try {
      const resolved = await resolveFixtureForEvent(event);
      if (resolved) {
        mapping.apiFootballFixtureId = resolved.fixtureId;
        const stats = await getFixtureStatistics(resolved.fixtureId).catch(() => null);
        afStats = apiFootballStatsByField(stats);
      }
      const cached = await prisma.fixtureMapping.findUnique({ where: { pulsescoreEventKey: event.id } });
      if (cached) mapping = { apiFootballFixtureId: cached.apiFootballFixtureId, confidence: cached.confidence, verified: cached.verified };
    } catch (err) {
      logger.warn({ err, matchId: event.id }, "Unified: falha ao obter estatísticas complementares da API-Football");
    }
  }

  const psPair = (home: number | undefined, away: number | undefined) => ({ home: home ?? null, away: away ?? null });

  return {
    matchId: event.id,
    sport: event.sport,
    league: event.league,
    home: { name: event.home },
    away: { name: event.away },
    score: { home: event.homeScore ?? null, away: event.awayScore ?? null, source: event.homeScore !== undefined || event.awayScore !== undefined ? "pulsescore" : null },
    status: { value: event.status, source: "pulsescore" },
    clock: { minuteOrPeriod: event.minuteOrPeriod, source: "pulsescore" },
    statistics: {
      attacks: NEVER_AVAILABLE,
      dangerousAttacks: NEVER_AVAILABLE,
      momentum: NEVER_AVAILABLE,
      possession: pickPair(undefined, afStats.possession),
      shots: pickPair(undefined, afStats.shots),
      shotsOnTarget: pickPair(undefined, afStats.shotsOnTarget),
      shotsOffTarget: pickPair(undefined, afStats.shotsOffTarget),
      blockedShots: pickPair(undefined, afStats.blockedShots),
      corners: pickPair(psPair(psStats?.home.corners, psStats?.away.corners), afStats.corners),
      fouls: pickPair(undefined, afStats.fouls),
      offsides: pickPair(undefined, afStats.offsides),
      passes: pickPair(undefined, afStats.passes),
      passAccuracy: pickPair(undefined, afStats.passAccuracy),
      yellowCards: pickPair(psPair(psStats?.home.yellowCards, psStats?.away.yellowCards), afStats.yellowCards),
      redCards: pickPair(psPair(psStats?.home.redCards, psStats?.away.redCards), afStats.redCards),
      saves: pickPair(undefined, afStats.saves),
    },
    mapping,
  };
}

/**
 * Endpoint unificado (spec secção 21) — o frontend consome só isto para uma partida, nunca a
 * Pulsescore/API-Football diretamente (nem sequer os outros endpoints /h2h, /predictions,
 * /standings, /stats já existentes, que continuam a servir os seus próprios propósitos — este é
 * o "resumo ao vivo" combinado). Caminho normal: lê o snapshot em memória da Pulsescore
 * (hybridSportsService, sempre a fonte principal) e complementa com a API-Football via o motor
 * de mapeamento persistente (mapping/service.ts).
 *
 * Caminho degradado (spec secção 24): se a Pulsescore já não tiver este evento em memória
 * (reinício do processo, evento a sair da lista de "ao vivo" antes do frontend atualizar, etc.)
 * mas já existir um fixture mapeado, usa a API-Football como substituto temporário só para
 * placar/estado/relógio — nunca deixa cair para nada só porque a Pulsescore está momentaneamente
 * sem esse evento.
 */
export async function getUnifiedMatchData(matchId: string): Promise<UnifiedMatchData | null> {
  const event = hybridSportsService.getById(matchId);
  if (event) return buildFromLiveEvent(event);

  const cached = await prisma.fixtureMapping.findUnique({ where: { pulsescoreEventKey: matchId } });
  if (!cached?.apiFootballFixtureId) return null;

  try {
    const fx = await getFixtureById(cached.apiFootballFixtureId);
    const f = fx.response[0];
    if (!f) return null;
    logger.warn({ matchId, fixtureId: cached.apiFootballFixtureId }, "Unified: evento ausente da Pulsescore — a usar API-Football como fallback degradado");
    const status = f.fixture.status.short === "FT" || f.fixture.status.short === "AET" || f.fixture.status.short === "PEN" ? "finished" : f.fixture.status.elapsed !== null ? "live" : "scheduled";
    return {
      matchId,
      sport: "football",
      league: "",
      home: { name: f.teams.home.name },
      away: { name: f.teams.away.name },
      score: { home: f.goals.home, away: f.goals.away, source: "api-football" },
      status: { value: status, source: "api-football" },
      clock: { minuteOrPeriod: f.fixture.status.elapsed !== null ? `${f.fixture.status.elapsed}'` : "", source: "api-football" },
      statistics: {
        attacks: NEVER_AVAILABLE,
        dangerousAttacks: NEVER_AVAILABLE,
        momentum: NEVER_AVAILABLE,
        possession: NEVER_AVAILABLE,
        shots: NEVER_AVAILABLE,
        shotsOnTarget: NEVER_AVAILABLE,
        shotsOffTarget: NEVER_AVAILABLE,
        blockedShots: NEVER_AVAILABLE,
        corners: NEVER_AVAILABLE,
        fouls: NEVER_AVAILABLE,
        offsides: NEVER_AVAILABLE,
        passes: NEVER_AVAILABLE,
        passAccuracy: NEVER_AVAILABLE,
        yellowCards: NEVER_AVAILABLE,
        redCards: NEVER_AVAILABLE,
        saves: NEVER_AVAILABLE,
      },
      mapping: { apiFootballFixtureId: cached.apiFootballFixtureId, confidence: cached.confidence, verified: cached.verified },
      degraded: { reason: "Pulsescore indisponível para este evento — a usar API-Football como fonte temporária" },
    };
  } catch (err) {
    logger.warn({ err, matchId }, "Unified: fallback API-Football também falhou");
    return null;
  }
}
