import http from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { attachSportsWebsocketGateway } from "./modules/sports/websocket/gateway";
import { hybridSportsService } from "./modules/sports/hybridService";

const app = createApp();
const server = http.createServer(app);

attachSportsWebsocketGateway(server);
hybridSportsService.start();

server.listen(env.PORT, () => {
  logger.info(`Bet62 API a correr em http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string) {
  logger.info({ signal }, "A encerrar servidor...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
