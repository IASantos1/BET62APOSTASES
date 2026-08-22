import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler";
import { listCasinoGames } from "./catalogSync";

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

export default router;
