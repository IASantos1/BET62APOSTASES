import { getPrematchEvents } from "../prematch/service";
import { ALL_SPORTS, type Sport } from "../types";

const CACHE_TTL_MS = 60_000;
let cache: { competitions: Competition[]; fetchedAt: number } | null = null;

export interface Competition {
  league: string;
  sport: Sport;
  eventCount: number;
}

// Nomes (ou fragmentos) de ligas grandes, por ordem de preferência — usado só para ordenar o
// topo da lista "Competições" do menu lateral; qualquer liga fora desta lista continua a
// aparecer, só fica ordenada por número de jogos do dia. Comparação por "contém" (case
// insensitive) porque a Pulsescore devolve o nome completo da liga (ex: "England - Premier
// League"), não um código fixo.
const BIG_LEAGUES = [
  "Champions League",
  "Premier League",
  "La Liga",
  "Serie A",
  "Bundesliga",
  "Ligue 1",
  "Primeira Liga",
  "Europa League",
  "NBA",
  "Euroliga",
  "EuroLeague",
  "ATP",
  "WTA",
  "Roland Garros",
  "Wimbledon",
  "US Open",
  "Australian Open",
  "UFC",
  "NHL",
  "MLB",
];

function bigLeagueRank(league: string): number {
  const idx = BIG_LEAGUES.findIndex((name) => league.toLowerCase().includes(name.toLowerCase()));
  return idx === -1 ? -1 : BIG_LEAGUES.length - idx; // maior = mais prioritário
}

function isToday(isoDate: string | undefined): boolean {
  if (!isoDate) return false;
  const d = new Date(isoDate);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

/**
 * Top-5 ligas com jogos hoje para o menu lateral "Competições", com preferência para ligas
 * grandes (ver BIG_LEAGUES) e desempate por número de jogos do dia. Reutiliza a mesma cache de
 * 45s de getPrematchEvents() por desporto — não dispara pedidos extra à Pulsescore.
 */
export async function getTodayCompetitions(): Promise<Competition[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.competitions;

  const byLeague = new Map<string, Competition>();
  const results = await Promise.allSettled(ALL_SPORTS.map((sport) => getPrematchEvents(sport)));

  results.forEach((result, i) => {
    if (result.status !== "fulfilled") return;
    const sport = ALL_SPORTS[i]!;
    for (const evt of result.value.events) {
      if (!isToday(evt.startTime)) continue;
      const key = `${sport}:${evt.league}`;
      const existing = byLeague.get(key);
      if (existing) existing.eventCount += 1;
      else byLeague.set(key, { league: evt.league, sport, eventCount: 1 });
    }
  });

  const competitions = [...byLeague.values()].sort((a, b) => {
    const rankDiff = bigLeagueRank(b.league) - bigLeagueRank(a.league);
    return rankDiff !== 0 ? rankDiff : b.eventCount - a.eventCount;
  });

  const top5 = competitions.slice(0, 5);
  cache = { competitions: top5, fetchedAt: Date.now() };
  return top5;
}
