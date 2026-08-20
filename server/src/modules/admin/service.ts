import { Prisma, UserRole, UserStatus, KycStatus, WithdrawalStatus, DepositStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { applyLedgerMovement } from "../wallet/service";
import { listGames as listCatalogGames, findGame } from "../casino/catalog";
import { addAlias as addTeamAlias, removeAlias as removeTeamAlias, listAliases as listTeamAliases } from "../sports/mapping/aliasStore";

function paginate(page?: number, limit?: number) {
  const take = Math.min(Math.max(limit ?? 20, 1), 100);
  const currentPage = Math.max(page ?? 1, 1);
  return { take, skip: (currentPage - 1) * take, page: currentPage };
}

// ============ DASHBOARD ============

export async function getDashboardStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [
    totalUsers,
    activeUsers,
    newUsersToday,
    walletAgg,
    pendingKyc,
    pendingWithdrawals,
    depositsToday,
    withdrawalsToday,
    casinoTxToday,
    recentAuditLogs,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { status: "ACTIVE" } }),
    prisma.user.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.wallet.aggregate({ _sum: { balance: true, lockedBalance: true } }),
    prisma.kycSubmission.count({ where: { status: { in: ["PENDING", "IN_REVIEW"] } } }),
    prisma.withdrawal.count({ where: { status: { in: ["REQUESTED", "UNDER_REVIEW"] } } }),
    prisma.deposit.aggregate({ where: { status: "SUCCEEDED", createdAt: { gte: todayStart } }, _sum: { amount: true }, _count: true }),
    prisma.withdrawal.aggregate({ where: { status: "PAID", updatedAt: { gte: todayStart } }, _sum: { amount: true }, _count: true }),
    prisma.casinoTransaction.count({ where: { createdAt: { gte: todayStart } } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 15, include: { user: { select: { username: true, email: true } } } }),
  ]);

  return {
    totalUsers,
    activeUsers,
    newUsersToday,
    totalWalletBalance: walletAgg._sum.balance ?? new Prisma.Decimal(0),
    totalLockedBalance: walletAgg._sum.lockedBalance ?? new Prisma.Decimal(0),
    pendingKyc,
    pendingWithdrawals,
    depositsToday: { count: depositsToday._count, total: depositsToday._sum.amount ?? new Prisma.Decimal(0) },
    withdrawalsToday: { count: withdrawalsToday._count, total: withdrawalsToday._sum.amount ?? new Prisma.Decimal(0) },
    casinoTxToday,
    recentAuditLogs,
  };
}

// ============ USERS ============

export async function listUsers(opts: { search?: string; status?: UserStatus; role?: UserRole; page?: number; limit?: number }) {
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const where: Prisma.UserWhereInput = {
    ...(opts.status ? { status: opts.status } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.search
      ? {
          OR: [
            { email: { contains: opts.search, mode: "insensitive" } },
            { username: { contains: opts.search, mode: "insensitive" } },
            { name: { contains: opts.search, mode: "insensitive" } },
            { publicId: { contains: opts.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      select: {
        id: true,
        publicId: true,
        email: true,
        username: true,
        name: true,
        role: true,
        status: true,
        country: true,
        createdAt: true,
        wallet: { select: { balance: true, currency: true } },
      },
    }),
  ]);

  return { total, page, limit: take, users };
}

export async function getUserDetail(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      wallet: true,
      limits: true,
      kycSubmissions: { orderBy: { createdAt: "desc" } },
      selfExclusions: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!user) throw Errors.notFound("Utilizador não encontrado");

  const [ledgerEntries, deposits, withdrawals, auditLogs] = await Promise.all([
    user.wallet
      ? prisma.ledgerEntry.findMany({ where: { walletId: user.wallet.id }, orderBy: { createdAt: "desc" }, take: 20 })
      : [],
    prisma.deposit.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.withdrawal.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20, include: { bankAccount: true } }),
    prisma.auditLog.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);

  const { passwordHash: _passwordHash, ...safeUser } = user;
  return { ...safeUser, ledgerEntries, deposits, withdrawals, auditLogs };
}

// select explícito (sem passwordHash) em vez de devolver o user do update() tal como vem —
// o Prisma devolve TODAS as colunas por omissão, incluindo o hash da password, que nunca deve
// sair da API (bug real apanhado em teste manual destes dois endpoints).
const SAFE_USER_SELECT = {
  id: true,
  publicId: true,
  email: true,
  username: true,
  name: true,
  role: true,
  status: true,
  country: true,
  createdAt: true,
} as const;

