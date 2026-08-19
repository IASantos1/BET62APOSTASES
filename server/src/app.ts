import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

import authRoutes from "./modules/auth/routes";
import userRoutes from "./modules/users/routes";
import walletRoutes from "./modules/wallet/routes";
import stripeRoutes, { stripeWebhookHandler } from "./modules/payments/stripe/routes";
import revolutRoutes from "./modules/payments/revolut/routes";
import sportsRoutes from "./modules/sports/routes";
import casinoRoutes from "./modules/casino/routes";

// server/src/app.ts e server/dist/app.js ficam ambos exatamente 2 níveis abaixo da raiz do
// monorepo (server/src e server/dist), por isso este caminho relativo funciona em dev e em prod.
const WEB_DIR = path.join(__dirname, "../../web");

export function createApp() {
  const app = express();

  // CSP desligado: o frontend usa scripts inline (tema claro/escuro automático, fallback do
  // /config.js) que a política por defeito do helmet bloquearia. As outras proteções do
  // helmet (X-Frame-Options, HSTS, noSniff, etc.) continuam ativas.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(pinoHttp({ logger }));

  // Stripe webhook needs the raw body for signature verification — must be registered
  // BEFORE express.json() so the JSON parser never touches this route's body.
  app.post("/api/payments/stripe/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);

  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok", env: env.NODE_ENV }));

  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/wallet", walletRoutes);
  app.use("/api/payments/stripe", stripeRoutes);
  app.use("/api/payments/revolut", revolutRoutes);
  app.use("/api/sports", sportsRoutes);
  app.use("/api/casino", casinoRoutes);

  // Frontend estático servido pelo mesmo processo Node — mesma origem que a API, por isso
  // o frontend não precisa de saber o domínio do backend (nada de CORS nem de variáveis
  // BET62_API_BASE/BET62_WS_BASE por ambiente).
  app.get("/config.js", (_req, res) => {
    res.type("application/javascript");
    res.send(
      "window.BET62_CONFIG = { API_BASE: '/api', " +
        "WS_BASE: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host };\n"
    );
  });
  app.use(express.static(WEB_DIR));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(WEB_DIR, "index.html"));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
