import { EventEmitter } from "events";
import WebSocket from "ws";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import type { LiveEvent, LiveOdds, LiveSelection, Sport } from "../types";
import { SPORT_SLUGS, bookmakerFor, orderMarketsWithPrimaryFirst, sortNumericMarketFamilies, fetchLiveSportsUnionAllBookmakers } from "./client";
import { acquireDistributedLock, refreshDistributedLock } from "../../../lib/redis";

const LOCK_KEY = "bet62:locks:pulsescore-ws";
const LOCK_TTL_MS = 45_000;
const LOCK_REFRESH_MS = 30_000;

/**
 * Real-time WebSocket feed — confirmed via the official Pulsescore documentation (not
 * guesswork, unlike most of client.ts's earlier iterations). Pattern: one connection per
 * {bookmaker, sport} pair, `wss://api.pulsescore.net/api/{bookmaker}/ws/live?key=&sport=`
 * (query-param auth, unlike REST's x-secret header), one frame/second with every live event of
 * that sport. Requires PRO/MAX/ULTRA — the plan mentioned at the start of this integration
 * (149€/mo, 3 simultaneous connections) is MAX, so this should work, but the exact plan on the
 * account actually configured isn't something this code can know in advance: if the plan is
 * too low, the server closes with code 4003 and this manager stops retrying and just leaves
 * REST polling (hybridService.ts) as the only source — no functional loss, just no live score.
 *
 * With only `maxConnections` slots (3 on MAX) and 8 sports, connections are opened for the
 * busiest sports right now (by live event count, actually sorted by eventCount in
 * fetchLiveSportsUnionAllBookmakers — ver correção de 2026-08-24 em client.ts, antes a ordem
 * vinda da Pulsescore era usada tal e qual, o que podia deixar de fora desportos populares como
 * ténis/futebol/basquetebol de forma consistente) e re-avaliado periodicamente; REST polling em
 * hybridService.ts cobre os desportos que não estão ligados por WebSocket neste momento, por
 * isso nada fica por sondar — o WS é um upgrade de latência para os desportos no topo, não um
 * substituto.
 */
const REFRESH_INTERVAL_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;

// Bet365 alone uses a versioned path (/api/v3/bet365/ws/live); every other bookmaker, including
// "paddypower" (the default here) and "unibetau" (used for Fórmula 1), is unversioned.
function wsUrlFor(sport: Sport): string {
  const bookmaker = bookmakerFor(sport);
  const slug = SPORT_SLUGS[sport];
  const base = env.PULSESCORE_REST_URL.replace(/^http/, "ws").replace(/\/api$/, "");
  const path = bookmaker === "bet365" ? "/api/v3/bet365/ws/live" : `/api/${bookmaker}/ws/live`;
  return `${base}${path}?key=${env.PULSESCORE_API_KEY}&sport=${slug}`;
}

interface WsSelection {
  name?: string;
  rawName?: string;
  decimal?: string | number;
  odds?: string | number;
  isActive?: boolean;
}
interface WsMarket {
  canonicalMarket?: string;
  rawName?: string;
  selections?: WsSelection[];
}
interface WsMatchClock {
  minute?: number;
  second?: number;
  period?: string;
}
interface WsTeamStats {
  yellowCards?: number;
  redCards?: number;
  corners?: number;
}
interface WsSetsStats {
  home: number[];
  away: number[];
  homeServe?: boolean;
}
interface WsEvent {
  eventId: string;
  league: string;
  home: string;
  away: string;
  // CRASHED PRODUCTION (2026-08-19): the official docs describe this as a single "H-A" string,
  // but paddypower's real WS frames send the SAME {home, away} string-pair object shape as its
  // REST /live-events (PulsescoreScore in client.ts) — `score.split is not a function` crashed
  // the whole Node process because this field was typed/parsed as always a string. Doc vs. real
  // sample disagreeing is a repeat of the pattern already seen elsewhere in this integration, so
  // parseScore() below now accepts both shapes defensively instead of trusting either one.
  score?: string | { home?: string | number; away?: string | number };
  live?: boolean;
  startTime?: string;
  markets?: WsMarket[];
  country?: string;
  matchClock?: WsMatchClock;
  statistics?: { football?: { home?: WsTeamStats; away?: WsTeamStats }; sets?: WsSetsStats };
}
interface WsFrame {
  type?: string; // "connected" handshake frame
  bookmaker?: string;
  sport?: string;
  plan?: string;
  validSports?: string[];
  count?: number;
  data?: WsEvent[];
}

