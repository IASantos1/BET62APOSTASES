import { prisma } from "../../lib/prisma";
import { getAllGames } from "./apiClient";

// O catálogo confirmado em POST /v4/game/all tem milhares de jogos — pedir isto ao provedor em
// cada carregamento de página seria lento e desnecessário. Este sync espelha o catálogo inteiro
// para uma tabela local (substituição total: apaga tudo e volta a inserir, em vez de N upserts)
// para o frontend/admin consultarem a partir daqui.

export interface CatalogSyncResult {
  totalGames: number;
  syncedAt: Date;
}

export async function syncGameCatalog(): Promise<CatalogSyncResult> {
  const games = await getAllGames();
  const syncedAt = new Date();

  await prisma.$transaction([
    prisma.casinoGame.deleteMany({}),
    prisma.casinoGame.createMany({
      data: games.map((g) => ({
        providerId: g.providerId,
        gameCode: g.gameCode,
        gameName: g.gameName,
        localeName: g.localeName,
        gameImage: g.gameImage,
        gameImageNarrow: g.gameImageNarrow,
        launchEnable: g.launchEnable,
        category: g.category,
        regDate: g.regDate,
        syncedAt,
      })),
      skipDuplicates: true,
    }),
  ]);

  return { totalGames: games.length, syncedAt };
}

export interface ListCasinoGamesOptions {
  providerId?: number;
  category?: string;
  // Correspondência parcial (case-insensitive) no gameName — usada tanto pela pesquisa livre do
  // jogador como pelas "categorias" da página de Cassino (Megaways/Jackpots/etc.), já que o
  // `category` real devolvido pelo provedor é genérico ("Slots" para tudo, ver
  // docs/CASINO_SLOTS.md) e não distingue esses temas.
  search?: string;
  sort?: "name_asc" | "name_desc" | "newest";
  // Só jogos com launch_enable=true — usado pela rota pública (GET /api/casino/games), que só
  // deve listar jogos que o jogador pode mesmo abrir. A rota de admin não filtra por isto, para
  // continuar a ver o catálogo completo tal como veio do provedor.
  onlyLaunchable?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listCasinoGames(options: ListCasinoGamesOptions = {}) {
  const page = options.page && options.page > 0 ? options.page : 1;
  const pageSize = options.pageSize && options.pageSize > 0 && options.pageSize <= 200 ? options.pageSize : 50;

  const where = {
    ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    ...(options.category ? { category: options.category } : {}),
    ...(options.search ? { gameName: { contains: options.search, mode: "insensitive" as const } } : {}),
    ...(options.onlyLaunchable ? { launchEnable: true } : {}),
  };

  const orderBy =
    options.sort === "name_desc"
      ? [{ gameName: "desc" as const }]
      : options.sort === "newest"
        ? [{ regDate: "desc" as const }]
        : [{ providerId: "asc" as const }, { gameName: "asc" as const }];

  const [total, games] = await Promise.all([
    prisma.casinoGame.count({ where }),
    prisma.casinoGame.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, games };
}
