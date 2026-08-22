import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatório"),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET deve ter pelo menos 32 caracteres"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET deve ter pelo menos 32 caracteres"),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(30),

  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  // --- Stripe (deposits: card, MB WAY, Multibanco) ---
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_MODE: z.enum(["sandbox", "live"]).default("sandbox"),
  // Publishable (pk_test_/pk_live_) — safe to expose to the frontend by design (never secret),
  // needed by Stripe.js/Elements to mount the card field in our own deposit modal (see
  // GET /config.js in app.ts). Only card needs Stripe.js at all — MB WAY/Multibanco are
  // confirmed server-side (see payments/stripe/service.ts), no client-side Stripe involved.
  STRIPE_PUBLISHABLE_KEY: z.string().default(""),

  // --- Revolut Business (withdrawals / payouts) ---
  REVOLUT_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  REVOLUT_CLIENT_ID: z.string().default(""),
  REVOLUT_CLIENT_SECRET: z.string().default(""),
  REVOLUT_PRIVATE_KEY: z.string().default(""), // JWT-signed client assertion key (PEM)
  REVOLUT_ACCOUNT_ID: z.string().default(""), // source account for payouts

  // --- Pulsescore (odds aggregator: REST, confirmed via a real example request/response) ---
  // Auth is the "x-secret" HTTP header, not a query param — confirmed from a live sample call.
  PULSESCORE_API_KEY: z.string().default(""),
  PULSESCORE_REST_URL: z.string().default("https://api.pulsescore.net/api"),
  // Endpoint shape is /{bookmaker}/{sport}/leagues — Pulsescore aggregates odds per bookmaker
  // source. Switched from "10bet" to "paddypower": confirmed via real /live-events samples that
  // paddypower's REST live-events already includes matchClock, score and statistics (10bet's
  // REST did not — see pulsescore/client.ts). Change if a different source is preferred.
  PULSESCORE_BOOKMAKER: z.string().default("paddypower"),

  // --- API-Football (statistics) ---
  API_FOOTBALL_KEY: z.string().default(""),
  API_FOOTBALL_BASE_URL: z.string().default("https://v3.football.api-sports.io"),

  // --- Documentos KYC (upload de documento pessoal + extrato bancário) ---
  // Caminho local (relativo à raiz do processo) onde os ficheiros ficam guardados — NEEDS
  // VALIDATION antes de produção: sem um volume persistente do Railway montado neste caminho,
  // um redeploy apaga tudo (o sistema de ficheiros do container é efémero). Ver docs/KYC_DOCUMENTS.md.
  KYC_UPLOAD_DIR: z.string().default("uploads/kyc"),

  // --- Cassino Gold Palace (goldslotpalase.com, Agent API v4) ---
  // Reconstruído endpoint a endpoint, só com chamadas confirmadas ao vivo pelo utilizador (ver
  // docs/CASINO_SLOTS.md). Auth: "Authorization: Bearer {CASINO_AGENT_KEY}" em todos os pedidos.
  CASINO_AGENT_KEY: z.string().default(""),
  CASINO_PROVIDER_BASE_URL: z.string().default("https://agent.goldslotpalase.com"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Variáveis de ambiente inválidas:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();

export const isProd = env.NODE_ENV === "production";