export async function updateUserStatus(userId: string, status: "ACTIVE" | "SUSPENDED" | "CLOSED", adminId: string) {
  if (userId === adminId) throw Errors.badRequest("Não podes alterar o estado da tua própria conta");

  const user = await prisma.user.update({ where: { id: userId }, data: { status }, select: SAFE_USER_SELECT });
  await prisma.auditLog.create({
    data: { userId: adminId, action: "ADMIN_USER_STATUS_CHANGED", metadata: { targetUserId: userId, status } },
  });
  return user;
}

export async function updateUserRole(userId: string, role: UserRole, adminId: string) {
  if (userId === adminId) throw Errors.badRequest("Não podes alterar o teu próprio papel");

  const user = await prisma.user.update({ where: { id: userId }, data: { role }, select: SAFE_USER_SELECT });
  await prisma.auditLog.create({
    data: { userId: adminId, action: "ADMIN_USER_ROLE_CHANGED", metadata: { targetUserId: userId, role } },
  });
  return user;
}

export async function adjustUserBalance(userId: string, amount: number, reason: string, adminId: string) {
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw Errors.notFound("Carteira não encontrada");

  const { entry, wallet: updatedWallet } = await applyLedgerMovement({
    walletId: wallet.id,
    type: "ADJUSTMENT",
    amount,
    referenceType: "admin_adjustment",
    referenceId: adminId,
    metadata: { reason, adminId },
  });

  await prisma.auditLog.create({
    data: { userId: adminId, action: "ADMIN_BALANCE_ADJUSTED", metadata: { targetUserId: userId, amount, reason } },
  });

  return { entry, wallet: updatedWallet };
}

// ============ KYC ============

export async function listKycSubmissions(opts: { status?: KycStatus; page?: number; limit?: number }) {
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const where: Prisma.KycSubmissionWhereInput = opts.status ? { status: opts.status } : {};

  const [total, submissions] = await Promise.all([
    prisma.kycSubmission.count({ where }),
    prisma.kycSubmission.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: { user: { select: { id: true, publicId: true, email: true, username: true, name: true } } },
    }),
  ]);

  return { total, page, limit: take, submissions };
}

export async function reviewKyc(kycId: string, status: "APPROVED" | "REJECTED", rejectionReason: string | undefined, adminId: string) {
  const submission = await prisma.kycSubmission.findUnique({ where: { id: kycId } });
  if (!submission) throw Errors.notFound("Verificação não encontrada");
  if (submission.status === "APPROVED" || submission.status === "REJECTED") {
    throw Errors.conflict("Esta verificação já foi revista");
  }
  if (status === "REJECTED" && !rejectionReason) {
    throw Errors.badRequest("Motivo de rejeição obrigatório");
  }

  const updated = await prisma.kycSubmission.update({
    where: { id: kycId },
    data: { status, rejectionReason: status === "REJECTED" ? rejectionReason : null, reviewedByUserId: adminId, reviewedAt: new Date() },
  });

  await prisma.auditLog.create({
    data: { userId: adminId, action: "ADMIN_KYC_REVIEWED", metadata: { targetUserId: submission.userId, kycId, status, rejectionReason } },
  });

  return updated;
}

// ============ WITHDRAWALS / DEPOSITS (visão admin) ============
// A aprovação/rejeição em si já existe e está protegida (requireRole SUPPORT/ADMIN) em
// payments/revolut/{routes,service}.ts — approveAndPayWithdrawal()/rejectWithdrawal() — só
// faltava uma listagem admin-wide (a rota do jogador só lista as suas próprias). Reaproveita-se
// aquele fluxo em vez de duplicar a lógica de lock/unlock de saldo.

export async function listWithdrawalsAdmin(opts: { status?: WithdrawalStatus; page?: number; limit?: number }) {
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const where: Prisma.WithdrawalWhereInput = opts.status ? { status: opts.status } : {};

  const [total, withdrawals] = await Promise.all([
    prisma.withdrawal.count({ where }),
    prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: {
        bankAccount: true,
        user: { select: { id: true, publicId: true, email: true, username: true, name: true } },
      },
    }),
  ]);

  return { total, page, limit: take, withdrawals };
}

export async function listDepositsAdmin(opts: { status?: DepositStatus; page?: number; limit?: number }) {
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const where: Prisma.DepositWhereInput = opts.status ? { status: opts.status } : {};

  const [total, deposits] = await Promise.all([
    prisma.deposit.count({ where }),
    prisma.deposit.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip,
      include: { user: { select: { id: true, publicId: true, email: true, username: true, name: true } } },
    }),
  ]);

  return { total, page, limit: take, deposits };
}

