// ====================== TEMA AUTOMÁTICO (sem botão manual) ======================
// Já aplicado uma vez inline no <head> para evitar flash; aqui só voltamos a
// verificar a cada minuto para apanhar a transição das 08:00 / 20:00 com a aba aberta.
function applyAutoTheme() {
  const hour = new Date().getHours();
  const theme = hour >= 8 && hour < 20 ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
}
setInterval(applyAutoTheme, 60000);

// ====================== DESPORTOS ======================
const SPORTS_META = [
  { id: "football", label: "Futebol", icon: "⚽" },
  { id: "tennis", label: "Ténis", icon: "🎾" },
  { id: "basketball", label: "Basquete", icon: "🏀" },
  { id: "ice_hockey", label: "Hóquei", icon: "🏒" },
  { id: "mma", label: "MMA", icon: "🥋" },
  { id: "baseball", label: "Beisebol", icon: "⚾" },
  { id: "volleyball", label: "Voleibol", icon: "🏐" },
  { id: "formula1", label: "Fórmula 1", icon: "🏎️" },
];
let selectedSport = null; // null = todos
let selectedLeague = null; // filtra ainda mais por liga (ver loadFootballCountriesTree)

// Lista estática usada só como fallback instantâneo enquanto a árvore real (ver
// loadFootballCountriesTree, abaixo) ainda não carregou, ou se a API não devolver nada (ex: sem
// PULSESCORE_API_KEY configurada). Assim que houver dados reais, o menu troca para eles.
const FOOTBALL_LEAGUES_BY_COUNTRY = {
  Inglaterra: ["Premier League", "Championship", "FA Cup", "EFL Cup"],
  Espanha: ["La Liga", "Segunda División", "Copa del Rey"],
  Itália: ["Serie A", "Serie B", "Coppa Italia"],
  Alemanha: ["Bundesliga", "2. Bundesliga", "DFB-Pokal"],
  França: ["Ligue 1", "Ligue 2", "Coupe de France"],
  Portugal: ["Primeira Liga", "Liga Portugal 2", "Taça de Portugal"],
  "Países Baixos": ["Eredivisie", "Eerste Divisie", "KNVB Beker"],
  Bélgica: ["Jupiler Pro League", "Challenger Pro League", "Beker van België"],
  Escócia: ["Premiership", "Championship", "Scottish Cup"],
  Brasil: ["Brasileirão Série A", "Brasileirão Série B", "Copa do Brasil"],
  Argentina: ["Liga Profesional", "Primera Nacional", "Copa Argentina"],
  "Estados Unidos": ["MLS", "USL Championship", "US Open Cup"],
  Turquia: ["Süper Lig", "1. Lig", "Türkiye Kupası"],
  México: ["Liga MX", "Liga de Expansión MX", "Copa MX"],
};

// ====================== PAÍSES/LIGAS DE FUTEBOL — dados reais (campo `country`) ======================
// A bookmaker atual (paddypower, ver docs/SPORTS_DATA.md) devolve um `country` real (código ISO
// de 2 letras, ou "" para competições internacionais) em cada evento. Em vez de confiar só na
// lista estática acima, construímos a árvore país→ligas a partir dos jogos reais de futebol
// (pré-jogo + ao vivo) devolvidos agora pela API. Intl.DisplayNames traduz o código para um nome
// legível em português sem precisar de manter uma lista de países à mão.
const countryDisplayNames = (() => {
  try {
    return new Intl.DisplayNames(["pt"], { type: "region" });
  } catch {
    return null; // navegador sem suporte a Intl.DisplayNames — mostra o código em bruto
  }
})();
function countryLabel(code) {
  if (!code) return "Internacional";
  if (countryDisplayNames) {
    try {
      const name = countryDisplayNames.of(code.toUpperCase());
      if (name && name.toUpperCase() !== code.toUpperCase()) return name;
    } catch {
      /* código não reconhecido — cai para mostrar o código em bruto abaixo */
    }
  }
  return code;
}

// Código ISO de 2 letras -> emoji de bandeira (dois "regional indicator symbols" Unicode, ex:
// "US" -> 🇺🇸). Sem imagens/lista para manter — funciona para qualquer código real.
function flagEmoji(code) {
  if (!code || code.length !== 2) return "";
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return "";
  const codePoints = [...upper].map((c) => 0x1f1e6 + (c.charCodeAt(0) - 65));
  return String.fromCodePoint(...codePoints);
}

let footballCountriesTree = null; // null = ainda não carregado; [] = carregado mas vazio
let footballCountriesTreeAt = 0;
const FOOTBALL_TREE_TTL_MS = 5 * 60 * 1000;

async function loadFootballCountriesTree() {
  if (footballCountriesTree && footballCountriesTree.length && Date.now() - footballCountriesTreeAt < FOOTBALL_TREE_TTL_MS) {
    return footballCountriesTree;
  }
  try {
    const [prematch, live] = await Promise.all([Bet62Api.getPrematchEvents("football"), Bet62Api.getLiveEvents("football")]);
    const events = [...(prematch?.source === "pulsescore" ? prematch.events : []), ...(live?.events || [])];
    const byCountry = new Map(); // código ISO (ou "") -> Set<nome da liga>
    for (const e of events) {
      if (!e.league) continue;
      const code = e.country ?? "";
      if (!byCountry.has(code)) byCountry.set(code, new Set());
      byCountry.get(code).add(e.league);
    }
    const tree = [...byCountry.entries()]
      .map(([code, leagues]) => ({ label: countryLabel(code), leagues: [...leagues].sort((a, b) => a.localeCompare(b, "pt")) }))
      .sort((a, b) => (a.label === "Internacional" ? 1 : b.label === "Internacional" ? -1 : a.label.localeCompare(b.label, "pt")));
    footballCountriesTree = tree;
    footballCountriesTreeAt = Date.now();
    return tree;
  } catch {
    return footballCountriesTree || [];
  }
}

function renderSportSubnav() {
  const el = document.getElementById("sport-subnav");
  const chips = [{ id: null, label: "Todos", icon: "🔀" }, ...SPORTS_META];
  el.innerHTML = chips
    .map(
      (s) =>
        `<div class="sport-chip ${selectedSport === s.id ? "active" : ""}" onclick="selectSport(${s.id ? `'${s.id}'` : "null"})">${s.icon} ${s.label}</div>`
    )
    .join("");
}
function selectSport(sportId) {
  selectedSport = sportId;
  selectedLeague = null;
  renderSportSubnav();
  renderSportsMenu();
  const active = pageHistory[pageHistory.length - 1];
  if (active === "aovivo") renderLiveEvents();
  if (active === "esportes") renderPrematchList();
}

// ====================== MENU LATERAL ESQUERDO (Competições + Desportos) ======================
async function renderCompetitions() {
  const el = document.getElementById("competitions-list");
  if (!el) return;
  try {
    const { competitions } = await Bet62Api.getCompetitions();
    if (!competitions.length) {
      el.innerHTML = '<div class="empty-note" style="padding:6px 2px">Sem ligas com jogos hoje</div>';
      return;
    }
    const icon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
    el.innerHTML = competitions
      .map(
        (c) => `
      <div class="comp-item" onclick="selectSport('${c.sport}'); showPage('esportes'); closeDrawers();">
        <span>${icon[c.sport] || ""} ${c.league}</span>
        <span class="comp-count">${c.eventCount}</span>
      </div>`
      )
      .join("");
  } catch {
    el.innerHTML = "";
  }
}

const expandedSports = new Set();
const expandedCountries = new Set();

function toggleSportExpand(sportId, ev) {
  ev.stopPropagation();
  if (expandedSports.has(sportId)) {
    expandedSports.delete(sportId);
  } else {
    expandedSports.add(sportId);
    // Carrega a árvore país→ligas real na primeira vez que o utilizador abre Futebol; entretanto
    // o menu mostra a lista estática (renderSportsMenu trata disso), depois troca sozinho.
    if (sportId === "football") loadFootballCountriesTree().then(() => renderSportsMenu());
  }
  renderSportsMenu();
}
function toggleCountryExpand(country, ev) {
  ev.stopPropagation();
  if (expandedCountries.has(country)) expandedCountries.delete(country);
  else expandedCountries.add(country);
  renderSportsMenu();
}
function selectLeague(sportId, leagueName) {
  selectedSport = sportId;
  selectedLeague = leagueName;
  renderSportSubnav();
  renderSportsMenu();
  showPage("esportes");
  closeDrawers();
}

function goToSport(sportId) {
  selectSport(sportId);
  if (!["esportes", "aovivo"].includes(pageHistory[pageHistory.length - 1])) showPage("esportes");
  closeDrawers();
}

function renderSportsMenu() {
  const el = document.getElementById("sports-menu-list");
  if (!el) return;
  el.innerHTML = SPORTS_META.map((s) => {
    const hasChildren = s.id === "football";
    const isExpanded = expandedSports.has(s.id);
    const isActive = selectedSport === s.id && !selectedLeague;
    const chevron = hasChildren
      ? `<span class="sports-menu-chevron ${isExpanded ? "open" : ""}" onclick="toggleSportExpand('${s.id}', event)"><i class="fas fa-chevron-down"></i></span>`
      : "";
    const header = `
      <div class="sports-menu-item ${isActive ? "active" : ""}" onclick="goToSport('${s.id}')">
        <span>${s.icon} ${s.label}</span>${chevron}
      </div>`;
    if (!hasChildren || !isExpanded) return header;

    // Usa a árvore real (país→ligas dos jogos reais) assim que carregada; até lá, ou se vier
    // vazia (ex: sem PULSESCORE_API_KEY), cai para a lista estática curada.
    const countriesData =
      footballCountriesTree && footballCountriesTree.length
        ? footballCountriesTree.map((c) => [c.label, c.leagues])
        : Object.entries(FOOTBALL_LEAGUES_BY_COUNTRY);

    const countries = countriesData
      .map(([country, leagues]) => {
        const countryOpen = expandedCountries.has(country);
        const leaguesHtml = countryOpen
          ? leagues
              .map((league) => {
                const active = selectedSport === s.id && selectedLeague === league;
                return `<div class="league-item ${active ? "active" : ""}" onclick='selectLeague(${JSON.stringify(s.id)}, ${JSON.stringify(league)})'>${league}</div>`;
              })
              .join("")
          : "";
        return `
          <div class="country-item" onclick='toggleCountryExpand(${JSON.stringify(country)}, event)'>
            <span class="sports-menu-chevron ${countryOpen ? "open" : ""}"><i class="fas fa-chevron-down"></i></span>${country}
          </div>
          ${leaguesHtml}`;
      })
      .join("");

    return header + `<div class="country-list">${countries}</div>`;
  }).join("");
}

// ====================== DRAWERS (mobile/PWA) ======================
function toggleLeftDrawer() {
  document.getElementById("sidebar-left").classList.toggle("open");
  document.getElementById("drawer-overlay").classList.toggle("open");
}
function openRightDrawer() {
  document.getElementById("sidebar-right").classList.add("open");
  document.getElementById("drawer-overlay").classList.add("open");
}
function closeDrawers() {
  document.getElementById("sidebar-left").classList.remove("open");
  document.getElementById("sidebar-right").classList.remove("open");
  document.getElementById("drawer-overlay").classList.remove("open");
}

// Esqueleto de carregamento — mostra N cartões placeholder (mesma forma do .live-card real,
// ver CSS .skeleton-card) em vez de um "A carregar…" em texto simples, para o utilizador ver
// desde logo a forma da lista que está prestes a aparecer (percepção de carregamento rápido).
function skeletonCardsHtml(count) {
  const card = `
    <div class="skeleton-card">
      <div class="sk-top"><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
      <div class="skeleton-line sk-team"></div>
      <div class="skeleton-line sk-team" style="width:40%"></div>
      <div class="sk-odds"><div class="skeleton-line"></div><div class="skeleton-line"></div><div class="skeleton-line"></div></div>
    </div>`;
  return card.repeat(count);
}

// Carregamento por bloco: em vez de um único innerHTML gigante (trava o main thread quando a
// lista é grande, ex: "Todos" os desportos em Pré-jogo pode juntar dezenas de jogos vindos de 8
// pedidos em paralelo), insere os cartões em fatias sucessivas via requestAnimationFrame — o
// utilizador vê a lista aparecer em blocos em vez de tudo de uma vez ao fim do carregamento
// inteiro. htmlArray é um array de strings HTML, uma por cartão (não uma string já unida).
function renderInBlocks(container, htmlArray, blockSize = 12) {
  container.innerHTML = "";
  if (!htmlArray.length) return;
  let i = 0;
  const token = (container._renderToken = (container._renderToken || 0) + 1);
  function paintNext() {
    if (container._renderToken !== token) return; // uma renderização mais recente já assumiu este contentor
    const slice = htmlArray.slice(i, i + blockSize);
    const wrapper = document.createElement("div");
    wrapper.innerHTML = slice.join("");
    const frag = document.createDocumentFragment();
    while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
    container.appendChild(frag);
    i += blockSize;
    if (i < htmlArray.length) requestAnimationFrame(paintNext);
  }
  paintNext();
}

const prematchEventsById = new Map();

function clearLeagueFilter() {
  selectedLeague = null;
  renderSportsMenu();
  renderPrematchList();
}

async function renderPrematchList() {
  const container = document.getElementById("prematch-list");
  const requestToken = ++renderPrematchList._token;
  container.innerHTML = skeletonCardsHtml(6);

  const badge = document.getElementById("league-filter-badge");
  if (badge) {
    badge.innerHTML = selectedLeague
      ? `<div class="league-filter-badge">Filtrado por: <b>${selectedLeague}</b> <span onclick="clearLeagueFilter()">✕</span></div>`
      : "";
  }

  const sports = selectedSport ? [selectedSport] : SPORTS_META.map((s) => s.id);
  const realEvents = [];
  const results = await Promise.allSettled(sports.map((s) => Bet62Api.getPrematchEvents(s)));
  if (requestToken !== renderPrematchList._token) return; // uma seleção mais recente já está a carregar

  results.forEach((r) => {
    if (r.status === "fulfilled" && r.value.source === "pulsescore") realEvents.push(...r.value.events);
  });

  const filteredEvents = selectedLeague
    ? realEvents.filter((e) => e.league && e.league.toLowerCase().includes(selectedLeague.toLowerCase()))
    : realEvents;
  // Pedido explícito do utilizador: futebol sempre primeiro quando "Todos" os desportos estão
  // visíveis — os pedidos por desporto já resolvem por esta ordem (Promise.allSettled preserva a
  // ordem de `sports`, que começa em futebol), mas este sort explícito garante o agrupamento
  // mesmo que essa ordem interna mude no futuro (mesmo SPORT_ORDER usado em renderLiveEvents).
  const events = [...filteredEvents].sort((a, b) => (SPORT_ORDER[a.sport] ?? 99) - (SPORT_ORDER[b.sport] ?? 99));

  prematchEventsById.clear();
  events.forEach((e) => prematchEventsById.set(e.id, e));

  if (!events.length) {
    container.innerHTML = '<div class="empty-note">Sem jogos agendados para este desporto neste momento</div>';
    return;
  }
  const icon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
  const cardsHtml = events.map(
    (e) => `
      <div class="live-card" onclick="openMarket('${e.id}', false)">
        <div class="lc-top"><span>${icon[e.sport] || ""} ${e.league}</span><span>${formatKickoff(e.startTime)}</span></div>
        <div class="lc-teams"><span>${e.home}</span><span style="color:var(--muted);font-size:.8rem">vs</span><span>${e.away}</span></div>
        ${quickOddsHtml(e, e.odds?.[0], false)}
      </div>`
  );
  renderInBlocks(container, cardsHtml);
}
renderPrematchList._token = 0;
// Fuso horário fixo de Portugal (IANA — trata sozinho a mudança de hora WET/WEST, ao contrário
// de um offset fixo tipo "+01:00") — pedido explícito do utilizador: um jogo do Japão (Japan
// NPB) ou de qualquer outro país deve sempre aparecer na hora de Portugal, nunca na hora do
// dispositivo de quem está a ver. Sem isto, `toLocaleTimeString`/`toLocaleDateString` sem
// `timeZone` explícito usam o fuso do PRÓPRIO browser — só calhava mostrar certo antes disto
// para quem tivesse o telemóvel definido para o fuso de Portugal, por coincidência, não porque
// estivesse mesmo configurado.
const BET62_TIMEZONE = "Europe/Lisbon";

// Chave YYYY-MM-DD do dia civil em Portugal (não o do browser) — usada só para decidir "Hoje"
// vs. mostrar a data; a locale "en-CA" dá o formato ISO diretamente, não é a locale mostrada ao
// utilizador (essa continua "pt-PT" no `toLocaleTimeString`/`toLocaleDateString` abaixo).
function lisbonDateKey(date) {
  return date.toLocaleDateString("en-CA", { timeZone: BET62_TIMEZONE });
}

// A hora fixa a Portugal em formatKickoff() só está correta se `new Date(d)` calcular o INSTANTE
// certo à partida — e isso depende de `d` trazer o fuso explícito ("Z"/"+HH:MM"). SEM fuso
// explícito, o JavaScript trata a string como hora LOCAL de quem a está a interpretar (o
// dispositivo do utilizador), o que dá um instante diferente consoante o fuso desse dispositivo —
// exatamente o tipo de "hora errada"/"várias horas diferentes para o mesmo jogo" que foi
// reportado (ex: beisebol a aparecer com 2 horas de diferença da hora real). A Pulsescore nunca
// confirmou com uma amostra real qual das duas formas envia (ver docs/SPORTS_DATA.md) — por
// prudência, assume-se UTC quando falta o fuso (mesma convenção usada no resto deste projeto,
// ex: `updatedAt: new Date().toISOString()` no backend, que é sempre UTC com "Z"), acrescentando
// "Z" à string antes de a interpretar, em vez de deixar ao acaso do dispositivo de quem vê.
function parseServerDate(d) {
  if (typeof d !== "string") return new Date(d);
  const hasExplicitTimezone = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(d.trim());
  return new Date(hasExplicitTimezone ? d : `${d.trim()}Z`);
}

function formatKickoff(d) {
  const date = parseServerDate(d);
  const now = new Date();
  const sameDay = lisbonDateKey(date) === lisbonDateKey(now);
  const time = date.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit", timeZone: BET62_TIMEZONE });
  return sameDay ? `Hoje, ${time}` : date.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", timeZone: BET62_TIMEZONE }) + `, ${time}`;
}

// ====================== STATE ======================
let currentProfile = null;
let currentBalance = null;
let pageHistory = ["destaques"];
let selectedDepositMethod = "STRIPE_CARD";
let liveSocket = null;
let liveSnapshotReceived = false; // true assim que o 1º frame "snapshot" do WS chega — distingue "ainda a carregar" (esqueleto) de "carregou e está mesmo vazio", ver renderLiveEvents()
const liveEventsById = new Map();
let currentMarketEvent = null;
const betslipSelections = new Map(); // key -> { eventId, market, selection, odd }

// Seleções ativas de um mercado — o backend já não descarta seleções suspensas (isActive:false,
// ex: durante uma revisão VAR ou logo após um penálti/cartão), passam a chegar marcadas para a
// UI as mostrar suspensas em vez de clicáveis. Os cartões compactos (pré-jogo/ao vivo) só
// mostram as ativas, para não ocupar as 3 posições de pré-visualização com odds suspensas.
function activeSelectionEntries(group) {
  // Number.isFinite(sel?.odd) descarta qualquer entrada com odd inválida/em falta (ex: uma
  // transição de deploy em que JS antigo em cache leu a forma nova {odd,isActive} como se
  // fosse só um número — Number({odd:1.85,...}) dá NaN) em vez de deixar "NaN" aparecer no ecrã.
  return Object.entries(group?.selections ?? {}).filter(([, sel]) => sel?.isActive && Number.isFinite(sel?.odd));
}

// Clicar numa odd 1x2 do cartão compacto (pré-jogo/ao vivo) vai direto ao boletim, sem abrir o
// mercado — pedido explícito, o cartão inteiro tem onclick='openMarket(...)' à volta, por isso
// stopPropagation() é obrigatório para não navegar também. classList.toggle() dá feedback visual
// imediato; o "picked" calculado em quickOddsHtml() a partir de betslipSelections garante que o
// estado sobrevive ao próximo refresh da lista (poll/WS), que substitui todo o innerHTML.
function quickPick(event, key, selection) {
  event.stopPropagation();
  toggleSelection(key, selection);
  event.currentTarget.classList.toggle("picked");
}

