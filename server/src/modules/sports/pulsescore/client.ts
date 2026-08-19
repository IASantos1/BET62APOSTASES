import { EventEmitter } from "events";
import WebSocket from "ws";
import { env } from "../../../config/env";
import { logger } from "../../../lib/logger";
import type { LiveEvent, Sport } from "../types";

/**
 * Pulsescore.com live websocket client (plan: 3 canais — futebol, ténis, basquete).
 *
 * NEEDS VALIDATION against Pulsescore's own docs: this environment's network egress proxy
 * blocks pulsescore.com, so the exact connection URL, auth handshake, subscription message
 * shape, and payload fields below are a best-effort integration contract, not confirmed API
 * behaviour. Before going live:
 *   1. Confirm the real WS endpoint + whether auth is a query param, a header (ws headers are
 *      supported by the `ws` package via the `options.headers` field used below), or an
 *      initial auth frame sent after connecting.
 *   2. Confirm the subscribe message format and the shape of update frames per sport.
 *   3. Confirm reconnect/heartbeat requirements (ping/pong interval, session resume tokens).
 *
 * The `normalize()` function is the single place that would need updating once the real
 * payload shape is confirmed — everything downstream consumes the normalized `LiveEvent` type.
 */

const SPORTS: Sport[] = ["football", "tennis", "basketball"];
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

export declare interface PulsescoreClient {
  on(event: "update", listener: (evt: LiveEvent) => void): this;
  on(event: "status", listener: (status: "connected" | "disconnected" | "unavailable") => void): this;
}

export class PulsescoreClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;

  get isConfigured(): boolean {
    return Boolean(env.PULSESCORE_API_KEY);
  }

  connect(): void {
    if (!this.isConfigured) {
      logger.warn("Pulsescore: PULSESCORE_API_KEY não definida — websocket desativado (usar fallback simulado)");
      this.emit("status", "unavailable");
      return;
    }

    this.closedByUser = false;
    this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  private openSocket() {
    const url = `${env.PULSESCORE_WS_URL}?apiKey=${encodeURIComponent(env.PULSESCORE_API_KEY)}`;
    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.emit("status", "connected");
      logger.info("Pulsescore: websocket conectado");
      this.ws?.send(JSON.stringify({ action: "subscribe", channels: SPORTS }));
    });

    this.ws.on("message", (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        const event = normalize(payload);
        if (event) this.emit("update", event);
      } catch (err) {
        logger.warn({ err }, "Pulsescore: falha ao processar mensagem");
      }
    });

    this.ws.on("close", () => {
      this.emit("status", "disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      logger.error({ err }, "Pulsescore: erro no websocket");
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    logger.info({ delay }, "Pulsescore: a tentar reconectar");
    setTimeout(() => this.openSocket(), delay);
  }
}

// NEEDS VALIDATION: placeholder mapping of an assumed Pulsescore payload shape to LiveEvent.
function normalize(payload: any): LiveEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const sport = payload.sport as Sport;
  if (!SPORTS.includes(sport)) return null;

  return {
    id: `pulsescore:${payload.matchId ?? payload.id}`,
    sport,
    league: payload.league ?? payload.competition ?? "—",
    home: payload.home?.name ?? payload.homeTeam ?? "?",
    away: payload.away?.name ?? payload.awayTeam ?? "?",
    homeScore: Number(payload.home?.score ?? payload.homeScore ?? 0),
    awayScore: Number(payload.away?.score ?? payload.awayScore ?? 0),
    minuteOrPeriod: String(payload.clock ?? payload.period ?? ""),
    status: payload.status === "finished" ? "finished" : payload.status === "live" ? "live" : "scheduled",
    odds: Array.isArray(payload.odds)
      ? payload.odds.map((m: any) => ({ market: m.market, selections: m.selections }))
      : [],
    updatedAt: new Date().toISOString(),
    source: "pulsescore",
  };
}

export const pulsescoreClient = new PulsescoreClient();