// Accepts both the docs' "H-A" string AND the {home,away} object shape actually seen from
// paddypower — never throws, whatever unexpected shape a frame carries (see WsEvent.score above).
// No ténis, os pontos do jogo atual nem sempre são numéricos (esperava-se "AD" em vantagem) —
// nesse caso (só possível na forma {home,away}, a única confirmada com dados reais de ténis)
// passa-se a string tal como veio, em vez de descartar o placar inteiro. O valor real que a
// Pulsescore envia em vantagem ainda não foi confirmado — o placar continuava a desaparecer
// mesmo depois deste fallback, o que sugere que `score` pode ficar totalmente ausente nesse
// instante. O log com `sport === "tennis"` serve para capturar a forma real da próxima vez.
function parseScore(score: WsEvent["score"], sport: Sport): { homeScore?: number | string; awayScore?: number | string } {
  if (!score) {
    if (sport === "tennis") logger.info("Pulsescore WS: ténis sem campo score (possível estado de vantagem)");
    return {};
  }
  if (typeof score === "string") {
    const [h, a] = score.split("-").map((p) => Number(p.trim()));
    if (h === undefined || a === undefined || Number.isNaN(h) || Number.isNaN(a)) {
      if (sport === "tennis") logger.info({ score }, "Pulsescore WS: ténis com score em string não parseável");
      return {};
    }
    return { homeScore: h, awayScore: a };
  }
  if (typeof score === "object") {
    if (score.home == null || score.away == null) {
      if (sport === "tennis") logger.info({ score }, "Pulsescore WS: ténis sem score.home/away parseável (possível estado de vantagem)");
      return {};
    }
    const h = Number(score.home);
    const a = Number(score.away);
    if (Number.isNaN(h) || Number.isNaN(a)) {
      if (sport === "tennis") logger.info({ score }, "Pulsescore WS: ténis com score.home/away não-numérico (possível estado de vantagem)");
      return { homeScore: score.home, awayScore: score.away };
    }
    return { homeScore: h, awayScore: a };
  }
  return {};
}

// Mesma lógica de client.ts: futebol tem minute/second, ténis só tem period (ex: "Set 2").
function formatWsMatchClock(clock: WsMatchClock | undefined, fallback: string): string {
  if (!clock) return fallback;
  if (typeof clock.minute === "number") return `${clock.minute}'`;
  if (typeof clock.period === "string" && clock.period.trim() !== "") return clock.period;
  return fallback;
}

// Mantém as seleções inativas em vez de as descartar (ver LiveSelection em types.ts) — mesma
// lógica do REST em client.ts, para o frontend as mostrar suspensas em vez de desaparecerem.
function normalizeWsMarket(m: WsMarket): LiveOdds {
  const selections = (m.selections ?? [])
    .map((s): [string, LiveSelection] | null => {
      const odd = Number(s.odds ?? s.decimal ?? NaN);
      if (Number.isNaN(odd)) return null;
      return [s.rawName ?? s.name ?? "?", { odd, isActive: s.isActive !== false }];
    })
    .filter((entry): entry is [string, LiveSelection] => entry !== null);
  const isActive = selections.length === 0 || selections.some(([, sel]) => sel.isActive);
  return { market: m.rawName ?? m.canonicalMarket ?? "Mercado", isActive, selections: Object.fromEntries(selections) };
}

function normalizeWsEvent(e: WsEvent, sport: Sport): LiveEvent {
  const markets = sortNumericMarketFamilies(orderMarketsWithPrimaryFirst(e.markets ?? []));
  const football = e.statistics?.football;
  const sets = e.statistics?.sets;
  return {
    id: `pulsescore:${e.eventId}`,
    sport,
    league: e.league,
    home: e.home,
    away: e.away,
    ...parseScore(e.score, sport),
    minuteOrPeriod: formatWsMatchClock(e.matchClock, e.live === false ? "" : "AO VIVO"),
    status: e.live === false ? "scheduled" : "live",
    odds: markets.map(normalizeWsMarket),
    updatedAt: new Date().toISOString(),
    source: "pulsescore",
    startTime: e.startTime,
    country: e.country,
    statistics:
      football || sets
        ? { home: football?.home ?? {}, away: football?.away ?? {}, sets: sets ? { home: sets.home, away: sets.away, homeServe: sets.homeServe } : undefined }
        : undefined,
  };
}

// WebSocket close codes the server won't recover from on its own — retrying is pointless.
const CLOSE_CODES_NO_RETRY = new Set([4001, 4003, 4004, 4010, 4029]);

class PulsescoreWsManager extends EventEmitter {
  private sockets = new Map<Sport, WebSocket>();
  private reconnectTimers = new Map<Sport, NodeJS.Timeout>();
  private planTooLow = false;
  private maxConnections = 3; // matches the MAX plan (149€/mo) mentioned when this was set up
  private isLeader = false;
  private leaderRefreshTimer?: NodeJS.Timeout;

