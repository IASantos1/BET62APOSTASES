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
  // source; "10bet" is the bookmaker confirmed in the sample. Change if a different source is preferred.
  PULSESCORE_BOOKMAKER: z.string().default("10bet"),

  // --- API-Football (statistics) ---
  API_FOOTBALL_KEY: z.string().default(""),
  API_FOOTBALL_BASE_URL: z.string().default("https://v3.football.api-sports.io"),

  // Fall back to simulated sports data when provider keys are absent (dev/demo mode)
  SPORTS_DATA_MOCK_FALLBACK: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
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