// ============ JOGO RESPONSÁVEL (monitorização) ============

export async function listSelfExclusions(opts: { activeOnly?: boolean }) {
  return prisma.selfExclusion.findMany({
    where: opts.activeOnly ? { active: true, OR: [{ endAt: null }, { endAt: { gt: new Date() } }] } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { user: { select: { id: true, publicId: true, email: true, username: true, name: true, status: true } } },
  });
}

// ============ CASINO ============
// O catálogo (catalog.ts) vem de um JSON estático do provedor — CasinoGameOverride guarda só a
// exceção manual por cima dele (ver comentário no schema.prisma). listCasinoGamesAdmin() junta
// as duas fontes para a UI mostrar o estado real e efetivo de cada jogo.

export async function listCasinoGamesAdmin(opts: { search?: string; category?: string; page?: number; limit?: number }) {
  const { games: allMatching, total } = listCatalogGamesUnfiltered(opts);
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const pageGames = allMatching.slice(skip, skip + take);
  const codes = pageGames.map((g) => g.game_code);
  const overrides = await prisma.casinoGameOverride.findMany({ where: { gameCode: { in: codes } } });
  const overrideByCode = new Map(overrides.map((o) => [o.gameCode, o]));

  const games = pageGames.map((g) => {
    const override = overrideByCode.get(g.game_code);
    return {
      gameCode: g.game_code,
      gameName: g.game_name,
      category: g.category,
      providerId: g.provider_id,
      catalogEnabled: g.launch_enable,
      overrideEnabled: override?.enabled ?? null,
      effectiveEnabled: override ? override.enabled : g.launch_enable,
    };
  });

  return { total, page, limit: take, games };
}

// listGames() do catálogo já filtra por launch_enable=true — para a gestão do admin precisamos
// de ver TODOS os jogos (incluindo os já desativados no JSON), por isso não se reaproveita
// listGames() aqui, só findGame()/o catálogo bruto via um pedido sem filtro de ativo.
function listCatalogGamesUnfiltered(opts: { search?: string; category?: string }) {
  const { games: activeOnly } = listCatalogGames({ search: opts.search, category: opts.category, limit: 100000 });
  return { games: activeOnly, total: activeOnly.length };
}

export async function setCasinoGameOverride(gameCode: string, enabled: boolean, adminId: string) {
  const game = findGame(gameCode) ?? null;
  if (!game) {
    // findGame() só encontra jogos com launch_enable=true no JSON — um jogo já desativado na
    // origem ainda é um alvo válido para o override (ex: voltar a ligá-lo manualmente), por isso
    // só se rejeita quando o código nem existe no catálogo.
    const existsInCatalog = listCatalogGames({ limit: 100000 }).games.some((g) => g.game_code === gameCode);
    if (!existsInCatalog) throw Errors.notFound("Jogo não encontrado no catálogo");
  }

  const override = await prisma.casinoGameOverride.upsert({
    where: { gameCode },
    create: { gameCode, enabled, updatedByUserId: adminId },
    update: { enabled, updatedByUserId: adminId },
  });

  await prisma.auditLog.create({
    data: { userId: adminId, action: "ADMIN_CASINO_GAME_OVERRIDE", metadata: { gameCode, enabled } },
  });

  return override;
}

export async function listCasinoTransactionsAdmin(opts: { limit?: number; cursor?: string }) {
  const limit = Math.min(opts.limit ?? 25, 100);
  const entries = await prisma.casinoTransaction.findMany({
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { wallet: { select: { user: { select: { id: true, publicId: true, email: true, username: true } } } } },
  });
  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  return { entries: page, nextCursor: hasMore ? page[page.length - 1]?.id : null };
}

// ============ AUDIT LOG ============

export async function listAuditLogs(opts: { userId?: string; action?: string; limit?: number; cursor?: string }) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const where: Prisma.AuditLogWhereInput = {
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.action ? { action: { contains: opts.action, mode: "insensitive" } } : {}),
  };

  const entries = await prisma.auditLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, publicId: true, email: true, username: true } } },
  });
  const hasMore = entries.length > limit;
  const page = hasMore ? entries.slice(0, limit) : entries;
  return { entries: page, nextCursor: hasMore ? page[page.length - 1]?.id : null };
}

// ============ DEFINIÇÕES DA PLATAFORMA ============
// Par chave/valor genérico (ver schema.prisma) em vez de colunas fixas. DEFAULT_SETTINGS
// documenta as chaves conhecidas e os valores por omissão quando ainda não há registo na BD —
// updateSettings() valida cada chave contra esta lista para nunca gravar lixo arbitrário.

