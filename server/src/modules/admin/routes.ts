import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, requireRole, type AuthedRequest } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { Errors } from "../../lib/errors";
import { approveAndPayWithdrawal, rejectWithdrawal } from "../payments/revolut/service";
import { getAgentInfo } from "../casino/apiClient";
import {
  getDashboardStats,
  listUsers,
  getUserDetail,
  updateUserStatus,
  updateUserRole,
  adjustUserBalance,
  listKycSubmissions,
  reviewKyc,
  listWithdrawalsAdmin,
  listDepositsAdmin,
  listSelfExclusions,
  listCasinoGamesAdmin,
  setCasinoGameOverride,
  listCasinoTransactionsAdmin,
  listAuditLogs,
  getSettings,
  updateSettings,
} from "./service";

function requireParamId(id: string | undefined): string {
  if (!id) throw Errors.badRequest("Parâmetro em falta");
  return id;
}

function pageQuery(req: AuthedRequest) {
  return {
    page: req.query.page ? Number(req.query.page) : undefined,
    limit: req.query.limit ? Number(req.query.limit) : undefined,
  };
}

const router = Router();
// Todo o painel admin exige um token válido de conta com role ADMIN — não há acesso self-serve
// a este papel (ver docs/ADMIN.md para como promover a primeira conta via SQL/Prisma Studio).
router.use(requireAuth, requireRole("ADMIN"));

router.get(
  "/dashboard",
  asyncHandler(async (_req, res) => res.json(await getDashboardStats()))
);

// --- Utilizadores ---

router.get(
  "/users",
  asyncHandler(async (req: AuthedRequest, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const status = typeof req.query.status === "string" ? (req.query.status as any) : undefined;
    const role = typeof req.query.role === "string" ? (req.query.role as any) : undefined;
    res.json(await listUsers({ search, status, role, ...pageQuery(req) }));
  })
);

router.get(
  "/users/:id",
  asyncHandler(async (req: AuthedRequest, res) => res.json(await getUserDetail(requireParamId(req.params.id))))
);

router.patch(
  "/users/:id/status",
  validateBody(z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "CLOSED"]) })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updateUserStatus(requireParamId(req.params.id), req.body.status, req.user!.id));
  })
);

router.patch(
  "/users/:id/role",
  validateBody(z.object({ role: z.enum(["USER", "SUPPORT", "ADMIN"]) })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updateUserRole(requireParamId(req.params.id), req.body.role, req.user!.id));
  })
);

router.post(
  "/users/:id/adjust-balance",
  validateBody(z.object({ amount: z.number().refine((n) => n !== 0, "Valor não pode ser zero"), reason: z.string().min(3).max(300) })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await adjustUserBalance(requireParamId(req.params.id), req.body.amount, req.body.reason, req.user!.id));
  })
);

// --- KYC ---

router.get(
  "/kyc",
  asyncHandler(async (req: AuthedRequest, res) => {
    const status = typeof req.query.status === "string" ? (req.query.status as any) : undefined;
    res.json(await listKycSubmissions({ status, ...pageQuery(req) }));
  })
);

router.patch(
  "/kyc/:id",
  validateBody(z.object({ status: z.enum(["APPROVED", "REJECTED"]), rejectionReason: z.string().max(500).optional() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await reviewKyc(requireParamId(req.params.id), req.body.status, req.body.rejectionReason, req.user!.id));
  })
);

// --- Levantamentos (aprovação/rejeição reaproveita payments/revolut/service.ts) ---

router.get(
  "/withdrawals",
  asyncHandler(async (req: AuthedRequest, res) => {
    const status = typeof req.query.status === "string" ? (req.query.status as any) : undefined;
    res.json(await listWithdrawalsAdmin({ status, ...pageQuery(req) }));
  })
);

router.post(
  "/withdrawals/:id/approve",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await approveAndPayWithdrawal(requireParamId(req.params.id), req.user!.id));
  })
);

router.post(
  "/withdrawals/:id/reject",
  validateBody(z.object({ reason: z.string().min(3).max(500) })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await rejectWithdrawal(requireParamId(req.params.id), req.user!.id, req.body.reason));
  })
);

// --- Depósitos (só leitura — o estado é dirigido pelo webhook do Stripe) ---

router.get(
  "/deposits",
  asyncHandler(async (req: AuthedRequest, res) => {
    const status = typeof req.query.status === "string" ? (req.query.status as any) : undefined;
    res.json(await listDepositsAdmin({ status, ...pageQuery(req) }));
  })
);

// --- Jogo responsável ---

router.get(
  "/self-exclusions",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await listSelfExclusions({ activeOnly: req.query.active !== "false" }));
  })
);

// --- Cassino ---

router.get(
  "/casino/games",
  asyncHandler(async (req: AuthedRequest, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    res.json(await listCasinoGamesAdmin({ search, category, ...pageQuery(req) }));
  })
);

router.patch(
  "/casino/games/:gameCode",
  validateBody(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await setCasinoGameOverride(requireParamId(req.params.gameCode), req.body.enabled, req.user!.id));
  })
);

router.get(
  "/casino/transactions",
  asyncHandler(async (req: AuthedRequest, res) => {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    res.json(await listCasinoTransactionsAdmin({ limit, cursor }));
  })
);

router.get(
  "/casino/agent-info",
  asyncHandler(async (_req, res) => res.json(await getAgentInfo()))
);

// --- Audit log ---

router.get(
  "/audit-logs",
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = typeof req.query.userId === "string" ? req.query.userId : undefined;
    const action = typeof req.query.action === "string" ? req.query.action : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    res.json(await listAuditLogs({ userId, action, limit, cursor }));
  })
);

// --- Definições da plataforma ---

router.get(
  "/settings",
  asyncHandler(async (_req, res) => res.json(await getSettings()))
);

router.patch(
  "/settings",
  validateBody(
    z
      .object({
        maintenanceMode: z.boolean(),
        minDepositEur: z.number().positive(),
        maxDepositEur: z.number().positive(),
        minWithdrawalEur: z.number().positive(),
        maxWithdrawalEur: z.number().positive(),
        kycRequiredAboveEur: z.number().nonnegative(),
      })
      .partial()
  ),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await updateSettings(req.body, req.user!.id));
  })
);

export default router;
