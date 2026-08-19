export type Sport =
  | "football"
  | "tennis"
  | "basketball"
  | "ice_hockey"
  | "baseball"
  | "volleyball"
  | "formula1"
  | "mma";

export const ALL_SPORTS: Sport[] = [
  "football",
  "tennis",
  "basketball",
  "ice_hockey",
  "baseball",
  "volleyball",
  "formula1",
  "mma",
];

export interface LiveOdds {
  market: string; // e.g. "1x2", "moneyline", "total_games"
  selections: Record<string, number>; // e.g. { home: 1.85, draw: 3.4, away: 4.2 }
}

export interface LiveEvent {
  id: string; // provider-native id, prefixed with source: "pulsescore:12345"
  sport: Sport;
  league: string;
  home: string;
  away: string;
  // Ausente para eventos reais da Pulsescore: a API confirmou não devolver placar/relógio
  // (ver pulsescore/client.ts) — só o feed simulado preenche estes campos.
  homeScore?: number;
  awayScore?: number;
  minuteOrPeriod: string; // "67'" for football, "Set 2" for tennis, "Q3" for basketball; "" for scheduled events
  status: "scheduled" | "live" | "finished";
  odds: LiveOdds[];
  updatedAt: string; // ISO timestamp
  source: "pulsescore";
  apiFootballFixtureId?: number; // present when a matching API-Football fixture id is known
  startTime?: string; // ISO timestamp — kickoff time, present for scheduled (pré-jogo) events
}