type SettingValue = boolean | number | string;
const DEFAULT_SETTINGS: Record<string, SettingValue> = {
  maintenanceMode: false,
  minDepositEur: 5,
  maxDepositEur: 5000,
  minWithdrawalEur: 10,
  maxWithdrawalEur: 5000,
  kycRequiredAboveEur: 2000,
};

let maintenanceCache: { value: boolean; expiresAt: number } | null = null;
const MAINTENANCE_CACHE_TTL_MS = 5_000;

export async function getSettings(): Promise<Record<string, SettingValue>> {
  const rows = await prisma.platformSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r.value as SettingValue]));
  const result: Record<string, SettingValue> = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    result[key] = byKey.get(key) ?? DEFAULT_SETTINGS[key]!;
  }
  return result;
}

export async function updateSettings(patch: Record<string, SettingValue>, adminId: string) {
  const keys = Object.keys(patch);
  const unknown = keys.filter((k) => !(k in DEFAULT_SETTINGS));
  if (unknown.length) throw Errors.badRequest(`Definições desconhecidas: ${unknown.join(", ")}`);

  await prisma.$transaction(
    keys.map((key) =>
      prisma.platformSetting.upsert({
        where: { key },
        create: { key, value: patch[key] as Prisma.InputJsonValue, updatedByUserId: adminId },
        update: { value: patch[key] as Prisma.InputJsonValue, updatedByUserId: adminId },
      })
    )
  );

  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_SETTINGS_UPDATED", metadata: patch } });

  if ("maintenanceMode" in patch) maintenanceCache = null; // invalida a cache usada pelo gate em app.ts

  return getSettings();
}

/**
 * Usado pelo middleware de manutenção (app.ts) em CADA pedido não-admin — cache de 5s em
 * memória para não bater na BD a esse ritmo. Falha aberto (devolve false em erro de BD) para
 * nunca bloquear a plataforma inteira por uma falha transitória de ligação à base de dados.
 */
export async function getMaintenanceMode(): Promise<boolean> {
  if (maintenanceCache && maintenanceCache.expiresAt > Date.now()) return maintenanceCache.value;
  try {
    const row = await prisma.platformSetting.findUnique({ where: { key: "maintenanceMode" } });
    const value = Boolean(row?.value ?? DEFAULT_SETTINGS.maintenanceMode);
    maintenanceCache = { value, expiresAt: Date.now() + MAINTENANCE_CACHE_TTL_MS };
    return value;
  } catch {
    return false;
  }
}

// ============ MAPEAMENTO PULSESCORE <-> API-FOOTBALL ============
// Ver server/src/modules/sports/mapping/ e docs/TEAM_MAPPING.md para o motor que preenche estas
// tabelas automaticamente. Esta secção só dá ao admin visibilidade (sobretudo sobre os
// mappings de baixa confiança, que o motor guarda mas nunca liga sozinho) e correção manual
// (spec: "POST /api/admin/team-mapping" — a correção manual tem sempre prioridade sobre o
// automático, marcando mappingMethod=MANUAL e verified=true, que o motor nunca sobrescreve).