  async start() {
    if (!env.PULSESCORE_API_KEY) return;
    try {
      this.isLeader = await acquireDistributedLock(LOCK_KEY, LOCK_TTL_MS);
    } catch (err) {
      logger.warn({ err: String(err).slice(0, 200) }, "[PULSESCORE WS] falhou aquisição de lock distribuído; a usar só REST/polling nesta réplica");
      this.isLeader = false;
    }
    if (!this.isLeader) {
      logger.info("[PULSESCORE WS] outra réplica é o líder upstream; esta instância só consome Pub/Sub Redis + REST/polling");
      return;
    }
    this.leaderRefreshTimer = setInterval(async () => {
      try {
        const renewed = await refreshDistributedLock(LOCK_KEY, LOCK_TTL_MS);
        if (!renewed) {
          this.isLeader = false;
          logger.warn("[PULSESCORE WS] perdemos o lock de líder upstream; a desligar conexões WS nesta réplica");
          for (const sport of Array.from(this.sockets.keys())) this.disconnect(sport);
          if (this.leaderRefreshTimer) clearInterval(this.leaderRefreshTimer);
        }
      } catch (err) {
        logger.warn({ err: String(err).slice(0, 200) }, "[PULSESCORE WS] falhou renovação do lock líder");
      }
    }, LOCK_REFRESH_MS);
    this.refreshTargets();
    setInterval(() => this.refreshTargets(), REFRESH_INTERVAL_MS);
  }

  activeSports(): Set<Sport> {
    return new Set(this.sockets.keys());
  }

  private async refreshTargets() {
    if (!this.isLeader || this.planTooLow) return;
    let targets: Sport[];
    try {
      const liveSports = await fetchLiveSportsUnionAllBookmakers();
      // Futebol Ao Vivo é dono exclusivo da Sportmonks quando o interruptor está ligado (ver
      // sportmonks/live.ts) — sem isto, o WebSocket ligava-se a futebol na mesma (é quase sempre
      // o desporto com mais eventos) e ficava a competir com o poller da Sportmonks pelo mesmo
      // snapshot em hybridService.ts.
      const candidates = env.FOOTBALL_PROVIDER === "sportmonks" ? liveSports.filter((s) => s !== "football") : liveSports;
      targets = candidates.slice(0, this.maxConnections);
    } catch (err) {
      logger.warn({ err }, "Pulsescore WS: falha ao decidir a que desportos ligar, a manter ligações atuais");
      return;
    }

    for (const sport of targets) {
      if (!this.sockets.has(sport) && this.isLeader) this.connect(sport);
    }
    for (const sport of this.sockets.keys()) {
      if (!targets.includes(sport)) this.disconnect(sport);
    }
  }

  private connect(sport: Sport) {
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrlFor(sport));
    } catch (err) {
      logger.warn({ err, sport }, "Pulsescore WS: não foi possível abrir a ligação");
      return;
    }
    this.sockets.set(sport, ws);

    // Tudo dentro de um só try/catch, não só o JSON.parse: um frame com uma forma inesperada
    // (ex: o "score" que crashou a produção — ver nota em WsEvent acima) nunca deve derrubar o
    // processo Node inteiro. Um erro aqui fica só a saltar este frame, com aviso no log.
    ws.on("message", (raw) => {
      try {
        const frame = JSON.parse(raw.toString()) as WsFrame;
        if (frame.type === "connected") {
          logger.info({ sport, bookmaker: frame.bookmaker, plan: frame.plan }, "Pulsescore WS: ligado");
          return;
        }
        if (!frame.data) return;
        const events = frame.data.filter((e) => e && e.home && e.away).map((e) => normalizeWsEvent(e, sport));
        this.emit("snapshot", { sport, events });
      } catch (err) {
        logger.warn({ err, sport }, "Pulsescore WS: frame com forma inesperada, a ignorar este frame");
      }
    });

    ws.on("close", (code) => {
      this.sockets.delete(sport);
      if (CLOSE_CODES_NO_RETRY.has(code)) {
        if (code === 4003) {
          this.planTooLow = true;
          logger.warn("Pulsescore WS: plano atual não inclui WebSocket (precisa de PRO/MAX/ULTRA) — a usar só REST/polling");
        } else {
          logger.warn({ sport, code }, "Pulsescore WS: ligação fechada, sem nova tentativa");
        }
        return;
      }
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(sport);
        this.connect(sport);
      }, RECONNECT_DELAY_MS);
      this.reconnectTimers.set(sport, timer);
    });

    ws.on("error", (err) => {
      logger.warn({ err, sport }, "Pulsescore WS: erro de ligação");
    });
  }

  private disconnect(sport: Sport) {
    const timer = this.reconnectTimers.get(sport);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sport);
    }
    this.sockets.get(sport)?.close();
    this.sockets.delete(sport);
  }
}

export const pulsescoreWs = new PulsescoreWsManager();
