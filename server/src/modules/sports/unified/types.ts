export type StatSource = "pulsescore" | "api-football" | null;

export interface SourcedPair {
  home: number | null;
  away: number | null;
  source: StatSource;
}

/**
 * Resposta do endpoint unificado (GET /api/sports/matches/:matchId/live) — junta Pulsescore
 * (fonte principal para placar/relógio/estado/cartões/cantos) e API-Football (complementar:
 * posse/remates/faltas/passes/etc, quando disponíveis) num único objeto, com a fonte de cada
 * campo explícita. Ver docs/UNIFIED_MATCH_DATA.md para a regra de prioridade e o porquê de
 * `attacks`/`dangerousAttacks` ficarem sempre `null` (nenhuma das duas fontes reais confirmadas
 * fornece isto até agora — não inventado).
 */
export interface UnifiedMatchData {
  matchId: string; // = LiveEvent.id ("pulsescore:12345") — já é o id interno único e opaco da BET62, ver docs/UNIFIED_MATCH_DATA.md
  sport: string;
  league: string;
  home: { name: string };
  away: { name: string };
  score: { home: number | string | null; away: number | string | null; source: StatSource };
  // "pulsescore" no caminho normal (é a fonte principal, spec secção 3) — só passa a
  // "api-football" no caminho degradado (`degraded` presente), quando a Pulsescore já não tem
  // este evento em memória e se usa a API-Football como substituto temporário (spec secção 24).
  status: { value: "scheduled" | "live" | "finished"; source: StatSource };
  clock: { minuteOrPeriod: string; source: StatSource };
  statistics: {
    attacks: SourcedPair;
    dangerousAttacks: SourcedPair;
    momentum: SourcedPair;
    possession: SourcedPair;
    shots: SourcedPair;
    shotsOnTarget: SourcedPair;
    shotsOffTarget: SourcedPair;
    blockedShots: SourcedPair;
    corners: SourcedPair;
    fouls: SourcedPair;
    offsides: SourcedPair;
    passes: SourcedPair;
    passAccuracy: SourcedPair;
    yellowCards: SourcedPair;
    redCards: SourcedPair;
    saves: SourcedPair;
  };
  mapping: { apiFootballFixtureId: number | null; confidence: number; verified: boolean };
  degraded?: { reason: string };
}