export async function listTeamMappings(opts: { search?: string; maxConfidence?: number; verifiedOnly?: boolean; sport?: string; page?: number; limit?: number }) {
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const where: Prisma.TeamMappingWhereInput = {
    ...(opts.sport ? { sport: opts.sport } : {}),
    ...(opts.verifiedOnly ? { verified: true } : {}),
    ...(opts.maxConfidence !== undefined ? { confidence: { lte: opts.maxConfidence } } : {}),
    ...(opts.search
      ? {
          OR: [
            { pulsescoreName: { contains: opts.search, mode: "insensitive" } },
            { apiFootballName: { contains: opts.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [total, mappings] = await Promise.all([
    prisma.teamMapping.count({ where }),
    prisma.teamMapping.findMany({ where, orderBy: [{ confidence: "asc" }, { createdAt: "desc" }], take, skip }),
  ]);
  return { total, page, limit: take, mappings };
}

export async function correctTeamMapping(id: string, apiFootballTeamId: number, apiFootballName: string, adminId: string) {
  const updated = await prisma.teamMapping.update({
    where: { id },
    data: { apiFootballTeamId, apiFootballName, mappingMethod: "MANUAL", verified: true, confidence: 100 },
  });
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_TEAM_MAPPING_CORRECTED", metadata: { teamMappingId: id, apiFootballTeamId, apiFootballName } } });
  return updated;
}

// Apaga o mapping (não só desliga) — a próxima vez que este nome aparecer, o motor volta a
// tentar resolvê-lo do zero em vez de ficar preso a um resultado antigo (ex: se a API-Football
// entretanto passou a cobrir uma equipa que antes não tinha).
export async function resetTeamMapping(id: string, adminId: string) {
  await prisma.teamMapping.delete({ where: { id } });
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_TEAM_MAPPING_RESET", metadata: { teamMappingId: id } } });
}

export async function listLeagueMappings(opts: { search?: string; maxConfidence?: number; sport?: string; page?: number; limit?: number }) {
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const where: Prisma.LeagueMappingWhereInput = {
    ...(opts.sport ? { sport: opts.sport } : {}),
    ...(opts.maxConfidence !== undefined ? { confidence: { lte: opts.maxConfidence } } : {}),
    ...(opts.search
      ? { OR: [{ pulsescoreName: { contains: opts.search, mode: "insensitive" } }, { apiFootballName: { contains: opts.search, mode: "insensitive" } }] }
      : {}),
  };
  const [total, mappings] = await Promise.all([
    prisma.leagueMapping.count({ where }),
    prisma.leagueMapping.findMany({ where, orderBy: [{ confidence: "asc" }, { createdAt: "desc" }], take, skip }),
  ]);
  return { total, page, limit: take, mappings };
}

export async function correctLeagueMapping(id: string, apiFootballLeagueId: number, apiFootballName: string, season: number, adminId: string) {
  const updated = await prisma.leagueMapping.update({
    where: { id },
    data: { apiFootballLeagueId, apiFootballName, season, mappingMethod: "MANUAL", verified: true, confidence: 100 },
  });
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_LEAGUE_MAPPING_CORRECTED", metadata: { leagueMappingId: id, apiFootballLeagueId, apiFootballName, season } } });
  return updated;
}

export async function resetLeagueMapping(id: string, adminId: string) {
  await prisma.leagueMapping.delete({ where: { id } });
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_LEAGUE_MAPPING_RESET", metadata: { leagueMappingId: id } } });
}

export async function listFixtureMappings(opts: { maxConfidence?: number; unlinkedOnly?: boolean; page?: number; limit?: number }) {
  const { take, skip, page } = paginate(opts.page, opts.limit);
  const where: Prisma.FixtureMappingWhereInput = {
    ...(opts.maxConfidence !== undefined ? { confidence: { lte: opts.maxConfidence } } : {}),
    ...(opts.unlinkedOnly ? { apiFootballFixtureId: null } : {}),
  };
  const [total, mappings] = await Promise.all([
    prisma.fixtureMapping.count({ where }),
    prisma.fixtureMapping.findMany({
      where,
      orderBy: [{ confidence: "asc" }, { createdAt: "desc" }],
      take,
      skip,
      include: { homeTeamMapping: true, awayTeamMapping: true, leagueMapping: true },
    }),
  ]);
  return { total, page, limit: take, mappings };
}

export async function correctFixtureMapping(id: string, apiFootballFixtureId: number, adminId: string) {
  const updated = await prisma.fixtureMapping.update({
    where: { id },
    data: { apiFootballFixtureId, mappingMethod: "MANUAL", verified: true, confidence: 100 },
  });
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_FIXTURE_MAPPING_CORRECTED", metadata: { fixtureMappingId: id, apiFootballFixtureId } } });
  return updated;
}

// Apaga o mapping do evento — a próxima vez que a UI pedir estatísticas/H2H/previsões deste
// mesmo evento Pulsescore, o motor volta a tentar associá-lo do zero (útil quando as equipas
// entretanto foram corrigidas/re-resolvidas e o fixture antigo ficou desatualizado).
export async function resetFixtureMapping(id: string, adminId: string) {
  await prisma.fixtureMapping.delete({ where: { id } });
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_FIXTURE_MAPPING_RESET", metadata: { fixtureMappingId: id } } });
}

export async function listMappingAliases() {
  return listTeamAliases();
}

export async function createMappingAlias(alias: string, canonicalName: string, sport: string, adminId: string) {
  await addTeamAlias(alias, canonicalName, sport);
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_TEAM_ALIAS_CREATED", metadata: { alias, canonicalName, sport } } });
}

export async function deleteMappingAlias(id: string, adminId: string) {
  await removeTeamAlias(id);
  await prisma.auditLog.create({ data: { userId: adminId, action: "ADMIN_TEAM_ALIAS_DELETED", metadata: { aliasId: id } } });
}
