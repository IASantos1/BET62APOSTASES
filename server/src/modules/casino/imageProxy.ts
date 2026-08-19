import { logger } from "../../lib/logger";
import { findGame } from "./catalog";

interface CachedImage {
  buffer: Buffer;
  contentType: string;
  cachedAt: number;
  isPlaceholder: boolean;
}

const cache = new Map<string, CachedImage>();
const SUCCESS_TTL_MS = 6 * 60 * 60 * 1000; // 6h — a imagem real do provedor raramente muda
const FAILURE_TTL_MS = 2 * 60 * 1000; // 2min — tenta de novo em breve (ex: assim que o IP for autorizado)
const FETCH_TIMEOUT_MS = 5_000;

const PLACEHOLDER_COLORS = [
  ["#ff6b9d", "#c44569"],
  ["#3949ab", "#1a237e"],
  ["#00acc1", "#006064"],
  ["#5d4037", "#3e2723"],
  ["#43a047", "#1b5e20"],
  ["#f4511e", "#bf360c"],
  ["#7b1fa2", "#4a148c"],
  ["#00838f", "#004d40"],
];

function colorsFor(seed: string): [string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const pair = PLACEHOLDER_COLORS[hash % PLACEHOLDER_COLORS.length]!;
  return [pair[0]!, pair[1]!];
}

function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w[0]!.toUpperCase());
  return initials.join("") || "?";
}

// Gerado quando a imagem real do provedor (api.playxspin.com) não está acessível — confirmado
// com o utilizador que este domínio dá timeout de ligação mesmo a partir da Railway (rede real,
// sem bloqueios de sandbox), provavelmente por falta de autorização de IP do lado do provedor.
// Em vez de um ícone de imagem partida no cartão do jogo, mostra um placeholder com o nome.
function buildPlaceholderSvg(gameName: string): string {
  const [from, to] = colorsFor(gameName);
  const initials = initialsFor(gameName);
  const escapedName = gameName.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="216" height="160" viewBox="0 0 216 160">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${from}"/>
        <stop offset="100%" stop-color="${to}"/>
      </linearGradient>
    </defs>
    <rect width="216" height="160" fill="url(#g)"/>
    <text x="108" y="82" font-family="sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${initials}</text>
    <text x="108" y="138" font-family="sans-serif" font-size="12" fill="#ffffffcc" text-anchor="middle">${escapedName.length > 26 ? escapedName.slice(0, 24) + "…" : escapedName}</text>
  </svg>`;
}

async function fetchRealImage(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType };
  } catch (err) {
    logger.warn({ err, url }, "Cassino: falha ao buscar imagem real do provedor, a usar placeholder");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Devolve a imagem de um jogo do catálogo — a real do provedor quando acessível, com cache de
 * sucesso e de falha para não repetir o pedido lento a cada carregamento de página. Nunca
 * devolve null: sem imagem real, gera sempre um placeholder consistente (mesmas cores para o
 * mesmo jogo), para o cartão nunca mostrar um ícone de imagem partida.
 */
export async function getGameImage(gameCode: string): Promise<CachedImage | null> {
  const game = findGame(gameCode);
  if (!game) return null;

  const cached = cache.get(gameCode);
  const ttl = cached?.isPlaceholder ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
  if (cached && Date.now() - cached.cachedAt < ttl) return cached;

  const real = await fetchRealImage(game.game_image);
  const entry: CachedImage = real
    ? { ...real, cachedAt: Date.now(), isPlaceholder: false }
    : { buffer: Buffer.from(buildPlaceholderSvg(game.game_name)), contentType: "image/svg+xml", cachedAt: Date.now(), isPlaceholder: true };

  cache.set(gameCode, entry);
  return entry;
}
