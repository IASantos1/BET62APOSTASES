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
import adminRoutes from "./modules/admin/routes";
import { maintenanceGate } from "./modules/admin/maintenanceGate";

// server/src/app.ts e server/dist/app.js ficam ambos exatamente 2 níveis abaixo da raiz do
// monorepo (server/src e server/dist), por isso este caminho relativo funciona em dev e em prod.
const WEB_DIR = path.join(__dirname, "../../web");

export function createApp() {
  const app = express();

  // Sem isto, o Railway (proxy TLS na frente do processo, HTTP puro internamente) fazia
  // req.protocol devolver sempre "http" e req.ip devolver sempre o IP interno do proxy — nunca
  // o IP real do cliente. Efeitos reais, não cosméticos: os IPs guardados no AuditLog
  // (auth/routes.ts) ficavam todos iguais (inúteis para investigar um login suspeito), o
  // limitador de tentativas de login (express-rate-limit, mesma chave por omissão = req.ip)
  // ficava a partilhar UM balde entre todos os utilizadores em vez de um por pessoa, e os
  // success_url/cancel_url do Stripe Checkout (payments/stripe/routes.ts) saíam com "http://"
  // mesmo em produção. "1" confia no primeiro salto à frente do processo — exatamente o que o
  // Railway é aqui (não há mais nenhum proxy entre o Railway e este processo).
  app.set("trust proxy", 1);

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

  // Bloqueia /api/* para jogadores quando o admin liga o modo de manutenção (definições da
  // plataforma) — exceto o próprio painel admin e login/refresh/logout (ver maintenanceGate.ts).
  app.use(maintenanceGate);

  app.use("/api/auth", authRoutes);
  app.use("/api/users", userRoutes);
  app.use("/api/wallet", walletRoutes);
  app.use("/api/payments/stripe", stripeRoutes);
  app.use("/api/payments/revolut", revolutRoutes);
  app.use("/api/sports", sportsRoutes);
  app.use("/api/casino", casinoRoutes);
  app.use("/api/admin", adminRoutes);

  // Frontend estático servido pelo mesmo processo Node — mesma origem que a API, por isso
  // o frontend não precisa de saber o domínio do backend (nada de CORS nem de variáveis
  // BET62_API_BASE/BET62_WS_BASE por ambiente).
  app.get("/config.js", (_req, res) => {
    res.type("application/javascript");
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.send(
      "window.BET62_CONFIG = { API_BASE: '/api', " +
        "WS_BASE: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host, " +
        // Publishable key — safe to ship to the browser by design (it's not the secret key),
        // needed by Stripe.js to mount the card field inline in our own deposit modal instead
        // of redirecting to a Stripe-hosted page (ver payments/stripe/service.ts).
        `STRIPE_PUBLISHABLE_KEY: ${JSON.stringify(env.STRIPE_PUBLISHABLE_KEY)} };\n`
    );
  });
  // "no-cache, must-revalidate" em vez de deixar o express.static usar o seu default (que
  // permite servir uma cópia em cache sem sequer voltar a perguntar ao servidor) — o site tem
  // `apple-mobile-web-app-capable` (index.html), que deixa adicionar ao ecrã principal do iOS;
  // esse modo standalone é conhecido por prender uma versão antiga do app.js/index.html durante
  // muito tempo sem ir buscar a nova (confirmado: botões novos não apareciam mesmo com o deploy
  // já feito). Isto não desliga a cache — só obriga a validar com o servidor (ETag/
  // If-None-Match) antes de reutilizar, o que continua a devolver 304 quando nada mudou.
  app.use(
    express.static(WEB_DIR, {
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      },
    })
  );
  // Painel administrativo: SPA própria, à parte da dos jogadores (login e token separados —
  // ver admin.js) — precisa de vir ANTES do catch-all abaixo, que serviria index.html (a SPA de
  // jogador) para qualquer caminho, incluindo /admin.
  app.get(/^\/admin(\/.*)?$/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.sendFile(path.join(WEB_DIR, "admin.html"));
  });

  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.sendFile(path.join(WEB_DIR, "index.html"));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
