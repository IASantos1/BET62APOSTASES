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
  page?: number;
  pageSize?: number;
}

export async function listCasinoGames(options: ListCasinoGamesOptions = {}) {
  const page = options.page && options.page > 0 ? options.page : 1;
  const pageSize = options.pageSize && options.pageSize > 0 && options.pageSize <= 200 ? options.pageSize : 50;

  const where = {
    ...(options.providerId !== undefined ? { providerId: options.providerId } : {}),
    ...(options.category ? { category: options.category } : {}),
  };

  const [total, games] = await Promise.all([
    prisma.casinoGame.count({ where }),
    prisma.casinoGame.findMany({
      where,
      orderBy: [{ providerId: "asc" }, { gameName: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return { total, page, pageSize, games };
}
