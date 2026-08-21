import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../../middleware/auth";
import { validateBody } from "../../../middleware/validate";
import { createCardDepositIntent, createMbWayDeposit, createMultibancoDeposit, getDepositStatus, handleStripeWebhookEvent } from "./service";
import { Errors } from "../../../lib/errors";

const router = Router();

router.post(
  "/deposits",
  requireAuth,
  validateBody(
    z.object({
      provider: z.enum(["STRIPE_CARD", "STRIPE_MBWAY", "STRIPE_MULTIBANCO"]),
      amountEur: z.number().positive(),
      phone: z.string().optional(), // só STRIPE_MBWAY
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const { provider, amountEur, phone } = req.body as { provider: string; amountEur: number; phone?: string };
    const userId = req.user!.id;

    if (provider === "STRIPE_CARD") {
      const result = await createCardDepositIntent({ userId, amountEur });
      return res.status(201).json(result);
    }
    if (provider === "STRIPE_MBWAY") {
      if (!phone) throw Errors.badRequest("Número de telemóvel obrigatório para MB WAY");
      const result = await createMbWayDeposit({ userId, amountEur, phone });
      return res.status(201).json(result);
    }
    const result = await createMultibancoDeposit({ userId, amountEur });
    res.status(201).json(result);
  })
);

// Sondado pelo frontend enquanto espera aprovação MB WAY na app do cliente (a confirmação
// final é assíncrona, fora do nosso controlo — o cliente tem de abrir a app e aprovar).
router.get(
  "/deposits/:id",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.params.id) throw Errors.badRequest("Parâmetro id em falta");
    const result = await getDepositStatus(req.user!.id, req.params.id);
    res.json(result);
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