// As 3 odds 1x2 do cartão compacto ficavam invisíveis assim que o mercado era suspenso (VAR,
// pênalti, cartão...), porque só entradas ativas (activeSelectionEntries) chegavam a aparecer —
// pedido explícito para NUNCA sumirem: agora mostram-se sempre, ativas clicáveis e suspensas
// como bloco cinzento "Suspenso" (mesmo tratamento já usado na página do mercado, ver
// renderMarketGroups acima) em vez de desaparecer.
function quickOddsHtml(e, group, isLive) {
  if (!group?.selections) return "";
  if (!group.isActive) return '<div class="lc-odds"><div class="suspended" style="flex:3">Suspenso</div></div>';
  const entries = Object.entries(group.selections).slice(0, 3);
  if (!entries.length) return "";
  return `<div class="lc-odds">${entries
    .map(([label, sel]) => {
      const labelPt = translateSelectionLabel(label);
      if (!sel.isActive || !Number.isFinite(sel.odd)) {
        return `<div class="suspended">${labelPt}<br>Suspenso</div>`;
      }
      const key = `${e.id}|${group.market}|${label}`;
      const picked = betslipSelections.has(key);
      const selection = { eventId: e.id, sport: e.sport, market: group.market, selection: label, odd: sel.odd, home: e.home, away: e.away, league: e.league };
      const arrow = isLive ? oddsArrowHtml(key, sel.odd) : "";
      return `<div class="${picked ? "picked" : ""}" onclick='quickPick(event, ${JSON.stringify(key)}, ${JSON.stringify(selection)})'>${labelPt}<br>${sel.odd.toFixed(2)}${arrow}</div>`;
    })
    .join("")}</div>`;
}

// Setas de subida/descida das odds: guarda o último valor visto por seleção (mesma chave
// "eventId|mercado|seleção" usada no boletim) e compara a cada render — só mostra seta quando
// o valor mudou desde o render anterior, por isso desaparece sozinha no ciclo seguinte se a
// odd não voltar a mudar.
const oddsHistory = new Map();
function oddsArrowHtml(key, value) {
  const prev = oddsHistory.get(key);
  oddsHistory.set(key, value);
  if (prev === undefined || value === prev) return "";
  return value > prev ? '<span class="odds-arrow up">▲</span>' : '<span class="odds-arrow down">▼</span>';
}

// ====================== NAVIGATION ======================
function showPage(page) {
  if (pageHistory[pageHistory.length - 1] !== page) pageHistory.push(page);
  closeDrawers();

  ["destaques", "profile", "esportes", "cassino", "aovivo", "promocao", "market"].forEach((p) => {
    const el = document.getElementById("page-" + p);
    if (el) el.classList.toggle("hidden", p !== page);
  });
  document.querySelectorAll(".top-nav-item").forEach((t) => {
    t.classList.toggle("active", t.dataset.page === page);
  });
  document.getElementById("sport-subnav").classList.toggle("hidden", page !== "esportes" && page !== "aovivo");

  const showBack = page !== "destaques";
  document.getElementById("btn-back").classList.toggle("hidden", !showBack);

  if (page === "profile") loadProfile();
  if (page === "aovivo") { renderSportSubnav(); renderLiveEvents(); ensureLiveSocket(); }
  if (page === "esportes") { renderSportSubnav(); renderPrematchList(); }
  if (page === "destaques") renderDestaquesHighlights();
  if (page === "cassino") enterCasinoPage();
  if (page === "promocao") loadPromocaoPage();
}

function goBack() {
  if (pageHistory.length > 1) {
    pageHistory.pop();
    showPage(pageHistory[pageHistory.length - 1]);
  } else {
    showPage("destaques");
  }
}

// Gesto "arrastar da borda esquerda para voltar" (como no iOS), pedido pelo utilizador além do
// botão de seta. Só ativa quando o toque começa perto da borda esquerda do ecrã — não em
// qualquer ponto do ecrã — para não entrar em conflito com listas com scroll horizontal que já
// existem (chips de desporto, linhas de odds, etc.).
(function setupSwipeBack() {
  const EDGE_PX = 24;
  const MIN_DX = 70;
  let startX = null;
  let startY = null;
  let tracking = false;

  document.addEventListener(
    "touchstart",
    (ev) => {
      const t = ev.touches[0];
      tracking = t.clientX <= EDGE_PX;
      startX = tracking ? t.clientX : null;
      startY = tracking ? t.clientY : null;
    },
    { passive: true }
  );

  document.addEventListener(
    "touchend",
    (ev) => {
      if (!tracking || startX === null) return;
      tracking = false;
      const t = ev.changedTouches[0];
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dx > MIN_DX && dx > dy * 1.5) goBack();
      startX = null;
      startY = null;
    },
    { passive: true }
  );
})();

function toggleAccordion(header) {
  header.closest(".menu-item").classList.toggle("open");
}

// ====================== CASSINO ======================
// Página construída só com dados reais do catálogo sincronizado (ver
// server/src/modules/casino/routes.ts, GET /api/casino/games, e docs/CASINO_SLOTS.md) — nenhum
// jogo, imagem, categoria ou "popular" é inventado. As "categorias" (Megaways/Jackpots/etc.) são
// só uma pesquisa por palavra-chave no nome real do jogo (o `category` do provedor é genérico,
// "Slots" para tudo) — ver TAG_KEYWORDS no backend.
//
// O botão de jogar ainda não abre o jogo de verdade: falta confirmar que user/create teve
// sucesso no provedor (ver docs/CASINO_SLOTS.md, secção Callback) — por isso mostra um aviso em
// vez de fingir que funciona.
function escHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const CASINO_TABS = [
  { id: "", label: "TODOS" },
  { id: "megaways", label: "MEGAWAYS™" },
  { id: "jackpots", label: "JACKPOTS" },
  { id: "bonus", label: "COMPRAR BÓNUS" },
  { id: "freespins", label: "RODADAS GRÁTIS" },
  { id: "novos", label: "NOVOS" },
  { id: "populares", label: "POPULARES" },
  { id: "baccarat", label: "BACCARAT" },
  { id: "blackjack", label: "BLACKJACK" },
  { id: "roulette", label: "ROULETTE" },
];

const casinoState = { tag: "", search: "", sort: "", page: 1, pageSize: 24, total: 0, loading: false };
const casinoGamesByCode = new Map(); // gameCode -> jogo, para o clique nos cartões (delegação, ver abaixo)
let casinoInitialized = false;
let casinoSearchDebounce = null;
let casinoHeroSlides = [];
let casinoHeroIndex = 0;
let casinoHeroTimer = null;

function casinoGameImage(g) {
  return g.gameImage || g.gameImageNarrow || "";
}
function casinoGameTitle(g) {
  return g.localeName || g.gameName || "";
}

// Delegação de eventos (em vez de onclick inline com o nome do jogo, que pode ter aspas — ex:
// "Gonzo's Quest" — e partir o atributo HTML) nos três contentores onde cartões/CTA aparecem;
// funciona mesmo depois de o innerHTML de cada contentor ser substituído a cada carregamento.
function casinoDelegatedClick(ev) {
  const el = ev.target.closest("[data-game-code]");
  if (!el) return;
  casinoPlayGame(el.dataset.gameCode);
}

function enterCasinoPage() {
  if (casinoInitialized) return;
  casinoInitialized = true;
  ["casino-hero-track", "casino-popular-row", "casino-grid"].forEach((id) => {
    document.getElementById(id).addEventListener("click", casinoDelegatedClick);
  });
  renderCasinoTabs();
  loadCasinoHeroAndPopular();
  casinoLoadGames(true);
}

function renderCasinoTabs() {
  const el = document.getElementById("casino-tabs-bar");
  el.innerHTML = CASINO_TABS.map(
    (t) => `<div class="casino-tab ${casinoState.tag === t.id ? "active" : ""}" data-tag="${t.id}" onclick="casinoSelectTab('${t.id}')">${t.label}</div>`
  ).join("");
}

function casinoSelectTab(tag) {
  casinoState.tag = tag;
  document.querySelectorAll(".casino-tab").forEach((el) => el.classList.toggle("active", el.dataset.tag === tag));
  casinoLoadGames(true);
}

function casinoOnSearchInput() {
  const value = document.getElementById("casino-search-input").value.trim();
  clearTimeout(casinoSearchDebounce);
  casinoSearchDebounce = setTimeout(() => {
    casinoState.search = value;
    casinoLoadGames(true);
  }, 350);
}

function casinoOnSortChange() {
  casinoState.sort = document.getElementById("casino-sort-select").value;
  casinoLoadGames(true);
}

async function loadCasinoHeroAndPopular() {
  const heroTrack = document.getElementById("casino-hero-track");
  const popularRow = document.getElementById("casino-popular-row");
  popularRow.innerHTML = Array(6).fill('<div class="casino-skel-card" style="flex:0 0 128px"></div>').join("");

  try {
    const result = await Bet62Api.getCasinoGames({ limit: 20 });
    const games = result.games || [];
    games.forEach((g) => casinoGamesByCode.set(g.gameCode, g));
    casinoHeroSlides = games.slice(0, 5);
    renderCasinoHero();
    popularRow.innerHTML = games.length
      ? games.map((g) => casinoGameCardHtml(g)).join("")
      : '<div class="empty-note">Sem jogos disponíveis neste momento</div>';
  } catch (err) {
    heroTrack.innerHTML = "";
    popularRow.innerHTML = '<div class="empty-note">Não foi possível carregar os jogos populares</div>';
  }
}

function renderCasinoHero() {
  const track = document.getElementById("casino-hero-track");
  const dots = document.getElementById("casino-hero-dots");
  clearInterval(casinoHeroTimer);
  casinoHeroIndex = 0;

  if (!casinoHeroSlides.length) {
    track.innerHTML = `
      <div class="casino-hero-slide" style="background:linear-gradient(135deg,#1a0a0a,#2d0f0f)">
        <div class="casino-hero-slide-body">
          <div class="casino-hero-eyebrow">BET62 CASSINO</div>
          <div class="casino-hero-title">Slots a caminho</div>
        </div>
      </div>`;
    dots.innerHTML = "";
    return;
  }

  track.style.transform = "translateX(0%)";
  track.innerHTML = casinoHeroSlides
    .map(
      (g) => `
      <div class="casino-hero-slide" style="background-image:url('${escHtml(casinoGameImage(g))}')">
        <div class="casino-hero-slide-body">
          <div class="casino-hero-eyebrow">JOGO EM DESTAQUE</div>
          <div class="casino-hero-title">${escHtml(casinoGameTitle(g))}</div>
          <button class="casino-hero-cta" data-game-code="${escHtml(g.gameCode)}">JOGUE AGORA</button>
        </div>
      </div>`
    )
    .join("");
  dots.innerHTML = casinoHeroSlides.map((_, i) => `<div class="hero-dot ${i === 0 ? "active" : ""}" onclick="casinoHeroGoTo(${i})"></div>`).join("");

  if (casinoHeroSlides.length > 1) casinoHeroTimer = setInterval(() => casinoHeroStep(1), 5000);
}

function casinoHeroGoTo(index) {
  if (!casinoHeroSlides.length) return;
  casinoHeroIndex = ((index % casinoHeroSlides.length) + casinoHeroSlides.length) % casinoHeroSlides.length;
  document.getElementById("casino-hero-track").style.transform = `translateX(-${casinoHeroIndex * 100}%)`;
  document.querySelectorAll("#casino-hero-dots .hero-dot").forEach((d, i) => d.classList.toggle("active", i === casinoHeroIndex));
}

function casinoHeroStep(delta) {
  casinoHeroGoTo(casinoHeroIndex + delta);
}

function casinoGameCardHtml(g) {
  const title = escHtml(casinoGameTitle(g));
  const img = escHtml(casinoGameImage(g));
  return `
    <div class="casino-game-card" data-game-code="${escHtml(g.gameCode)}">
      ${img ? `<img src="${img}" alt="${title}" loading="lazy">` : ""}
      <div class="casino-game-card-overlay"><div class="casino-game-name">${title}</div></div>
      <div class="casino-game-play"><i class="fas fa-play-circle"></i></div>
    </div>`;
}

async function casinoLoadGames(reset) {
  if (casinoState.loading) return;
  casinoState.loading = true;
  if (reset) casinoState.page = 1;

  const grid = document.getElementById("casino-grid");
  const loadMoreBtn = document.getElementById("casino-load-more");
  const emptyNote = document.getElementById("casino-empty-note");
  const titleEl = document.getElementById("casino-grid-title");
  const activeTab = CASINO_TABS.find((t) => t.id === casinoState.tag);
  titleEl.textContent = activeTab && activeTab.id ? activeTab.label : "SLOTS";

  if (reset) {
    grid.innerHTML = Array(12).fill('<div class="casino-skel-card"></div>').join("");
    emptyNote.classList.add("hidden");
  }

  try {
    const result = await Bet62Api.getCasinoGames({
      page: casinoState.page,
      limit: casinoState.pageSize,
      tag: casinoState.tag || undefined,
      search: casinoState.search || undefined,
      sort: casinoState.sort || undefined,
    });
    casinoState.total = result.total || 0;
    const games = result.games || [];
    games.forEach((g) => casinoGamesByCode.set(g.gameCode, g));
    const html = games.map((g) => casinoGameCardHtml(g)).join("");
    grid.innerHTML = reset ? html : grid.innerHTML + html;

    const loadedCount = grid.querySelectorAll(".casino-game-card").length;
    emptyNote.classList.toggle("hidden", loadedCount > 0);
    loadMoreBtn.classList.toggle("hidden", loadedCount >= casinoState.total);
  } catch (err) {
    if (reset) grid.innerHTML = "";
    emptyNote.textContent = "Não foi possível carregar os jogos. Tente novamente.";
    emptyNote.classList.remove("hidden");
    loadMoreBtn.classList.add("hidden");
  } finally {
    casinoState.loading = false;
  }
}

function casinoLoadMore() {
  casinoState.page += 1;
  casinoLoadGames(false);
}

function casinoPlayGame(gameCode) {
  if (!Bet62Api.isAuthenticated()) {
    openAuth("login");
    return;
  }
  const g = casinoGamesByCode.get(gameCode);
  const name = g ? casinoGameTitle(g) : "Jogo";
  const img = g ? (g.gameImage || g.gameImageNarrow || "") : "";

  openCasinoLoader(name, img, "A preparar a sua sessão de jogo…", "A ligar ao provedor Gold Palace");

  const state = { cancelled: false };
  document.getElementById("cg-frame").onload = () => {
    if (!state.cancelled) hideCasinoLoader();
  };
  // Ligar evento close do modal para marcar cancelled
  const _oldClose = closeCasinoGame;
  const wrappedClose = () => {
    state.cancelled = true;
    _oldClose();
  };
  // (o botão Fechar e ESC ainda chamam closeCasinoGame global — marcamos cancelled via
  // MutationObserver no modal hidden. Mais simples: sobrepor via oncancel listener inline:)
  const modal = document.getElementById("casino-game-modal");
  const obs = new MutationObserver(() => {
    if (modal.classList.contains("hidden")) state.cancelled = true;
  });
  obs.observe(modal, { attributes: true, attributeFilter: ["class"] });

  Bet62Api.provisionCasinoAccount()
    .then((prov) => {
      if (state.cancelled) return;
      if (prov?.needsRetry) {
        setCasinoLoader(
          "Conta de cassino a ser ativada…",
          "Tente novamente em 30 segundos, ou entre em contacto com o suporte se o problema persistir."
        );
        setTimeout(() => {
          if (state.cancelled) return;
          doLaunchCasino(gameCode, name, state);
        }, 2000);
        return;
      }
      doLaunchCasino(gameCode, name, state);
    })
    .catch((err) => {
      if (state.cancelled) return;
      const msg = err?.message || "Erro ao preparar sessão de jogo";
      const code = err?.code || "";
      let sub = "Por favor tente novamente mais tarde.";
      if (code === "CASINO_ACCOUNT_PENDING") sub = "Tente novamente em 30 segundos.";
      else if (err?.status === 403) sub = "Complete a validação de identidade (KYC) para poder jogar.";
      else if (err?.status === 401) { openAuth("login"); closeCasinoGame(); return; }
      setCasinoLoader(msg, sub, true);
    });
}

function openCasinoLoader(name, img, text, sub) {
  const modal = document.getElementById("casino-game-modal");
  const cgName = document.getElementById("cg-name");
  const cgImg = document.getElementById("cg-img");
  const cgFrame = document.getElementById("cg-frame");
  // Limpar iframe anterior (segurança: não deixa jogo anterior correr em background)
  try { cgFrame.removeAttribute("src"); cgFrame.src = "about:blank"; } catch {}
  cgName.textContent = name || "Jogo";
  if (cgImg) { if (img) cgImg.src = img; else cgImg.style.visibility = "hidden"; }
  setCasinoLoader(text, sub);
  showCasinoLoader();
  modal.classList.remove("hidden");
  // Fechar com ESC
  document.addEventListener("keydown", casinoEscHandler);
}

function casinoEscHandler(e) {
  if (e.key === "Escape") closeCasinoGame();
}

function showCasinoLoader() {
  document.getElementById("cg-loader").style.display = "flex";
}
function hideCasinoLoader() {
  document.getElementById("cg-loader").style.display = "none";
}
function setCasinoLoader(text, sub, isError) {
  const t = document.getElementById("cg-loader-text");
  const s = document.getElementById("cg-loader-sub");
  if (t) t.textContent = text || "";
  if (s) s.textContent = sub || "";
  if (isError) {
    const sp = document.querySelector(".casino-game-spinner");
    if (sp) sp.style.animation = "none";
  }
}

function doLaunchCasino(gameCode, name, state) {
  Bet62Api.launchCasinoGame(gameCode)
    .then((res) => {
      if (state.cancelled) return;
      const url = res?.gameUrl;
      if (!url) {
        setCasinoLoader("URL de lançamento inválida", "O provedor não devolveu um link válido para este jogo.", true);
        return;
      }
      setCasinoLoader("A abrir jogo…", "A carregar " + (res?.game?.gameName || name));
      const frame = document.getElementById("cg-frame");
      frame.src = url;
    })
    .catch((err) => {
      if (state.cancelled) return;
      const msg = err?.message || "Erro ao abrir jogo";
      let sub = "Por favor tente novamente mais tarde.";
      if (err?.status === 403) sub = "Complete a validação de identidade (KYC) para poder jogar.";
      else if (err?.status === 401) { openAuth("login"); closeCasinoGame(); return; }
      setCasinoLoader(msg, sub, true);
    });
}

function closeCasinoGame() {
  const modal = document.getElementById("casino-game-modal");
  const cgFrame = document.getElementById("cg-frame");
  // Parar jogo: remover src + about:blank (impede audio/jogo continuar a correr em background)
  try { cgFrame.removeAttribute("src"); cgFrame.src = "about:blank"; } catch {}
  modal.classList.add("hidden");
  document.removeEventListener("keydown", casinoEscHandler);
}

// ====================== AUTH ======================
function openAuth(tab) {
  document.getElementById("auth-modal").classList.add("open");
  hideAuthError();
  switchAuth(tab || "login");
}
function switchAuth(tab) {
  document.getElementById("tab-login").classList.toggle("active", tab === "login");
  document.getElementById("tab-register").classList.toggle("active", tab === "register");
  document.getElementById("login-form").classList.toggle("hidden", tab !== "login");
  document.getElementById("register-form").classList.toggle("hidden", tab !== "register");
  hideAuthError();
}
function closeAuth() {
  document.getElementById("auth-modal").classList.remove("open");
}
function showAuthError(message) {
  const el = document.getElementById("auth-error");
  el.textContent = message;
  el.classList.add("show");
}
function hideAuthError() {
  document.getElementById("auth-error").classList.remove("show");
}

async function doRegister() {
  const name = document.getElementById("reg-name").value.trim();
  const email = document.getElementById("reg-email").value.trim();
  const username = document.getElementById("reg-user").value.trim();
  const password = document.getElementById("reg-pass").value;
  const birthDate = document.getElementById("reg-birth").value;
  const acceptedTerms = document.getElementById("reg-terms").checked;

  hideAuthError();
  if (!name || !email || !username || password.length < 8 || !birthDate) {
    return showAuthError("Preencha todos os campos corretamente. Senha mínima: 8 caracteres.");
  }
  if (!acceptedTerms) return showAuthError("Aceite os Termos e a Política de Privacidade.");

  const btn = document.getElementById("btn-register");
  btn.disabled = true;
  try {
    await Bet62Api.register({ name, email, username, password, birthDate, acceptedTerms });
    closeAuth();
    await afterAuthSuccess();
    alert("🎉 Conta criada com sucesso! Bem-vindo, " + name.split(" ")[0]);
  } catch (err) {
    showAuthError(err.message || "Não foi possível criar a conta.");
  } finally {
    btn.disabled = false;
  }
}

