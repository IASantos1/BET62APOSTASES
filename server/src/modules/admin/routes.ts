import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, requireRole, type AuthedRequest } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { Errors } from "../../lib/errors";
import { userRateLimit } from "../../lib/userRateLimit";
import { approveAndPayWithdrawal, rejectWithdrawal } from "../payments/revolut/service";
import { listBetsNeedingReview, manualSettleSelection } from "../betting/service";
import { adminListPromotions, adminCreatePromotion, adminUpdatePromotion } from "../promotions/service";
import { getKycDocumentFile } from "../users/kycDocuments";
import {
  getAgentInfo,
  testCallback,
  getUserInfo,
  getGameProviders,
  getGames,
  getAllGames,
  launchGame,
  getOnlineGames,
  getCallConfig,
  callStart,
  callCancel,
  createFreeround,
  cancelFreeround,
  listTransactions,
  listTransactionsByCursor,
  getRoundDetails,
  listUserStatistics,
} from "../casino/apiClient";
import { provisionCasinoAccount } from "../casino/accountProvisioning";
import { syncGameCatalog, listCasinoGames } from "../casino/catalogSync";
import {
  getDashboardStats,
  listUsers,
  getUserDetail,
  updateUserStatus,
  updateUserRole,
  adjustUserBalance,
  listKycSubmissions,
  reviewKyc,
  reviewKycDocument,
  listWithdrawalsAdmin,
  listDepositsAdmin,
  listSelfExclusions,
  listAuditLogs,
  getSettings,
  updateSettings,
  listTeamMappings,
  correctTeamMapping,
  resetTeamMapping,
  listLeagueMappings,
  correctLeagueMapping,
  resetLeagueMapping,
  listFixtureMappings,
  correctFixtureMapping,
  resetFixtureMapping,
  listMappingAliases,
  createMappingAlias,
  deleteMappingAlias,
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

// F2-5: Rate limit global por utilizador autenticado em TODAS as rotas do painel admin.
// 180 req/min por admin (geralmente painel é manual, mas protege de fuga de memória ou
// utilizadores com scripts). Redis prefix admin:global — usa Redis se disponível, senão mem.
const adminLimiter = userRateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  redisPrefix: "admin:global",
  message: {
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Demasiados pedidos no painel admin. Tente novamente em instantes.",
    },
  },
});
router.use(adminLimiter);

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
  validateBody(z.object({ status: z.enum(["APPROVED", "REJECTED"]), rejectionReason: z.string().max(500).optional(), reviewNotes: z.string().max(500).optional() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await reviewKyc(requireParamId(req.params.id), req.body.status, req.body.rejectionReason, req.user!.id, req.body.reviewNotes));
  })
);

// Revisão manual por documento KYC individual (ficheiros ID/extrato) — complementa o
// reviewKyc acima (que é para a KycSubmission, texto do número/tipo). Campos reviewNotes,
// reviewedByUserId e reviewedAt já existem no schema desde F1-3; esta rota passa a gravá-los.
router.patch(
  "/kyc/documents/:id",
  validateBody(z.object({ status: z.enum(["APPROVED", "REJECTED"]), reviewNotes: z.string().max(500).optional() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await reviewKycDocument(requireParamId(req.params.id), req.body.status, req.user!.id, req.body.reviewNotes));
  })
);

// Documento pessoal/extrato bancário enviado pelo utilizador (ver getUserDetail — já vêm
// listados em user.kycDocuments) — só o conteúdo do ficheiro em si precisa de rota própria.
// null em vez do userId: o admin pode ver o documento de qualquer utilizador, ao contrário de
// GET /users/me/kyc/documents/:id/file (só o dono).
router.get(
  "/kyc/documents/:id/file",
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.params.id) throw Errors.badRequest("Parâmetro id em falta");
    const { doc, absolutePath } = await getKycDocumentFile(req.params.id, null);
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.fileName)}"`);
    res.sendFile(absolutePath);
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

// --- Apostas presas em revisão manual (mercados que o motor de liquidação automática não sabe
// resolver com segurança — ver betting/settlementRules.ts) ---

