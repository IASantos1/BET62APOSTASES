import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import {
  getProfile,
  selfExclude,
  submitKyc,
  updateLimits,
  updatePersonalInfo,
  updatePreferences,
} from "./service";

const router = Router();
router.use(requireAuth);

router.get(
  "/me",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await getProfile(req.user!.id));
  })
);

router.patch(
  "/me",
  validateBody(
    z.object({
      name: z.string().min(2).max(120).optional(),
      phone: z.string().max(30).optional(),
      addressLine: z.string().max(200).optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updatePersonalInfo(req.user!.id, req.body));
  })
);

router.patch(
  "/me/preferences",
  validateBody(
    z.object({
      locale: z.enum(["pt", "en", "es"]).optional(),
      currency: z.enum(["EUR", "BRL", "USD"]).optional(),
      oddsFormat: z.enum(["decimal", "fractional", "american"]).optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updatePreferences(req.user!.id, req.body));
  })
);

router.post(
  "/me/kyc",
  validateBody(
    z.object({
      docType: z.enum(["CITIZEN_CARD", "PASSPORT", "DRIVING_LICENSE"]),
      docNumber: z.string().min(3).max(40),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.status(201).json(await submitKyc(req.user!.id, req.body.docType, req.body.docNumber));
  })
);

router.patch(
  "/me/limits",
  validateBody(
    z.object({
      dailyDepositLimit: z.number().nonnegative().optional(),
      weeklyLossLimit: z.number().nonnegative().optional(),
      sessionTimeLimitMinutes: z.number().int().min(1).max(24 * 60).optional(),
      realityCheckEnabled: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updateLimits(req.user!.id, req.body));
  })
);

router.post(
  "/me/self-exclusion",
  validateBody(
    z.object({
      days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90), z.null()]),
      reason: z.string().max(500).optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await selfExclude(req.user!.id, req.body.days, req.body.reason));
  })
);

export default router;
