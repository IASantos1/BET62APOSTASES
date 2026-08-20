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

export interface LiveSelection {
  odd: number;
  // CONFIRMED real da Pulsescore (PulsescoreSelection.isActive, ver pulsescore/client.ts) — o
  // bookmaker desativa temporariamente uma seleção (ex: durante uma revisão VAR ou logo após um
  // penálti/cartão) sem a remover do mercado. Antes disto, o código descartava seleções/mercados
  // inativos em silêncio (nunca chegavam ao frontend); agora chegam com isActive:false para a UI
  // os mostrar como suspensos (não clicáveis) em vez de os fazer desaparecer. Não há nenhum
  // campo confirmado com o MOTIVO da suspensão (VAR/pênalti/grande chance/cartão) — só este
  // sinal genérico ligado/desligado.
  isActive: boolean;
}

export interface LiveOdds {
  market: string; // e.g. "1x2", "moneyline", "total_games"
  isActive: boolean; // mercado suspenso como um todo (ver LiveSelection acima)
  selections: Record<string, LiveSelection>; // e.g. { home: {odd:1.85,isActive:true}, ... }
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
  // undefined e o frontend esconde a linha de placar (nunca inventa "0-0"). Tipo `string` além
  // de `number` porque no ténis os pontos do jogo atual nem sempre são numéricos (ex: "AD" em
  // vantagem) — passado tal como o provedor envia, em vez de descartado por não converter para
  // número (bug real: "40"/"15" apareciam bem, "AD" fazia o placar inteiro desaparecer).
  homeScore?: number | string;
  awayScore?: number | string;
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
