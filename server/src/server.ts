import http from "http";
import { createApp } from "./app";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { attachSportsWebsocketGateway } from "./modules/sports/websocket/gateway";
import { hybridSportsService } from "./modules/sports/hybridService";
import { seedDefaultAliases } from "./modules/sports/mapping/aliasStore";
import { settleEventFinished, checkEarlySettlement, sweepStaleBets } from "./modules/betting/settlement";
import { sweepExpiredPromotions, seedRecommendedLaunchPromotion } from "./modules/promotions/service";
import type { LiveEvent } from "./modules/sports/types";

const app = createApp();
const server = http.createServer(app);

attachSportsWebsocketGateway(server);
hybridSportsService.start();
seedDefaultAliases().catch((err) => logger.warn({ err }, "Mapping: falha ao semear aliases por omissão"));
seedRecommendedLaunchPromotion().catch((err) => logger.warn({ err }, "Promotions: falha ao semear a promoção de lançamento"));

// Liquidação de apostas — ver docs/BETTING.md. "remove" é o único momento em que o placar
// final de um evento ainda está disponível (a Pulsescore nunca reporta um estado "finished"
// explícito neste feed, o jogo só desaparece do próximo snapshot).
hybridSportsService.on("remove", (_id: string, lastKnownEvent?: LiveEvent) => {
  if (!lastKnownEvent) return; // defensivo — nunca deveria faltar, ver hybridService.ts
  settleEventFinished(lastKnownEvent).catch((err) => logger.error({ err, eventId: lastKnownEvent.id }, "[BETTING] falha ao liquidar apostas deste evento"));
});
// Liquidação antecipada (Settlement Engine, ver betting/settlement.ts) — corre a CADA snapshot
// ao vivo, ainda com o jogo a decorrer, para os poucos mercados cujo resultado já pode estar
// matematicamente decidido antes do apito final (ex: BTTS Sim, Over já ultrapassado).
hybridSportsService.on("event", (evt: LiveEvent) => {
  checkEarlySettlement(evt).catch((err) => logger.error({ err, eventId: evt.id }, "[BETTING] falha na liquidação antecipada deste evento"));
});
// Vassoura de segurança para o caso raro de o processo reiniciar a meio de um jogo e nunca ver
// o "remove" desse evento específico (o mapa em memória do hybridSportsService reconstrói-se
// do zero) — nunca inventa um resultado, só marca para revisão manual.
setInterval(() => {
  sweepStaleBets().catch((err) => logger.error({ err }, "[BETTING] falha na vassoura de apostas presas"));
}, 30 * 60_000);
// Vassoura de promoções expiradas (ver promotions/service.ts) — mesmo padrão, intervalo mais
// curto porque o prazo de uma promoção (ex: 7 dias) é uma janela fina que vale a pena fechar
// com alguma prontidão assim que passa.
setInterval(() => {
  sweepExpiredPromotions().catch((err) => logger.error({ err }, "[PROMOTIONS] falha na vassoura de promoções expiradas"));
}, 10 * 60_000);

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
