import { EventEmitter } from "events";
import type { LiveEvent, Sport } from "./types";

/**
 * Simulated live-event generator used when Pulsescore isn't configured (no API key) or is
 * unreachable, so the platform stays fully demoable end-to-end without paid credentials.
 * Controlled by SPORTS_DATA_MOCK_FALLBACK (default true).
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
];

function randomOdds(homeScore: number, awayScore: number) {
  const homeAdvantage = homeScore >= awayScore ? -0.15 : 0.15;
  const home = Math.max(1.2, 2.1 + homeAdvantage + (Math.random() - 0.5) * 0.2);
  const away = Math.max(1.2, 2.1 - homeAdvantage + (Math.random() - 0.5) * 0.2);
  return [{ market: "1x2", selections: { home: Number(home.toFixed(2)), draw: 3.4, away: Number(away.toFixed(2)) } }];
}

function toLiveEvent(m: MockMatch): LiveEvent {
  const minuteOrPeriod =
    m.sport === "football"
      ? `${Math.min(90, Math.floor(m.clockSeconds / 60))}'`
      : m.sport === "basketball"
        ? `Q${Math.min(4, 1 + Math.floor(m.clockSeconds / 600))}`
        : `Set ${1 + (m.homeScore + m.awayScore) % 3}`;

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
    odds: randomOdds(m.homeScore, m.awayScore),
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
    return this.matches.map(toLiveEvent);
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
  }
}

export const mockSportsFeed = new MockSportsFeed();
