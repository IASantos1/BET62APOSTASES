import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import { ALL_SPORTS, type Sport } from "../types";
import { createRedisDuplicateClient, getRedisClient, isRedisReady } from "../../../lib/redis";
import type Redis from "ioredis";

const VALID_SPORTS: Sport[] = ALL_SPORTS;
const CHANNEL_EVENT = "bet62:ws:event";
const CHANNEL_REMOVE = "bet62:ws:remove";

interface ClientState {
  socket: WebSocket;
  sports: Set<Sport>;
}

/**
 * Internal WebSocket relay + Redis Pub/Sub bridge:
 * - Em 1 réplica Railway, o caminho é o antigo (hybrid -> clientes WS locais).
 * - Em N réplicas Railway com REDIS_URL:
 *     * híbrido emite "event"/"remove" -> publica nos canais Redis
 *     * TODAS as réplicas subscrevem -> enviam o frame aos seus clientes WS locais.
 *   Sem isto, um evento recebido pela Pulsescore só chega aos clientes WS conectados à mesma réplica.
 */
export function attachSportsWebsocketGateway(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/live" });
  const clients = new Set<ClientState>();
  let subscriber: Redis | null = null;
  let publisher: Redis | null = null;
  let subscribed = false;

  const redis = getRedisClient();
  if (redis && isRedisReady()) {
    subscriber = createRedisDuplicateClient();
    publisher = redis;
    if (subscriber) {
      subscriber.subscribe(CHANNEL_EVENT, CHANNEL_REMOVE).catch((err) => {
        logger.warn({ err: String(err).slice(0, 200) }, "[WS REDIS] falhou subscribe, a usar apenas broadcast local");
        subscriber = null;
      });
      subscriber.on("message", (channel, raw) => {
        try {
          if (channel === CHANNEL_EVENT) {
            const event = JSON.parse(raw);
            const frame = JSON.stringify({ type: "update", event });
            for (const client of clients) {
              if (client.sports.has(event.sport) && client.socket.readyState === WebSocket.OPEN) {
                client.socket.send(frame);
              }
            }
          } else if (channel === CHANNEL_REMOVE) {
            const id = raw;
            const frame = JSON.stringify({ type: "remove", id });
            for (const client of clients) {
              if (client.socket.readyState === WebSocket.OPEN) client.socket.send(frame);
            }
          }
        } catch (err) {
          logger.warn({ err: String(err).slice(0, 200), channel, raw: raw.slice(0, 200) }, "[WS REDIS] frame inválido, a ignorar");
        }
      });
      subscribed = true;
    }
  }

  wss.on("connection", (socket, req) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const requested = (url.searchParams.get("sports") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is Sport => VALID_SPORTS.includes(s as Sport));

    const state: ClientState = { socket, sports: new Set(requested.length ? requested : VALID_SPORTS) };
    clients.add(state);

    socket.send(
      JSON.stringify({
        type: "snapshot",
        events: hybridSportsService.snapshot().filter((e) => state.sports.has(e.sport)),
      })
    );

    socket.on("close", () => clients.delete(state));
    socket.on("error", () => clients.delete(state));
  });

  hybridSportsService.on("event", (event) => {
    const frame = JSON.stringify({ type: "update", event });
    if (subscribed && publisher) {
      publisher.publish(CHANNEL_EVENT, JSON.stringify(event)).catch((err) => {
        logger.warn({ err: String(err).slice(0, 200) }, "[WS REDIS] falhou publish event; fallback a broadcast local");
        for (const client of clients) {
          if (client.sports.has(event.sport) && client.socket.readyState === WebSocket.OPEN) {
            client.socket.send(frame);
          }
        }
      });
    } else {
      for (const client of clients) {
        if (client.sports.has(event.sport) && client.socket.readyState === WebSocket.OPEN) {
          client.socket.send(frame);
        }
      }
    }
  });

  hybridSportsService.on("remove", (id: string) => {
    const frame = JSON.stringify({ type: "remove", id });
    if (subscribed && publisher) {
      publisher.publish(CHANNEL_REMOVE, String(id)).catch((err) => {
        logger.warn({ err: String(err).slice(0, 200) }, "[WS REDIS] falhou publish remove; fallback a broadcast local");
        for (const client of clients) {
          if (client.socket.readyState === WebSocket.OPEN) client.socket.send(frame);
        }
      });
    } else {
      for (const client of clients) {
        if (client.socket.readyState === WebSocket.OPEN) client.socket.send(frame);
      }
    }
  });

  logger.info({ redisPubSub: subscribed ? "ON" : "OFF" }, "Gateway websocket de desporto ativo em /ws/live");
  return wss;
}
