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
  "mma",
  "baseball",
  "volleyball",
  "formula1",
];

export interface LiveOdds {
  market: string; // e.g. "1x2", "moneyline", "total_games"
  selections: Record<string, number>; // e.g. { home: 1.85, draw: 3.4, away: 4.2 }
}

export interface LiveTeamStats {
  yellowCards?: number;
  redCards?: number;
  corners?: number;
}

export interface LiveSetsStatistics {
  home: number[]; // jogos ganhos por set, um índice por set (ex: [6,4] = 1º set 6, 2º set 4)
  away: number[];
  homeServe?: boolean;
}

export interface LiveStatistics {
  home: LiveTeamStats;
  away: LiveTeamStats;
  sets?: LiveSetsStatistics; // só ténis — jogos por set + quem está a servir
}

export interface LiveEvent {
  id: string; // provider-native id, prefixed with source: "pulsescore:12345"
  sport: Sport;
  league: string;
  home: string;
  away: string;
  // CONFIRMED presentes para eventos reais da bookmaker "paddypower" (matchClock/score/
  // statistics no próprio REST /live-events — ver pulsescore/client.ts). A bookmaker anterior
  // ("10bet") não os devolvia; se o bookmaker mudar de novo para uma sem estes campos, ficam
  // undefined e o frontend esconde a linha de placar (nunca inventa "0-0").
  homeScore?: number;
  awayScore?: number;
  minuteOrPeriod: string; // "67'" for football, "Set 2" for tennis, "Q3" for basketball; "" for scheduled events
  status: "scheduled" | "live" | "finished";
  odds: LiveOdds[];
  updatedAt: string; // ISO timestamp
  source: "pulsescore";
  apiFootballFixtureId?: number; // present when a matching API-Football fixture id is known
  startTime?: string; // ISO timestamp — kickoff time, present for scheduled (pré-jogo) events
  country?: string; // ISO 2-letter code (e.g. "CO", "GB"); "" for international/qualifier competitions
  statistics?: LiveStatistics; // yellow/red cards, corners — only when the bookmaker provides them
}