async function doLogin() {
  const identifier = document.getElementById("login-user").value.trim();
  const password = document.getElementById("login-pass").value;
  hideAuthError();
  if (!identifier || !password) return showAuthError("Preencha o e-mail/utilizador e a senha.");

  const btn = document.getElementById("btn-login");
  btn.disabled = true;
  try {
    await Bet62Api.login(identifier, password);
    closeAuth();
    await afterAuthSuccess();
  } catch (err) {
    showAuthError(err.message || "Não foi possível iniciar sessão.");
  } finally {
    btn.disabled = false;
  }
}

async function afterAuthSuccess() {
  // login()/register() limpam cachedSession de propósito (ver api.js) — sem isto,
  // isAuthenticated() ficava sempre false (o cookie de sessão é httpOnly, o JS nunca o
  // consegue ler diretamente; só getSession(), que pergunta ao servidor, sabe o estado real).
  await Bet62Api.getSession();
  await Promise.all([loadProfile(), loadBalance()]);
  showPage("profile");
}

async function logout() {
  if (!confirm("Terminar sessão?")) return;
  await Bet62Api.logout();
  currentProfile = null;
  currentBalance = null;
  updateHeader();
  showPage("destaques");
}

// ====================== PROFILE ======================
async function loadProfile() {
  if (!Bet62Api.isAuthenticated()) {
    renderGuestProfile();
    return;
  }
  try {
    currentProfile = await Bet62Api.getProfile();
    await loadBalance();
    renderProfile();
    loadPromotionsPanel();
  } catch (err) {
    if (err.status === 401) {
      currentProfile = null;
      renderGuestProfile();
    } else {
      alert("Erro ao carregar perfil: " + err.message);
    }
  }
}

async function loadBalance() {
  if (!Bet62Api.isAuthenticated()) return;
  try {
    currentBalance = await Bet62Api.getBalance();
    updateHeader();
  } catch {
    /* silencioso: o saldo será atualizado na próxima ação bem-sucedida */
  }
}

// ====================== BÓNUS E PROMOÇÕES ======================
// Carteira segmentada (Saldo Real/Promocional/Levantável) + progresso de rollover da promoção
// ativa — ver server/src/modules/promotions/service.ts. bonusBalance NUNCA é levantável
// diretamente (só depois de convertido para saldo real ao completar o rollover).
const PROMO_STATUS_LABEL = { ACTIVE: "Ativa", COMPLETED: "Concluída", EXPIRED: "Expirada", CANCELLED: "Anulada" };
const PROMO_TYPE_LABEL_PT = { WELCOME_BONUS: "Bónus de Boas-Vindas", DEPOSIT_BONUS: "Bónus de Depósito", CASHBACK: "Cashback", FREEBET: "Freebet" };

async function loadPromotionsPanel() {
  const el = document.getElementById("promotions-content");
  if (!el || !Bet62Api.isAuthenticated()) return;
  try {
    const [balance, data] = await Promise.all([Bet62Api.getBalance(), Bet62Api.getMyPromotions()]);
    renderPromotionsPanel(balance, data.promotions);
  } catch (err) {
    el.innerHTML = `<div style="color:var(--muted);text-align:center;padding:20px 0">Não foi possível carregar as promoções (${escHtml(err.message || "erro")})</div>`;
  }
}

function fmtExpiryCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: "Expira a qualquer momento", soon: true };
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const soon = days < 1;
  if (days >= 1) return { text: `Expira em ${days}d ${hours}h`, soon };
  const minutes = Math.floor((ms % 3600000) / 60000);
  return { text: `Expira em ${hours}h ${minutes}m`, soon };
}

function renderPromotionsPanel(balance, promotions) {
  const el = document.getElementById("promotions-content");
  const bonusBalance = Number(balance.bonusBalance || 0);
  const active = promotions.find((p) => p.status === "ACTIVE");
  const history = promotions.filter((p) => p.status !== "ACTIVE");

  let html = `
    <div class="wallet-split">
      <div class="wallet-split-card"><div class="wallet-split-label">Saldo Real</div><div class="wallet-split-value">€ ${Number(balance.balance).toFixed(2)}</div></div>
      <div class="wallet-split-card bonus"><div class="wallet-split-label">Saldo Promocional</div><div class="wallet-split-value">€ ${bonusBalance.toFixed(2)}</div></div>
      <div class="wallet-split-card withdrawable full"><div class="wallet-split-label">Saldo Levantável</div><div class="wallet-split-value">€ ${Number(balance.available).toFixed(2)}</div></div>
    </div>`;

  if (active) {
    const required = Number(active.rolloverRequired);
    const progress = Number(active.rolloverProgress);
    const pct = required > 0 ? Math.min(100, (progress / required) * 100) : 100;
    const expiry = fmtExpiryCountdown(active.expiresAt);
    html += `
      <div class="promo-card">
        <div class="promo-card-head">
          <span class="promo-card-name">🎁 ${escHtml(PROMO_TYPE_LABEL_PT[active.promotion?.type] || active.promotion?.name || "Promoção")}</span>
          <span class="status-badge status-ok">${PROMO_STATUS_LABEL.ACTIVE}</span>
        </div>
        <div style="font-size:.82rem;color:var(--muted)">Bónus concedido: <b style="color:var(--text)">€ ${Number(active.bonusAmount).toFixed(2)}</b></div>
        <div class="promo-progress-track"><div class="promo-progress-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="promo-progress-label"><span>€ ${progress.toFixed(2)} apostado</span><span>${pct.toFixed(0)}% de € ${required.toFixed(2)} necessários</span></div>
        <div class="promo-expiry ${expiry.soon ? "soon" : ""}">${expiry.text} · odd mínima ${Number(active.minOdd).toFixed(2)}</div>
      </div>`;
  }

  if (history.length) {
    html += `<div style="font-size:.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:.3px;margin:14px 0 8px">Histórico</div>`;
    html += history
      .map(
        (p) => `<div class="promo-history-item">
          <span>${escHtml(PROMO_TYPE_LABEL_PT[p.promotion?.type] || p.promotion?.name || "Promoção")}</span>
          <span class="status-badge ${p.status === "COMPLETED" ? "status-ok" : p.status === "EXPIRED" ? "status-bad" : "status-pending"}">${PROMO_STATUS_LABEL[p.status] || p.status}</span>
        </div>`
      )
      .join("");
  }

  if (!active && !history.length) {
    html += `<div style="color:var(--muted);text-align:center;padding:12px 0">Ainda sem promoções — faça o primeiro depósito para ativar o Bónus de Boas-Vindas.</div>`;
  }

  el.innerHTML = html;
}

// ====================== PÁGINA PROMOÇÃO (futurista) ======================
// Nada de valores hardcoded — o hero e a grelha vêm sempre de /api/promotions/active (o que o
// admin tiver configurado em "Promoções", ver admin/routes.ts), e o cartão de progresso (se
// autenticado) de /api/promotions/mine. Reutiliza PROMO_TYPE_LABEL_PT/PROMO_STATUS_LABEL/
// fmtExpiryCountdown já definidos acima para o painel do perfil.
const FPROMO_ICON = { WELCOME_BONUS: "🎁", DEPOSIT_BONUS: "💰", CASHBACK: "🔁", FREEBET: "🎟️" };
const FPROMO_TILE_CLASS = { WELCOME_BONUS: "", DEPOSIT_BONUS: "type-deposit", CASHBACK: "type-cashback", FREEBET: "type-freebet" };

function fpromoValueLabel(p) {
  if (p.bonusPercent) {
    const pct = `${Number(p.bonusPercent)}%`;
    return p.bonusMaxAmount ? `${pct} até € ${Number(p.bonusMaxAmount).toFixed(0)}` : pct;
  }
  if (p.bonusFixedAmount) return `€ ${Number(p.bonusFixedAmount).toFixed(2)}`;
  return "—";
}

async function loadPromocaoPage() {
  const el = document.getElementById("promocao-content");
  if (!el) return;
  try {
    const [promotions, myPromotions] = await Promise.all([
      Bet62Api.getActivePromotionsPublic().then((d) => d.promotions),
      Bet62Api.isAuthenticated() ? Bet62Api.getMyPromotions().then((d) => d.promotions).catch(() => []) : Promise.resolve([]),
    ]);
    renderPromocaoPage(promotions, myPromotions);
  } catch (err) {
    el.innerHTML = `<div class="fpromo-empty">Não foi possível carregar as promoções (${escHtml(err.message || "erro")})</div>`;
  }
}

function renderPromocaoPage(promotions, myPromotions) {
  const el = document.getElementById("promocao-content");
  const active = myPromotions.find((p) => p.status === "ACTIVE");
  const primary = promotions.find((p) => p.type === "WELCOME_BONUS") || promotions[0];

  let html = "";

  if (primary) {
    const eligible = primary.eligibleSports?.length ? primary.eligibleSports.join(", ") : "Todos os desportos";
    html += `
      <div class="fpromo-hero">
        <div class="fpromo-hero-badge">${FPROMO_ICON[primary.type] || "🚀"} ${escHtml(PROMO_TYPE_LABEL_PT[primary.type] || primary.name)}</div>
        <div class="fpromo-hero-value"><span class="accent">${fpromoValueLabel(primary)}</span></div>
        <div class="fpromo-hero-sub">${escHtml(primary.name)}</div>
        <div class="fpromo-hero-terms">
          ${primary.minDepositAmount ? `<span class="fpromo-pill">Depósito mín. € ${Number(primary.minDepositAmount).toFixed(2)}</span>` : ""}
          <span class="fpromo-pill">Rollover ${Number(primary.rolloverMultiplier)}x</span>
          <span class="fpromo-pill">Odd mínima ${Number(primary.minOdd).toFixed(2)}</span>
          <span class="fpromo-pill">Válido ${primary.validityDays} dias</span>
          <span class="fpromo-pill">${escHtml(eligible)}</span>
        </div>
        ${!Bet62Api.isAuthenticated() ? `<button class="fpromo-cta" onclick="openAuth('register')">REGISTE-SE AGORA</button>` : !active ? `<button class="fpromo-cta" onclick="openDeposit()">FAZER DEPÓSITO</button>` : ""}
      </div>`;
  }

  if (active) {
    const required = Number(active.rolloverRequired);
    const progress = Number(active.rolloverProgress);
    const pct = required > 0 ? Math.min(100, (progress / required) * 100) : 100;
    const expiry = fmtExpiryCountdown(active.expiresAt);
    html += `
      <div class="fpromo-active">
        <div class="fpromo-active-head">
          <span class="fpromo-active-name">⚡ A tua promoção ativa — ${escHtml(PROMO_TYPE_LABEL_PT[active.promotion?.type] || active.promotion?.name || "Promoção")}</span>
          <span class="status-badge status-ok">${PROMO_STATUS_LABEL.ACTIVE}</span>
        </div>
        <div class="fpromo-active-ring"><div class="fpromo-active-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="fpromo-active-label"><span>${pct.toFixed(0)}% do rollover cumprido</span><span class="${expiry.soon ? "soon" : ""}" style="${expiry.soon ? "color:var(--red);font-weight:700" : ""}">${expiry.text}</span></div>
        <div class="fpromo-active-figures">
          <div>Bónus concedido<b>€ ${Number(active.bonusAmount).toFixed(2)}</b></div>
          <div>Apostado<b>€ ${progress.toFixed(2)}</b></div>
          <div>Necessário<b>€ ${required.toFixed(2)}</b></div>
          <div>Odd mínima<b>${Number(active.minOdd).toFixed(2)}</b></div>
        </div>
      </div>`;
  }

  if (promotions.length) {
    html += `<div class="fpromo-section-title">🎯 Todas as Promoções Ativas</div><div class="fpromo-grid">`;
    html += promotions
      .map((p) => {
        const eligible = p.eligibleSports?.length ? p.eligibleSports.join(", ") : "Todos os desportos";
        return `<div class="fpromo-tile ${FPROMO_TILE_CLASS[p.type] || ""}">
          <div class="fpromo-tile-icon">${FPROMO_ICON[p.type] || "🎁"}</div>
          <div class="fpromo-tile-name">${escHtml(p.name)}</div>
          <div class="fpromo-tile-value">${fpromoValueLabel(p)}</div>
          <div class="fpromo-tile-terms">
            ${p.minDepositAmount ? `<div>Depósito mínimo: <b>€ ${Number(p.minDepositAmount).toFixed(2)}</b></div>` : ""}
            <div>Rollover: <b>${Number(p.rolloverMultiplier)}x</b></div>
            <div>Odd mínima: <b>${Number(p.minOdd).toFixed(2)}</b></div>
            <div>Prazo: <b>${p.validityDays} dias</b></div>
            <div>Desportos: <b>${escHtml(eligible)}</b></div>
          </div>
        </div>`;
      })
      .join("");
    html += `</div>`;
  } else if (!primary) {
    html += `<div class="fpromo-empty">Sem promoções ativas neste momento — volta em breve.</div>`;
  }

  el.innerHTML = html;
}

function renderGuestProfile() {
  document.getElementById("user-avatar").textContent = "?";
  document.getElementById("user-name").textContent = "Convidado";
  document.getElementById("user-email").textContent = "Faça login";
  document.getElementById("user-id").textContent = "—";
}

function renderProfile() {
  const p = currentProfile;
  const initial = (p.name || p.username || "?")[0].toUpperCase();
  document.getElementById("user-avatar").textContent = initial;
  document.getElementById("user-name").textContent = p.name || p.username;
  document.getElementById("user-email").textContent = p.email;
  document.getElementById("user-id").textContent = p.id;

  document.getElementById("f-name").value = p.name || "";
  document.getElementById("f-email").value = p.email || "";
  document.getElementById("f-phone").value = p.phone || "";
  document.getElementById("f-address").value = p.addressLine || "";
  document.getElementById("f-lang").value = p.locale || "pt";
  document.getElementById("f-currency").value = p.currency || "EUR";
  document.getElementById("f-odds").value = p.oddsFormat || "decimal";

  if (p.limits) {
    document.getElementById("f-limit-deposit").value = p.limits.dailyDepositLimit;
    document.getElementById("f-limit-loss").value = p.limits.weeklyLossLimit;
    document.getElementById("f-limit-session").value = p.limits.sessionTimeLimitMinutes;
    document.getElementById("toggle-reality").classList.toggle("on", p.limits.realityCheckEnabled);
  }

  const kycLabels = {
    NOT_STARTED: "Não iniciado",
    PENDING: "Pendente",
    IN_REVIEW: "Em análise",
    APPROVED: "Verificado",
    REJECTED: "Rejeitado",
  };
  const kycBadge = document.getElementById("kyc-status");
  kycBadge.textContent = kycLabels[p.kycStatus] || p.kycStatus;
  kycBadge.className =
    "status-badge " +
    (p.kycStatus === "APPROVED" ? "status-ok" : p.kycStatus === "REJECTED" ? "status-bad" : "status-pending");

  refreshWithdrawalsList();
  refreshKycDocumentsList();
}

// ====================== MINHAS APOSTAS: modal + bilhetes (Em Aberto/Resolvido/Cash Out/Anulada) ======================
let myBetsCache = [];
let myBetsCurrentTab = "open";
let myBetsLiveRefreshTimer = null;

const MYBETS_EMPTY_LABEL = {
  open: "Sem apostas em aberto",
  resolved: "Sem apostas resolvidas",
  cashout: "Ainda não fez nenhum cash out",
  void: "Sem apostas anuladas",
};

const TICKET_STATUS_META = {
  PENDING: { cls: "st-pending", label: "Em Aberto" },
  WON: { cls: "st-won", label: "Ganha" },
  LOST: { cls: "st-lost", label: "Perdida" },
  VOID: { cls: "st-void", label: "Anulada" },
  NEEDS_REVIEW: { cls: "st-pending", label: "Em Revisão" },
  CASHED_OUT: { cls: "st-cashout", label: "Cash Out" },
};

function betMatchesTab(b, tab) {
  if (tab === "open") return b.status === "PENDING";
  if (tab === "resolved") return b.status === "WON" || b.status === "LOST" || b.status === "NEEDS_REVIEW";
  if (tab === "cashout") return b.status === "CASHED_OUT";
  if (tab === "void") return b.status === "VOID";
  return false;
}

function openMyBetsModal() {
  if (!requireLogin()) return;
  closeDrawers();
  document.getElementById("mybets-modal").classList.remove("hidden");
  ensureLiveSocket(); // para os bilhetes Em Aberto poderem mostrar relógio/placar ao vivo
  loadMyBets();
  startMyBetsLiveRefresh();
}

function closeMyBetsModal() {
  document.getElementById("mybets-modal").classList.add("hidden");
  stopMyBetsLiveRefresh();
}

