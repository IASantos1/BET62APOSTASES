import { EventEmitter } from "events";
import WebSocket from "ws";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import type { LiveEvent, LiveOdds, LiveSelection, Sport } from "../types";
import { SPORT_SLUGS, bookmakerFor, orderMarketsForSport, sortNumericMarketFamilies, fetchLiveSportsWithEvents } from "./client";
import { acquireDistributedLock, refreshDistributedLock } from "../../../lib/redis";

/**
 * Pulsescore WebSocket client — reescrito do zero (2026-08-27). Um WS por {bookmaker, sport},
 * `wss://api.pulsescore.net/api/{bookmaker}/ws/live?key=&sport=` (auth por query param, ao
 * contrário do header x-secret do REST), um frame/segundo com todos os eventos ao vivo desse
 * desporto. Só disponível nos planos PRO/MAX/ULTRA — se o plano não incluir WS, o servidor fecha
 * com o código 4003 e este gestor para de tentar, deixando o polling REST (hybridService.ts)
 * como única fonte, sem perda funcional, só sem a latência extra do tempo real.
 *
 * Com apenas `maxConnections` vagas (3 no plano MAX) para 8 desportos, liga-se aos desportos
 * mais movimentados AGORA (por nº de eventos ao vivo, ver fetchLiveSportsWithEvents em
 * client.ts) — reavaliado a cada REFRESH_INTERVAL_MS. Ténis tem sempre prioridade garantida
 * (PRIORITY_WS_SPORTS), independentemente da contagem, a pedido explícito do utilizador.
 */
const REFRESH_INTERVAL_MS = 15_000;
const RECONNECT_DELAY_MS = 5_000;
const PRIORITY_WS_SPORTS: Sport[] = ["tennis"];
const LOCK_KEY = "bet62:locks:pulsescore-ws";
const LOCK_TTL_MS = 45_000;
const LOCK_REFRESH_MS = 30_000;

// bet365 é a única bookmaker com caminho versionado (/api/v3/bet365/ws/live); as outras,
// incluindo a atual ("onexbet"), são /api/{bookmaker}/ws/live.
function wsUrlFor(sport: Sport): string {
  const bookmaker = bookmakerFor(sport);
  const slug = SPORT_SLUGS[sport];
  const base = env.PULSESCORE_REST_URL.replace(/^http/, "ws").replace(/\/api$/, "");
  const path = bookmaker === "bet365" ? "/api/v3/bet365/ws/live" : `/api/${bookmaker}/ws/live`;
  return `${base}${path}?key=${env.PULSESCORE_API_KEY}&sport=${slug}`;
}

// ============================== Forma crua do frame WebSocket ==============================

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
  // A Pulsescore manda o MESMO par de strings {home,away} do REST (PulsescoreScore, ver
  // client.ts) — não a string única "H-A" que a documentação oficial descreve. Já causou um
  // crash de produção quando tratado só como string; aceite defensivamente nas duas formas.
  score?: string | { home?: string | number; away?: string | number };
  live?: boolean;
  startTime?: string;
  markets?: WsMarket[];
  country?: string;
  matchClock?: WsMatchClock;
  statistics?: { football?: { home?: WsTeamStats; away?: WsTeamStats }; sets?: WsSetsStats };
  moreInfo?: { gamePoints?: string | number | { home?: string | number; away?: string | number } };
}
interface WsFrame {
  type?: string; // "connected" = handshake
  bookmaker?: string;
  plan?: string;
  data?: WsEvent[];
}

// ============================== Normalização (mesmos factos confirmados do REST, ver client.ts) ==============================

// Ténis: moreInfo.gamePoints (pontos do jogo atual, 0/15/30/40/AD) tem sempre prioridade sobre o
// campo `score` genérico, que é ambíguo (a onexbet manda aí um valor que parece ser sets ganhos,
// não os pontos do jogo) — mesmo fix aplicado no REST (client.ts::parseScoreForSport).
function parseWsTennisGamePoints(moreInfo: WsEvent["moreInfo"]): { homeScore?: number | string; awayScore?: number | string } {
  const gp = moreInfo?.gamePoints;
  if (gp == null) return {};
  if (typeof gp === "string" || typeof gp === "number") {
    const [homeRaw, awayRaw] = String(gp).split(":").map((p) => p.trim());
    if (!homeRaw || !awayRaw) return {};
    return {
      homeScore: Number.isNaN(Number(homeRaw)) ? homeRaw : Number(homeRaw),
      awayScore: Number.isNaN(Number(awayRaw)) ? awayRaw : Number(awayRaw),
    };
  }
  if (gp.home == null || gp.away == null) return {};
  return { homeScore: gp.home, awayScore: gp.away };
}

