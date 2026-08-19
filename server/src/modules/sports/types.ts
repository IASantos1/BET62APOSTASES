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
  id: string; // provider-native id, prefixed with source: "pulsescore:12345" or "mock:football-1"
  sport: Sport;
  league: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  minuteOrPeriod: string; // "67'" for football, "Set 2" for tennis, "Q3" for basketball
  status: "scheduled" | "live" | "finished";
  odds: LiveOdds[];
  updatedAt: string; // ISO timestamp
  source: "pulsescore" | "mock";
  apiFootballFixtureId?: number; // present when a matching API-Football fixture id is known
}
