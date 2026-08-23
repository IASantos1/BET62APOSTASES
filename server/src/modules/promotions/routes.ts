import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { listMyPromotions, listActivePromotionsPublic } from "./service";

const router = Router();

// Público — mostrado ANTES de aderir (secção 21 da spec: todas as regras visíveis antes da
// adesão), não exige login.
router.get(
  "/active",
  asyncHandler(async (_req, res) => {
    res.json({ promotions: await listActivePromotionsPublic() });
  })
);

router.get(
  "/mine",
  requireAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json({ promotions: await listMyPromotions(req.user!.id) });
  })
);

export default router;