function parseWsScore(score: WsEvent["score"], sport: Sport, moreInfo: WsEvent["moreInfo"]): { homeScore?: number | string; awayScore?: number | string } {
  if (sport === "tennis") {
    const points = parseWsTennisGamePoints(moreInfo);
    if (points.homeScore !== undefined && points.awayScore !== undefined) return points;
  }
  if (!score) return sport === "tennis" ? parseWsTennisGamePoints(moreInfo) : {};
  if (typeof score === "string") {
    const [h, a] = score.split("-").map((p) => Number(p.trim()));
    if (Number.isNaN(h) || Number.isNaN(a)) return sport === "tennis" ? parseWsTennisGamePoints(moreInfo) : {};
    return { homeScore: h, awayScore: a };
  }
  if (score.home == null || score.away == null) return sport === "tennis" ? parseWsTennisGamePoints(moreInfo) : {};
  const h = Number(score.home);
  const a = Number(score.away);
  if (Number.isNaN(h) || Number.isNaN(a)) return { homeScore: score.home, awayScore: score.away }; // ex: ténis em vantagem ("AD")
  return { homeScore: h, awayScore: a };
}

function formatWsMatchClock(clock: WsMatchClock | undefined, fallback: string): string {
  if (!clock) return fallback;
  if (typeof clock.minute === "number") return `${clock.minute}'`;
  if (typeof clock.period === "string" && clock.period.trim() !== "") return clock.period;
  return fallback;
}

// A KEY de cada seleção (rótulo mostrado no frontend) é `rawName` (pode vir truncado/abreviado,
// ex: ténis "Vi Sachko"), mas `canonicalName` (de `name`) é o nome mais completo/normalizado que
// web/app.js usa para confirmar que a seleção é mesmo o jogador/equipa deste jogo — NUNCA
// descartar `name` mesmo quando `rawName` também existe.
function normalizeWsMarket(m: WsMarket): LiveOdds {
  const selections = (m.selections ?? [])
    .map((s): [string, LiveSelection] | null => {
      const odd = Number(s.odds ?? s.decimal ?? NaN);
      if (Number.isNaN(odd)) return null;
      return [s.rawName ?? s.name ?? "?", { odd, isActive: s.isActive !== false, canonicalName: s.name }];
    })
    .filter((entry): entry is [string, LiveSelection] => entry !== null);
  const isActive = selections.length === 0 || selections.some(([, sel]) => sel.isActive);
  return { market: m.rawName ?? m.canonicalMarket ?? "Mercado", isActive, selections: Object.fromEntries(selections) };
}

function normalizeWsEvent(e: WsEvent, sport: Sport): LiveEvent {
  const markets = sortNumericMarketFamilies(orderMarketsForSport(sport, e.markets ?? []));
  const football = e.statistics?.football;
  const sets = e.statistics?.sets;
  return {
    id: `pulsescore:${e.eventId}`,
    sport,
    league: e.league,
    home: e.home,
    away: e.away,
    ...parseWsScore(e.score, sport, e.moreInfo),
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

function prioritizeWsSports(candidates: Sport[], maxConnections: number): Sport[] {
  const prioritized = PRIORITY_WS_SPORTS.filter((sport) => candidates.includes(sport));
  const remaining = candidates.filter((sport) => !prioritized.includes(sport));
  return [...prioritized, ...remaining].slice(0, maxConnections);
}

// Códigos de fecho que o servidor não recupera sozinho — repetir só desperdiça pedidos.
const CLOSE_CODES_NO_RETRY = new Set([4001, 4003, 4004, 4010, 4029]);

class PulsescoreWsManager extends EventEmitter {
  private sockets = new Map<Sport, WebSocket>();
  private reconnectTimers = new Map<Sport, NodeJS.Timeout>();
  private planTooLow = false;
  private maxConnections = 3; // plano MAX (149€/mês)
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
      const liveSports = await fetchLiveSportsWithEvents();
      // Futebol Ao Vivo é dono exclusivo da Sportmonks quando FOOTBALL_PROVIDER=sportmonks — sem
      // isto, o WS ligava-se a futebol na mesma (quase sempre o desporto com mais eventos) e
      // competia com o poller da Sportmonks pelo mesmo snapshot em hybridService.ts.
      const candidates = env.FOOTBALL_PROVIDER === "sportmonks" ? liveSports.filter((s) => s !== "football") : liveSports;
      targets = prioritizeWsSports(candidates, this.maxConnections);
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

    // Tudo dentro de um só try/catch, não só o JSON.parse: um frame com forma inesperada nunca
    // deve derrubar o processo Node inteiro — só salta este frame, com aviso no log.
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
