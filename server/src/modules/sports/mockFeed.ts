import { EventEmitter } from "events";
import type { LiveEvent, LiveOdds, Sport } from "./types";

/**
 * Simulated live-event generator used when Pulsescore isn't configured (no API key) or is
 * unreachable, so the platform stays fully demoable end-to-end without paid credentials.
 * Controlled by SPORTS_DATA_MOCK_FALLBACK (default true).
 *
 * Covers all 8 sports the product wants: futebol, ténis, basquete, hóquei de gelo, beisebol,
 * voleibol, Fórmula 1 e MMA. Fórmula 1 doesn't fit a head-to-head home/away shape, so it's
 * modelled within the same LiveEvent type by repurposing `home`/`away` as the Grand Prix name
 * and session type, and putting the driver standings into the odds selections — this avoids a
 * second data shape just for one sport.
 */

interface MockMatch {
  id: string;
  sport: Sport;
  league: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  clockSeconds: number;
}

const SEED_MATCHES: MockMatch[] = [
  { id: "mock:football-1", sport: "football", league: "Primeira Liga", home: "Benfica", away: "FC Porto", homeScore: 1, awayScore: 1, clockSeconds: 38 * 60 },
  { id: "mock:football-2", sport: "football", league: "La Liga", home: "Real Madrid", away: "Barcelona", homeScore: 2, awayScore: 0, clockSeconds: 61 * 60 },
  { id: "mock:tennis-1", sport: "tennis", league: "ATP 250", home: "J. Sinner", away: "C. Alcaraz", homeScore: 1, awayScore: 1, clockSeconds: 0 },
  { id: "mock:basketball-1", sport: "basketball", league: "Euroliga", home: "Real Madrid", away: "Fenerbahçe", homeScore: 58, awayScore: 61, clockSeconds: 0 },
  { id: "mock:hockey-1", sport: "ice_hockey", league: "NHL", home: "Toronto Maple Leafs", away: "Boston Bruins", homeScore: 2, awayScore: 2, clockSeconds: 34 * 60 },
  { id: "mock:baseball-1", sport: "baseball", league: "MLB", home: "New York Yankees", away: "Boston Red Sox", homeScore: 3, awayScore: 2, clockSeconds: 0 },
  { id: "mock:volleyball-1", sport: "volleyball", league: "Superliga", home: "Sporting CP", away: "Benfica", homeScore: 2, awayScore: 1, clockSeconds: 0 },
  { id: "mock:mma-1", sport: "mma", league: "UFC Fight Night", home: "A. Pereira", away: "I. Adesanya", homeScore: 0, awayScore: 0, clockSeconds: 4 * 60 },
];

const F1_EVENT: LiveEvent = {
  id: "mock:formula1-1",
  sport: "formula1",
  league: "Fórmula 1 — Mundial de Pilotos",
  home: "GP de Interlagos",
  away: "Corrida",
  homeScore: 0,
  awayScore: 0,
  minuteOrPeriod: "Volta 32/58",
  status: "live",
  odds: [
    { market: "Vencedor da corrida", selections: { Verstappen: 1.45, Norris: 3.6, Leclerc: 6.5, Hamilton: 9.0 } },
    { market: "Pódio (top 3)", selections: { Verstappen: 1.12, Norris: 1.35, Leclerc: 1.9 } },
    { market: "Volta mais rápida", selections: { Verstappen: 2.5, Norris: 3.2, Leclerc: 4.8 } },
  ],
  updatedAt: new Date().toISOString(),
  source: "mock",
};

