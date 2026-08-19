import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../middleware/errorHandler";
import { requireAuth, requireRole, type AuthedRequest } from "../../../middleware/auth";
import { validateBody } from "../../../middleware/validate";
import { prisma } from "../../../lib/prisma";
import { Errors } from "../../../lib/errors";
import { approveAndPayWithdrawal, listWithdrawals, rejectWithdrawal, requestWithdrawal } from "./service";

function requireParamId(id: string | undefined): string {
  if (!id) throw Errors.badRequest("Parâmetro id em falta");
  return id;
}

const router = Router();
router.use(requireAuth);

const ibanSchema = z
  .string()
  .regex(/^PT50\d{21}$/, "IBAN português inválido (formato PT50 + 21 dígitos)")
  .or(z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/, "IBAN inválido"));

router.post(
  "/bank-accounts",
  validateBody(
    z.object({
      accountHolder: z.string().min(2).max(120),
      iban: z.string().min(15).max(34),
      bic: z.string().max(11).optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    const account = await prisma.bankAccount.create({
      data: { userId: req.user!.id, ...req.body },
    });
    res.status(201).json(account);
  })
);

router.get(
  "/bank-accounts",
  asyncHandler(async (req: AuthedRequest, res) => {
    const accounts = await prisma.bankAccount.findMany({ where: { userId: req.user!.id } });
    res.json(accounts);
  })
);

router.post(
  "/withdrawals",
  validateBody(z.object({ amountEur: z.number().positive(), bankAccountId: z.string().uuid() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    const withdrawal = await requestWithdrawal({ userId: req.user!.id, ...req.body });
    res.status(201).json(withdrawal);
  })
);

router.get(
  "/withdrawals",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await listWithdrawals(req.user!.id));
  })
);

// --- Compliance / back-office review (SUPPORT, ADMIN only) ---

router.post(
  "/withdrawals/:id/approve",
  requireRole("SUPPORT", "ADMIN"),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await approveAndPayWithdrawal(requireParamId(req.params.id), req.user!.id));
  })
);

router.post(
  "/withdrawals/:id/reject",
  requireRole("SUPPORT", "ADMIN"),
  validateBody(z.object({ reason: z.string().min(3).max(500) })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await rejectWithdrawal(requireParamId(req.params.id), req.user!.id, req.body.reason));
  })
);

export default router;
