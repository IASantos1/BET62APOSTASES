import { prisma } from "../../../lib/prisma";
import { logger } from "../../../lib/logger";
import { normalizeTeamName } from "./normalize";
import { ALIAS_SEED } from "./aliasSeed";

// Cache em memória (chave "sport|normalizedAlias" -> canonicalName), recarregada a partir da
// TeamAlias no arranque e sempre que o admin adiciona/remove um alias — evita uma consulta à BD
// por cada nome a resolver (teamMatcher.ts chama findCanonicalAlias() para CADA equipa de CADA
// evento pedido).
let cache: Map<string, string> | null = null;

function cacheKey(sport: string, normalizedAlias: string): string {
  return `${sport}|${normalizedAlias}`;
}

export async function reloadAliasCache(): Promise<void> {
  const rows = await prisma.teamAlias.findMany();
  const next = new Map<string, string>();
  for (const row of rows) next.set(cacheKey(row.sport, row.normalizedAlias), row.canonicalName);
  cache = next;
}

/** Devolve o nome canónico para um alias conhecido, ou null se não houver nenhum. */
export async function findCanonicalAlias(rawName: string, sport: string): Promise<string | null> {
  if (!cache) await reloadAliasCache();
  const key = cacheKey(sport, normalizeTeamName(rawName));
  return cache!.get(key) ?? null;
}

/**
 * Semeia os aliases conhecidos à partida (aliasSeed.ts) — idempotente (skipDuplicates na
 * restrição única [sport, normalizedAlias]), chamado uma vez no arranque do servidor. Não
 * sobrescreve nada que já exista (ex: um alias que o admin já tenha corrigido manualmente).
 */
export async function seedDefaultAliases(): Promise<void> {
  const rows = ALIAS_SEED.flatMap((entry) =>
    entry.aliases.map((alias) => ({
      sport: entry.sport,
      alias,
      normalizedAlias: normalizeTeamName(alias),
      canonicalName: entry.canonicalName,
    }))
  );
  const result = await prisma.teamAlias.createMany({ data: rows, skipDuplicates: true });
  if (result.count > 0) logger.info({ count: result.count }, "Mapping: aliases por omissão semeados");
  await reloadAliasCache();
}

export async function addAlias(alias: string, canonicalName: string, sport: string): Promise<void> {
  await prisma.teamAlias.upsert({
    where: { sport_normalizedAlias: { sport, normalizedAlias: normalizeTeamName(alias) } },
    create: { sport, alias, normalizedAlias: normalizeTeamName(alias), canonicalName },
    update: { alias, canonicalName },
  });
  await reloadAliasCache();
}

export async function removeAlias(id: string): Promise<void> {
  await prisma.teamAlias.delete({ where: { id } });
  await reloadAliasCache();
}

export async function listAliases() {
  return prisma.teamAlias.findMany({ orderBy: [{ sport: "asc" }, { canonicalName: "asc" }] });
}