function selectMyBetsTab(tab) {
  myBetsCurrentTab = tab;
  document.querySelectorAll("#mybets-tabs .mybets-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  renderMyBetsBody();
}

async function loadMyBets() {
  const body = document.getElementById("mybets-body");
  if (!body) return;
  body.innerHTML = skeletonCardsHtml(3);
  try {
    const { bets } = await Bet62Api.listMyBets();
    myBetsCache = bets;
    renderMyBetsBody();
  } catch {
    body.innerHTML = '<div class="empty-note">Não foi possível carregar as apostas.</div>';
  }
}

function renderMyBetsBody() {
  const body = document.getElementById("mybets-body");
  if (!body) return;
  const bets = myBetsCache.filter((b) => betMatchesTab(b, myBetsCurrentTab));
  if (!bets.length) {
    body.innerHTML = `<div class="empty-note">${MYBETS_EMPTY_LABEL[myBetsCurrentTab]}</div>`;
    return;
  }
  body.innerHTML = bets.map((b) => betTicketHtml(b)).join("");
  if (myBetsCurrentTab === "open") refreshMyBetsCashOutOffers();
}

function betTicketLegHtml(s, isPending) {
  const marketPt = translateMarketDisplayName(s.market, s.sport, [s.selection], s.home, s.away);
  const selPt = translateSelectionLabel(s.selection);
  const liveEvent = isPending ? liveEventsById.get(s.eventId) : null;
  const liveHtml = liveEvent
    ? `<div class="bet-ticket-live"><span class="live-dot"></span> ${liveEvent.minuteOrPeriod || "AO VIVO"} • ${liveEvent.homeScore ?? "-"} - ${liveEvent.awayScore ?? "-"}</div>`
    : "";
  return `
    <div class="bet-ticket-leg" data-eid="${s.eventId}">
      <div class="bet-ticket-leg-teams">${s.home} vs ${s.away}</div>
      <div class="bet-ticket-leg-market">${marketPt}: <b>${selPt}</b> <span class="bet-ticket-leg-odd">@ ${Number(s.odd).toFixed(2)}</span></div>
      ${liveHtml}
    </div>`;
}

function betTicketHtml(b) {
  const isPending = b.status === "PENDING";
  const anyLegLive = isPending && b.selections.some((s) => liveEventsById.has(s.eventId));
  const stateClass = isPending ? (anyLegLive ? "is-live" : "is-open") : b.status === "WON" ? "is-won" : b.status === "LOST" ? "is-lost" : b.status === "CASHED_OUT" ? "is-cashout" : "is-void";
  const statusMeta = TICKET_STATUS_META[b.status] || { cls: "st-pending", label: b.status };
  const statusCls = anyLegLive && isPending ? "st-live" : statusMeta.cls;
  const statusLabel = anyLegLive && isPending ? "Ao Vivo" : statusMeta.label;
  const legsHtml = b.selections.map((s) => betTicketLegHtml(s, isPending)).join("");
  const modeLabel = b.type === "MULTIPLA" ? "Múltipla" : b.type === "BET_BUILDER" ? "Bet Builder" : "Simples";

  const returnLabel =
    b.status === "WON" ? "Ganho" : b.status === "CASHED_OUT" ? "Recebido" : b.status === "VOID" ? "Devolvido" : b.status === "LOST" ? "Retorno" : "Retorno potencial";
  const returnValue =
    b.status === "WON" || b.status === "CASHED_OUT" || b.status === "VOID"
      ? Number(b.payout).toFixed(2)
      : b.status === "LOST"
        ? "0.00"
        : Number(b.potentialReturn).toFixed(2);

  // Botão de Cash Out fica em baixo, junto dos valores do bilhete (Stake/Odd/Retorno/ID) —
  // pedido explícito do utilizador. Para isso não ficar escondido numa Múltipla com muitas
  // seleções, a lista de seleções (.bet-ticket-legs) tem scroll interno próprio (ver CSS,
  // max-height+overflow-y:auto) em vez de esticar o bilhete inteiro — o cabeçalho e o rodapé
  // com Cash Out ficam sempre visíveis, só as seleções é que rolam por dentro quando são muitas.
  const cashoutRow = isPending
    ? `<div class="bet-ticket-cashout-row"><button class="bet-ticket-cashout-btn" id="cashout-btn-${b.id}" onclick='requestCashOut(${JSON.stringify(b.id)})' disabled>A verificar Cash Out…</button></div>`
    : "";

  return `
    <div class="bet-ticket ${stateClass}" data-bet-id="${b.id}">
      <div class="bet-ticket-top">
        <span class="bet-ticket-mode">${modeLabel} • ${b.selections.length} seleç${b.selections.length > 1 ? "ões" : "ão"}</span>
        <span class="bet-ticket-status ${statusCls}">${statusLabel}</span>
      </div>
      <div class="bet-ticket-legs">${legsHtml}</div>
      <div class="bet-ticket-punch"></div>
      <div class="bet-ticket-bottom">
        <div class="bet-ticket-figures">
          <div>Stake<b>€ ${Number(b.stake).toFixed(2)}</b></div>
          <div>Odd${b.selections.length > 1 ? " total" : ""}<b>${Number(b.totalOdd).toFixed(2)}</b></div>
          <div>${returnLabel}<b>€ ${returnValue}</b></div>
          <div class="bt-id">ID<b>#${b.id.slice(0, 8).toUpperCase()}</b></div>
        </div>
      </div>
      ${cashoutRow}
      <div class="bet-ticket-barcode"></div>
    </div>`;
}

// Só chamado para os bilhetes Em Aberto — pede à API o valor de cash out AGORA MESMO para cada
// aposta visível (nunca calculado no browser: as odds ao vivo e a regra de elegibilidade vivem
// só no servidor, ver server/src/modules/betting/cashout.ts).
async function refreshMyBetsCashOutOffers() {
  const openBets = myBetsCache.filter((b) => b.status === "PENDING");
  await Promise.all(
    openBets.map(async (b) => {
      const btn = document.getElementById(`cashout-btn-${b.id}`);
      if (!btn) return;
      try {
        const offer = await Bet62Api.getCashOutOffer(b.id);
        if (offer.eligible && offer.value !== undefined) {
          btn.disabled = false;
          btn.textContent = `Cash Out € ${Number(offer.value).toFixed(2)}`;
          btn.dataset.value = offer.value;
        } else {
          btn.disabled = true;
          btn.textContent = "Cash Out indisponível";
        }
      } catch {
        btn.disabled = true;
        btn.textContent = "Cash Out indisponível";
      }
    })
  );
}

async function requestCashOut(betId) {
  const btn = document.getElementById(`cashout-btn-${betId}`);
  const value = btn?.dataset.value;
  if (!value) return;
  if (!confirm(`Confirma o Cash Out desta aposta agora por € ${Number(value).toFixed(2)}? Esta ação não pode ser desfeita.`)) return;
  btn.disabled = true;
  btn.textContent = "A processar…";
  try {
    const result = await Bet62Api.cashOutBet(betId);
    alert(`✅ Cash Out realizado: € ${Number(result.value).toFixed(2)} creditado na sua carteira.`);
    await loadBalance();
    await loadMyBets();
  } catch (err) {
    alert("Erro: " + err.message);
    await loadMyBets(); // resincroniza (o valor/estado pode ter mudado entretanto)
  }
}

function startMyBetsLiveRefresh() {
  stopMyBetsLiveRefresh();
  myBetsLiveRefreshTimer = setInterval(() => {
    if (document.getElementById("mybets-modal")?.classList.contains("hidden")) return;
    if (myBetsCurrentTab !== "open") return;
    updateMyBetsLiveBadges();
    refreshMyBetsCashOutOffers();
  }, 12000);
}

function stopMyBetsLiveRefresh() {
  if (myBetsLiveRefreshTimer) {
    clearInterval(myBetsLiveRefreshTimer);
    myBetsLiveRefreshTimer = null;
  }
}

// Atualiza só o relógio/placar de cada perna já no DOM (sem reconstruir os bilhetes — perderia o
// botão de Cash Out já carregado) — chamado a cada mensagem do WebSocket ao vivo enquanto o modal
// está aberto no separador "Em Aberto", e também no timer de refresco periódico.
function updateMyBetsLiveBadges() {
  document.querySelectorAll("#mybets-body .bet-ticket-leg[data-eid]").forEach((legEl) => {
    const liveEvent = liveEventsById.get(legEl.dataset.eid);
    let liveEl = legEl.querySelector(".bet-ticket-live");
    if (liveEvent) {
      const html = `<span class="live-dot"></span> ${liveEvent.minuteOrPeriod || "AO VIVO"} • ${liveEvent.homeScore ?? "-"} - ${liveEvent.awayScore ?? "-"}`;
      if (!liveEl) {
        liveEl = document.createElement("div");
        liveEl.className = "bet-ticket-live";
        legEl.appendChild(liveEl);
        const ticketEl = legEl.closest(".bet-ticket");
        ticketEl?.classList.add("is-live");
        const statusEl = ticketEl?.querySelector(".bet-ticket-status");
        if (statusEl && statusEl.classList.contains("st-pending")) {
          statusEl.classList.replace("st-pending", "st-live");
          statusEl.textContent = "Ao Vivo";
        }
      }
      liveEl.innerHTML = html;
    } else if (liveEl) {
      liveEl.remove();
    }
  });
}

function updateMyBetsLiveBadgesIfOpen() {
  const modal = document.getElementById("mybets-modal");
  if (!modal || modal.classList.contains("hidden") || myBetsCurrentTab !== "open") return;
  updateMyBetsLiveBadges();
}

async function savePersonal() {
  if (!requireLogin()) return;
  try {
    currentProfile = await Bet62Api.updatePersonal({
      name: document.getElementById("f-name").value.trim(),
      phone: document.getElementById("f-phone").value.trim(),
      addressLine: document.getElementById("f-address").value.trim(),
    });
    renderProfile();
    alert("✅ Informações pessoais salvas!");
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

async function savePreferences() {
  if (!requireLogin()) return;
  try {
    currentProfile = await Bet62Api.updatePreferences({
      locale: document.getElementById("f-lang").value,
      currency: document.getElementById("f-currency").value,
      oddsFormat: document.getElementById("f-odds").value,
    });
    alert("✅ Preferências salvas!");
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

async function submitKYC() {
  if (!requireLogin()) return;
  const docNumber = document.getElementById("f-doc-number").value.trim();
  if (!docNumber) return alert("Preencha o número do documento");
  try {
    await Bet62Api.submitKyc(document.getElementById("f-doc-type").value, docNumber);
    await loadProfile();
    alert("📄 Documentos enviados! A verificação pode demorar até 24h.");
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

const KYC_DOC_TYPE_LABELS = { ID_DOCUMENT: "Documento pessoal", BANK_STATEMENT: "Extrato bancário" };

async function uploadKycFile(type, inputId) {
  if (!requireLogin()) return;
  const input = document.getElementById(inputId);
  const file = input.files && input.files[0];
  if (!file) return alert("Escolha um ficheiro primeiro.");
  try {
    await Bet62Api.uploadKycDocument(type, file);
    input.value = "";
    await refreshKycDocumentsList();
    alert(`✅ ${KYC_DOC_TYPE_LABELS[type]} enviado!`);
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

async function refreshKycDocumentsList() {
  const container = document.getElementById("kyc-documents-list");
  if (!container || !Bet62Api.isAuthenticated()) return;
  try {
    const { documents } = await Bet62Api.listMyKycDocuments();
    if (!documents.length) {
      container.innerHTML = '<div class="empty-note">Nenhum documento enviado ainda</div>';
      return;
    }
    container.innerHTML = documents
      .map(
        (d) => `
      <div class="limit-row">
        <div>${KYC_DOC_TYPE_LABELS[d.type] || d.type} <span style="color:var(--muted);font-size:.78rem">— ${d.fileName}</span></div>
        <span class="status-badge status-ok">Enviado</span>
      </div>`
      )
      .join("");
  } catch {
    /* silencioso */
  }
}

async function saveLimits() {
  if (!requireLogin()) return;
  try {
    await Bet62Api.updateLimits({
      dailyDepositLimit: Number(document.getElementById("f-limit-deposit").value) || 0,
      weeklyLossLimit: Number(document.getElementById("f-limit-loss").value) || 0,
      sessionTimeLimitMinutes: Number(document.getElementById("f-limit-session").value) || 120,
      realityCheckEnabled: document.getElementById("toggle-reality").classList.contains("on"),
    });
    alert("✅ Limites atualizados!");
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

async function autoExclude(days) {
  if (!requireLogin()) return;
  const label = days === null ? "PERMANENTEMENTE" : `por ${days} dia(s)`;
  if (!confirm(`Autoexcluir ${label}? Esta ação bloqueia imediatamente a sua conta.`)) return;
  try {
    await Bet62Api.selfExclude(days, "Solicitado pelo utilizador via perfil");
    alert("Autoexclusão ativada. Sessão terminada.");
    await Bet62Api.logout();
    currentProfile = null;
    updateHeader();
    showPage("destaques");
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

async function saveBank() {
  if (!requireLogin()) return;
  const accountHolder = document.getElementById("f-bank-name").value.trim();
  const iban = document.getElementById("f-iban").value.replace(/\s+/g, "").trim();
  const bic = document.getElementById("f-bic").value.trim();
  if (!accountHolder || !iban) return alert("Preencha titular e IBAN");
  try {
    await Bet62Api.saveBankAccount({ accountHolder, iban, bic: bic || undefined });
    alert("✅ Conta bancária guardada!");
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

async function requestWithdraw() {
  if (!requireLogin()) return;
  const amountEur = Number(document.getElementById("f-withdraw-amount").value);
  if (!amountEur || amountEur < 10) return alert("Indique um valor válido (mínimo 10€)");

  try {
    const accounts = await Bet62Api.listBankAccounts();
    if (!accounts.length) return alert("Guarde primeiro uma conta bancária nesta secção.");
    const bankAccountId = accounts[accounts.length - 1].id;
    await Bet62Api.requestWithdrawal(amountEur, bankAccountId);
    alert("✅ Pedido de levantamento enviado para revisão de conformidade.");
    await refreshWithdrawalsList();
    await loadBalance();
  } catch (err) {
    alert("Erro: " + err.message);
  }
}

async function refreshWithdrawalsList() {
  const container = document.getElementById("withdrawals-list");
  if (!Bet62Api.isAuthenticated()) return;
  try {
    const withdrawals = await Bet62Api.listWithdrawals();
    if (!withdrawals.length) {
      container.innerHTML = '<div class="empty-note">Sem levantamentos ainda</div>';
      return;
    }
    const statusLabels = {
      REQUESTED: "Pedido",
      UNDER_REVIEW: "Em revisão",
      APPROVED: "Aprovado",
      REJECTED: "Rejeitado",
      PROCESSING: "A processar",
      PAID: "Pago",
      FAILED: "Falhou",
    };
    container.innerHTML = withdrawals
      .map(
        (w) =>
          `<div class="limit-row"><div>€${Number(w.amount).toFixed(2)}</div><span class="status-badge ${w.status === "PAID" ? "status-ok" : w.status === "REJECTED" || w.status === "FAILED" ? "status-bad" : "status-pending"}">${statusLabels[w.status] || w.status}</span></div>`
      )
      .join("");
  } catch {
    /* silencioso */
  }
}

// Aba "Levantar" do mesmo modal do Depositar (ver switchMoneyModal/openDeposit) — mesmas rotas
// de conta bancária/levantamento já usadas em Perfil > Dados Bancários e Levantamentos, num
// único passo: se já existir uma conta guardada com o mesmo IBAN reaproveita-a, senão cria uma
// nova antes de pedir o levantamento.
async function submitWithdraw() {
  const accountHolder = document.getElementById("w-name").value.trim();
  const iban = document.getElementById("w-iban").value.replace(/\s+/g, "").trim();
  const bic = document.getElementById("w-bic").value.trim();
  const amountEur = Number(document.getElementById("w-amount").value);
  const errEl = document.getElementById("deposit-error");
  errEl.classList.remove("show");

  if (!accountHolder || !iban) {
    errEl.textContent = "Indique o nome completo e o IBAN.";
    errEl.classList.add("show");
    return;
  }
  if (!amountEur || amountEur < 10) {
    errEl.textContent = "Indique um valor válido (mínimo 10€).";
    errEl.classList.add("show");
    return;
  }

  const btn = document.getElementById("btn-withdraw-submit");
  btn.disabled = true;
  try {
    const accounts = await Bet62Api.listBankAccounts();
    let account = accounts.find((a) => a.iban.replace(/\s+/g, "").toUpperCase() === iban.toUpperCase());
    if (!account) account = await Bet62Api.saveBankAccount({ accountHolder, iban, bic: bic || undefined });
    await Bet62Api.requestWithdrawal(amountEur, account.id);
    closeDeposit();
    alert("✅ Pedido de levantamento enviado para revisão de conformidade.");
    await refreshWithdrawalsList();
    await loadBalance();
  } catch (err) {
    errEl.textContent = err.message || "Não foi possível pedir o levantamento.";
    errEl.classList.add("show");
  } finally {
    btn.disabled = false;
  }
}

function requireLogin() {
  if (!Bet62Api.isAuthenticated()) {
    alert("Faça login primeiro");
    return false;
  }
  return true;
}

// ====================== HEADER ======================
function updateHeader() {
  const authed = Bet62Api.isAuthenticated();
  document.getElementById("btn-header-login").classList.toggle("hidden", authed);
  document.getElementById("balance-display").classList.toggle("hidden", !authed);
  document.getElementById("btn-header-mybets").classList.toggle("hidden", !authed);
  document.getElementById("btn-header-deposit").classList.toggle("hidden", !authed);
  document.getElementById("btn-avatar").classList.toggle("hidden", !authed);

  if (currentBalance) {
    document.getElementById("balance-display").textContent = "€ " + Number(currentBalance.available).toFixed(2);
  } else {
    document.getElementById("balance-display").textContent = "€ 0.00";
  }
  document.getElementById("btn-avatar").textContent = currentProfile
    ? (currentProfile.name || currentProfile.username || "U")[0].toUpperCase()
    : "👤";
}

// ====================== DEPOSIT ======================
// Tudo confirmado dentro do próprio modal da BET62 — nunca uma segunda página (pedido
// explícito do utilizador). Só o CARTÃO precisa de Stripe.js (o campo do cartão tem de ser um
// iframe da própria Stripe, exigência de PCI-DSS — nunca o nosso JS a tocar no número do
// cartão), montado aqui dentro do nosso modal, não numa página à parte. MB WAY e Multibanco são
// confirmados diretamente no nosso backend (ver payments/stripe/service.ts) — nenhum dos dois
// precisa de Stripe.js: MB WAY porque a "confirmação" acontece na app do telemóvel do cliente,
// não no browser; Multibanco porque é um voucher estático (entidade+referência), sem nenhuma
// interação necessária no browser para o gerar.
let stripeJsClient = null;
let cardElement = null;
function getStripeJsClient() {
  if (stripeJsClient) return stripeJsClient;
  const pk = window.BET62_CONFIG.STRIPE_PUBLISHABLE_KEY;
  if (!pk || typeof Stripe !== "function") return null;
  stripeJsClient = Stripe(pk);
  return stripeJsClient;
}
// Montado uma única vez e reutilizado entre aberturas do modal — só precisa de existir quando o
// método Cartão está selecionado. Não segue mudanças de tema claro/escuro depois de montado
// (limitação conhecida, secundária: o modal costuma ficar aberto pouco tempo).
function mountCardElementIfNeeded() {
  if (cardElement) return;
  const stripe = getStripeJsClient();
  if (!stripe) return;
  const textColor = getComputedStyle(document.documentElement).getPropertyValue("--text").trim() || "#000";
  const mutedColor = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() || "#999";
  cardElement = stripe.elements().create("card", {
    style: { base: { fontSize: "15px", color: textColor, "::placeholder": { color: mutedColor } }, invalid: { color: "#e63027" } },
  });
  cardElement.mount("#card-element");
}

// Um único modal para Depositar/Levantar, com abas — pedido explícito para não ter um ícone
// próprio de Levantar no cabeçalho, o levantamento vive dentro deste mesmo modal.
function openDeposit() {
  if (!Bet62Api.isAuthenticated()) return openAuth("login");
  document.getElementById("deposit-modal").classList.add("open");
  document.getElementById("deposit-form-fields").classList.remove("hidden");
  const resultEl = document.getElementById("deposit-result");
  resultEl.classList.add("hidden");
  resultEl.innerHTML = "";
  document.getElementById("btn-deposit").disabled = false;
  selectDepositMethod(selectedDepositMethod || "STRIPE_CARD");
  switchMoneyModal("deposit");
}
function closeDeposit() {
  document.getElementById("deposit-modal").classList.remove("open");
  stopDepositPolling();
}
function switchMoneyModal(tab) {
  document.getElementById("deposit-error").classList.remove("show");
  document.getElementById("money-tab-deposit").classList.toggle("active", tab === "deposit");
  document.getElementById("money-tab-withdraw").classList.toggle("active", tab === "withdraw");
  document.getElementById("deposit-section").classList.toggle("hidden", tab !== "deposit");
  document.getElementById("withdraw-section").classList.toggle("hidden", tab !== "withdraw");
}
const DEPOSIT_METHOD_HINTS = {
  STRIPE_CARD: "Os dados do cartão ficam só neste campo seguro da Stripe — nunca passam pelo nosso servidor.",
  STRIPE_MBWAY: "Vai receber um pedido de confirmação na app MB WAY do número indicado.",
  STRIPE_MULTIBANCO: "Vamos gerar aqui mesmo a entidade e referência para pagar no Multibanco ou homebanking.",
};
function selectDepositMethod(method) {
  selectedDepositMethod = method;
  document.querySelectorAll(".dm-btn").forEach((b) => b.classList.toggle("active", b.dataset.method === method));
  document.getElementById("deposit-method-hint").textContent = DEPOSIT_METHOD_HINTS[method] || "";
  document.getElementById("deposit-card-group").classList.toggle("hidden", method !== "STRIPE_CARD");
  document.getElementById("deposit-mbway-group").classList.toggle("hidden", method !== "STRIPE_MBWAY");
  if (method === "STRIPE_CARD") mountCardElementIfNeeded();
}
async function submitDeposit() {
  const amountEur = Number(document.getElementById("deposit-amount").value);
  const errEl = document.getElementById("deposit-error");
  errEl.classList.remove("show");

  if (!amountEur || amountEur < 10) {
    errEl.textContent = "Indique um valor válido (mínimo 10€)";
    errEl.classList.add("show");
    return;
  }

  const btn = document.getElementById("btn-deposit");
  btn.disabled = true;
  try {
    if (selectedDepositMethod === "STRIPE_CARD") await submitCardDeposit(amountEur);
    else if (selectedDepositMethod === "STRIPE_MBWAY") await submitMbWayDeposit(amountEur);
    else await submitMultibancoDeposit(amountEur);
  } catch (err) {
    errEl.textContent = err.message || "Não foi possível iniciar o depósito.";
    errEl.classList.add("show");
    btn.disabled = false;
  }
}

async function submitCardDeposit(amountEur) {
  const stripe = getStripeJsClient();
  if (!stripe || !cardElement) throw new Error("Pagamento por cartão indisponível neste momento.");
  const { clientSecret } = await Bet62Api.createDeposit("STRIPE_CARD", amountEur);
  // confirmCardPayment trata de um eventual desafio 3DS com uma sobreposição na própria
  // página (a própria Stripe injeta o iframe do desafio por cima do nosso modal) — nunca uma
  // navegação para outro sítio.
  const result = await stripe.confirmCardPayment(clientSecret, {
    payment_method: { card: cardElement, billing_details: currentProfile?.email ? { email: currentProfile.email } : {} },
  });
  if (result.error) throw new Error(result.error.message || "O pagamento não foi autorizado.");
  showDepositResult("success", { note: "Pagamento aprovado! O saldo atualiza-se em poucos instantes." });
  loadBalance();
}

async function submitMbWayDeposit(amountEur) {
  const phone = document.getElementById("deposit-phone").value.trim();
  if (!phone) throw new Error("Indique o número de telemóvel MB WAY.");
  const { depositId } = await Bet62Api.createDeposit("STRIPE_MBWAY", amountEur, phone);
  showDepositResult("waiting-mbway", {});
  pollDepositStatus(depositId);
}

async function submitMultibancoDeposit(amountEur) {
  const { entity, reference, expiresAt } = await Bet62Api.createDeposit("STRIPE_MULTIBANCO", amountEur);
  showDepositResult("multibanco", { entity, reference, expiresAt, amountEur });
}

function showDepositResult(kind, data) {
  document.getElementById("deposit-form-fields").classList.add("hidden");
  const el = document.getElementById("deposit-result");
  el.classList.remove("hidden");
  if (kind === "success") {
    el.innerHTML = `
      <div class="deposit-result"><div class="dr-icon">✅</div><div class="dr-title">Depósito enviado</div><div class="dr-note">${data.note}</div></div>
      <button class="auth-submit" onclick="closeDeposit()">FECHAR</button>`;
  } else if (kind === "failed") {
    el.innerHTML = `
      <div class="deposit-result"><div class="dr-icon">❌</div><div class="dr-title">Pagamento não concluído</div><div class="dr-note">${data.note}</div></div>
      <button class="auth-submit" onclick="closeDeposit()">FECHAR</button>`;
  } else if (kind === "waiting-mbway") {
    el.innerHTML = `
      <div class="deposit-result"><div class="dr-icon">📱</div><div class="dr-title">A aguardar aprovação</div>
        <div class="dr-note">Abra a app MB WAY no seu telemóvel e confirme o pagamento. <span class="spinner-dot"></span></div></div>
      <button class="btn-outline" onclick="closeDeposit()">Fechar (o saldo atualiza-se sozinho)</button>`;
  } else if (kind === "multibanco") {
    const expires = data.expiresAt ? new Date(data.expiresAt).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: BET62_TIMEZONE }) : null;
    el.innerHTML = `
      <div class="deposit-result">
        <div class="dr-icon">🏧</div>
        <div class="dr-title">Pague no Multibanco ou homebanking</div>
        <div class="mb-voucher">
          <div class="mb-voucher-row"><span class="mb-voucher-label">Entidade</span><span class="mb-voucher-value">${data.entity}</span></div>
          <div class="mb-voucher-row"><span class="mb-voucher-label">Referência</span><span class="mb-voucher-value">${data.reference}</span></div>
          <div class="mb-voucher-row"><span class="mb-voucher-label">Valor</span><span class="mb-voucher-value">${data.amountEur.toFixed(2)}€</span></div>
        </div>
        <div class="dr-note">${expires ? `Válido até ${expires}. ` : ""}O saldo é atualizado automaticamente assim que o pagamento for confirmado.</div>
      </div>
      <button class="auth-submit" onclick='copyMultibancoReference(${JSON.stringify(data.entity)}, ${JSON.stringify(data.reference)})'>COPIAR ENTIDADE E REFERÊNCIA</button>
      <button class="btn-outline" onclick="closeDeposit()">Fechar</button>`;
  }
}
function copyMultibancoReference(entity, reference) {
  navigator.clipboard?.writeText(`Entidade: ${entity}  Referência: ${reference}`).catch(() => {});
}

let depositPollTimer = null;
function stopDepositPolling() {
  if (depositPollTimer) {
    clearTimeout(depositPollTimer);
    depositPollTimer = null;
  }
}
// MB WAY não tem nenhum retorno visual síncrono — a aprovação acontece na app do telemóvel do
// cliente, fora do nosso controlo — por isso sondamos o nosso próprio GET /deposits/:id em vez
// de bloquear à espera. Desiste ao fim de ~90s (30x3s) para não prender o utilizador no modal
// indefinidamente; o saldo continua a atualizar-se sozinho via webhook mesmo depois de fechar.
function pollDepositStatus(depositId, attempt = 0) {
  stopDepositPolling();
  depositPollTimer = setTimeout(async () => {
    try {
      const { status } = await Bet62Api.getDepositStatus(depositId);
      if (status === "SUCCEEDED") {
        showDepositResult("success", { note: "Pagamento aprovado! O saldo atualiza-se em poucos instantes." });
        loadBalance();
        return;
      }
      if (status === "FAILED" || status === "CANCELLED") {
        showDepositResult("failed", { note: "O pedido MB WAY foi recusado ou expirou. Tente novamente." });
        return;
      }
    } catch {
      /* falha transitória a sondar — tenta outra vez no próximo ciclo */
    }
    if (attempt < 29) {
      pollDepositStatus(depositId, attempt + 1);
    } else {
      const note = document.querySelector("#deposit-result .dr-note");
      if (note) note.innerHTML = "Ainda não recebemos a confirmação. Pode fechar esta janela — o saldo atualiza-se sozinho assim que aprovar na app.";
    }
  }, 3000);
}

// ====================== DESTAQUES: JOGOS EM DESTAQUE ======================
// Pedido explícito do utilizador: a página Destaques mostra 5 pré-jogos (com preferência para
// competições da UEFA — Champions League, Europa League, etc.) e 5 jogos Ao Vivo (1 de cada:
// futebol, ténis, basquete, beisebol, mais 1 "bónus" — sempre futebol; qualquer um destes 4
// desportos sem jogo ao vivo neste momento tem a sua vaga preenchida com mais futebol em vez de
// ficar por preencher).
const DESTAQUES_LIVE_SPORTS = ["football", "tennis", "basketball", "baseball"];

function highlightPrematchCardHtml(e, icon) {
  return `
    <div class="live-card" onclick="openMarket('${e.id}', false)">
      <div class="lc-top"><span>${icon[e.sport] || ""} ${e.league}</span><span>${formatKickoff(e.startTime)}</span></div>
      <div class="lc-teams"><span>${e.home}</span><span style="color:var(--muted);font-size:.8rem">vs</span><span>${e.away}</span></div>
      ${quickOddsHtml(e, e.odds?.[0], false)}
    </div>`;
}

function highlightLiveCardHtml(e, icon) {
  const clockClass = isClockMissing(e) ? "clock-missing" : "";
  const oddsHtml = quickOddsHtml(e, e.odds?.[0], true);
  return e.statistics?.sets ? renderSetsCard(e, clockClass, oddsHtml, icon[e.sport] || "") : renderGenericCard(e, clockClass, oddsHtml, icon[e.sport] || "");
}

async function renderDestaquesHighlights() {
  const prematchEl = document.getElementById("destaques-prematch-list");
  const liveEl = document.getElementById("destaques-live-list");
  if (!prematchEl || !liveEl) return;
  prematchEl.innerHTML = skeletonCardsHtml(5);
  liveEl.innerHTML = skeletonCardsHtml(5);
  const icon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));

  const [prematchResults, liveResult] = await Promise.all([
    Promise.allSettled(SPORTS_META.map((s) => Bet62Api.getPrematchEvents(s.id))),
    Bet62Api.getLiveEvents().catch(() => ({ events: [] })),
  ]);

  // --- Pré-jogo: 5, com preferência para competições UEFA (ordenação estável: mantém a ordem
  // relativa original dentro de cada grupo, só separa "é UEFA" de "não é UEFA"). ---
  const prematchEvents = [];
  prematchResults.forEach((r) => {
    if (r.status === "fulfilled" && r.value.source === "pulsescore") prematchEvents.push(...r.value.events);
  });
  const prematchHighlights = [...prematchEvents]
    .sort((a, b) => (/uefa/i.test(a.league || "") ? 0 : 1) - (/uefa/i.test(b.league || "") ? 0 : 1))
    .slice(0, 5);
  prematchHighlights.forEach((e) => prematchEventsById.set(e.id, e));

  if (!prematchHighlights.length) {
    prematchEl.innerHTML = '<div class="empty-note">Sem jogos agendados neste momento</div>';
  } else {
    renderInBlocks(prematchEl, prematchHighlights.map((e) => highlightPrematchCardHtml(e, icon)));
  }

  // --- Ao vivo: 1 por desporto-alvo + vagas em falta (incluindo o "bónus") preenchidas com
  // futebol extra. ---
  const liveEvents = liveResult.events || [];
  liveEvents.forEach((e) => liveEventsById.set(e.id, e));

  const picked = [];
  const pickedIds = new Set();
  let missingSlots = 0;
  for (const sportId of DESTAQUES_LIVE_SPORTS) {
    const candidate = liveEvents.find((e) => e.sport === sportId);
    if (candidate) {
      picked.push(candidate);
      pickedIds.add(candidate.id);
    } else {
      missingSlots += 1;
    }
  }
  const extraFootballNeeded = 1 + missingSlots; // 1 vaga "bónus" + cada vaga em falta
  const extraFootball = liveEvents.filter((e) => e.sport === "football" && !pickedIds.has(e.id)).slice(0, extraFootballNeeded);
  const liveHighlights = [...picked, ...extraFootball].slice(0, 5);

  if (!liveHighlights.length) {
    liveEl.innerHTML = '<div class="empty-note">Sem jogos ao vivo neste momento</div>';
  } else {
    renderInBlocks(liveEl, liveHighlights.map((e) => highlightLiveCardHtml(e, icon)));
  }
}

// ====================== LIVE SPORTS (Pulsescore + API-Football híbrido) ======================
function ensureLiveSocket() {
  if (liveSocket && liveSocket.readyState <= 1) return;

  const statusEl = document.getElementById("ws-status");
  liveSocket = new WebSocket(`${window.BET62_CONFIG.WS_BASE}/ws/live`);

  liveSocket.onopen = () => {
    statusEl.textContent = "🟢 Ligado ao feed ao vivo";
  };
  liveSocket.onclose = () => {
    statusEl.textContent = "🔴 Desligado — a tentar religar…";
    setTimeout(ensureLiveSocket, 3000);
  };
  liveSocket.onerror = () => {
    statusEl.textContent = "⚠️ Erro na ligação ao feed ao vivo";
  };
  liveSocket.onmessage = (msg) => {
    const data = JSON.parse(msg.data);
    if (data.type === "snapshot") {
      liveSnapshotReceived = true;
      liveEventsById.clear();
      data.events.forEach((e) => liveEventsById.set(e.id, e));
      renderLiveEvents();
    } else if (data.type === "update") {
      liveEventsById.set(data.event.id, data.event);
      // Só reconstrói a lista inteira se o cartão ainda não existir no DOM (jogo novo ao vivo,
      // ou já não passa no filtro de desporto atual) — caso contrário, atualiza só esse cartão
      // para não interromper o scroll do utilizador (ver comentário em patchLiveEventCard).
      if (!patchLiveEventCard(data.event)) renderLiveEvents();
    } else if (data.type === "remove") {
      // Jogo terminado (ou já não devolvido pela Pulsescore) — sai da página Ao Vivo assim que
      // este frame chega, sem esperar por um reload (ver applySportSnapshot em hybridService.ts
      // e o relay em websocket/gateway.ts).
      liveEventsById.delete(data.id);
      if (currentMarketEvent && currentMarketEvent.id === data.id) currentMarketEvent._finished = true;
      renderLiveEvents();
    }
    if (currentMarketEvent && liveEventsById.has(currentMarketEvent.id)) {
      currentMarketEvent = liveEventsById.get(currentMarketEvent.id);
    }
    if (currentMarketEvent && pageHistory[pageHistory.length - 1] === "market") renderMarketPage();
    updateMyBetsLiveBadgesIfOpen();
    syncBetslipLiveState();
  };
}

// Quando um evento ao vivo não tem relógio/período real (matchClock ausente ou numa forma que
// formatMatchClock não reconheceu — ver client.ts/wsClient.ts), minuteOrPeriod cai no genérico
// "AO VIVO". Sinalizado a vermelho em vez de passar despercebido como se fosse dado normal.
function isClockMissing(e) {
  return e.status === "live" && (!e.minuteOrPeriod || e.minuteOrPeriod === "AO VIVO");
}

// Cartão "por sets": ativado por DADOS (statistics.sets presente), não por nome do desporto —
// ténis tem sets confirmado num exemplo real; voleibol também se joga por sets no mundo real
// (o utilizador tinha razão), por isso ativa-se sozinho assim que a bookmaker devolver
// statistics.sets para voleibol também, sem precisar de código novo. Beisebol NÃO entra aqui —
// joga-se por innings, não por sets, um conceito diferente (e a bookmaker não devolveria
// statistics.sets para beisebol).
// Nomes empilhados (casa em cima, fora em baixo) com bandeira, TODOS os sets já jogados visíveis
// em colunas fixas lado a lado (S1, S2, S3... — pedido explícito: o placar de um set não some
// quando o seguinte começa, fica lá marcado), ponto a indicar quem serve, e o set atual abreviado
// ("Sn") no canto superior direito como indicador de estado ao vivo.
function renderSetsCard(e, clockClass, oddsHtml, icon) {
  const sets = e.statistics.sets;
  const numSets = Math.max(sets.home.length, sets.away.length);
  const homeServe = sets.homeServe === true;
  const awayServe = sets.homeServe === false;
  const setLabel = e.minuteOrPeriod.replace(/^Set /, "S");
  // Não usar `typeof === "number"`: no ténis os pontos do jogo atual podem vir como string não
  // numérica (ex: "AD" em vantagem) — exigir número escondia o placar inteiro assim que chegava
  // a vantagem, embora "15"/"30"/"40" aparecessem bem antes disso.
  const showPoints = e.homeScore !== undefined && e.awayScore !== undefined;
  const flag = flagEmoji(e.country);

  const cols = (arr) =>
    Array.from({ length: numSets }, (_, i) => `<span class="sets-grid-col">${arr[i] ?? ""}</span>`).join("");
  const headerCols = Array.from({ length: numSets }, (_, i) => `<span class="sets-grid-col">S${i + 1}</span>`).join("");

  return `
    <div class="live-card" data-eid="${e.id}" onclick='openMarket(${JSON.stringify(e.id)}, true)'>
      <div class="lc-top"><span>${icon} ${e.league}</span><span class="${clockClass}">${setLabel}</span></div>
      ${showPoints ? `<div class="event-points">${e.homeScore} - ${e.awayScore}</div>` : ""}
      <div class="sets-grid">
        <div class="sets-grid-row sets-grid-header"><span class="sets-grid-name"></span>${headerCols}</div>
        <div class="sets-grid-row">
          <span class="sets-grid-name">${flag} ${e.home}${homeServe ? '<span class="serve-dot"></span>' : ""}</span>${cols(sets.home)}
        </div>
        <div class="sets-grid-row">
          <span class="sets-grid-name">${flag} ${e.away}${awayServe ? '<span class="serve-dot"></span>' : ""}</span>${cols(sets.away)}
        </div>
      </div>
      ${oddsHtml}
    </div>`;
}

// Cartão genérico (futebol, basquete, hóquei, beisebol, MMA, F1): casa e fora um embaixo do
// outro, com o placar ANTES do nome da equipa (à esquerda, não à direita — pedido explícito do
// utilizador; o ténis/voleibol em renderSetsCard() mantém o placar do lado direito). Alinhado na
// mesma coluna em todos os cartões, nunca "empurrado" consoante o tamanho dos nomes.
// Cartõezinhos vermelhos junto ao nome da equipa (ex: "🟥" x1 por expulsão) — pedido explícito
// do utilizador para o cartão principal de Ao Vivo, não só no Match Tracker (que já tinha isto
// na linha de estatísticas). Repete o emoji por cada expulsão, não só uma vez, já que mais de um
// jogador expulso no mesmo jogo acontece e cada um conta.
function redCardsHtml(redCards) {
  const n = Number(redCards) || 0;
  // Retângulo fino em CSS em vez do emoji 🟥 (que é largo, um quadrado) — mais parecido com um
  // cartão de futebol real.
  return n > 0 ? ` ${'<span class="mini-red-card"></span>'.repeat(n)}` : "";
}

function renderGenericCard(e, clockClass, oddsHtml, icon) {
  const hasScore = e.homeScore !== undefined && e.awayScore !== undefined;
  const homeRed = redCardsHtml(e.statistics?.home?.redCards);
  const awayRed = redCardsHtml(e.statistics?.away?.redCards);
  return `
    <div class="live-card" data-eid="${e.id}" onclick='openMarket(${JSON.stringify(e.id)}, true)'>
      <div class="lc-top"><span>${icon} ${e.league}</span><span class="${clockClass}">${e.minuteOrPeriod}</span></div>
      <div class="event-rows">
        <div class="event-row score-left">${hasScore ? `<span class="event-row-score">${e.homeScore}</span>` : ""}<span class="event-team">${e.home}${homeRed}</span></div>
        <div class="event-row score-left">${hasScore ? `<span class="event-row-score">${e.awayScore}</span>` : ""}<span class="event-team">${e.away}${awayRed}</span></div>
      </div>
      ${oddsHtml}
    </div>`;
}

// Ordem fixa pedida: Futebol sempre primeiro, depois Ténis, depois Basquete, resto abaixo —
// mesma ordem já usada em SPORTS_META, por isso só reaproveita o índice de cada desporto lá.
const SPORT_ORDER = Object.fromEntries(SPORTS_META.map((s, i) => [s.id, i]));

function renderLiveEvents() {
  const container = document.getElementById("live-list");
  if (!container) return;
  const events = [...liveEventsById.values()]
    .filter((e) => !selectedSport || e.sport === selectedSport)
    .sort((a, b) => (SPORT_ORDER[a.sport] ?? 99) - (SPORT_ORDER[b.sport] ?? 99));
  if (!events.length) {
    // Antes do primeiro snapshot do WebSocket, "sem eventos" ainda não é verdade — é só que
    // ainda não chegou nada; mostra o esqueleto em vez de afirmar (por breves instantes,
    // erradamente) que não há jogos ao vivo.
    container.innerHTML = liveSnapshotReceived ? '<div class="empty-note">Sem eventos ao vivo para este desporto neste momento</div>' : skeletonCardsHtml(4);
    return;
  }
  const sportIcon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
  const cardsHtml = events.map((e) => {
    const clockClass = isClockMissing(e) ? "clock-missing" : "";
    const icon = sportIcon[e.sport] || "";
    const oddsHtml = quickOddsHtml(e, e.odds?.[0], true);

    if (e.statistics?.sets) return renderSetsCard(e, clockClass, oddsHtml, icon);
    return renderGenericCard(e, clockClass, oddsHtml, icon);
  });
  renderInBlocks(container, cardsHtml);
}

// Atualiza SÓ o cartão de um jogo já visível, sem tocar no resto da lista — usado nas
// mensagens "update" do WebSocket (placar/odds/relógio a mudar), que chegam com muita
// frequência. Antes disto, cada mensagem chamava renderLiveEvents() inteiro (innerHTML="" +
// reconstrução de todos os cartões), o que interrompia o gesto de scroll do utilizador a meio
// (o dedo fica a "arrastar" um nó do DOM que acabou de ser destruído) — reportado como
// "bug ao rolar a página". Devolve false quando o jogo ainda não está no DOM (é novo ou o
// filtro de desporto mudou), para o chamador cair de volta no render completo nesse caso.
function patchLiveEventCard(e) {
  if (selectedSport && e.sport !== selectedSport) return true; // não visível, nada a tocar
  const container = document.getElementById("live-list");
  if (!container) return false;
  const existing = Array.from(container.children).find((c) => c.dataset && c.dataset.eid === String(e.id));
  if (!existing) return false;
  const sportIcon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
  const clockClass = isClockMissing(e) ? "clock-missing" : "";
  const icon = sportIcon[e.sport] || "";
  const oddsHtml = quickOddsHtml(e, e.odds?.[0], true);
  const html = e.statistics?.sets ? renderSetsCard(e, clockClass, oddsHtml, icon) : renderGenericCard(e, clockClass, oddsHtml, icon);
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html.trim();
  existing.replaceWith(wrapper.firstElementChild);
  return true;
}

// ====================== MERCADOS + MATCH TRACKER ======================
function openMarket(eventId, isLive) {
  const event = isLive ? liveEventsById.get(eventId) : prematchEventsById.get(eventId);
  if (!event) return;
  currentMarketEvent = event;
  currentMarketEvent._isLive = isLive;
  selectedMarketFilter = null; // volta a "Todos" a cada novo evento aberto
  betBuilderPicks.clear();
  betBuilderStake = 0;
  showPage("market");
  renderMarketPage();

  // Eventos reais da Pulsescore: pede dados frescos em vez de confiar só na última leitura
  // em cache (snapshot ao vivo ou lista de pré-jogo).
  if (event.source === "pulsescore") {
    const marketsBeforeRefresh = event.odds || [];
    Bet62Api.refreshEvent(eventId, event.sport)
      .then((res) => {
        if (pageHistory[pageHistory.length - 1] !== "market" || !currentMarketEvent || currentMarketEvent.id !== eventId) return;
        const refreshed = res.event;
        // /events/{id} (usado aqui) nunca teve a forma da resposta confirmada com um pedido
        // real, ao contrário da lista de pré-jogo/ao vivo (essa sim, confirmada rica — até 34
        // mercados numa amostra real de beisebol). Para não arriscar substituir mercados já
        // mostrados por uma resposta mais pobre deste endpoint, só troca a lista de mercados se
        // vier com pelo menos tantos quanto já tínhamos; os restantes campos (placar, relógio,
        // estatísticas) atualizam sempre, porque esses sim ganham em ser frescos.
        if (!refreshed.odds || refreshed.odds.length < marketsBeforeRefresh.length) {
          refreshed.odds = marketsBeforeRefresh;
        }
        currentMarketEvent = refreshed;
        currentMarketEvent._isLive = isLive;
        renderMarketPage();
      })
      .catch(() => {
        /* mantém os dados em cache se a atualização falhar */
      });
  }
}

function renderMarketPage() {
  const e = currentMarketEvent;
  if (!e) return;
  const sportMeta = SPORTS_META.find((s) => s.id === e.sport);
  document.getElementById("market-league").textContent = `${sportMeta ? sportMeta.icon + " " : ""}${e.league}`;
  document.getElementById("market-title").textContent = `${e.home} vs ${e.away}`;
  renderMatchTracker(e);
  renderMarketFilterBar(e);
  if (selectedMarketFilter === BET_BUILDER_LABEL) {
    renderBetBuilder(e);
  } else {
    renderMarketGroups(e);
  }
}

function renderMatchTracker(e) {
  const el = document.getElementById("match-tracker");
  const isLive = e._isLive || e.status === "live";

  if (e._finished) {
    el.innerHTML = `
      <div class="mt-scheduled">
        <span class="status-badge status-ok">ENCERRADO</span>
        <div style="color:var(--muted);font-size:.85rem;margin-top:10px">${e.home} vs ${e.away}</div>
        ${
          e.homeScore !== undefined && e.awayScore !== undefined
            ? `<div class="mt-score" style="margin-top:10px">${e.homeScore} - ${e.awayScore}</div>`
            : ""
        }
      </div>`;
    return;
  }

  if (!isLive) {
    el.innerHTML = `
      <div class="mt-scheduled">
        <span class="status-badge status-pending">PRÉ-JOGO</span>
        <div class="big" style="margin-top:10px">${formatKickoff(e.startTime)}</div>
        <div style="color:var(--muted);font-size:.82rem;margin-top:6px">${e.home} vs ${e.away}</div>
      </div>
      <div class="mt-actions">
        <div class="mt-action-btn" onclick="openTracker()"><span class="mt-action-icon"><span class="pitch-icon" style="width:26px;height:18px"></span></span>Match Tracker</div>
        <div class="mt-action-btn" onclick="openStats()"><span class="mt-action-icon">📊</span>Estatísticas</div>
      </div>`;
    return;
  }

  const clockClass = isClockMissing(e) ? " clock-missing" : "";

  if (e.sport === "formula1") {
    el.innerHTML = `
      <div class="mt-live"><span class="dot"></span> AO VIVO</div>
      <div style="text-align:center">
        <div style="font-weight:700;font-size:1.05rem">${e.home}</div>
        <div class="mt-period${clockClass}" style="margin-top:8px">${e.minuteOrPeriod}</div>
      </div>`;
    return;
  }

  const hasScore = e.homeScore !== undefined && e.awayScore !== undefined;
  el.innerHTML = `
    <div class="mt-live"><span class="dot"></span> AO VIVO</div>
    <div class="mt-teams">
      <div class="mt-team">${e.home}</div>
      ${hasScore ? `<div class="mt-score">${e.homeScore} - ${e.awayScore}</div>` : '<div style="color:var(--muted);font-size:.85rem">vs</div>'}
      <div class="mt-team">${e.away}</div>
    </div>
    <div class="mt-period${clockClass}">${e.minuteOrPeriod}</div>
    <div class="mt-actions">
      <div class="mt-action-btn" onclick="openTracker()"><span class="mt-action-icon"><span class="pitch-icon" style="width:26px;height:18px"></span></span>Match Tracker</div>
      <div class="mt-action-btn" onclick="openStats()"><span class="mt-action-icon">📊</span>Estatísticas</div>
    </div>`;
}

// ====================== MATCH TRACKER (mini campo 2D) ======================
// Só o ponto de entrada por agora — o campo 2D em si ainda não foi construído.
function openTracker() {
  document.getElementById("tracker-modal").classList.add("open");
}
function closeTracker() {
  document.getElementById("tracker-modal").classList.remove("open");
}

// ====================== ESTATÍSTICAS (Margens de Vitória / H2H / Classificação) ======================
function openStats() {
  if (!currentMarketEvent) return;
  document.getElementById("stats-modal").classList.add("open");
  switchStatsTab("prob");
}
function closeStats() {
  document.getElementById("stats-modal").classList.remove("open");
}
function switchStatsTab(tab) {
  document.getElementById("stats-tab-prob").classList.toggle("active", tab === "prob");
  document.getElementById("stats-tab-h2h").classList.toggle("active", tab === "h2h");
  document.getElementById("stats-tab-teamstats").classList.toggle("active", tab === "teamstats");
  document.getElementById("stats-tab-table").classList.toggle("active", tab === "table");
  document.getElementById("stats-body-prob").classList.toggle("hidden", tab !== "prob");
  document.getElementById("stats-body-h2h").classList.toggle("hidden", tab !== "h2h");
  document.getElementById("stats-body-teamstats").classList.toggle("hidden", tab !== "teamstats");
  document.getElementById("stats-body-table").classList.toggle("hidden", tab !== "table");
  if (tab === "prob") renderWinProbability(currentMarketEvent);
  if (tab === "h2h") renderH2H(currentMarketEvent);
  if (tab === "teamstats") renderTeamStats(currentMarketEvent);
  if (tab === "table") renderStandings(currentMarketEvent);
}

function renderWinProbabilityBars(el, entries, advice) {
  el.innerHTML =
    entries
      .map(
        ([label, pct]) => `
        <div class="win-prob-row">
          <div class="win-prob-row-top"><span>${label}</span><span>${pct.toFixed(1)}%</span></div>
          <div class="win-prob-bar-track"><div class="win-prob-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        </div>`
      )
      .join("") + (advice ? `<div class="empty-note" style="text-align:left;padding-top:4px">💡 ${advice}</div>` : "");
}

// Probabilidade de vitória: para futebol tenta primeiro a previsão real da API-Football
// (percent home/draw/away, calculada por eles a partir de forma/médias de golos), com o
// cálculo pelas odds como recurso (resolução do fixture pode falhar/ambiguar, ou o desporto
// não é futebol — a API-Football só cobre futebol). Fórmula do recurso: 1/odd por seleção,
// normalizado para somar 100% (remove a margem do bookmaker).
async function renderWinProbability(e) {
  const el = document.getElementById("stats-body-prob");
  if (e.sport === "football") {
    el.innerHTML = '<div class="empty-note">A carregar…</div>';
    try {
      const { predictions } = await Bet62Api.getPredictions(e.id);
      if (predictions && predictions.percent) {
        renderWinProbabilityBars(
          el,
          [
            [e.home, parseFloat(predictions.percent.home)],
            ["Empate", parseFloat(predictions.percent.draw)],
            [e.away, parseFloat(predictions.percent.away)],
          ],
          predictions.advice
        );
        return;
      }
    } catch {
      /* cai para o cálculo pelas odds abaixo */
    }
  }
  const market = e.odds && e.odds[0];
  const active = activeSelectionEntries(market);
  if (!active.length) {
    el.innerHTML = '<div class="empty-note">Sem odds disponíveis para calcular probabilidades</div>';
    return;
  }
  const raw = active.map(([label, sel]) => [label, 1 / sel.odd]);
  const total = raw.reduce((sum, [, p]) => sum + p, 0);
  renderWinProbabilityBars(
    el,
    raw.map(([label, p]) => [label, total > 0 ? (p / total) * 100 : 0])
  );
}

// H2H via API-Football (resolução de equipa por nome no backend — melhor esforço, ver
// getHeadToHeadByTeamNames() no servidor). "Sem dados" é um resultado normal, não um erro.
let h2hLoadedForEventId = null;
async function renderH2H(e) {
  const el = document.getElementById("stats-body-h2h");
  if (h2hLoadedForEventId === e.id) return; // já carregado para este evento, não repete o pedido
  el.innerHTML = '<div class="empty-note">A carregar…</div>';
  try {
    const { matches } = await Bet62Api.getH2H(e.id);
    h2hLoadedForEventId = e.id;
    if (!matches || !matches.length) {
      el.innerHTML = '<div class="empty-note">Sem confrontos diretos recentes disponíveis</div>';
      return;
    }
    el.innerHTML = matches
      .map(
        (m) => `
      <div class="h2h-item">
        <div class="h2h-teams">
          <span class="h2h-comp">${m.competition} • ${new Date(m.date).toLocaleDateString("pt-PT", { timeZone: BET62_TIMEZONE })}</span>
          ${m.homeTeam} vs ${m.awayTeam}
        </div>
        <div class="h2h-score">${m.homeGoals ?? "?"} - ${m.awayGoals ?? "?"}</div>
      </div>`
      )
      .join("");
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar os confrontos diretos</div>';
  }
}

// Rótulos PT dos tipos de estatística devolvidos pela API-Football (ver amostra real colada
// pelo utilizador em /fixtures/statistics) — o que não estiver mapeado aqui aparece tal como
// veio, em vez de ser escondido.
const TEAM_STAT_LABELS = {
  "Shots on Goal": "Remates à baliza",
  "Shots off Goal": "Remates fora",
  "Total Shots": "Remates totais",
  "Blocked Shots": "Remates bloqueados",
  "Shots insidebox": "Remates dentro da área",
  "Shots outsidebox": "Remates fora da área",
  Fouls: "Faltas",
  "Corner Kicks": "Cantos",
  Offsides: "Fora de jogo",
  "Ball Possession": "Posse de bola",
  "Yellow Cards": "Cartões amarelos",
  "Red Cards": "Cartões vermelhos",
  "Goalkeeper Saves": "Defesas do guarda-redes",
  "Total passes": "Passes totais",
  "Passes accurate": "Passes certos",
  "Passes %": "Precisão de passe",
};

// Estatísticas completas por equipa via API-Football (só futebol — a API-Football não cobre
// outros desportos). Reaproveita as classes .mt-stats/.mt-stats-col/.mt-stats-labels já usadas
// antes na linha de estatísticas do Match Tracker.
let teamStatsLoadedForEventId = null;
async function renderTeamStats(e) {
  const el = document.getElementById("stats-body-teamstats");
  if (e.sport !== "football") {
    el.innerHTML = '<div class="empty-note">Estatísticas detalhadas disponíveis só para futebol, por agora</div>';
    return;
  }
  if (teamStatsLoadedForEventId === e.id) return;
  el.innerHTML = '<div class="empty-note">A carregar…</div>';
  try {
    const { response } = await Bet62Api.getTeamStats(e.id);
    teamStatsLoadedForEventId = e.id;
    const [home, away] = response || [];
    if (!home || !away || !home.statistics?.length) {
      el.innerHTML = '<div class="empty-note">Sem estatísticas detalhadas disponíveis para este jogo</div>';
      return;
    }
    const rows = home.statistics.map((s, i) => ({
      label: TEAM_STAT_LABELS[s.type] || s.type,
      homeVal: s.value ?? "-",
      awayVal: away.statistics[i]?.value ?? "-",
    }));
    el.innerHTML = `
      <div class="mt-stats">
        <div class="mt-stats-col home">${rows.map((r) => `<div>${r.homeVal}</div>`).join("")}</div>
        <div class="mt-stats-labels">${rows.map((r) => `<div>${r.label}</div>`).join("")}</div>
        <div class="mt-stats-col away">${rows.map((r) => `<div>${r.awayVal}</div>`).join("")}</div>
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar as estatísticas</div>';
  }
}

// Classificação da liga do evento via API-Football (só futebol) — realça as duas equipas do
// jogo atual na tabela, quando encontradas.
let standingsLoadedForEventId = null;
async function renderStandings(e) {
  const el = document.getElementById("stats-body-table");
  if (e.sport !== "football") {
    el.innerHTML = '<div class="empty-note">Classificação disponível só para futebol, por agora</div>';
    return;
  }
  if (standingsLoadedForEventId === e.id) return;
  el.innerHTML = '<div class="empty-note">A carregar…</div>';
  try {
    const { standings } = await Bet62Api.getStandings(e.id);
    standingsLoadedForEventId = e.id;
    if (!standings || !standings.length) {
      el.innerHTML = '<div class="empty-note">Sem classificação disponível para esta competição</div>';
      return;
    }
    el.innerHTML = `
      <div class="standings-table">
        <div class="standings-row standings-header">
          <span class="st-rank">#</span><span class="st-team">Equipa</span><span class="st-pts">Pts</span><span class="st-pj">J</span><span class="st-gd">SG</span>
        </div>
        ${standings
          .map(
            (r) => `
          <div class="standings-row${r.team === e.home || r.team === e.away ? " highlight" : ""}">
            <span class="st-rank">${r.rank}</span><span class="st-team">${r.team}</span><span class="st-pts">${r.points}</span><span class="st-pj">${r.played}</span><span class="st-gd">${r.goalsDiff > 0 ? "+" : ""}${r.goalsDiff}</span>
          </div>`
          )
          .join("")}
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar a classificação</div>';
  }
}

// Filtros de mercado por desporto (barra de chips entre o cabeçalho e a lista de mercados, ver
// #market-filter-bar). Cada categoria é reconhecida por palavras-chave no NOME BRUTO do
// mercado tal como a Pulsescore o envia (group.market, tipicamente em inglês — "Match Odds",
// "Total Goals", "Both Teams to Score", etc., ver docs/SPORTS_DATA.md para amostras reais
// confirmadas). Sem uma lista fechada de todos os nomes que a Pulsescore pode mandar para cada
// desporto/liga, a classificação é por palavra-chave (heurística), não por igualdade exata —
// mais robusta a pequenas variações de texto entre bookmakers/desportos do que uma lista fixa,
// mas pode não cobrir um nome de mercado muito invulgar (esse cai fora de todas as categorias
// específicas e só aparece em "Todos"). A ORDEM de cada lista importa: a primeira categoria
// cujo teste bater é a escolhida (ex: "1st Half Corners" fica em "1º Tempo", não em
// "Escanteios" — mercados de uma parte específica agrupam-se todos juntos, como nos sites de
// apostas de referência).
const MARKET_FILTER_CATEGORIES = {
  football: [
    { label: "1º Tempo", test: (m) => /1st half|first half|half.?time|\bht\b/i.test(m) && !/2nd|second/i.test(m) },
    { label: "2º Tempo", test: (m) => /2nd half|second half/i.test(m) },
    { label: "Escanteios", test: (m) => /corner/i.test(m) },
    { label: "Cartões", test: (m) => /\bcard|booking/i.test(m) },
    { label: "Ambas Marcam", test: (m) => /both teams to score|\bbtts\b|both to score/i.test(m) },
    { label: "Marcador", test: (m) => /goalscorer|\bscorer\b|first to score|last to score|to score first|to score last|player.*(to score|goals)/i.test(m) },
    { label: "Placar Exato", test: (m) => /correct score|exact score/i.test(m) },
    { label: "Handicap", test: (m) => /handicap|spread|asian/i.test(m) },
    { label: "Mais/Menos", test: (m) => /over\/?under|total goals|\bo\/u\b/i.test(m) },
    { label: "Resultado", test: (m) => /match odds|\b1x2\b|to win|winner|double chance|draw no bet|full time result|3.?way/i.test(m) },
  ],
  basketball: [
    { label: "1º Quarto", test: (m) => /1st quarter|first quarter|\bq1\b/i.test(m) },
    { label: "1º Tempo", test: (m) => /1st half|first half/i.test(m) },
    { label: "Resultado por quarto", test: (m) => /quarter.*(result|winner)|winning quarter/i.test(m) },
    { label: "Margem de vitória", test: (m) => /winning margin|margin of victory/i.test(m) },
    { label: "Total da equipa", test: (m) => /team total/i.test(m) },
    { label: "Handicap", test: (m) => /handicap|spread/i.test(m) },
    { label: "Mais/Menos pontos", test: (m) => /over\/?under|total points/i.test(m) },
    { label: "Pontos exatos", test: (m) => /correct score|exact (score|points)/i.test(m) },
    { label: "Vencedor", test: (m) => /money.?line|to win|match winner|winner\b/i.test(m) },
  ],
  tennis: [
    { label: "Primeiro set", test: (m) => /1st set|first set/i.test(m) },
    { label: "Tie-break — Sim/Não", test: (m) => /tie.?break/i.test(m) },
    { label: "Handicap de games", test: (m) => /game handicap|games handicap/i.test(m) },
    { label: "Mais/Menos games", test: (m) => /total games|games? over\/?under/i.test(m) },
    { label: "Handicap de sets", test: (m) => /set handicap|sets handicap/i.test(m) },
    { label: "Resultado exato em sets", test: (m) => /correct score|exact score|set score/i.test(m) },
    { label: "Vencedor do set", test: (m) => /set\s*\d*\s*winner|to win (the )?set/i.test(m) },
    { label: "Vencedor do jogo", test: (m) => /match winner|to win the match|money.?line/i.test(m) },
  ],
  ice_hockey: [
    { label: "Resultado após 1º período", test: (m) => /1st period|first period/i.test(m) },
    { label: "Total por período", test: (m) => /period.*total|total.*period/i.test(m) },
    { label: "Dupla Chance", test: (m) => /double chance/i.test(m) },
    { label: "Ambas marcam", test: (m) => /both teams to score|\bbtts\b/i.test(m) },
    { label: "Placar exato", test: (m) => /correct score|exact score/i.test(m) },
    { label: "Handicap", test: (m) => /handicap|puck line/i.test(m) },
    { label: "Mais/Menos golos", test: (m) => /over\/?under|total goals/i.test(m) },
    { label: "Vencedor", test: (m) => /match odds|\b1x2\b|to win|winner|money.?line/i.test(m) },
  ],
  volleyball: [
    { label: "Handicap de sets", test: (m) => /set handicap|sets handicap/i.test(m) },
    { label: "Handicap de pontos", test: (m) => /point handicap|points handicap/i.test(m) },
    { label: "Total de sets", test: (m) => /total sets/i.test(m) },
    { label: "Mais/Menos pontos", test: (m) => /total points|over\/?under/i.test(m) },
    { label: "Resultado exato em sets", test: (m) => /correct score|exact score|set score/i.test(m) },
    { label: "Vencedor do set", test: (m) => /set\s*\d*\s*winner|to win (the )?set/i.test(m) },
    { label: "Vencedor", test: (m) => /match winner|to win|money.?line/i.test(m) },
  ],
};
// Futebol é o único com um balde "resto" explícito (pedido do utilizador) — os outros desportos
// não têm, um mercado que não bata em nenhuma categoria só aparece em "Todos".
const FOOTBALL_CATCHALL_LABEL = "Especiais";

let selectedMarketFilter = null; // null = "Todos"

// ====================== TRADUÇÃO DE MERCADOS/SELEÇÕES ======================
// A Pulsescore devolve `market`/rótulo de seleção já prontos a mostrar, mas em inglês (ver
// docs/SPORTS_DATA.md: "rawName em cada mercado/seleção já vem pronto a mostrar" — não existe
// nenhum campo de tradução na resposta real). Traduz-se aqui por palavra-chave, mesma disciplina
// já usada em MARKET_FILTER_CATEGORIES/classifyMarket acima e em
// server/.../pulsescore/marketRouting.ts::classifyRoutingMarket (heurística, não uma lista
// fechada de todos os nomes possíveis) — um nome que não bata em nada fica no original em inglês
// em vez de arriscar mostrar uma tradução errada.
//
// IMPORTANTE: isto traduz só o TEXTO MOSTRADO. O valor bruto (`group.market`/`label`) continua a
// ser usado sem alteração nas chaves do boletim e no objeto enviado para a API de apostas — o
// backend classifica/liquida apostas comparando contra o texto original em inglês
// (settlementRules.ts), nunca contra esta tradução.
const PERIOD_LABEL_PATTERNS = [
  { test: (m) => /1st half|first half/i.test(m), label: "1º Tempo" },
  { test: (m) => /2nd half|second half/i.test(m), label: "2º Tempo" },
  { test: (m) => /half.?time|\bht\b/i.test(m), label: "1º Tempo" },
  { test: (m) => /1st quarter|first quarter|\bq1\b/i.test(m), label: "1º Quarto" },
  { test: (m) => /2nd quarter|second quarter|\bq2\b/i.test(m), label: "2º Quarto" },
  { test: (m) => /3rd quarter|third quarter|\bq3\b/i.test(m), label: "3º Quarto" },
  { test: (m) => /4th quarter|fourth quarter|\bq4\b/i.test(m), label: "4º Quarto" },
  { test: (m) => /1st period|first period/i.test(m), label: "1º Período" },
  { test: (m) => /2nd period|second period/i.test(m), label: "2º Período" },
  { test: (m) => /3rd period|third period/i.test(m), label: "3º Período" },
  { test: (m) => /1st set|first set/i.test(m), label: "1º Set" },
];

function extractPeriodSuffix(rawName) {
  const hit = PERIOD_LABEL_PATTERNS.find((p) => p.test(rawName));
  return hit ? ` (${hit.label})` : "";
}

// Substantivo certo para mercados "Mais/Menos de X" consoante o desporto (golos/pontos/games...).
const OVER_UNDER_NOUN = {
  football: "Golos",
  ice_hockey: "Golos",
  baseball: "Corridas",
  basketball: "Pontos",
  volleyball: "Pontos",
  tennis: "Games",
  mma: "Rounds",
};

// Cascata por palavra-chave alinhada de propósito com classifyRoutingMarket() em
// server/src/modules/sports/pulsescore/marketRouting.ts — um novo tipo de mercado reconhecido lá
// deve ganhar tradução aqui também. Devolve null quando não reconhece nada (ver translateMarketDisplayName).
function translateMarketBaseName(m, sport) {
  if (/extra.?time.*correct score|correct score.*extra.?time/i.test(m)) return "Resultado Exato (Prolongamento)";
  if (/extra.?time/i.test(m)) return "Resultado (Prolongamento)";
  if (/scorecast/i.test(m)) return "Marcador + Resultado";
  if (/result.*both teams to score|both teams to score.*result/i.test(m)) return "Resultado + Ambas Marcam";
  if (/result.*goalscorer|goalscorer.*result/i.test(m)) return "Resultado + Marcador";
  if (/mythical/i.test(m)) return "Confronto Mítico";
  if (/10.?min|ten.?minute/i.test(m)) return "Mercado dos Primeiros 10 Minutos";
  if (/multi.?corners/i.test(m)) return "Múltiplos Cantos";

  if (/odd.?\/?.?even.*corner|corner.*odd.?\/?.?even/i.test(m)) return "Cantos Ímpar/Par";
  if (/odd.?\/?.?even.*card|card.*odd.?\/?.?even/i.test(m)) return "Cartões Ímpar/Par";
  if (/odd.?\/?.?even/i.test(m)) return "Golos Ímpar/Par";

  if (/race to.*corner|corner.*race to/i.test(m)) return "Primeiro a Atingir X Cantos";
  if (/race to.*card|card.*race to/i.test(m)) return "Primeiro a Atingir X Cartões";
  if (/race to/i.test(m)) return "Primeiro a Atingir X Golos";

  if (/first to score|to score first|first goalscorer/i.test(m)) return "Primeiro Marcador";
  if (/last to score|to score last|last goalscorer/i.test(m)) return "Último Marcador";
  if (/goalscorer|\bscorer\b|player.*(to score|goals)/i.test(m)) return "Marcador a Qualquer Momento";

  if (/player.*shot.*target|shot.*target.*player/i.test(m)) return "Remates à Baliza do Jogador";
  if (/player.*shot/i.test(m)) return "Remates do Jogador";
  if (/shot.*on target|shots? on target/i.test(m)) return "Remates à Baliza";
  if (/\bshots?\b/i.test(m)) return "Total de Remates";
  if (/\bpass(es)?\b/i.test(m)) return "Passes";
  if (/\bassists?\b/i.test(m)) return "Assistências";
  if (/\bfouls?\b/i.test(m)) return "Faltas";
  if (/offside/i.test(m)) return "Fora de Jogo";
  if (/goal.?minute|time of.*goal/i.test(m)) return "Minuto do Golo";

  if (/player.*booked|booked.*player|to be booked/i.test(m)) return "Jogador a Ser Advertido";
  if (/corner.*handicap|handicap.*corner/i.test(m)) return "Handicap de Cantos";
  const isOverUnder = /over\/?under|total (goals|points|games|runs|corners|cards)/i.test(m);
  if (/corner/i.test(m)) return isOverUnder ? "Total de Cantos" : "Cantos";
  if (/\bcard|booking/i.test(m)) return "Total de Cartões";

  if (/correct score|exact score/i.test(m)) return "Resultado Exato";
  if (/both teams to score|\bbtts\b|both to score/i.test(m)) return "Ambas as Equipas Marcam";
  if (/tie.?break/i.test(m)) return "Haverá Tie-Break";
  if (/winning margin|margin of victory/i.test(m)) return "Margem de Vitória";
  if (/team total/i.test(m)) return "Total da Equipa";
  if (/set\s*\d*\s*winner|to win (the )?set/i.test(m)) return "Vencedor do Set";
  if (/handicap|spread|asian/i.test(m)) return "Handicap";
  if (isOverUnder) {
    const noun = OVER_UNDER_NOUN[sport] || "Golos";
    const numMatch = m.match(/(\d+(?:\.\d+)?)/);
    return numMatch ? `Mais/Menos de ${numMatch[1]} ${noun}` : `Mais/Menos de ${noun}`;
  }
  if (/draw no bet/i.test(m)) return "Empate Anula Aposta";
  if (/double chance/i.test(m)) return "Dupla Hipótese";
  if (/match odds|\b1x2\b|to win|winner|money.?line|full time result|3.?way|match winner/i.test(m)) return "Resultado Final";
  return null;
}

// Validação geral, não só para BTTS: vários nomes de mercado reconhecidos por palavra-chave
// implicam um vocabulário de seleção conhecido (BTTS só devia ter "Sim"/"Não", Resultado só
// devia ter 1/X/2 ou os nomes das equipas, etc.) — caso real que expôs isto em produção: um
// mercado com o placar já 1-1 aos 86' a mostrar odds típicas de Resultado (equipa/empate/equipa,
// empate fortemente favorito a 1.25 — faria sentido para Resultado perto do fim, NENHUM sentido
// para BTTS, que já estaria "Sim" garantido com 1-1 no placar) só apanhou "Ambas as Equipas
// Marcam" porque o nome bruto continha a frase por coincidência, sem ser mesmo esse mercado.
//
// Mesmo princípio (e, sempre que possível, o mesmo vocabulário exato) do motor de liquidação
// automática — server/src/modules/betting/settlementRules.ts nunca resolve uma aposta sozinho só
// por classificar o NOME do mercado; cada resolveX() também confirma que a SELEÇÃO bate no
// formato esperado da categoria antes de decidir, caindo em UNRESOLVABLE (revisão manual) em
// qualquer outro caso — nunca arrisca liquidar mal. Aqui o "custo" de falhar a validação é só
// mostrar o nome em inglês em vez de um rótulo em português enganador, mas a disciplina é a
// mesma: nunca confiar só na palavra-chave do nome do mercado.
function marketSelectionsLookPlausible(basePt, selectionLabels, home, away) {
  if (!selectionLabels || !selectionLabels.length) return true; // nada para validar
  const norm = (s) => String(s).trim().toLowerCase();
  const labels = selectionLabels.map(norm);
  const homeL = home ? norm(home) : null;
  const awayL = away ? norm(away) : null;

  if (basePt === "Ambas as Equipas Marcam" || basePt === "Haverá Tie-Break") {
    return labels.every((l) => /^(yes|sim|no|não|nao)$/.test(l));
  }
  if (basePt === "Cantos Ímpar/Par" || basePt === "Cartões Ímpar/Par" || basePt === "Golos Ímpar/Par") {
    return labels.every((l) => /^(odd|even|ímpar|impar|par)$/.test(l));
  }
  if (basePt === "Resultado Exato" || basePt === "Resultado Exato (Prolongamento)") {
    return labels.every((l) => /^\d+\s*[-–—:]\s*\d+$/.test(l));
  }
  if (basePt === "Resultado Final" || basePt === "Resultado (Prolongamento)" || basePt === "Empate Anula Aposta") {
    return labels.every((l) => ["1", "x", "2", "home", "away", "draw", "empate", "casa", "fora"].includes(l) || l === homeL || l === awayL);
  }
  if (basePt === "Dupla Hipótese") {
    return labels.every((l) => {
      const compact = l.replace(/\s+/g, "");
      return ["1x", "x1", "x2", "2x", "12"].includes(compact) || /^.+\s+and\s+.+$/.test(l);
    });
  }
  if (basePt === "Total da Equipa" || /^mais\/menos de/i.test(basePt)) {
    return labels.every((l) => /over|under|mais|menos/.test(l));
  }
  return true; // sem vocabulário fixo confirmado para esta categoria — sem validação adicional
}

function translateMarketDisplayName(rawName, sport, selectionLabels, home, away) {
  if (!rawName) return rawName;
  const base = translateMarketBaseName(rawName, sport);
  if (!base) return rawName; // não reconhecido — mantém o nome original em inglês
  if (!marketSelectionsLookPlausible(base, selectionLabels, home, away)) return rawName;
  return base + extractPeriodSuffix(rawName);
}

const SELECTION_WORD_MAP = {
  home: "Casa",
  away: "Fora",
  draw: "Empate",
  tie: "Empate",
  yes: "Sim",
  no: "Não",
  odd: "Ímpar",
  even: "Par",
  "draw no bet": "Empate Anula Aposta",
};

// Rótulos de seleção também vêm prontos a mostrar da Pulsescore — mas ao contrário do nome do
// mercado, muitos são NOMES PRÓPRIOS (equipa, jogador) ou um placar, que nunca se traduzem; só se
// reconhece vocabulário fixo (Casa/Fora/Empate/Sim/Não/Mais de/Menos de/Ímpar/Par) e o padrão
// "Home -1.5"/"Away +1.5" de handicap. Tudo o resto passa exatamente como veio.
function translateSelectionLabel(rawLabel) {
  if (!rawLabel) return rawLabel;
  const trimmed = String(rawLabel).trim();
  const lower = trimmed.toLowerCase();
  if (SELECTION_WORD_MAP[lower]) return SELECTION_WORD_MAP[lower];
  // "Over 2.5" ou "Over 2.5 Goals"/"Under 3.5 Points" (reportado numa amostra real: o rótulo da
  // seleção repete a unidade do mercado, não só o número) — o número fica, a unidade cai (o
  // cabeçalho do mercado já diz "Golos"/"Pontos"/etc., ver translateMarketDisplayName).
  const overUnderMatch = trimmed.match(/^(over|under)\s*([\d.]+)?\s*(goals?|points?|games?|corners?|cards?|runs?)?$/i);
  if (overUnderMatch) {
    const word = overUnderMatch[1].toLowerCase() === "over" ? "Mais de" : "Menos de";
    return overUnderMatch[2] ? `${word} ${overUnderMatch[2]}` : word;
  }
  const handicapMatch = trimmed.match(/^(home|away)\s*([+-]?[\d.]+)$/i);
  if (handicapMatch) {
    const side = handicapMatch[1].toLowerCase() === "home" ? "Casa" : "Fora";
    return `${side} ${handicapMatch[2]}`;
  }
  // Dupla Hipótese: rótulos reais vêm como "<Equipa> and Draw" / "<Equipa1> and <Equipa2>" —
  // só a palavra de ligação ("and"→"e") e "Draw"→"Empate" são traduzidos, os nomes das equipas
  // (não vocabulário fixo) passam exatamente como vieram.
  const doubleChanceMatch = trimmed.match(/^(.+?)\s+and\s+(.+)$/i);
  if (doubleChanceMatch) {
    const side = (s) => (/^draw$/i.test(s) ? "Empate" : s);
    return `${side(doubleChanceMatch[1])} e ${side(doubleChanceMatch[2])}`;
  }
  return trimmed;
}

// Pedido explícito do utilizador: um chip "Bet Builder" entre "Todos" e "1º Tempo" (só futebol —
// as suas 5 categorias, ver BET_BUILDER_CATEGORIES abaixo, são todas conceitos de futebol). Não
// é um filtro como os outros (não estreita a lista de mercados existente) — troca a página inteira
// para o modo de construção de apostas combinadas do mesmo jogo, ver renderBetBuilder().
const BET_BUILDER_LABEL = "Bet Builder";

function renderMarketFilterBar(e) {
  const el = document.getElementById("market-filter-bar");
  if (!el) return;
  const categories = MARKET_FILTER_CATEGORIES[e.sport];
  if (!categories || !e.odds || !e.odds.length) {
    el.innerHTML = "";
    return;
  }
  const labels = ["Todos"];
  if (e.sport === "football") labels.push(BET_BUILDER_LABEL);
  labels.push(...categories.map((c) => c.label));
  if (e.sport === "football") labels.push(FOOTBALL_CATCHALL_LABEL);
  el.innerHTML = labels
    .map((label) =>
      label === BET_BUILDER_LABEL
        ? `<div class="mf-chip mf-chip-bet-builder ${selectedMarketFilter === label ? "active" : ""}" onclick='selectMarketFilter(${JSON.stringify(label)})'><i class="fas fa-database"></i> ${label}</div>`
        : `<div class="mf-chip ${(selectedMarketFilter ?? "Todos") === label ? "active" : ""}" onclick='selectMarketFilter(${JSON.stringify(label)})'>${label}</div>`
    )
    .join("");
}
function selectMarketFilter(label) {
  selectedMarketFilter = label === "Todos" ? null : label;
  renderMarketFilterBar(currentMarketEvent);
  if (label === BET_BUILDER_LABEL) {
    renderBetBuilder(currentMarketEvent);
  } else {
    renderMarketGroups(currentMarketEvent);
  }
}
// Classifica um mercado numa ÚNICA categoria (a primeira, pela ordem da lista, cujo teste
// bata — ver comentário em MARKET_FILTER_CATEGORIES) em vez de testar cada categoria de forma
// independente: "1st Half Corners" bate tanto em "1º Tempo" como em "Escanteios" se testado
// separadamente, o que faria o mesmo mercado aparecer em dois filtros diferentes — errado para
// uma barra de chips onde cada mercado deve ter um único sítio. Sem categoria batida, cai no
// balde "Especiais" do futebol; nos restantes desportos (sem balde definido) fica sem
// categoria (null) — só visível em "Todos".
function classifyMarket(sport, marketName) {
  const categories = MARKET_FILTER_CATEGORIES[sport];
  if (!categories) return null;
  const match = categories.find((c) => c.test(marketName));
  if (match) return match.label;
  return sport === "football" ? FOOTBALL_CATCHALL_LABEL : null;
}
// Devolve só os grupos de mercado que pertencem à categoria escolhida (ou todos, sem filtro
// selecionado).
function filterMarketGroups(e) {
  if (!selectedMarketFilter) return e.odds;
  if (!MARKET_FILTER_CATEGORIES[e.sport]) return e.odds;
  return e.odds.filter((g) => classifyMarket(e.sport, g.market) === selectedMarketFilter);
}

function renderMarketGroups(e) {
  const el = document.getElementById("market-groups");
  if (!e.odds || !e.odds.length) {
    el.innerHTML = '<div class="empty-note">Sem mercados disponíveis para este evento</div>';
    return;
  }
  // Mercado principal antes de filtrar (ver comparação `group === primaryMarket` abaixo) — o
  // filtro de categoria (barra de chips) pode escolher um subconjunto onde o mercado principal
  // real nem sequer aparece, ou deixa de ser o primeiro; precisa de continuar a ser identificado
  // pelo mercado em si, não pela posição dentro da lista já filtrada.
  const primaryMarket = e.odds[0];
  const groups = filterMarketGroups(e);
  if (!groups.length) {
    el.innerHTML = '<div class="empty-note">Sem mercados nesta categoria</div>';
    return;
  }
  const isLive = e._isLive || e.status === "live";
  el.innerHTML = groups
    .map((group) => {
      // Mercado principal (1X2/moneyline, sempre o primeiro — ver orderMarketsWithPrimaryFirst
      // no backend) totalmente suspenso: em vez de 3 caixas "Suspenso" repetidas lado a lado,
      // mostra-se um único botão a cobrir a linha toda. O rótulo do mercado (group.market) pode
      // vir "Match Odds", "Grande Chance" ou até "Revisão VAR" consoante o bookmaker/desporto —
      // por isso a decisão compara o próprio grupo, não o texto do nome.
      const marketNamePt = translateMarketDisplayName(group.market, e.sport, Object.keys(group.selections || {}), e.home, e.away);
      if (group === primaryMarket && !group.isActive) {
        return `<div class="market-group"><h4>${marketNamePt}</h4><div class="selection-row">
          <div class="selection-btn suspended"><span class="sel-odd">Suspenso</span></div>
        </div></div>`;
      }
      const rows = Object.entries(group.selections)
        .map(([label, sel]) => {
          const labelPt = translateSelectionLabel(label);
          // Seleção suspensa pelo bookmaker (isActive:false — ex: durante uma revisão VAR ou
          // logo após um penálti/cartão, ver LiveSelection em types.ts): mostra-se visível mas
          // sem onclick, em vez de desaparecer ou continuar clicável com uma odd desatualizada.
          // Mesmo tratamento para uma odd inválida (ex: NaN de uma transição de deploy com JS
          // antigo em cache) — nunca deixar clicar numa aposta sem preço válido.
          if (!sel.isActive || !Number.isFinite(sel.odd)) {
            return `<div class="selection-btn suspended">
              <span class="sel-label">${labelPt}</span><span class="sel-odd">Suspenso</span>
            </div>`;
          }
          const key = `${e.id}|${group.market}|${label}`;
          const picked = betslipSelections.has(key);
          const selection = { eventId: e.id, sport: e.sport, market: group.market, selection: label, odd: sel.odd, home: e.home, away: e.away, league: e.league };
          // Setas de subida/descida só em Ao Vivo — no pré-jogo o valor não costuma mudar
          // ao ponto de justificar o indicador, e não foi pedido para essa página.
          const arrow = isLive ? oddsArrowHtml(key, sel.odd) : "";
          return `<div class="selection-btn ${picked ? "picked" : ""}" onclick='toggleSelection(${JSON.stringify(key)}, ${JSON.stringify(selection)})'>
            <span class="sel-label">${labelPt}</span><span class="sel-odd">${sel.odd.toFixed(2)}${arrow}</span>
          </div>`;
        })
        .join("");
      const suspendedBadge = !group.isActive ? '<span class="market-suspended-badge">Suspenso</span>' : "";
      return `<div class="market-group"><h4>${marketNamePt}${suspendedBadge}</h4><div class="selection-row">${rows}</div></div>`;
    })
    .join("");
}

// ====================== BET BUILDER (apostas combinadas do MESMO jogo) ======================
// Pedido explícito do utilizador: até 4 seleções combinadas (odd total = produto das odds
// individuais, mesma fórmula da Múltipla) do MESMO evento, mas só nas 5 categorias que o motor
// de liquidação automática já sabe resolver sozinho — Resultado/Golos/Ambas Marcam (BTTS)/
// Escanteios/Cartões. Mercados de jogador (remates, assistências, faltas, impedimentos, passes)
// ficam de fora: este projeto nunca recebeu, em nenhuma amostra real, dados por jogador que
// permitissem liquidar essas apostas sem inventar o resultado (ver docs/BETTING.md).
//
// classifyForBetBuilder() espelha EXATAMENTE server/src/modules/betting/settlementRules.ts
// (classifyMarket + classifyForBetBuilder) — o servidor nunca confia neste espelho e reclassifica
// tudo de novo a partir do zero antes de aceitar a aposta; isto só existe para não mostrar ao
// utilizador uma seleção que o servidor ia recusar de qualquer forma.
const BET_BUILDER_PERIOD_RE =
  /1st half|first half|2nd half|second half|half.?time|\bht\b|1st quarter|first quarter|2nd quarter|3rd quarter|4th quarter|\bq[1-4]\b|1st period|first period|2nd period|3rd period|period\s*\d|1st set|first set/i;

function classifyForBetBuilder(marketName) {
  const m = marketName;
  if (BET_BUILDER_PERIOD_RE.test(m)) return null;
  if (/draw no bet/i.test(m)) return "RESULTADO";
  // Dupla Hipótese separada de Resultado (pedido explícito) — antes as duas ficavam na mesma
  // categoria "Resultado", o que impedia escolher as duas ao mesmo tempo (só uma seleção por
  // categoria) mesmo sendo mercados diferentes.
  if (/double chance/i.test(m)) return "DUPLA_CHANCE";
  const isOverUnder = /over\/?under|total/i.test(m);
  if (/corner/i.test(m)) return isOverUnder ? "ESCANTEIOS" : null;
  if (/\bcard|booking/i.test(m)) return isOverUnder ? "CARTOES" : null;
  if (/both teams to score|\bbtts\b/i.test(m)) return "BTTS";
  if (/correct score|exact score/i.test(m)) return null; // fora das categorias pedidas
  if (isOverUnder || /total (goals|points|games|runs)/i.test(m)) return "GOLS";
  if (/handicap|spread|asian/i.test(m)) return null;
  if (/match odds|\b1x2\b|to win|winner|money.?line|full time result|3.?way/i.test(m)) return "RESULTADO";
  return null;
}

const BET_BUILDER_CATEGORIES = [
  { key: "RESULTADO", label: "Resultado" },
  { key: "DUPLA_CHANCE", label: "Dupla Chance" },
  { key: "BTTS", label: "Ambas Marcam" },
  { key: "GOLS", label: "Acima/Abaixo" },
  { key: "CARTOES", label: "Cartões" },
  { key: "ESCANTEIOS", label: "Cantos" },
];
const BET_BUILDER_MAX_SELECTIONS = 4;

let betBuilderPicks = new Map(); // categoria (RESULTADO/GOLS/...) -> { market, selection, odd, label }
let betBuilderStake = 0;

function betBuilderCombinedOdd() {
  return [...betBuilderPicks.values()].reduce((acc, p) => acc * p.odd, 1);
}

function toggleBetBuilderPick(category, market, label, odd) {
  const existing = betBuilderPicks.get(category);
  if (existing && existing.market === market && existing.selection === label) {
    betBuilderPicks.delete(category); // clicar na já escolhida desmarca-a
  } else {
    // Nova vaga precisa de espaço livre (a categoria já ocupada não conta como "nova vaga" — só
    // troca a seleção dentro da mesma categoria, sempre permitido).
    if (!existing && betBuilderPicks.size >= BET_BUILDER_MAX_SELECTIONS) return;
    betBuilderPicks.set(category, { market, selection: label, odd });
  }
  renderBetBuilder(currentMarketEvent);
}

function renderBetBuilder(e) {
  const el = document.getElementById("market-groups");
  if (!el) return;
  if (!e.odds || !e.odds.length) {
    el.innerHTML = '<div class="empty-note">Sem mercados disponíveis para este evento</div>';
    return;
  }

  const sectionsHtml = BET_BUILDER_CATEGORIES.map((cat) => {
    // Todas as seleções ativas e com odd válida de QUALQUER mercado desta categoria (pode haver
    // mais do que um mercado bruto na mesma categoria, ex: duas linhas diferentes de "Total
    // Corners") — cada botão sabe a que mercado bruto pertence, para submeter certo.
    // DEDUPLICADO por rótulo (Map, não array): reportado com um caso real — "Both Teams to
    // Score" apareceu duas vezes em e.odds (duas fontes/mercados brutos diferentes que classificam
    // para a mesma categoria BTTS), fazendo "Sim"/"Não" aparecerem repetidos como se fossem odds
    // diferentes. Cada categoria só pode ter, no máximo, uma seleção com o mesmo rótulo — a
    // primeira encontrada (mercado principal, ver orderMarketsWithPrimaryFirst no backend) vence,
    // as restantes com o mesmo rótulo são descartadas.
    const optionsByLabel = new Map();
    for (const group of e.odds) {
      if (classifyForBetBuilder(group.market) !== cat.key) continue;
      for (const [label, sel] of Object.entries(group.selections ?? {})) {
        if (!sel.isActive || !Number.isFinite(sel.odd)) continue;
        if (optionsByLabel.has(label)) continue;
        optionsByLabel.set(label, { market: group.market, label, odd: sel.odd });
      }
    }
    const options = [...optionsByLabel.values()];
    if (!options.length) {
      return `<div class="market-group bb-category"><h4>${cat.label}</h4><div class="empty-note" style="padding:6px 2px">Sem mercados disponíveis nesta categoria</div></div>`;
    }
    const picked = betBuilderPicks.get(cat.key);
    const rows = options
      .map(({ market, label, odd }) => {
        const isPicked = picked && picked.market === market && picked.selection === label;
        return `<div class="selection-btn ${isPicked ? "picked" : ""}" onclick='toggleBetBuilderPick(${JSON.stringify(cat.key)}, ${JSON.stringify(market)}, ${JSON.stringify(label)}, ${odd})'>
          <span class="sel-label">${translateSelectionLabel(label)}</span><span class="sel-odd">${odd.toFixed(2)}</span>
        </div>`;
      })
      .join("");
    return `<div class="market-group bb-category"><h4>${cat.label}</h4><div class="selection-row">${rows}</div></div>`;
  }).join("");

  const count = betBuilderPicks.size;
  const combinedOdd = betBuilderCombinedOdd();
  const stakeValue = betBuilderStake > 0 ? betBuilderStake : "";
  const potentialReturn = betBuilderStake > 0 ? (betBuilderStake * combinedOdd).toFixed(2) : "0.00";

  el.innerHTML = `
    <div class="bb-intro">
      <i class="fas fa-database"></i> Combine até ${BET_BUILDER_MAX_SELECTIONS} seleções deste jogo — uma por categoria.
    </div>
    ${sectionsHtml}
    <div class="bb-summary">
      <div class="bb-summary-row"><span>${count}/${BET_BUILDER_MAX_SELECTIONS} seleções</span><span>Odd combinada: <b>${count ? combinedOdd.toFixed(2) : "—"}</b></span></div>
      <div class="bb-summary-row">
        <input type="number" min="0.5" step="0.5" placeholder="Valor (€)" value="${stakeValue}" oninput="setBetBuilderStake(this.value)">
        <button class="btn-save" style="width:auto;margin-top:0" ${count ? "" : "disabled"} onclick="submitBetBuilder()">Adicionar Aposta</button>
      </div>
      <div class="bb-summary-row" style="color:var(--muted);font-size:.82rem">Retorno potencial: € ${potentialReturn}</div>
      <div id="bb-error" class="auth-error"></div>
    </div>`;
}

function setBetBuilderStake(value) {
  betBuilderStake = Number(value) || 0;
  // Só atualiza o texto do retorno potencial (não refaz o innerHTML todo — perderia o foco do
  // <input> a cada tecla, mesmo bug já evitado no boletim principal, ver setStake()).
  const combinedOdd = betBuilderCombinedOdd();
  const row = document.querySelector("#market-groups .bb-summary-row:last-of-type");
  if (row) row.textContent = `Retorno potencial: € ${betBuilderStake > 0 ? (betBuilderStake * combinedOdd).toFixed(2) : "0.00"}`;
}

function showBetBuilderError(msg) {
  const el = document.getElementById("bb-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
}

async function submitBetBuilder() {
  const errEl = document.getElementById("bb-error");
  if (errEl) errEl.classList.remove("show");

  if (!betBuilderPicks.size) return;
  if (!(betBuilderStake > 0)) return showBetBuilderError("Indique o valor da aposta.");

  const e = currentMarketEvent;
  const selections = [...betBuilderPicks.values()].map((p) => ({ eventId: e.id, sport: e.sport, market: p.market, selection: p.selection, odd: p.odd }));

  const btn = document.querySelector("#market-groups .bb-summary button");
  if (btn) btn.disabled = true;
  try {
    const { bets } = await Bet62Api.placeBets("BET_BUILDER", selections, betBuilderStake);
    betBuilderPicks.clear();
    betBuilderStake = 0;
    renderBetBuilder(currentMarketEvent);
    alert(`✅ Bet Builder colocado!\nRetorno potencial: € ${Number(bets[0].potentialReturn).toFixed(2)}`);
    loadBalance();
  } catch (err) {
    showBetBuilderError(err.message || "Não foi possível colocar a aposta.");
    if (btn) btn.disabled = false;
  }
}

function toggleSelection(key, selection) {
  if (betslipSelections.has(key)) {
    betslipSelections.delete(key);
    betslipStakes.delete(key);
  } else {
    betslipSelections.set(key, selection);
    ensureLiveSocket(); // para o boletim poder detetar suspensão/mudança de odd em tempo real
  }
  if (currentMarketEvent) renderMarketGroups(currentMarketEvent);
  renderBetslipPanel();
}

// Compara cada seleção do boletim contra o snapshot ao vivo mais recente (liveEventsById, o
// mesmo mapa da página Ao Vivo) — só faz sentido para jogos que já estão ao vivo neste momento
// (pré-jogo não tem um feed contínuo de odds nesta integração, ver docs/SPORTS_DATA.md).
// Duas situações distintas, pedido explícito do utilizador:
// - Mercado/seleção suspenso pela casa agora mesmo (VAR, intervalo, etc.) → badge "Suspenso",
//   bloqueia a submissão dessa seleção (ver submitBetslip) até voltar ao normal.
// - Mercado ativo mas a odd mudou desde que foi adicionada ao boletim → badge "Odds Ajustada", a
//   odd guardada é atualizada para a atual e a seleção continua utilizável — o utilizador pode
//   confirmar a aposta na hora, já com o valor certo (nunca falha na submissão por odd
//   desatualizada, já que aqui fica sempre sincronizada com o que o servidor vai ver).
function syncBetslipLiveState() {
  if (!betslipSelections.size) return;
  let changed = false;
  for (const s of betslipSelections.values()) {
    const event = liveEventsById.get(s.eventId);
    if (!event) continue; // não está ao vivo agora — sem dados para validar, mantém como está
    const group = event.odds?.find((g) => g.market === s.market);
    const sel = group?.selections?.[s.selection];
    const isSuspended = !group || !group.isActive || !sel || !sel.isActive || !Number.isFinite(sel.odd);
    if (isSuspended) {
      if (s._liveState !== "suspended") {
        s._liveState = "suspended";
        changed = true;
      }
      continue;
    }
    const wasSuspended = s._liveState === "suspended";
    if (Math.abs(sel.odd - s.odd) > 0.005) {
      s.odd = sel.odd;
      s._liveState = "adjusted";
      changed = true;
    } else if (wasSuspended) {
      s._liveState = null; // voltou ao normal com a mesma odd de antes
      changed = true;
    }
  }
  if (changed) renderBetslipPanel();
}

// ====================== BOLETIM DE APOSTA (Simples / Múltipla) ======================
// Regras: Simples = cada seleção é uma aposta independente, com valor próprio; o total
// investido é a soma de todos os valores. Múltipla = todas as seleções combinadas num único
// bilhete, odd total = produto de todas as odds, um único valor de aposta — mas só é permitida
// com 2+ seleções e NUNCA com duas seleções do mesmo evento (resultados correlacionados não
// são aceites em apostas múltiplas, é a regra padrão do mercado).
let betslipMode = "simples"; // "simples" | "multipla"
const betslipStakes = new Map(); // key -> valor apostado (modo Simples)
let multiplaStake = 0;

// setStake()/setMultiplaStake() NÃO chamam renderBetslipPanel() — isso reconstruiria o
// innerHTML do painel inteiro a cada tecla digitada, incluindo o próprio <input> onde o
// utilizador está a escrever, que perde o foco e fecha o teclado do telemóvel a cada caractere
// (bug real reportado). updateBetslipSummary() só atualiza o texto dos totais, deixando os
// <input> intactos; a estrutura do painel só precisa de refazer-se em mudanças estruturais
// (adicionar/remover seleção, trocar Simples/Múltipla, limpar).
function setStake(key, value) {
  betslipStakes.set(key, value);
  updateBetslipSummary();
}
function setBetslipMode(mode) {
  betslipMode = mode;
  renderBetslipPanel();
}
function setMultiplaStake(value) {
  multiplaStake = Number(value) || 0;
  updateBetslipSummary();
}
function updateBetslipSummary() {
  const selections = [...betslipSelections.entries()];
  if (betslipMode === "simples") {
    const totalStake = selections.reduce((sum, [key]) => sum + (Number(betslipStakes.get(key)) || 0), 0);
    const totalReturn = selections.reduce((sum, [key, s]) => sum + (Number(betslipStakes.get(key)) || 0) * s.odd, 0);
    const stakeEl = document.getElementById("bs-total-stake");
    const returnEl = document.getElementById("bs-total-return");
    if (stakeEl) stakeEl.textContent = `€ ${totalStake.toFixed(2)}`;
    if (returnEl) returnEl.textContent = `€ ${totalReturn.toFixed(2)}`;
  } else {
    const totalOdd = selections.reduce((prod, [, s]) => prod * s.odd, 1);
    const returnEl = document.getElementById("bs-multipla-return");
    if (returnEl) returnEl.textContent = `€ ${(multiplaStake * totalOdd).toFixed(2)}`;
  }
}
function clearBetslip() {
  betslipSelections.clear();
  betslipStakes.clear();
  multiplaStake = 0;
  renderBetslipPanel();
  if (currentMarketEvent) renderMarketGroups(currentMarketEvent);
}

function renderBetslipPanel() {
  const panels = [document.getElementById("betslip-panel")].filter(Boolean);
  const selections = [...betslipSelections.entries()];

  const fab = document.getElementById("betslip-fab");
  const fabCount = document.getElementById("betslip-fab-count");
  if (fab && fabCount) {
    fabCount.textContent = selections.length;
    fab.classList.toggle("hidden", selections.length === 0);
  }
  const eventIds = selections.map(([, s]) => s.eventId);
  const hasDuplicateEvent = new Set(eventIds).size < eventIds.length;
  const canMultipla = selections.length >= 2 && !hasDuplicateEvent;
  if (!canMultipla && betslipMode === "multipla") betslipMode = "simples";
  const hasSuspended = selections.some(([, s]) => s._liveState === "suspended");

  panels.forEach((el) => {
    if (!selections.length) {
      el.innerHTML = '<div class="empty-note">Selecione odds nos mercados para adicionar ao boletim</div>';
      return;
    }

    const rowsHtml = selections
      .map(([key, s]) => {
        const isSuspended = s._liveState === "suspended";
        const isAdjusted = s._liveState === "adjusted";
        const rowClass = isSuspended ? "bs-row-suspended" : isAdjusted ? "bs-row-adjusted" : "";
        const badgeHtml = isSuspended
          ? '<span class="bs-row-badge badge-suspended">Suspenso</span>'
          : isAdjusted
            ? '<span class="bs-row-badge badge-adjusted">Odds Ajustada</span>'
            : "";
        return `
      <div class="bs-row ${rowClass}">
        <div class="bs-row-info">
          <div class="bs-row-teams">${s.home || ""}${s.away ? " vs " + s.away : ""}</div>
          <div class="bs-row-sel">${translateMarketDisplayName(s.market, s.sport, [s.selection], s.home, s.away)}: <b>${translateSelectionLabel(s.selection)}</b> @ ${Number(s.odd).toFixed(2)}</div>
          ${badgeHtml}
        </div>
        <div class="bs-row-actions">
          ${
            betslipMode === "simples" && !isSuspended
              ? `<input type="number" min="0.5" step="0.5" class="bs-stake-input" value="${betslipStakes.get(key) || ""}" placeholder="€" oninput='setStake(${JSON.stringify(key)}, this.value)'>`
              : ""
          }
          <button class="bs-remove" onclick='toggleSelection(${JSON.stringify(key)})' aria-label="Remover">✕</button>
        </div>
      </div>`;
      })
      .join("");

    let summaryHtml;
    if (betslipMode === "simples") {
      const totalStake = selections.reduce((sum, [key]) => sum + (Number(betslipStakes.get(key)) || 0), 0);
      const totalReturn = selections.reduce((sum, [key, s]) => sum + (Number(betslipStakes.get(key)) || 0) * s.odd, 0);
      summaryHtml = `
        <div class="bs-summary"><span>Total investido</span><span id="bs-total-stake">€ ${totalStake.toFixed(2)}</span></div>
        <div class="bs-summary"><span>Retorno potencial</span><span class="bs-return" id="bs-total-return">€ ${totalReturn.toFixed(2)}</span></div>`;
    } else {
      const totalOdd = selections.reduce((prod, [, s]) => prod * s.odd, 1);
      summaryHtml = `
        <div class="field" style="margin:10px 0"><label>Valor da aposta (€)</label>
          <input type="number" min="0.5" step="0.5" value="${multiplaStake || ""}" placeholder="€" oninput="setMultiplaStake(this.value)"></div>
        <div class="bs-summary"><span>Odd total</span><span>${totalOdd.toFixed(2)}</span></div>
        <div class="bs-summary"><span>Retorno potencial</span><span class="bs-return" id="bs-multipla-return">€ ${(multiplaStake * totalOdd).toFixed(2)}</span></div>`;
    }

    el.innerHTML = `
      <div class="bs-tabs">
        <div class="bs-tab ${betslipMode === "simples" ? "active" : ""}" onclick="setBetslipMode('simples')">Simples</div>
        <div class="bs-tab ${betslipMode === "multipla" ? "active" : ""} ${canMultipla ? "" : "disabled"}" onclick="${canMultipla ? "setBetslipMode('multipla')" : ""}">Múltipla</div>
      </div>
      ${!canMultipla && selections.length >= 2 ? '<div class="field-hint" style="margin:8px 2px">Múltipla indisponível: há mais do que uma seleção do mesmo evento.</div>' : ""}
      ${hasSuspended ? '<div class="field-hint" style="margin:8px 2px">Remova ou aguarde a(s) seleção(ões) suspensa(s) para poder confirmar.</div>' : ""}
      <div class="auth-error" id="bs-error"></div>
      <div class="bs-rows">${rowsHtml}</div>
      ${summaryHtml}
      <button class="btn-save" id="bs-submit-btn" onclick="submitBetslip()" ${hasSuspended ? "disabled" : ""}>Confirmar Aposta</button>
      <button class="btn-outline" onclick="clearBetslip()">Limpar Boletim</button>`;
  });
}

function showBetslipError(msg) {
  const el = document.getElementById("bs-error");
  if (el) {
    el.textContent = msg;
    el.classList.add("show");
  } else {
    alert(msg);
  }
}

// Colocação real (débito atómico da carteira no servidor, ver server/src/modules/betting) — a
// odd que aqui aparece é só a última vista pelo utilizador; o servidor revalida sempre contra a
// odd atual antes de aceitar, nunca confia neste valor.
async function submitBetslip() {
  if (!Bet62Api.isAuthenticated()) return openAuth("login");
  if (!betslipSelections.size) return alert("Escolha pelo menos uma seleção nos mercados para adicionar ao boletim.");
  if ([...betslipSelections.values()].some((s) => s._liveState === "suspended")) {
    return showBetslipError("Remova ou aguarde a(s) seleção(ões) suspensa(s) antes de confirmar.");
  }

  const entries = [...betslipSelections.entries()];
  if (betslipMode === "simples") {
    const missing = entries.filter(([key]) => !(Number(betslipStakes.get(key)) > 0));
    if (missing.length) return showBetslipError("Indique o valor da aposta em todas as seleções do boletim.");
  } else if (!(multiplaStake > 0)) {
    return showBetslipError("Indique o valor da aposta múltipla.");
  }

  const btn = document.getElementById("bs-submit-btn");
  if (btn) btn.disabled = true;

  try {
    if (betslipMode === "multipla") {
      const selections = entries.map(([, s]) => ({ eventId: s.eventId, sport: s.sport, market: s.market, selection: s.selection, odd: s.odd }));
      const { bets } = await Bet62Api.placeBets("MULTIPLA", selections, multiplaStake);
      clearBetslip();
      alert(`✅ Aposta Múltipla colocada!\nRetorno potencial: € ${Number(bets[0].potentialReturn).toFixed(2)}`);
    } else {
      const selections = entries.map(([key, s]) => ({
        eventId: s.eventId,
        sport: s.sport,
        market: s.market,
        selection: s.selection,
        odd: s.odd,
        stake: Number(betslipStakes.get(key)),
      }));
      const { bets, errors } = await Bet62Api.placeBets("SIMPLES", selections);
      // Só remove do boletim as seleções que FORAM colocadas com sucesso — as que falharam
      // (odd mudou entretanto, mercado suspenso) ficam para o utilizador ver o motivo e decidir.
      const failedKeys = new Set(errors.map((e) => `${e.input.eventId}|${e.input.market}|${e.input.selection}`));
      for (const [key] of entries) {
        if (!failedKeys.has(key)) {
          betslipSelections.delete(key);
          betslipStakes.delete(key);
        }
      }
      renderBetslipPanel();
      if (errors.length) {
        showBetslipError(`${bets.length} aposta(s) colocada(s). ${errors.length} não colocada(s): ${errors.map((e) => e.error).join(" ")}`);
      } else {
        alert(`✅ ${bets.length} aposta(s) colocada(s) com sucesso!`);
      }
    }
    loadBalance();
  } catch (err) {
    showBetslipError(err.message || "Não foi possível colocar a aposta.");
  } finally {
    const stillThere = document.getElementById("bs-submit-btn");
    if (stillThere) stillThere.disabled = false;
  }
}

// ====================== INIT ======================
(async function init() {
  applyAutoTheme();
  // Preenche o estado de sessão em cache ANTES de qualquer verificação de isAuthenticated()
  // (ver afterAuthSuccess acima — mesmo motivo: o cookie de sessão é httpOnly).
  await Bet62Api.getSession();
  updateHeader();
  showPage("destaques");
  renderSportsMenu();
  renderCompetitions();
  renderBetslipPanel();
  if (Bet62Api.isAuthenticated()) {
    await loadProfile();
  }
})();
