import { env } from "../../../config/env";
import { Errors } from "../../../lib/errors";
import { logger } from "../../../lib/logger";

/**
 * Revolut Business API client — NEEDS VALIDATION against
 * https://developer.revolut.com/docs/business/business-api (blocked from this environment,
 * could not be fetched during this build). Implemented from documented knowledge of Revolut's
 * OAuth2 "client credentials with private key JWT" flow; verify every field name/endpoint
 * against the live API reference before enabling production payouts.
 *
 * Expected flow:
 *   1. One-time manual step in Revolut Business console: register API client, generate a
 *      certificate, get REVOLUT_CLIENT_ID + upload the public key; keep the PEM private key
 *      as REVOLUT_PRIVATE_KEY.
 *   2. Exchange a signed JWT assertion for a short-lived access_token (~40 min) via
 *      POST https://b2b.revolut.com/api/1.0/auth/token (sandbox: https://sandbox-b2b.revolut.com).
 *   3. Use the access_token as a Bearer token for counterparty + payment endpoints.
 *   4. Refresh proactively before expiry (store token + expiry in memory/DB; do not hardcode).
 */

const BASE_URL =
  env.REVOLUT_ENV === "live" ? "https://b2b.revolut.com/api/1.0" : "https://sandbox-b2b.revolut.com/api/1.0";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function assertConfigured() {
  if (!env.REVOLUT_CLIENT_ID || !env.REVOLUT_PRIVATE_KEY) {
    throw Errors.badRequest(
      "Levantamentos indisponíveis: credenciais Revolut Business não configuradas neste ambiente."
    );
  }
}

async function getAccessToken(): Promise<string> {
  assertConfigured();

  if (cachedToken && cachedToken.expiresAt > Date.now() + 5_000) {
    return cachedToken.accessToken;
  }

  // NEEDS VALIDATION: exact token endpoint + JWT assertion claims (iss/sub/aud/jti) per
  // Revolut's current docs before production use.
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.REVOLUT_CLIENT_ID,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: env.REVOLUT_PRIVATE_KEY, // placeholder: replace with a signed JWT, not the raw PEM
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "Falha ao autenticar com a Revolut Business API");
    throw Errors.internal("Falha ao autenticar com o provedor de levantamentos");
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

export interface PayoutRequest {
  reference: string; // idempotency key, e.g. withdrawal.id
  amount: number;
  currency: string;
  accountHolder: string;
  iban: string;
  bic?: string | null;
}

export interface PayoutResult {
  providerPaymentId: string;
  state: "pending" | "completed" | "failed";
}

export async function sendPayout(payout: PayoutRequest): Promise<PayoutResult> {
  const token = await getAccessToken();

  // NEEDS VALIDATION: real flow requires creating/reusing a "counterparty" first
  // (POST /1.0/counterparty) and paying from a specific REVOLUT_ACCOUNT_ID, then
  // POST /1.0/pay with { request_id, account_id, receiver: { counterparty_id, account_id }, amount, currency, reference }.
  const res = await fetch(`${BASE_URL}/pay`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      request_id: payout.reference,
      account_id: env.REVOLUT_ACCOUNT_ID,
      amount: payout.amount,
      currency: payout.currency,
      reference: `Bet62 levantamento ${payout.reference}`,
      receiver: {
        name: payout.accountHolder,
        iban: payout.iban,
        bic: payout.bic ?? undefined,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    logger.error({ status: res.status, body }, "Falha ao criar payout na Revolut Business API");
    return { providerPaymentId: "", state: "failed" };
  }

  const data = (await res.json()) as { id: string; state: string };
  const state = data.state === "completed" ? "completed" : data.state === "failed" ? "failed" : "pending";
  return { providerPaymentId: data.id, state };
}
