import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { requireAuth, type AuthedRequest } from "../../middleware/auth";
import { complianceGate } from "../../lib/complianceGate";
import { listCasinoGames } from "./catalogSync";
import { provisionCasinoAccount } from "./accountProvisioning";
import { launchGame } from "./apiClient";
import { Errors } from "../../lib/errors";
import { prisma } from "../../lib/prisma";

// Rotas públicas do Cassino (sem requireAuth) — mesmo padrão de sports/routes.ts: dados de
// navegação/consulta que qualquer visitante deve poder ver antes de entrar na conta, distintas
// das rotas de gestão em admin/routes.ts (GET /api/admin/casino/games), que exigem ADMIN.

const router = Router();

// "Categorias" da página de Cassino (Megaways/Jackpots/etc.) mapeadas para uma correspondência
// parcial no gameName — o `category` real do provedor é genérico ("Slots" para tudo, ver
// docs/CASINO_SLOTS.md), não há um campo próprio para estes temas. "novos" e "populares" não
// entram aqui: são tratados à parte (ordenação por regDate e amostra do catálogo,
// respetivamente), não por palavra-chave no nome.
const TAG_KEYWORDS: Record<string, string> = {
  megaways: "megaways",
  jackpots: "jackpot",
  bonus: "bonus",
  freespins: "free spins",
  baccarat: "baccarat",
  blackjack: "blackjack",
  roulette: "roulette",
};

router.get(
  "/games",
  asyncHandler(async (req, res) => {
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const search = typeof req.query.search === "string" && req.query.search.trim() ? req.query.search.trim() : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const sort = req.query.sort === "name_asc" || req.query.sort === "name_desc" || req.query.sort === "newest" ? req.query.sort : undefined;

    const result = await listCasinoGames({
      page,
      pageSize: limit,
      onlyLaunchable: true,
      search: search ?? (tag ? TAG_KEYWORDS[tag] : undefined),
      sort: tag === "novos" ? "newest" : sort,
    });

    res.json(result);
  })
);

// ========================================================================
// ROTAS AUTENTICADAS (self-service do jogador)
// Exigem: sessão válida + compliance (KYC aprovado, sem self-exclusion ativa)
// ========================================================================
const authedRouter = Router();
authedRouter.use(requireAuth);
// Cassino é atividade de jogo a dinheiro real — KYC e self-exclusion obrigatórios por
// regulamento SRIJ/SGAJ quando COMPLIANCE_KYC_REQUIRED está on (default).
authedRouter.use(complianceGate({ requireKyc: true, requireNotSelfExcluded: true }));

// Garante que a conta do jogador existe tanto localmente (CasinoAccount) como no
// provedor Gold Palace (POST /v4/user/create) e devolve o estado atual. Idempotente:
// se já está tudo criado, devolve instantaneamente sem chamar o provedor de novo.
authedRouter.post(
  "/account/provision",
  asyncHandler(async (req: AuthedRequest, res) => {
    const result = await provisionCasinoAccount(req.user!.id);
    res.json({
      id: result.id,
      userId: result.userId,
      account: result.account,
      providerUserCode: result.providerUserCode,
      createdAt: result.createdAt,
      justCreated: result.justCreated,
      userCodeExtracted: result.userCodeExtracted,
      needsRetry: result.providerUserCode === null,
    });
  })
);

// Lança um jogo real:
//   1. Garante que a conta está provisionada (chama provision se não estiver)
//   2. Busca providerId e gameCode no catálogo local CasinoGame
//   3. Chama POST /v4/game/game-url no provedor
//   4. Devolve o game_url para o frontend abrir num iframe white-label
authedRouter.post(
  "/games/:gameCode/launch",
  asyncHandler(async (req: AuthedRequest, res) => {
    const gameCode = req.params.gameCode;
    if (!gameCode) throw Errors.badRequest("gameCode em falta");

    // Chave única do catálogo é (providerId, gameCode) — um mesmo gameCode pode existir em
    // múltiplos provedores (raro, mas possível). findFirst por gameCode igual e
    // launch_enable=true resolve com robustez (catálogo só tem 1 jogo por código).
    const game = await prisma.casinoGame.findFirst({
      where: { gameCode, launchEnable: true },
    });
    if (!game) throw Errors.notFound("Jogo não encontrado no catálogo");

    const provisioned = await provisionCasinoAccount(req.user!.id);
    if (provisioned.providerUserCode === null) {
      throw Errors.badRequest(
        "A sua conta de cassino ainda está a ser criada no provedor. Tente novamente em 30 segundos. Se o problema persistir, entre em contacto com o suporte.",
        { code: "CASINO_ACCOUNT_PENDING" }
      );
    }

    const host = req.get("host") ?? "localhost";
    const proto = req.protocol;
    const returnUrl = `${proto}://${host}/#cassino`;

    const launchResult = await launchGame({
      userCode: provisioned.providerUserCode,
      providerId: game.providerId,
      gameSymbol: game.gameCode,
      returnUrl,
      lang: 1,
    });

    if (!launchResult.gameUrl) {
      throw Errors.internal(
        "O provedor de cassino devolveu um URL de lançamento inválido. Tente novamente.",
        { code: "CASINO_NO_LAUNCH_URL" }
      );
    }

    res.json({
      gameUrl: launchResult.gameUrl,
      game: {
        gameCode: game.gameCode,
        gameName: game.gameName,
        providerId: game.providerId,
        gameImage: game.gameImage,
      },
      providerUserCode: provisioned.providerUserCode,
    });
  })
);

router.use(authedRouter);

export default router;
