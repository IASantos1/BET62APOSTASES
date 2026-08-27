import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import { sanitizePublicEvent, sanitizePublicEvents } from "../publicEvent";
import { ALL_SPORTS, type Sport } from "../types";
import { createRedisDuplicateClient, getRedisClient, isRedisReady } from "../../../lib/redis";
import type Redis from "ioredis";

const VALID_SPORTS: Sport[] = ALL_SPORTS;
const CHANNEL_EVENT = "bet62:ws:event";
const CHANNEL_REMOVE = "bet62:ws:remove";

interface ClientState {
  socket: WebSocket;
  sports: Set<Sport>;
  isAlive: boolean;
}

// Intervalo de ping/pong (ver HEARTBEAT_INTERVAL_MS abaixo): sem isto, uma ligação que morre sem
// um FIN/RST TCP limpo (ex: telemóvel muda de wifi para dados móveis, ou passa muito tempo em
// segundo plano) fica "presa" como OPEN dos dois lados — o cliente nunca recebe onclose, por isso
// nunca tenta religar (ver ensureLiveSocket() em app.js: só religa quando readyState > 1), e este
// servidor continua a "enviar para o vazio" um cliente que já não está a ouvir. Reportado pelo
// utilizador com atrasos reais de 20-30s no placar/odds em ao vivo depois de a app voltar de
// segundo plano — o "pisca vermelho depois verde" era exatamente este tipo de ligação zombie a
// finalmente cair, só muito mais tarde do que se esperava (o timeout TCP do sistema operativo pode
// demorar muito mais do que isto). Ping/pong é o padrão recomendado pela própria biblioteca `ws`
// para este problema exato.
const HEARTBEAT_INTERVAL_MS = 25_000;

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

    const state: ClientState = { socket, sports: new Set(requested.length ? requested : VALID_SPORTS), isAlive: true };
    clients.add(state);

    socket.send(
      JSON.stringify({
        type: "snapshot",
        // Só "live" — este canal é a lista "Ao Vivo" no frontend (renderLiveEvents em app.js
        // mostra tudo o que recebe daqui sem filtrar status). O hybridSportsService também guarda
        // jogos "scheduled" (ver comentário em routes.ts GET /events, mesmo filtro) — sem isto,
        // jogos de pré-jogo apareciam na lista "Ao Vivo" assim que a ligação abria.
        events: sanitizePublicEvents(hybridSportsService.snapshot().filter((e) => state.sports.has(e.sport) && e.status === "live")),
      })
    );

    socket.on("pong", () => {
      state.isAlive = true;
    });
    socket.on("close", () => clients.delete(state));
    socket.on("error", () => clients.delete(state));
  });

  // A cada ciclo: termina quem não respondeu ao ping anterior (ligação zombie — ver comentário de
  // HEARTBEAT_INTERVAL_MS acima) e pede um novo pong a quem sobrou. `terminate()` (não `close()`)
  // fecha já sem esperar handshake nenhum — o cliente não vai responder de qualquer forma.
  const heartbeat = setInterval(() => {
    for (const state of clients) {
      if (!state.isAlive) {
        state.socket.terminate();
        clients.delete(state);
        continue;
      }
      state.isAlive = false;
      state.socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  hybridSportsService.on("event", (event) => {
    // Mesmo filtro do snapshot inicial acima — sem isto, cada vez que sportmonks/prematch.ts
    // renova um jogo "scheduled" no hybrid (syncScheduledToHybrid, a cada 40s) esse evento
    // passava por aqui como uma atualização "Ao Vivo" normal.
    if (event.status !== "live") return;
    const publicEvent = sanitizePublicEvent(event);
    const frame = JSON.stringify({ type: "update", event: publicEvent });
    if (subscribed && publisher) {
      publisher.publish(CHANNEL_EVENT, JSON.stringify(publicEvent)).catch((err) => {
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
