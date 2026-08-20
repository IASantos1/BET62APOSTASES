import Stripe from "stripe";
import { env } from "../../../config/env";
import { Errors } from "../../../lib/errors";

let _stripe: Stripe | null = null;

/**
 * Lazily-constructed Stripe client. The server boots fine without STRIPE_SECRET_KEY
 * (sandbox/demo mode) — it only throws when a deposit is actually attempted, so the
 * rest of the platform (auth, wallet, profile) stays usable while keys are pending.
 *
 * STRIPE_MODE (sandbox|live) was declared in env.ts but never actually checked against
 * anything — dead config. Now it guards against the one mistake that matters most when
 * flipping a payments integration to production: deploying with the wrong kind of key (a
 * leftover sk_test_ while STRIPE_MODE=live, silently taking "payments" that never really
 * charge anyone; or the reverse, a real sk_live_ key accidentally active while the app still
 * thinks it's in sandbox). Fails loudly at first use instead of silently misbehaving.
 */
export function getStripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw Errors.badRequest(
      "Depósitos indisponíveis: STRIPE_SECRET_KEY não configurada neste ambiente."
    );
  }
  const expectedPrefix = env.STRIPE_MODE === "live" ? "sk_live_" : "sk_test_";
  if (!env.STRIPE_SECRET_KEY.startsWith(expectedPrefix)) {
    throw Errors.internal(
      `STRIPE_MODE=${env.STRIPE_MODE} mas STRIPE_SECRET_KEY não começa por "${expectedPrefix}" — a chave e o modo configurado não coincidem. Corrige STRIPE_MODE ou a chave antes de aceitar depósitos.`
    );
  }
  if (!_stripe) {
    _stripe = new Stripe(env.STRIPE_SECRET_KEY, {
      // NEEDS VALIDATION: confirm the latest stable API version in the Stripe dashboard
      // before going live — pin it explicitly rather than trusting the account default.
      apiVersion: "2024-06-20",
    });
  }
  return _stripe;
}
