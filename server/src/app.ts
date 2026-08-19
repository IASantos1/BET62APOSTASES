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

export function createApp() {
  const app = express();

  app.use(helmet());
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