function randomOdds(sport: Sport, homeScore: number, awayScore: number): LiveOdds[] {
  const homeAdvantage = homeScore >= awayScore ? -0.15 : 0.15;
  const jitter = () => (Math.random() - 0.5) * 0.2;
  const home = Number(Math.max(1.2, 2.1 + homeAdvantage + jitter()).toFixed(2));
  const away = Number(Math.max(1.2, 2.1 - homeAdvantage + jitter()).toFixed(2));

  switch (sport) {
    case "football":
      return [
        { market: "1X2", selections: { home, draw: 3.4, away } },
        { market: "Total (mais/menos 2.5)", selections: { mais: 1.85, menos: 1.95 } },
        { market: "Ambas Marcam", selections: { sim: 1.7, nao: 2.1 } },
      ];
    case "basketball":
      return [
        { market: "Vencedor", selections: { home: Number((home - 0.3).toFixed(2)), away: Number((away - 0.3).toFixed(2)) } },
        { market: "Hándicap (-5.5 / +5.5)", selections: { home: 1.9, away: 1.9 } },
        { market: "Total de pontos", selections: { mais: 1.9, menos: 1.9 } },
      ];
    case "ice_hockey":
      return [
        { market: "Moneyline", selections: { home, draw: 4.2, away } },
        { market: "Total de golos", selections: { mais: 1.95, menos: 1.85 } },
      ];
    case "baseball":
      return [
        { market: "Moneyline", selections: { home, away } },
        { market: "Total de corridas", selections: { mais: 1.9, menos: 1.9 } },
      ];
    case "volleyball":
      return [
        { market: "Vencedor", selections: { home: Number((home - 0.2).toFixed(2)), away: Number((away - 0.2).toFixed(2)) } },
        { market: "Total de sets", selections: { "mais 3.5": 2.1, "menos 3.5": 1.7 } },
      ];
    case "mma":
      return [
        { market: "Vencedor do combate", selections: { home, away } },
        { market: "Método de vitória", selections: { ko_tko: 2.1, submissao: 3.4, decisao: 2.8 } },
      ];
    default:
      return [{ market: "1X2", selections: { home, draw: 3.4, away } }];
  }
}

function toLiveEvent(m: MockMatch): LiveEvent {
  const minuteOrPeriod =
    m.sport === "football" || m.sport === "ice_hockey"
      ? `${Math.min(90, Math.floor(m.clockSeconds / 60))}'`
      : m.sport === "basketball"
        ? `Q${Math.min(4, 1 + Math.floor(m.clockSeconds / 600))}`
        : m.sport === "tennis"
          ? `Set ${1 + (m.homeScore + m.awayScore) % 3}`
          : m.sport === "volleyball"
            ? `Set ${1 + (m.homeScore + m.awayScore) % 5}`
            : m.sport === "baseball"
              ? `${1 + Math.floor(m.clockSeconds / 300)}.ª entrada`
              : m.sport === "mma"
                ? `Round ${1 + Math.floor(m.clockSeconds / 300)}`
                : "";

  return {
    id: m.id,
    sport: m.sport,
    league: m.league,
    home: m.home,
    away: m.away,
    homeScore: m.homeScore,
    awayScore: m.awayScore,
    minuteOrPeriod,
    status: "live",
    odds: randomOdds(m.sport, m.homeScore, m.awayScore),
    updatedAt: new Date().toISOString(),
    source: "mock",
  };
}

export declare interface MockSportsFeed {
  on(event: "update", listener: (evt: LiveEvent) => void): this;
}

export class MockSportsFeed extends EventEmitter {
  private matches = SEED_MATCHES.map((m) => ({ ...m }));
  private timer: NodeJS.Timeout | null = null;

  start(intervalMs = 4000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): LiveEvent[] {
    return [...this.matches.map(toLiveEvent), { ...F1_EVENT, updatedAt: new Date().toISOString() }];
  }

  private tick() {
    for (const match of this.matches) {
      match.clockSeconds += 15;
      if (Math.random() < 0.08) {
        if (Math.random() < 0.5) match.homeScore += 1;
        else match.awayScore += 1;
      }
      this.emit("update", toLiveEvent(match));
    }
    this.emit("update", { ...F1_EVENT, minuteOrPeriod: nextF1Lap(), updatedAt: new Date().toISOString() });
  }
}

let f1Lap = 32;
function nextF1Lap(): string {
  f1Lap = f1Lap >= 58 ? 32 : f1Lap + 1;
  return `Volta ${f1Lap}/58`;
}

export const mockSportsFeed = new MockSportsFeed();