router.get(
  "/bets/needs-review",
  asyncHandler(async (_req: AuthedRequest, res) => {
    res.json({ bets: await listBetsNeedingReview() });
  })
);

router.post(
  "/bets/selections/:id/settle",
  validateBody(z.object({ outcome: z.enum(["WON", "LOST", "VOID"]), reviewNotes: z.string().max(500).optional() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    await manualSettleSelection(requireParamId(req.params.id), req.body.outcome, req.user!.id, req.body.reviewNotes);
    res.json({ ok: true });
  })
);

// --- Promoções (Bónus/Rollover) — configurável sem tocar código, ver promotions/service.ts ---

const promotionInputSchema = z.object({
  type: z.enum(["WELCOME_BONUS", "DEPOSIT_BONUS", "CASHBACK", "FREEBET"]),
  name: z.string().min(1).max(120),
  active: z.boolean().optional(),
  bonusPercent: z.number().positive().max(1000).nullable().optional(),
  bonusFixedAmount: z.number().positive().nullable().optional(),
  bonusMaxAmount: z.number().positive().nullable().optional(),
  minDepositAmount: z.number().positive().nullable().optional(),
  rolloverMultiplier: z.number().min(1).max(20).optional(),
  minOdd: z.number().min(1).max(50).optional(),
  validityDays: z.number().int().min(1).max(365).optional(),
  eligibleSports: z.array(z.string()).optional(),
});

router.get(
  "/promotions",
  asyncHandler(async (_req: AuthedRequest, res) => {
    res.json({ promotions: await adminListPromotions() });
  })
);

router.post(
  "/promotions",
  validateBody(promotionInputSchema),
  asyncHandler(async (req: AuthedRequest, res) => {
    const promotion = await adminCreatePromotion(req.body);
    res.status(201).json({ promotion });
  })
);

router.patch(
  "/promotions/:id",
  validateBody(promotionInputSchema.partial()),
  asyncHandler(async (req: AuthedRequest, res) => {
    const promotion = await adminUpdatePromotion(requireParamId(req.params.id), req.body);
    res.json({ promotion });
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

// --- Cassino ---
// Reconstruído passo a passo — por agora só o endpoint de diagnóstico (confirma se o
// CASINO_AGENT_KEY/CASINO_PROVIDER_BASE_URL configurados neste ambiente estão a funcionar).

router.get(
  "/casino/agent-info",
  asyncHandler(async (_req, res) => res.json(await getAgentInfo()))
);

router.get(
  "/casino/callback-test",
  asyncHandler(async (_req, res) => res.json(await testCallback()))
);

router.get(
  "/casino/users/:userCode",
  asyncHandler(async (req: AuthedRequest, res) => {
    const userCode = Number(req.params.userCode);
    if (!Number.isInteger(userCode)) throw Errors.badRequest("user_code inválido");
    res.json(await getUserInfo(userCode));
  })
);

router.get(
  "/casino/providers",
  asyncHandler(async (_req, res) => res.json(await getGameProviders()))
);

router.get(
  "/casino/providers/:providerId/games",
  asyncHandler(async (req: AuthedRequest, res) => {
    const providerId = Number(req.params.providerId);
    if (!Number.isInteger(providerId)) throw Errors.badRequest("provider_id inválido");
    res.json(await getGames(providerId));
  })
);

router.get(
  "/casino/games/all",
  asyncHandler(async (_req, res) => res.json(await getAllGames()))
);

// Espelho local do catálogo (ver casino/catalogSync.ts) — o que o frontend/admin devem consultar
// no dia a dia, em vez de GET /casino/games/all (pede o catálogo inteiro ao provedor de cada vez).
router.post(
  "/casino/games/sync",
  asyncHandler(async (_req, res) => res.json(await syncGameCatalog()))
);

// Diagnóstico de POST /v4/game/game-url — bloqueado enquanto user/create não funcionar (ver
// docs/CASINO_SLOTS.md): qualquer user_code aqui vai devolver USER_NOT_FOUND até haver contas
// reais criadas no provedor.
router.post(
  "/casino/games/launch",
  validateBody(
    z.object({
      userCode: z.number().int(),
      providerId: z.number().int(),
      gameSymbol: z.string().min(1),
      lang: z.number().int().optional(),
      returnUrl: z.string().optional(),
      rtp: z.number().optional(),
      isFinishJackpot: z.boolean().optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => res.json(await launchGame(req.body)))
);

router.get(
  "/casino/games/online",
  asyncHandler(async (_req, res) => res.json(await getOnlineGames()))
);

router.get(
  "/casino/call-config",
  asyncHandler(async (_req, res) => res.json(await getCallConfig()))
);

// Diagnóstico de POST /v4/game/call_start — devolveu PERMISSION_ERROR com gplay_id 0 (ver
// docs/CASINO_SLOTS.md); significado de gplay_id/set_point/type ainda por confirmar.
router.post(
  "/casino/call-start",
  validateBody(
    z.object({
      gplayId: z.number().int(),
      setPoint: z.number(),
      type: z.number().int(),
      memo: z.string().optional(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => res.json(await callStart(req.body)))
);

router.post(
  "/casino/call-cancel",
  validateBody(z.object({ callId: z.number().int() })),
  asyncHandler(async (req: AuthedRequest, res) => res.json(await callCancel(req.body.callId)))
);

// Diagnóstico de POST /v4/game/freeround/create — confirmado que expirationDate (epoch em ms)
// tem de ser pelo menos 30 minutos no futuro (ver docs/CASINO_SLOTS.md).
router.post(
  "/casino/freerounds",
  validateBody(
    z.object({
      userCode: z.number().int(),
      providerId: z.number().int(),
      gameSymbol: z.string().min(1),
      bet: z.number(),
      win: z.number(),
      rounds: z.number().int(),
      expirationDate: z.number().int(),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => res.json(await createFreeround(req.body)))
);

router.post(
  "/casino/freerounds/cancel",
  validateBody(z.object({ frId: z.string().min(1) })),
  asyncHandler(async (req: AuthedRequest, res) => res.json(await cancelFreeround(req.body.frId)))
);

router.get(
  "/casino/transactions",
  asyncHandler(async (req: AuthedRequest, res) => {
    const startTime = typeof req.query.startTime === "string" ? req.query.startTime : undefined;
    const endTime = typeof req.query.endTime === "string" ? req.query.endTime : undefined;
    if (!startTime || !endTime) throw Errors.badRequest("startTime e endTime são obrigatórios (\"YYYY-MM-DD HH:MM:SS\")");
    const { page, limit } = pageQuery(req);
    res.json(
      await listTransactions({
        startTime,
        endTime,
        offset: page && limit ? (page - 1) * limit : undefined,
        limit,
      })
    );
  })
);

router.get(
  "/casino/transactions/cursor",
  asyncHandler(async (req: AuthedRequest, res) => {
    const lastId = req.query.lastId ? Number(req.query.lastId) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json(await listTransactionsByCursor({ lastId, limit }));
  })
);

router.post(
  "/casino/round-details",
  validateBody(
    z.object({
      userCode: z.number().int(),
      roundId: z.string().min(1),
      providerId: z.number().int(),
      gameCode: z.string().min(1),
    })
  ),
  asyncHandler(async (req: AuthedRequest, res) => res.json(await getRoundDetails(req.body)))
);

router.get(
  "/casino/statistics/user",
  asyncHandler(async (req: AuthedRequest, res) => {
    const startTime = typeof req.query.startTime === "string" ? req.query.startTime : undefined;
    const endTime = typeof req.query.endTime === "string" ? req.query.endTime : undefined;
    if (!startTime || !endTime) throw Errors.badRequest("startTime e endTime são obrigatórios (ISO 8601)");
    const { page, limit } = pageQuery(req);
    res.json(
      await listUserStatistics({
        startTime,
        endTime,
        offset: page && limit ? (page - 1) * limit : undefined,
        limit,
      })
    );
  })
);

// Cria a conta no provedor (user/create) e guarda o mapeamento local (CasinoAccount) usado pelo
// callback — ver casino/accountProvisioning.ts e casino/callback.ts. Primeiro teste real de
// user/create desde que a rota /callback existe.
router.post(
  "/casino/accounts/provision",
  validateBody(z.object({ userId: z.string().min(1) })),
  asyncHandler(async (req: AuthedRequest, res) => res.json(await provisionCasinoAccount(req.body.userId)))
);

router.get(
  "/casino/games",
  asyncHandler(async (req: AuthedRequest, res) => {
    const { page, limit } = pageQuery(req);
    const providerId = req.query.providerId ? Number(req.query.providerId) : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    res.json(await listCasinoGames({ providerId, category, page, pageSize: limit }));
  })
);

// --- Jogo responsável ---

router.get(
  "/self-exclusions",
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await listSelfExclusions({ activeOnly: req.query.active !== "false" }));
  })
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

// --- Mapeamento Pulsescore <-> API-Football (docs/TEAM_MAPPING.md) ---

router.get(
  "/mapping/teams",
  asyncHandler(async (req: AuthedRequest, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const sport = typeof req.query.sport === "string" ? req.query.sport : undefined;
    const maxConfidence = req.query.maxConfidence ? Number(req.query.maxConfidence) : undefined;
    res.json(await listTeamMappings({ search, sport, maxConfidence, ...pageQuery(req) }));
  })
);

router.patch(
  "/mapping/teams/:id",
  validateBody(z.object({ apiFootballTeamId: z.number().int().positive(), apiFootballName: z.string().min(1) })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await correctTeamMapping(requireParamId(req.params.id), req.body.apiFootballTeamId, req.body.apiFootballName, req.user!.id));
  })
);

router.delete(
  "/mapping/teams/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    await resetTeamMapping(requireParamId(req.params.id), req.user!.id);
    res.status(204).end();
  })
);

router.get(
  "/mapping/leagues",
  asyncHandler(async (req: AuthedRequest, res) => {
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const sport = typeof req.query.sport === "string" ? req.query.sport : undefined;
    const maxConfidence = req.query.maxConfidence ? Number(req.query.maxConfidence) : undefined;
    res.json(await listLeagueMappings({ search, sport, maxConfidence, ...pageQuery(req) }));
  })
);

router.patch(
  "/mapping/leagues/:id",
  validateBody(z.object({ apiFootballLeagueId: z.number().int().positive(), apiFootballName: z.string().min(1), season: z.number().int() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await correctLeagueMapping(requireParamId(req.params.id), req.body.apiFootballLeagueId, req.body.apiFootballName, req.body.season, req.user!.id));
  })
);

router.delete(
  "/mapping/leagues/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    await resetLeagueMapping(requireParamId(req.params.id), req.user!.id);
    res.status(204).end();
  })
);

router.get(
  "/mapping/fixtures",
  asyncHandler(async (req: AuthedRequest, res) => {
    const maxConfidence = req.query.maxConfidence ? Number(req.query.maxConfidence) : undefined;
    const unlinkedOnly = req.query.unlinkedOnly === "true";
    res.json(await listFixtureMappings({ maxConfidence, unlinkedOnly, ...pageQuery(req) }));
  })
);

router.patch(
  "/mapping/fixtures/:id",
  validateBody(z.object({ apiFootballFixtureId: z.number().int().positive() })),
  asyncHandler(async (req: AuthedRequest, res) => {
    res.json(await correctFixtureMapping(requireParamId(req.params.id), req.body.apiFootballFixtureId, req.user!.id));
  })
);

router.delete(
  "/mapping/fixtures/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    await resetFixtureMapping(requireParamId(req.params.id), req.user!.id);
    res.status(204).end();
  })
);

router.get(
  "/mapping/aliases",
  asyncHandler(async (_req, res) => res.json(await listMappingAliases()))
);

router.post(
  "/mapping/aliases",
  validateBody(z.object({ alias: z.string().min(1).max(120), canonicalName: z.string().min(1).max(120), sport: z.string().min(1).max(30).default("football") })),
  asyncHandler(async (req: AuthedRequest, res) => {
    await createMappingAlias(req.body.alias, req.body.canonicalName, req.body.sport, req.user!.id);
    res.status(201).json(await listMappingAliases());
  })
);

router.delete(
  "/mapping/aliases/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    await deleteMappingAlias(requireParamId(req.params.id), req.user!.id);
    res.status(204).end();
  })
);

export default router;
