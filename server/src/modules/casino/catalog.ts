import rawCatalog from "./data/games.json";

export interface CasinoGame {
  provider_id: number;
  game_code: string;
  game_name: string;
  game_image: string;
  launch_enable: boolean;
  category: string;
  reg_date: string;
}

// Catálogo real enviado pelo utilizador (Cassino Gold Palace, ~Pragmatic Play) — não é gerado
// nem inventado, é o corpo devolvido pelo endpoint de lista de jogos do provedor.
const GAMES: CasinoGame[] = (rawCatalog as { data: CasinoGame[] }).data;

// Jogos em destaque na página Destaques — códigos reais e populares do catálogo. Lista curada
// à mão em vez de aleatória, para manter os mesmos jogos "de rosto" entre carregamentos.
const HIGHLIGHT_CODES = [
  "vs20fruitsw", // Sweet Bonanza
  "vs20olympgate", // Gates of Olympus
  "vs10bbbonanza", // Big Bass Bonanza
  "vs40wildwest", // Wild West Gold
  "vs20starlight", // Starlight Princess
  "vs25wolfgold", // Wolf Gold
];

export function listGames(opts: { search?: string; category?: string; limit?: number; offset?: number } = {}) {
  let games = GAMES.filter((g) => g.launch_enable);

  if (opts.category) {
    const category = opts.category.toLowerCase();
    games = games.filter((g) => g.category.toLowerCase() === category);
  }
  if (opts.search) {
    const search = opts.search.toLowerCase();
    games = games.filter((g) => g.game_name.toLowerCase().includes(search));
  }

  const total = games.length;
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? total;
  return { total, games: games.slice(offset, offset + limit) };
}

export function listHighlightedGames(): CasinoGame[] {
  const byCode = new Map(GAMES.map((g) => [g.game_code, g]));
  return HIGHLIGHT_CODES.map((code) => byCode.get(code)).filter((g): g is CasinoGame => !!g && g.launch_enable);
}

export function findGame(gameCode: string): CasinoGame | undefined {
  return GAMES.find((g) => g.game_code === gameCode && g.launch_enable);
}
