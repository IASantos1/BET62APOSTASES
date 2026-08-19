import type { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "../../../lib/logger";
import { hybridSportsService } from "../hybridService";
import { ALL_SPORTS, type Sport } from "../types";

const VALID_SPORTS: Sport[] = ALL_SPORTS;

interface ClientState {
  socket: WebSocket;
  sports: Set<Sport>;
}

/**
 * Internal WebSocket relay: frontend connects to /ws/live?sports=football,tennis and gets
 * the current snapshot immediately, then a stream of `{ type: "update", event }` frames as
 * Pulsescore (or the mock fallback) pushes changes. This decouples the browser from the
 * upstream provider connection entirely.
 */
export function attachSportsWebsocketGateway(httpServer: HttpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/live" });
  const clients = new Set<ClientState>();

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
    for (const client of clients) {
      if (client.sports.has(event.sport) && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(frame);
      }
    }
  });

  logger.info("Gateway websocket de desporto ativo em /ws/live");
  return wss;
}
