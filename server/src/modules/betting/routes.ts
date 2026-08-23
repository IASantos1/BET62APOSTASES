import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { placeBets, listMyBets } from "./service";
import { getCashOutOffer, executeCashOut } from "./cashout";
import { userRateLimit } from "../../lib/userRateLimit";
import { complianceGate } from "../../lib/complianceGate";
import { Errors } from "../../lib/errors";

const router = Router();

const selectionSchema = z.object({
  eventId: z.string().min(1),
  sport: z.string().min(1),
  market: z.string().min(1),
  selection: z.string().min(1),
  odd: z.number().positive(),
  stake: z.number().positive().optional(),
});

const placeBetLimiter = userRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  redisPrefix: "bets:place",
  message: {
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Limite de apostas por minuto atingido. Tente novamente em instantes.",
    },
  },
});

router.post(
  "/",
  requireAuth,
  placeBetLimiter,
  complianceGate({
    requireKyc: true,
    requireNotSelfExcluded: true,
    checkWeeklyLossLimit: true,
  }),
  validateBody(
    z.object({
      mode: z.enum(["SIMPLES", "MULTIPLA", "BET_BUILDER"]),
      selections: z.array(selectionSchema).min(1).max(20),
      stake: z.number().positive().optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const result = await placeBets({ userId: req.user!.id, mode: req.body.mode, selections: req.body.selections, stake: req.body.stake });
    res.status(201).json(result);
  })
);

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await listMyBets(req.user!.id, { cursor });
    res.json(result);
  })
);

// Ver docs/BETTING.md#cash-out — valor recalculado do zero a cada pedido (nunca cacheado), as
// odds ao vivo mudam constantemente.
router.get(
  "/:id/cashout",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const betId = req.params.id;
    if (!betId) throw Errors.badRequest("id em falta");
    const offer = await getCashOutOffer(req.user!.id, betId);
    res.json(offer);
  })
);

router.post(
  "/:id/cashout",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const betId = req.params.id;
    if (!betId) throw Errors.badRequest("id em falta");
    const result = await executeCashOut(req.user!.id, betId);
    res.json(result);
  })
);

export default router;
