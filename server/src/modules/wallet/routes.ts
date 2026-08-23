import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { getWalletByUserId, listLedgerEntries } from "./service";

const router = Router();
router.use(requireAuth);

router.get(
  "/balance",
  asyncHandler(async (req: AuthedRequest, res) => {
    const wallet = await getWalletByUserId(req.user!.id);
    res.json({
      currency: wallet.currency,
      balance: wallet.balance,
      lockedBalance: wallet.lockedBalance,
      available: wallet.balance.sub(wallet.lockedBalance),
      bonusBalance: wallet.bonusBalance,
    });
  })
);

router.get(
  "/transactions",
  asyncHandler(async (req: AuthedRequest, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const result = await listLedgerEntries(req.user!.id, { limit, cursor });
    res.json(result);
  })
);

export default router;
