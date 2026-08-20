/**
 * normalizeTeamName() / calculateTeamSimilarity() — funções puras, sem I/O (nem BD nem rede),
 * usadas por teamMatcher.ts. Extraído de apifootball/client.ts (onde vivia como normalizeName/
 * nameSimilarity) para ser a peça reutilizável partilhada por todo o motor de mapeamento —
 * apifootball/client.ts continua a usá-las para a sua própria pesquisa "melhor esforço"
 * (searchTeam/searchLeague), agora importadas daqui em vez de duplicadas.
 */

// Sufixos demasiado genéricos para servirem de sinal de identidade — removidos antes de comparar
// (ex: "Barcelona" vs "Barcelona SC" continuam a poder ser clubes diferentes, por isso "sc" fica
// de fora desta lista de propósito, ver nota em GENERIC_NAME_WORDS abaixo).
export function normalizeTeamName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|cf|ac|afc|cd|ud|sd)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Palavras demasiado comuns em nomes de clube/liga para, sozinhas, servirem de sinal de
// correspondência (ex: "Real Madrid" não pode "passar" por "Real Sociedad" só por partilharem
// "real") — mas reduzida à lista mínima que não compromete abreviações legítimas onde a
// palavra partilhada É o único nome distintivo do próprio clube (ex: "Manchester United" ~
// "Man United" precisa de "united" continuar a contar, ver prefixMatches em tokenSimilarity).
const GENERIC_NAME_WORDS = new Set([
  "real", "deportivo", "sporting", "atletico", "athletic", "united", "city", "town",
  "county", "racing", "union", "national", "sport", "calcio", "club", "deportes",
]);

// Distância de edição normalizada (0..1) — apanha diferenças de grafia/acentuação entre as
// duas fontes (ex: "Bayern München" vs "Bayern Munich").
function editSimilarity(a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return 1 - dp[m]![n]! / Math.max(m, n);
}

// Sobreposição de palavras entre os dois nomes já normalizados — só conta palavras "não
// genéricas" (GENERIC_NAME_WORDS) como sinal forte, e trata palavras não-partilhadas mas
// relacionadas por prefixo (ex: "man" abrevia "manchester") também como sinal forte, para não
// perder abreviações legítimas cujo único nome distintivo aparece truncado.
function tokenSimilarity(na: string, nb: string): number {
  const wa = na.split(" ").filter(Boolean);
  const wb = nb.split(" ").filter(Boolean);
  const sa = new Set(wa);
  const sb = new Set(wb);
  const common = [...sa].filter((w) => sb.has(w));
  const significant = common.filter((w) => !GENERIC_NAME_WORDS.has(w));
  const onlyA = [...sa].filter((w) => !sb.has(w));
  const onlyB = [...sb].filter((w) => !sa.has(w));
  let prefixMatches = 0;
  for (const wA of onlyA) {
    if (onlyB.some((wB) => wA.length >= 3 && wB.length >= 3 && (wA.startsWith(wB) || wB.startsWith(wA)))) prefixMatches++;
  }
  const strongCommon = significant.length + prefixMatches;
  const effectiveCommon = strongCommon > 0 ? strongCommon : common.length * 0.3;
  return effectiveCommon / Math.max(sa.size, sb.size);
}

/**
 * Semelhança entre dois nomes (equipa ou liga) — combina sobreposição de palavras (mais forte
 * para nomes com várias palavras) com distância de edição (apanha variações de grafia), com a
 * segunda "amortecida" quando a primeira é fraca — evita que dois nomes só partilhem um prefixo
 * comum longo (ex: "Deportivo Santani" ~ "Deportivo Capiata") passem por semelhantes só pela
 * distância de edição. Não apanha acrónimos puros sem sobreposição textual nenhuma (ex: "PSG"
 * vs "Paris Saint Germain") — é exatamente para esses casos que existe o dicionário de aliases
 * (aliasStore.ts), consultado ANTES desta função no pipeline de teamMatcher.ts.
 */
export function calculateTeamSimilarity(a: string, b: string): number {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const t = tokenSimilarity(na, nb);
  const e = editSimilarity(na, nb);
  const guardedEdit = t < 0.3 ? e * 0.55 : e;
  return Math.max(t, guardedEdit);
}
