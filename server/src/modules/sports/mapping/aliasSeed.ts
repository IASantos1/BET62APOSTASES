/**
 * Aliases conhecidos à partida — só os casos que a semelhança de texto pura (normalize.ts)
 * genuinamente não apanha, sobretudo acrónimos sem sobreposição textual nenhuma com o nome
 * completo (ex: "PSG" vs "Paris Saint Germain" não partilham nenhuma palavra/prefixo). Casos
 * como "Inter"~"Internazionale" ou "Man Utd"~"Manchester United" já costumam bater certo só
 * com calculateTeamSimilarity() (prefixo/sobreposição de palavras) — estão aqui à mesma, como
 * rede de segurança, porque o custo de os ter é zero.
 *
 * Isto é só a SEMENTE inicial — aliasStore.ts semeia-os na tabela TeamAlias no arranque (só se
 * ainda não existirem), e dali em diante a lista cresce via painel admin (POST /api/admin/team-
 * aliases), sem precisar de tocar neste ficheiro nem fazer deploy novo (pedido explícito da
 * spec: "permitir adicionar novos aliases sem alterar o código principal").
 */
export interface AliasSeedEntry {
  sport: string;
  canonicalName: string; // nome a usar como query na pesquisa da API-Football
  aliases: string[];
}

export const ALIAS_SEED: AliasSeedEntry[] = [
  {
    sport: "football",
    canonicalName: "Manchester United",
    aliases: ["Manchester United", "Man Utd", "Man United", "Manchester Utd", "MUFC"],
  },
  {
    sport: "football",
    canonicalName: "Paris Saint Germain",
    aliases: ["Paris Saint Germain", "PSG", "Paris SG", "Paris Saint-Germain"],
  },
  {
    sport: "football",
    canonicalName: "Internazionale",
    aliases: ["Inter", "Inter Milan", "Internazionale", "Inter Milano"],
  },
  {
    sport: "football",
    canonicalName: "Bayern Munich",
    aliases: ["Bayern Munich", "Bayern München", "Bayern Munchen", "FC Bayern", "Bayern"],
  },
  {
    sport: "football",
    canonicalName: "Sporting CP",
    aliases: ["Sporting CP", "Sporting Lisbon", "Sporting Lisboa", "Sporting Clube de Portugal", "Sporting"],
  },
  {
    sport: "football",
    canonicalName: "Real Betis",
    aliases: ["Real Betis", "Betis"],
  },
];
