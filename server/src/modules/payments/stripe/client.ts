import Stripe from "stripe";
import { env } from "../../../config/env";
import { Errors } from "../../../lib/errors";

let _stripe: Stripe | null = null;

/**
 * Lazily-constructed Stripe client. The server boots fine without STRIPE_SECRET_KEY
 * (sandbox/demo mode) — it only throws when a deposit is actually attempted, so the
 * rest of the platform (auth, wallet, profile) stays usable while keys are pending.
 */
export function getStripeClient(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw Errors.badRequest(
      "Depósitos por cartão indisponíveis: STRIPE_SECRET_KEY não configurada neste ambiente."
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
