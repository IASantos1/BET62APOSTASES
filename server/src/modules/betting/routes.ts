import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { placeBets, listMyBets } from "./service";

const router = Router();

const selectionSchema = z.object({
  eventId: z.string().min(1),
  sport: z.string().min(1),
  market: z.string().min(1),
  selection: z.string().min(1),
  odd: z.number().positive(),
  stake: z.number().positive().optional(),
});

router.post(
  "/",
  requireAuth,
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

export default router;
