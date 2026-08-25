import { z } from "zod";
import "dotenv/config";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatório"),

  // Redis para escalonamento horizontal: usado por TtlCache, rate-limit store e Pub/Sub
  // entre réplicas Railway do WebSocket gateway de desporto. Opcional em desenvolvimento
  // local (sem REDIS_URL, tudo cai para Map em memória, funcional mas não partilhado entre N
  // réplicas se Railway >= 2). No Railway oficial: "redis://default:PASS@HOST:PORT"
  REDIS_URL: z.string().optional(),

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
  // "direct" = subscrição direta em api-football.com (header x-apisports-key, host
  // v3.football.api-sports.io). "rapidapi" = subscrição via RapidAPI (dois headers diferentes —
  // x-rapidapi-key + x-rapidapi-host — e outro host); ver apifootball/client.ts::apiFootballFetch.
  API_FOOTBALL_PROVIDER: z.enum(["direct", "rapidapi"]).default("direct"),
  API_FOOTBALL_RAPIDAPI_HOST: z.string().default("api-football-v1.p.rapidapi.com"),

  // --- Sportmonks (só futebol: placar/odds/estatísticas — substituto opcional da Pulsescore +
  // API-Football só para este desporto, pedido explícito do utilizador, ver sportmonks/client.ts) ---
  // Interruptor deliberado (não um "remover" definitivo) — "suspender" a Pulsescore para futebol
  // foi o pedido, por isso continua tudo implementado e pronto a reativar só mudando esta
  // variável de volta, sem alterações de código. Os outros 7 desportos NUNCA passam pela
  // Sportmonks, ficam sempre na Pulsescore.
  FOOTBALL_PROVIDER: z.enum(["pulsescore", "sportmonks"]).default("pulsescore"),
  SPORTMONKS_API_KEY: z.string().default(""),
  SPORTMONKS_BASE_URL: z.string().default("https://api.sportmonks.com/v3/football"),
  // bet365 (id 2) — confirmado na amostra real enviada pelo utilizador (rounds/{id}?...&filters=
  // bookmakers:2). Sem uma segunda amostra de outra bookmaker, fica como único bookmaker usado.
  SPORTMONKS_BOOKMAKER_ID: z.coerce.number().default(2),

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
  // Segredo partilhado configurado no painel do agente (goldslotpalase.com) — o provedor envia-o
  // de volta no header "Callback-Token" em todo pedido a POST /callback (ver casino/callback.ts).
  // Vazio por omissão = todos os callbacks são rejeitados (nunca aceitar um callback sem token
  // configurado, é o único mecanismo de autenticação confirmado — o campo "check" do corpo não
  // tem o algoritmo confirmado, por isso não é validado).
  CASINO_CALLBACK_TOKEN: z.string().default(""),

  // --- Compliance / Responsible Gambling (gating em bets e depósitos) ---
  // Desativar só em desenvolvimento local para testar o UI sem KYC.
  // Em produção é OBRIGATÓRIO (licença SRIJ/SGAJ): "requisito KYC + RG antes de depósito/aposta".
  COMPLIANCE_KYC_REQUIRED: z.coerce.boolean().default(true),
  COMPLIANCE_RG_LIMITS_ENFORCED: z.coerce.boolean().default(true),
  // IPs (separados por vírgula) que o provedor de cassino usa para fazer callbacks — whitelist
  // no POST /casino/callback. Vazio = não aplica whitelist (só confia no Callback-Token).
  CASINO_CALLBACK_IP_WHITELIST: z.string().default(""),
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
