import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../../middleware/auth";
import { validateBody } from "../../../middleware/validate";
import { createDepositCheckout, handleStripeWebhookEvent } from "./service";
import { Errors } from "../../../lib/errors";

const router = Router();

router.post(
  "/deposits",
  requireAuth,
  validateBody(
    z.object({
      provider: z.enum(["STRIPE_CARD", "STRIPE_MBWAY", "STRIPE_MULTIBANCO"]),
      amountEur: z.number().positive(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    // origin do próprio pedido (nunca fixo no código) — mesmo domínio de onde o frontend fez
    // este pedido, funciona tanto no domínio final (bet62.plus) como no subdomínio do Railway.
    const origin = `${req.protocol}://${req.get("host")}`;
    const result = await createDepositCheckout({ userId: req.user!.id, origin, ...req.body });
    res.status(201).json(result);
  })
);

// Mounted separately in app.ts with express.raw() — Stripe requires the exact raw
// request body bytes to validate the webhook signature.
export const stripeWebhookHandler = asyncHandler(async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") throw Errors.badRequest("Assinatura Stripe em falta");
  const result = await handleStripeWebhookEvent(req.body as Buffer, signature);
  res.json(result);
});

export default router;
