// Serializa um valor para dentro de um atributo HTML delimitado por aspas simples (ex:
// onclick='fn(${attrJson(x)})') — JSON.stringify() sozinho nunca escapa aspas simples (não faz
// parte da especificação JSON), por isso um nome real com apóstrofo (equipa, jogador, mercado —
// ex: "N'Golo Kanté", "Côte d'Ivoire") fechava o atributo a meio, partindo o onclick e deixando o
// resto do texto solto no HTML como marcação inesperada. Reportado pelo utilizador como "clico
// numa odd e seleciona várias" — sintoma plausível de um atributo onclick corrompido a meio.
function attrJson(value) {
  return JSON.stringify(value).replace(/'/g, "&#39;");
}

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

// Futebol pré-jogo (Sportmonks): a janela toda tem ~200 jogos/5 dias, mas só o dia selecionado
// vem na resposta (~40 jogos), para não repetir a lentidão de mandar tudo de uma vez com todos os
// mercados (pedido explícito do utilizador: manter TODOS os mercados, mas limitar quantos JOGOS
// ficam visíveis, navegando por dia em vez de por corte de mercados). null = dia por omissão (o
// primeiro disponível, ver sportmonks/prematch.ts). Só se aplica ao futebol — os outros desportos
// (Pulsescore) continuam a devolver a lista inteira de uma vez, como sempre.
let selectedFootballDate = null;
let footballAvailableDates = []; // preenchido a partir de data.availableDates na resposta

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
    const events = [...(prematch?.source === "pulsescore" || prematch?.source === "sportmonks" ? prematch.events : []), ...(live?.events || [])];
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
                return `<div class="league-item ${active ? "active" : ""}" onclick='selectLeague(${attrJson(s.id)}, ${attrJson(league)})'>${league}</div>`;
              })
              .join("")
          : "";
        return `
          <div class="country-item" onclick='toggleCountryExpand(${attrJson(country)}, event)'>
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

// Cache local (localStorage) dos jogos de Pré-jogo — pinta instantaneamente ao abrir/reabrir a
// Web ou PWA, em vez de mostrar a lista vazia (só o skeleton) durante os segundos que a Pulsescore
// demora a responder, mesmo mostrando exatamente os mesmos jogos há pouco. Os dados frescos da
// rede substituem sempre a cache assim que chegam — nunca fica preso ao que estava guardado, e
// `hasKickedOff()` filtra à hora de PINTAR (não à hora de guardar), por isso um jogo que já
// começou entretanto não aparece, mesmo vindo da cache.
const PREMATCH_CACHE_PREFIX = "bet62:prematch-cache:";
const PREMATCH_CACHE_MAX_AGE_MS = 3 * 60 * 60 * 1000; // 3h — generoso, mas nunca mostra jogos de ontem

function savePrematchCache(key, events) {
  try {
    localStorage.setItem(PREMATCH_CACHE_PREFIX + key, JSON.stringify({ events, savedAt: Date.now() }));
  } catch {
    /* localStorage indisponível (modo privado, quota cheia...) — sem cache, comportamento igual a antes */
  }
}

function loadPrematchCache(key) {
  try {
    const raw = localStorage.getItem(PREMATCH_CACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Date.now() - parsed.savedAt > PREMATCH_CACHE_MAX_AGE_MS) return null;
    return Array.isArray(parsed.events) ? parsed.events : null;
  } catch {
    return null;
  }
}

function clearLeagueFilter() {
  selectedLeague = null;
  renderSportsMenu();
  renderPrematchList();
}

function paintPrematchList(container, realEvents) {
  const filteredEvents = realEvents
    .filter((e) => !hasKickedOff(e)) // já passou da hora de início — deve estar em Ao Vivo, não aqui
    .filter((e) => !selectedLeague || (e.league && e.league.toLowerCase().includes(selectedLeague.toLowerCase())));
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
        <div class="lc-teams">${teamLogoImg(e.homeLogo,"sm",e.home)}<span>${e.home}</span><span style="color:var(--muted);font-size:.8rem">vs</span><span>${e.away}</span>${teamLogoImg(e.awayLogo,"sm",e.away)}</div>
        ${quickOddsHtml(e, safeFindPrimaryMarket(e) ?? e.odds?.[0], false)}
      </div>`
  );
  renderInBlocks(container, cardsHtml);
}

async function renderPrematchList() {
  const container = document.getElementById("prematch-list");
  const requestToken = ++renderPrematchList._token;

  const badge = document.getElementById("league-filter-badge");
  if (badge) {
    badge.innerHTML = selectedLeague
      ? `<div class="league-filter-badge">Filtrado por: <b>${selectedLeague}</b> <span onclick="clearLeagueFilter()">✕</span></div>`
      : "";
  }

  const sports = selectedSport ? [selectedSport] : SPORTS_META.map((s) => s.id);
  const cacheKey = `list:${sports.join(",")}`;
  const cachedEvents = loadPrematchCache(cacheKey);
  if (cachedEvents) paintPrematchList(container, cachedEvents);
  else container.innerHTML = skeletonCardsHtml(6);

  // Futebol é o desporto prioritário a carregar depressa (pedido explícito do utilizador) —
  // pedido em separado dos outros e pintado assim que a SUA resposta chegar, sem esperar pelos
  // restantes. Antes disto, um único desporto lento a responder atrasava TODOS (Promise.allSettled
  // só pintava depois de todos os 8 pedidos terminarem, futebol incluído). Os pedidos continuam
  // todos em paralelo (otherPromise arranca já, antes do await do futebol) — não fica mais lento
  // para os outros desportos, só o futebol é que deixa de ficar refém do mais lento.
  const includesFootball = sports.includes("football");
  const otherSports = sports.filter((s) => s !== "football");
  const otherPromise = Promise.allSettled(otherSports.map((s) => Bet62Api.getPrematchEvents(s)));
  let footballEvents = [];

  if (includesFootball) {
    try {
      const data = await Bet62Api.getPrematchEvents("football", selectedFootballDate);
      if (requestToken !== renderPrematchList._token) return;
      footballEvents = data.source === "pulsescore" || data.source === "sportmonks" ? data.events : [];
      footballAvailableDates = data.availableDates || [];
      renderFootballDateFilter();
      // Pinta já: futebol fresco + os restantes desportos ainda com o que estava em cache (se
      // houver), para não fazer desaparecer jogos já visíveis enquanto se espera pelos outros.
      const otherFromCache = (cachedEvents || []).filter((e) => e.sport !== "football");
      paintPrematchList(container, [...footballEvents, ...otherFromCache]);
    } catch {
      footballEvents = [];
    }
  } else {
    footballAvailableDates = [];
    renderFootballDateFilter();
  }

  const otherResults = await otherPromise;
  if (requestToken !== renderPrematchList._token) return; // uma seleção mais recente já está a carregar

  const otherEvents = [];
  otherResults.forEach((r) => {
    if (r.status === "fulfilled" && r.value.source === "pulsescore") otherEvents.push(...r.value.events);
  });

  const realEvents = [...footballEvents, ...otherEvents];
  savePrematchCache(cacheKey, realEvents);
  paintPrematchList(container, realEvents);
}
renderPrematchList._token = 0;

// Separadores de dia do pré-jogo de futebol (só Sportmonks — availableDates só vem preenchido
// nesse ramo, ver prematch/service.ts) — só aparecem quando se está mesmo a ver só futebol
// (selectedSport === "football"), nunca na vista "Todos" nem nos outros desportos.
function renderFootballDateFilter() {
  const el = document.getElementById("football-date-filter");
  if (!el) return;
  if (selectedSport !== "football" || !footballAvailableDates.length) {
    el.innerHTML = "";
    el.style.display = "none";
    return;
  }
  el.style.display = "flex";
  const todayKeyUtc = new Date().toISOString().slice(0, 10); // mesma convenção do backend (UTC)
  const activeDate = selectedFootballDate || footballAvailableDates[0];
  el.innerHTML = footballAvailableDates
    .map((d) => {
      const label =
        d === todayKeyUtc
          ? "Hoje"
          : new Date(`${d}T12:00:00Z`).toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit", timeZone: BET62_TIMEZONE });
      return `<div class="sport-chip ${d === activeDate ? "active" : ""}" onclick="selectFootballDate('${d}')">${label}</div>`;
    })
    .join("");
}

function selectFootballDate(date) {
  if (selectedFootballDate === date) return;
  selectedFootballDate = date;
  renderPrematchList();
}

// Atualização periódica em segundo plano das listas de Pré-jogo (Esportes e Destaques) — sem
// isto, a lista só refrescava ao mudar de página/filtro, podendo ficar minutos sem refletir jogos
// novos ou horários corrigidos enquanto o utilizador fica parado numa destas páginas. Pausa
// sozinho com a aba em segundo plano (document.hidden) para não gastar rede/bateria à toa, e só
// age quando a página relevante está mesmo visível — mesmo padrão de guarda usado em
// startMyBetsLiveRefresh(). 60s: acima da cache de 45s do servidor (prematch/service.ts), para
// quase sempre apanhar dados já renovados do lado do servidor em vez de bater sempre na mesma
// resposta em cache.
setInterval(() => {
  if (document.hidden) return;
  const activePage = document.querySelector(".top-nav-item.active")?.dataset.page;
  if (activePage === "esportes") renderPrematchList();
  else if (activePage === "destaques") renderDestaquesHighlights();
}, 60000);
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

// Um evento "pré-jogo" cuja hora de início já passou não deve continuar a aparecer em Pré-jogo
// — mesmo que a Pulsescore ainda não o tenha movido para o feed Ao Vivo (o feed pode demorar um
// ciclo de sondagem a apanhar), a nossa própria hora de início já sabe que devia ter começado.
// Corta ali (não espera pela Pulsescore) para nunca ficar duplicado nos dois sítios ao mesmo
// tempo — pedido explícito do utilizador.
function hasKickedOff(e) {
  if (!e.startTime) return false;
  return parseServerDate(e.startTime).getTime() <= Date.now();
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

// Ordem canónica (Casa/Empate/Fora) das seleções de um mercado — precisa de ser reaplicada aqui,
// no frontend, mesmo já vindo ordenada do backend (ver HOME_DRAW_AWAY_PRIORITY em
// sportmonks/client.ts), porque Object.entries()/Object.keys() em JavaScript colocam SEMPRE
// chaves que parecem índices inteiros ("1", "2") primeiro, em ordem numérica ascendente, antes de
// qualquer chave não numérica ("X") — independentemente da ordem de inserção no objeto (regra do
// próprio motor JS, não hábito de quem escreveu o código). Isto fazia o cartão principal do Ao
// Vivo mostrar "1, 2, X" em vez de "1, X, 2" sempre que a Sportmonks usava estes rótulos (só em Ao
// Vivo — reportado pelo utilizador "estão aparecendo 12x e não 1x2"; o pré-jogo nunca sofria disto
// porque usa "Home"/"Draw"/"Away", que não são chaves numéricas). Só reordena quando o CONJUNTO de
// rótulos do grupo bate exatamente neste vocabulário (sem repetidos) — qualquer outro mercado
// (Mais/Menos, Ambas Marcam, nomes de equipa/jogador...) mantém-se exatamente na ordem que
// Object.entries() já dava, sem risco de baralhar algo que não se reconhece com confiança.
const HOME_DRAW_AWAY_ORDER = { "1": 0, home: 0, casa: 0, x: 1, draw: 1, tie: 1, empate: 1, "2": 2, away: 2, fora: 2 };
function orderedSelectionEntries(selections) {
  const entries = Object.entries(selections || {});
  const keys = entries.map(([label]) => label.trim().toLowerCase());
  const isHomeDrawAway = keys.length > 0 && keys.every((k) => k in HOME_DRAW_AWAY_ORDER) && new Set(keys).size === keys.length;
  if (!isHomeDrawAway) return entries;
  return [...entries].sort((a, b) => HOME_DRAW_AWAY_ORDER[a[0].trim().toLowerCase()] - HOME_DRAW_AWAY_ORDER[b[0].trim().toLowerCase()]);
}

// Seleções ativas de um mercado — o backend já não descarta seleções suspensas (isActive:false,
// ex: durante uma revisão VAR ou logo após um penálti/cartão), passam a chegar marcadas para a
// UI as mostrar suspensas em vez de clicáveis. Os cartões compactos (pré-jogo/ao vivo) só
// mostram as ativas, para não ocupar as 3 posições de pré-visualização com odds suspensas.
function activeSelectionEntries(group) {
  // Number.isFinite(sel?.odd) descarta qualquer entrada com odd inválida/em falta (ex: uma
  // transição de deploy em que JS antigo em cache leu a forma nova {odd,isActive} como se
  // fosse só um número — Number({odd:1.85,...}) dá NaN) em vez de deixar "NaN" aparecer no ecrã.
  return orderedSelectionEntries(group?.selections).filter(([, sel]) => sel?.isActive && Number.isFinite(sel?.odd));
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

// Rótulo do mercado principal suspenso — "Suspenso" genérico, ou "Grande Chance"/"Revisão VAR"
// quando `e.suspendedReason` vem preenchido (Sportmonks, ver detectSuspendedReason() no backend,
// sportmonks/client.ts — NÃO é um dado confirmado da API, é uma leitura nossa do evento mais
// recente do jogo, pedido explícito do utilizador). Jogos sem este campo (Pulsescore, ou
// Sportmonks sem eventos disponíveis) continuam a mostrar só "Suspenso", como sempre.
function primarySuspendedLabel(e) {
  if (e.suspendedReason === "goal") return "Grande Chance";
  if (e.suspendedReason === "var") return "Revisão VAR";
  if (e.suspendedReason === "penalty") return "Pênalti a Marcar";
  return "Suspenso";
}

// As 3 odds 1x2 do cartão compacto ficavam invisíveis assim que o mercado era suspenso (VAR,
// pênalti, cartão...), porque só entradas ativas (activeSelectionEntries) chegavam a aparecer —
// pedido explícito para NUNCA sumirem: agora mostram-se sempre, ativas clicáveis e suspensas
// como bloco cinzento "Suspenso" (mesmo tratamento já usado na página do mercado, ver
// renderMarketGroups acima) em vez de desaparecer.
//
// Mesmo tratamento agora também para quando NÃO existe grupo nenhum ainda (e.odds vazio) — bug
// real reportado com print: um jogo passava a "Ao Vivo" ~2 min antes do início (placar 0-0 já
// visível, correto) mas com o cartão sem odds nenhumas nem aviso, como se o mercado nem
// existisse — o utilizador pediu explicitamente para nunca ficar "assim sem odds", entrar sempre
// pelo menos como "Suspenso" até o bookmaker abrir o mercado.
const SUSPENDED_QUICK_ODDS_HTML = (e) => `<div class="lc-odds"><div class="suspended" style="flex:3">${primarySuspendedLabel(e)}</div></div>`;
// =========== VALIDADORES MÍNIMOS (apenas para CARTÕES da lista) =================
// Estes helpers são propositadamente ULTRA-SIMPLES e conservadores:
//   - Nunca mudam o comportamento se não houver dados suspeitos
//   - Só rejeitam o que é OBVIAMENTE errado (horário "19:00" como odd, labels
//     "Nem / Sem gol / Placar Empate" no lugar de Casa/Empate/Fora etc.)
//   - Se existir dúvida: mantém o dado original e não bloqueia nada.
function normalizeOddValue(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : NaN;
  if (typeof raw !== "string") return NaN;
  const s = raw.trim();
  // Fix A.1: Rejeita EXPLICITAMENTE strings com ":" (horário: "19:00", "21:00") ou "/"
  // (datas "27/08") — nunca são odds válidas.
  if (s.includes(":") || s.includes("/")) return NaN;
  // Só aceita dígitos + 1 separador decimal (ponto ou vírgula pt-PT).
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return NaN;
  return Number(s.replace(",", "."));
}
// Fix B.1: Classifica uma label como "parece lado Home / Draw / Away / None".
// Devolve "h" "d" "a" ou null. Usa palavras mais comuns em pt/en 1x2 / moneyline.
function classifyHdaLabel(labelRaw) {
  const rawOrig = String(labelRaw ?? "").trim();
  // Fix E (odds altas de handicap): REJEITA QUALQUER label que contenha
  // sinais de linha (+ / − / -) ou dígitos. Handicap e O/U com linha extrema
  // (ex: "Casa +5.5") têm odds absurdas (151.00) que NUNCA pertencem ao
  // mercado principal 1X2/Moneyline puro.
  if (/[+\-−0-9]/.test(rawOrig)) return null;
  const s = rawOrig
    .toLowerCase()
    // Remove quaisquer anexos de linha (ex: "Casa -1.5" → "casa", "Home +0.5" → "home")
    .replace(/[+-−]\s*\d+([.,]\d+)?$/, "")
    .trim();
  if (!s) return null;
  if (["1", "home", "casa", "casa.", "homes", "h"].includes(s)) return "h";
  if (["x", "2", "draw", "tie", "empate", "empates", "draws", "ties", "d"].includes(s) || /^draw\b|^empate\b|^tie\b/.test(s)) return "d";
  if (["2", "away", "fora", "aways", "a", "visitante"].includes(s)) return "a";
  return null;
}
function quickOddsHtml(e, group, isLive) {
  if (!group?.selections || !group.isActive) return SUSPENDED_QUICK_ODDS_HTML(e);

  // Fix A: filtrar entries por valor ODD aceitável (não horário, não data, faixa 1.01–1000)
  // Cartões mostram sempre o mercado PRINCIPAL 1X2 / Moneyline; odds > 1000 aqui são 99.9% erro.
  const MIN_ODD = 1.01;
  const MAX_ODD = 1000;
  const entriesFiltered = [];
  for (const [label, sel] of orderedSelectionEntries(group.selections)) {
    if (!sel || sel.isActive === false) continue;
    const v = normalizeOddValue(sel.odd);
    if (!Number.isFinite(v)) continue;
    if (v < MIN_ODD || v > MAX_ODD) continue;
    entriesFiltered.push([label, { ...sel, odd: v }]);
    if (entriesFiltered.length >= 3) break;
  }
  if (!entriesFiltered.length) return SUSPENDED_QUICK_ODDS_HTML(e);

  // Fix B: os botões do cartão NÃO PODEM ser "Nem / Sem gol / Placar Empate".
  // Requisitos mínimos:
  //   3 botões → {h, d, a} (1X2 completo) OU no mínimo 2 de {h,d,a} + 1 outro não suspeito.
  //   2 botões → {h, a} (moneyline casa/fora).
  //   1 botão → SEMPRE suspenso (1 botão sem contexto é erro 99%).
  const labels = entriesFiltered.map(([l]) => classifyHdaLabel(l));
  const counts = { h: 0, d: 0, a: 0, null: 0 };
  for (const l of labels) counts[l === null ? "null" : l]++;
  const looksOk =
    (entriesFiltered.length === 3 && (counts.h + counts.d + counts.a >= 2)) ||
    (entriesFiltered.length === 2 && counts.h >= 1 && counts.a >= 1);
  if (!looksOk) {
    // Qualquer outro caso (1 botão só, 2 botões sem casa/fora, 3 botões de BTTS etc.)
    // mostra "Suspenso" em vez de odds descontextualizadas.
    return SUSPENDED_QUICK_ODDS_HTML(e);
  }

  const entries = entriesFiltered;
  return `<div class="lc-odds">${entries
    .map(([label, sel]) => {
      const labelPt = translateSelectionLabel(label);
      const key = `${e.id}|${group.market}|${label}`;
      const picked = betslipSelections.has(key);
      const selection = { eventId: e.id, sport: e.sport, market: group.market, selection: label, odd: sel.odd, home: e.home, away: e.away, league: e.league };
      const arrow = isLive ? oddsArrowHtml(key, sel.odd) : "";
      return `<div class="${picked ? "picked" : ""}" onclick='quickPick(event, ${attrJson(key)}, ${attrJson(selection)})'>${labelPt}<br>${sel.odd.toFixed(2)}${arrow}</div>`;
    })
    .join("")}</div>`;
}
// Fix C + D: safeFindPrimaryMarket(e) — ULTRA conservador. 0 heurísticas.
// Passa por TODAS as odds do evento (não só [0]) e retorna o PRIMEIRO grupo que
// é 1X2/Moneyline a 2/3 botões válidos. Se NÃO encontrar nenhum → retorna undefined,
// os callers usam `?? e.odds?.[0]` para ficar exatamente como 01e8626. NUNCA destrói UX.
function safeFindPrimaryMarket(e) {
  if (!e || !Array.isArray(e.odds) || !e.odds.length) return undefined;
  for (let gIdx = 0; gIdx < e.odds.length; gIdx++) {
    const g = e.odds[gIdx];
    if (!g || !g.selections || g.isActive === false) continue;
    const sels = Object.entries(g.selections);
    if (sels.length < 2 || sels.length > 3) continue;
    let h = 0, d = 0, a = 0;
    let grupoValido = true;
    for (const [lbl, sel] of sels) {
      if (!sel || sel.isActive === false) { grupoValido = false; break; }
      // Fix E (odds altas): NÃO aceita handicap / O/U labels com dígitos ou +−
      if (/[+\-−0-9]/.test(String(lbl ?? "").trim())) { grupoValido = false; break; }
      const v = normalizeOddValue(sel.odd);
      if (!Number.isFinite(v) || v < 1.01 || v > 1000) { grupoValido = false; break; }
      const c = classifyHdaLabel(lbl);
      if (c === "h") h++;
      else if (c === "d") d++;
      else if (c === "a") a++;
    }
    if (!grupoValido) continue;
    const totalHda = h + d + a;
    if (sels.length === 3 && totalHda >= 2) return g;
    if (sels.length === 2 && h >= 1 && a >= 1) return g;
  }
  return undefined;
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
  // Sai da página de mercado: pára o motor 2D do mini campo (tracker2d.js) — o canvas e o seu
  // estado interno continuam vivos (nada é destruído), apenas se deixa de fazer repaints até
  // ser montado de novo quando voltarmos à página de mercado.
  if (page !== "market") pauseTracker2D();

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
  el.innerHTML = `<div class="fpromo-empty">A carregar promoções…</div>`;
  // Timeout defensivo: se o servidor nunca responder (deploy a decorrer, rede instável, etc.),
  // isto garante que a página nunca fica presa em "A carregar" para sempre — passados 12s mostra
  // sempre um erro com botão para tentar de novo.
  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error("O servidor demorou demasiado a responder")), ms));
  try {
    const [promotions, myPromotions] = await Promise.race([
      Promise.all([
        Bet62Api.getActivePromotionsPublic().then((d) => d.promotions),
        Bet62Api.isAuthenticated() ? Bet62Api.getMyPromotions().then((d) => d.promotions).catch(() => []) : Promise.resolve([]),
      ]),
      timeout(12000),
    ]);
    renderPromocaoPage(promotions, myPromotions);
  } catch (err) {
    el.innerHTML = `
      <div class="fpromo-empty">
        Não foi possível carregar as promoções (${escHtml(err.message || "erro")})
        <div><button class="fpromo-cta" style="margin-top:14px" onclick="loadPromocaoPage()">Tentar novamente</button></div>
      </div>`;
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
  expandedBetTicketId = null;
  document.querySelectorAll("#mybets-tabs .mybets-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  renderMyBetsBody();
}

async function loadMyBets() {
  const body = document.getElementById("mybets-body");
  if (!body) return;
  body.innerHTML = skeletonCardsHtml(3);
  expandedBetTicketId = null;
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

// Acordeão: só UM bilhete fica aberto de cada vez na lista — expandir outro fecha
// automaticamente o anterior (pedido explícito). Colapsado mostra só um resumo (evita a lista
// ficar gigante com vários bilhetes de muitas seleções); expandido mostra tudo (seleções,
// figuras, Cash Out). Nada de scroll aninhado dentro do bilhete — só a página/modal rola.
let expandedBetTicketId = null;

function toggleBetTicket(id) {
  expandedBetTicketId = expandedBetTicketId === id ? null : id;
  renderMyBetsBody();
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
  const isExpanded = expandedBetTicketId === b.id;
  const anyLegLive = isPending && b.selections.some((s) => liveEventsById.has(s.eventId));
  const stateClass = isPending ? (anyLegLive ? "is-live" : "is-open") : b.status === "WON" ? "is-won" : b.status === "LOST" ? "is-lost" : b.status === "CASHED_OUT" ? "is-cashout" : "is-void";
  const statusMeta = TICKET_STATUS_META[b.status] || { cls: "st-pending", label: b.status };
  const statusCls = anyLegLive && isPending ? "st-live" : statusMeta.cls;
  const statusLabel = anyLegLive && isPending ? "Ao Vivo" : statusMeta.label;
  // "Melhores Escolhas" reaproveita o tipo BET_BUILDER internamente (mesma liquidação, ver
  // placeFeaturedComboBet em betting/service.ts) — distingue-se aqui só para mostrar ao
  // utilizador, nunca muda como a aposta é resolvida.
  const modeLabel = b.boostPercent
    ? `🔥 Melhores Escolhas (+${b.boostPercent}%)`
    : b.type === "MULTIPLA"
      ? "Múltipla"
      : b.type === "BET_BUILDER"
        ? "Bet Builder"
        : "Simples";

  const returnLabel =
    b.status === "WON" ? "Ganho" : b.status === "CASHED_OUT" ? "Recebido" : b.status === "VOID" ? "Devolvido" : b.status === "LOST" ? "Retorno" : "Retorno potencial";
  const returnValue =
    b.status === "WON" || b.status === "CASHED_OUT" || b.status === "VOID"
      ? Number(b.payout).toFixed(2)
      : b.status === "LOST"
        ? "0.00"
        : Number(b.potentialReturn).toFixed(2);

  const toggleAttr = `onclick='toggleBetTicket(${attrJson(b.id)})'`;
  const head = `
    <div class="bet-ticket-top" ${toggleAttr}>
      <span class="bet-ticket-mode">${modeLabel} • ${b.selections.length} seleç${b.selections.length > 1 ? "ões" : "ão"}</span>
      <span class="bet-ticket-status ${statusCls}">${statusLabel}</span>
      <span class="bet-ticket-chevron">${isExpanded ? "▲" : "▾"}</span>
    </div>`;

  if (!isExpanded) {
    const first = b.selections[0];
    const moreLabel = b.selections.length > 1 ? ` <span class="muted">+${b.selections.length - 1} outra${b.selections.length > 2 ? "s" : ""}</span>` : "";
    return `
      <div class="bet-ticket ${stateClass}" data-bet-id="${b.id}">
        ${head}
        <div class="bet-ticket-summary" ${toggleAttr}>
          <div class="bet-ticket-summary-teams">${first.home} vs ${first.away}${moreLabel}</div>
          <div class="bet-ticket-summary-figures">€ ${Number(b.stake).toFixed(2)} <span class="muted">→</span> € ${returnValue}</div>
        </div>
      </div>`;
  }

  const legsHtml = b.selections.map((s) => betTicketLegHtml(s, isPending)).join("");
  // Botão de Cash Out fica em baixo, junto dos valores do bilhete (Stake/Odd/Retorno/ID) —
  // pedido explícito do utilizador — só existe no bilhete que está expandido no acordeão.
  const cashoutRow = isPending
    ? `<div class="bet-ticket-cashout-row"><button class="bet-ticket-cashout-btn" id="cashout-btn-${b.id}" onclick='requestCashOut(${attrJson(b.id)})' disabled>A verificar Cash Out…</button></div>`
    : "";

  return `
    <div class="bet-ticket ${stateClass}" data-bet-id="${b.id}">
      ${head}
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
      <button class="auth-submit" onclick='copyMultibancoReference(${attrJson(data.entity)}, ${attrJson(data.reference)})'>COPIAR ENTIDADE E REFERÊNCIA</button>
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
      <div class="lc-teams">${teamLogoImg(e.homeLogo,"sm",e.home)}<span>${e.home}</span><span style="color:var(--muted);font-size:.8rem">vs</span><span>${e.away}</span>${teamLogoImg(e.awayLogo,"sm",e.away)}</div>
      ${quickOddsHtml(e, safeFindPrimaryMarket(e) ?? e.odds?.[0], false)}
    </div>`;
}

function highlightLiveCardHtml(e, icon) {
  const clockClass = isClockMissing(e) ? "clock-missing" : "";
  const oddsHtml = quickOddsHtml(e, safeFindPrimaryMarket(e) ?? e.odds?.[0], true);
  return e.statistics?.sets ? renderSetsCard(e, clockClass, oddsHtml, icon[e.sport] || "") : renderGenericCard(e, clockClass, oddsHtml, icon[e.sport] || "");
}

// Banner de promoção na página Destaques — mesma fonte de dados da página Promoção
// (/api/promotions/active), reaproveitando os mesmos rótulos/valores. Sem promoção ativa
// configurada no admin, fica simplesmente sem banner (nunca inventa uma oferta).
async function renderDestaquesPromoBanner() {
  const el = document.getElementById("destaques-promo-banner");
  if (!el) return;
  try {
    const { promotions } = await Bet62Api.getActivePromotionsPublic();
    const primary = promotions.find((p) => p.type === "WELCOME_BONUS") || promotions[0];
    if (!primary) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = `
      <div class="fpromo-hero" style="cursor:pointer;margin-bottom:24px" onclick="showPage('promocao')">
        <div class="fpromo-hero-badge">${FPROMO_ICON[primary.type] || "🚀"} ${escHtml(PROMO_TYPE_LABEL_PT[primary.type] || primary.name)}</div>
        <div class="fpromo-hero-value"><span class="accent">${fpromoValueLabel(primary)}</span></div>
        <div class="fpromo-hero-sub">${escHtml(primary.name)} · toca para ver os detalhes</div>
      </div>`;
  } catch {
    el.innerHTML = "";
  }
}

// --- Pré-jogo: 5, com preferência para competições UEFA (ordenação estável: mantém a ordem
// relativa original dentro de cada grupo, só separa "é UEFA" de "não é UEFA"). Extraído para ser
// reutilizado tanto na pintura instantânea a partir da cache local (ver PREMATCH_CACHE_PREFIX)
// como na pintura com os dados frescos da Pulsescore. ---
function paintDestaquesPrematch(prematchEl, icon, prematchEvents) {
  const prematchHighlights = [...prematchEvents.filter((e) => !hasKickedOff(e))]
    .sort((a, b) => (/uefa/i.test(a.league || "") ? 0 : 1) - (/uefa/i.test(b.league || "") ? 0 : 1))
    .slice(0, 5);
  prematchHighlights.forEach((e) => prematchEventsById.set(e.id, e));

  if (!prematchHighlights.length) {
    prematchEl.innerHTML = '<div class="empty-note">Sem jogos agendados neste momento</div>';
  } else {
    renderInBlocks(prematchEl, prematchHighlights.map((e) => highlightPrematchCardHtml(e, icon)));
  }
}

async function renderDestaquesHighlights() {
  renderDestaquesPromoBanner();
  const prematchEl = document.getElementById("destaques-prematch-list");
  const liveEl = document.getElementById("destaques-live-list");
  if (!prematchEl || !liveEl) return;
  const icon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));

  // Pintura instantânea a partir da cache local — esta é a página de arranque (Destaques), a
  // primeira coisa vista ao abrir/reabrir a Web ou PWA, por isso é aqui que o "fica vazio por
  // uns segundos" reportado mais se nota.
  const cachedPrematch = loadPrematchCache("highlights");
  if (cachedPrematch) paintDestaquesPrematch(prematchEl, icon, cachedPrematch);
  else prematchEl.innerHTML = skeletonCardsHtml(5);
  liveEl.innerHTML = skeletonCardsHtml(5);

  const [prematchResults, liveResult] = await Promise.all([
    Promise.allSettled(SPORTS_META.map((s) => Bet62Api.getPrematchEvents(s.id))),
    Bet62Api.getLiveEvents().catch(() => ({ events: [] })),
  ]);

  const prematchEvents = [];
  prematchResults.forEach((r) => {
    if (r.status === "fulfilled" && (r.value.source === "pulsescore" || r.value.source === "sportmonks")) prematchEvents.push(...r.value.events);
  });
  savePrematchCache("highlights", prematchEvents);
  paintDestaquesPrematch(prematchEl, icon, prematchEvents);

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
// Marca de quando chegou o último frame (qualquer tipo) do WS — usada por
// forceReconnectLiveSocketIfStale() abaixo para detetar uma ligação "zombie": o browser não avisa
// (readyState continua OPEN) quando uma ligação morre sem um fecho limpo — típico de telemóvel a
// voltar de segundo plano ou a mudar de rede. Reportado pelo utilizador com atrasos reais de
// 20-30s no placar/odds ao vivo depois disso acontecer duas vezes seguidas.
let lastLiveFrameAt = 0;
const LIVE_STALE_MS = 30000;

function ensureLiveSocket() {
  if (liveSocket && liveSocket.readyState <= 1) return;

  liveSocket = new WebSocket(`${window.BET62_CONFIG.WS_BASE}/ws/live`);

  // Sem texto de "desligado"/erro para o utilizador — a reconexão (aqui e em
  // forceReconnectLiveSocketIfStale) já é automática e rápida, mostrar o estado real de cada
  // queda/religação só alarmava sem necessidade (pedido explícito do utilizador: "pode remover
  // aquele ligado e desligado, pode deixar diretamente ligado").
  liveSocket.onopen = () => {
    lastLiveFrameAt = Date.now();
  };
  liveSocket.onclose = () => {
    setTimeout(ensureLiveSocket, 3000);
  };
  liveSocket.onerror = () => {};
  liveSocket.onmessage = (msg) => {
    lastLiveFrameAt = Date.now();
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

// Chamado quando a app volta ao primeiro plano (aba/telemóvel) — se a ligação existente parece
// aberta mas está calada há mais de LIVE_STALE_MS, ou já está a meio de fechar, força já uma nova
// ligação em vez de esperar pelo próximo ping do heartbeat do servidor (até 25s, ver gateway.ts) ou
// pelo atraso de 3s do reconector passivo em onclose. Sem isto, o "pisca vermelho" só aparecia
// muito depois de a ligação já estar morta — exatamente o atraso de 20-30s reportado.
function forceReconnectLiveSocketIfStale() {
  if (!liveSocket) return; // nunca ligou ainda — ensureLiveSocket() liga quando for preciso
  const staleOpen = liveSocket.readyState === WebSocket.OPEN && Date.now() - lastLiveFrameAt > LIVE_STALE_MS;
  if (staleOpen) {
    liveSocket.close(); // readyState passa já a CLOSING (>1) — ensureLiveSocket() não fica bloqueado pela guarda
    ensureLiveSocket();
  } else if (liveSocket.readyState > 1) {
    // já estava CLOSING/CLOSED (ex: voltou de segundo plano muito depois do fecho) — religa já
    ensureLiveSocket();
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") forceReconnectLiveSocketIfStale();
});
window.addEventListener("focus", forceReconnectLiveSocketIfStale);
window.addEventListener("pageshow", forceReconnectLiveSocketIfStale);

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
    <div class="live-card" data-eid="${e.id}" onclick='openMarket(${attrJson(e.id)}, true)'>
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
    <div class="live-card" data-eid="${e.id}" onclick='openMarket(${attrJson(e.id)}, true)'>
      <div class="lc-top"><span>${icon} ${e.league}</span><span class="${clockClass}">${e.minuteOrPeriod}</span></div>
      <div class="event-rows">
        <div class="event-row score-left">${hasScore ? `<span class="event-row-score">${e.homeScore}</span>` : ""}<span class="event-team">${teamLogoImg(e.homeLogo,"sm",e.home)}<span data-initial-fallback="${teamInitials(e.home)}">${e.home}</span>${homeRed}</span></div>
        <div class="event-row score-left">${hasScore ? `<span class="event-row-score">${e.awayScore}</span>` : ""}<span class="event-team">${teamLogoImg(e.awayLogo,"sm",e.away)}<span data-initial-fallback="${teamInitials(e.away)}">${e.away}</span>${awayRed}</span></div>
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
    const oddsHtml = quickOddsHtml(e, safeFindPrimaryMarket(e) ?? e.odds?.[0], true);

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
  const oddsHtml = quickOddsHtml(e, safeFindPrimaryMarket(e) ?? e.odds?.[0], true);
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
  closeStats(); // cada evento novo abre sempre nos mercados, nunca preso nas estatísticas do anterior
  closeTracker(); // idem para o Match Tracker, nunca aberto por engano no jogo errado
  showPage("market");
  renderMarketPage();

  // Eventos reais da Pulsescore/Sportmonks: pede dados frescos em vez de confiar só na última
  // leitura em cache (snapshot ao vivo ou lista de pré-jogo) — para a Sportmonks isto é o que
  // torna as odds de um jogo ao vivo aberto mais frescas do que o ciclo de 15s da lista inteira
  // (reportado pelo utilizador como "as odds em ao vivo não estão atualizando").
  if (event.source === "pulsescore" || event.source === "sportmonks") {
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
  renderFeaturedCombo(e);
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
  refreshBallPositionIfNeeded(e, false); // atualiza o rasto real da bola (cabeçalho + modal, se aberto)

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
  const showVisual = e.sport === "football";
  el.innerHTML = `
    <div id="mt-basic-header">
      <div class="mt-teams-top">
        <div class="mt-team-name">${teamLogoImg(e.homeLogo, "", e.home)}<span data-initial-fallback="${teamInitials(e.home)}">${e.home}</span></div>
        <div class="mt-team-name away"><span data-initial-fallback="${teamInitials(e.away)}">${e.away}</span>${teamLogoImg(e.awayLogo, "", e.away)}</div>
      </div>
      <div class="mt-scoreboard">
        <div class="mt-live"><span class="dot"></span> AO VIVO</div>
        ${hasScore ? `<div class="mt-score">${e.homeScore} - ${e.awayScore}</div>` : '<div class="mt-vs-label">vs</div>'}
        <div class="mt-period${clockClass}">${e.minuteOrPeriod}</div>
      </div>
    </div>
    ${showVisual ? '<div class="mt-pulse" id="mt-pulse"></div>' : ""}
    <div class="mt-actions">
      <div class="mt-action-btn" onclick="openTracker()"><span class="mt-action-icon"><span class="pitch-icon" style="width:26px;height:18px"></span></span>Match Tracker</div>
      <div class="mt-action-btn" onclick="openStats()"><span class="mt-action-icon">📊</span>Estatísticas</div>
    </div>`;
  if (showVisual) renderMatchHeaderVisual(e);
}

// ====================== VISUAL DO CABEÇALHO AO VIVO: mini campo OU gráfico de eventos ======================
// Pedido explícito do utilizador: se o jogo tem cobertura real de posição da bola (Sportmonks
// ballCoordinates), o cabeçalho mostra o mini campo em vez do gráfico de eventos; só cai para o
// gráfico quando não há essa cobertura para este jogo. A decisão depende de já termos recebido
// uma resposta real da API (trackerBallState.hasCoverage), não de uma suposição.
//
// O mini campo já traz o seu próprio cabeçalho embutido (relógio + equipas + placar + AO VIVO,
// ver pitchHeaderHtml) — por isso o bloco #mt-basic-header (nomes/placar separados, por cima do
// mini campo) fica escondido quando o mini campo está ativo, para não duplicar a mesma informação
// duas vezes (bug real reportado com print, marcado com um X pelo utilizador). Continua visível
// quando cai para o gráfico de eventos, que não tem esse cabeçalho próprio.
function renderMatchHeaderVisual(e) {
  const el = document.getElementById("mt-pulse");
  if (!el) return;
  const basicHeader = document.getElementById("mt-basic-header");
  const hasCoverage = trackerBallState.eventId === e.id && trackerBallState.hasCoverage;
  if (hasCoverage) {
    if (!el.classList.contains("mt-mini-pitch")) el.classList.add("mt-mini-pitch");
    if (basicHeader) basicHeader.classList.add("hidden");
    renderPitchInto(el, trackerBallState.points, e, { compact: true });
  } else {
    el.classList.remove("mt-mini-pitch");
    if (basicHeader) basicHeader.classList.remove("hidden");
    renderMatchPulseTrack(e);
    refreshMatchPulseIfNeeded(e);
  }
}

// ====================== GRÁFICO DE EVENTOS DO JOGO (alternativa sem cobertura de mini campo) ======================
// Mostra só golos/cartões/VAR reais posicionados pelo minuto (getMatchTimeline/MatchEventRow, já
// usado na aba "Eventos" das estatísticas — ver Bet62Api.getTimeline). Pedido do utilizador foi
// um "gráfico de pressão" ao estilo de uma referência visual, mas não existe nenhuma métrica de
// pressão/intensidade por minuto confirmada em nenhum provedor desta app — em vez de inventar uma
// curva, mostra-se a linha do tempo real dos eventos confirmados sobre o eixo 0'-90'+.
// A escala é dinâmica (pulseMaxMinute) para nunca "apagar"/comprimir o jogo perto do minuto 90:
// prolonga-se automaticamente para acompanhar o minuto atual real, incluindo prolongamento.
let matchPulseState = { eventId: null, events: [], fetchedAt: 0 };
// Expor para o motor 2D (tracker2d.js) — `let` em script clássico não é global por defeito;
// a referência é constante (apenas as propriedades internas são mutadas nos polls).
window.matchPulseState = matchPulseState;
const MATCH_PULSE_REFRESH_MS = 20000;
const PULSE_MARKER_ICON = { goal: "⚽", redcard: "🟥", yellowcard: "🟨", var: "📺", penalty: "🎯", goal_disallowed: "⛔" };
function currentMatchMinute(e) {
  const m = /^(\d+)/.exec(e.minuteOrPeriod || "");
  return m ? parseInt(m[1], 10) : null;
}
function pulseMaxMinute(e, events) {
  const nowMinute = currentMatchMinute(e) || 0;
  const eventsMax = events.reduce((max, ev) => Math.max(max, parseInt(ev.minute, 10) || 0), 0);
  return Math.max(90, nowMinute, eventsMax);
}
function pulsePct(minute, maxMinute) {
  return Math.max(3, Math.min(97, (minute / maxMinute) * 100));
}
function renderMatchPulseTrack(e) {
  const el = document.getElementById("mt-pulse");
  if (!el) return;
  const events = matchPulseState.eventId === e.id ? matchPulseState.events : [];
  const markers = events.filter((ev) => PULSE_MARKER_ICON[ev.kind]);
  const nowMinute = currentMatchMinute(e);
  const maxMinute = pulseMaxMinute(e, events);
  const htPct = (45 / maxMinute) * 100;
  el.innerHTML = `
    <div class="mt-pulse-track">
      <div class="mt-pulse-line"></div>
      <div class="mt-pulse-ht" style="left:${htPct}%"></div>
      ${nowMinute !== null ? `<div class="mt-pulse-now" style="left:${pulsePct(nowMinute, maxMinute)}%"></div>` : ""}
      ${markers
        .map((ev) => {
          const minute = parseInt(ev.minute, 10) || 0;
          const tooltip = `${ev.minute} ${ev.label}${ev.playerName ? ": " + ev.playerName : ""} (${ev.team})`;
          return `<div class="mt-pulse-marker ${ev.isHome ? "home" : "away"}" style="left:${pulsePct(minute, maxMinute)}%" title="${tooltip}">
            <span class="mt-pulse-icon">${PULSE_MARKER_ICON[ev.kind]}</span>
            ${ev.playerName || ev.playerPhotoUrl ? `<span class="mt-pulse-name">${playerImg(ev.playerPhotoUrl, ev.playerName)}${ev.playerName || ""}</span>` : ""}
          </div>`;
        })
        .join("")}
    </div>
    <div class="mt-pulse-labels"><span>0'</span><span>45'</span><span>${maxMinute}'</span></div>`;
}
async function refreshMatchPulseIfNeeded(e) {
  const now = Date.now();
  if (matchPulseState.eventId !== e.id) {
    matchPulseState = { eventId: e.id, events: [], fetchedAt: 0 };
  }
  if (now - matchPulseState.fetchedAt < MATCH_PULSE_REFRESH_MS) return;
  matchPulseState.fetchedAt = now;
  try {
    const { events } = await Bet62Api.getTimeline(e.id);
    if (matchPulseState.eventId !== e.id) return; // saiu deste evento entretanto
    matchPulseState.events = events || [];
    if (currentMarketEvent && currentMarketEvent.id === e.id && !trackerBallState.hasCoverage) renderMatchPulseTrack(e);
  } catch {
    /* mantém os marcadores já mostrados */
  }
}

// ====================== MATCH TRACKER (mini campo 2D) ======================
// Posição real da bola via Sportmonks ballCoordinates (GET /fixtures/{id}?include=ballCoordinates,
// ver fetchBallCoordinates em sportmonks/client.ts) — CONFIRMADO por amostra real completa colada
// pelo utilizador (fixture 19568502, Chelsea vs FC Barcelona). x=0 é a baliza de um lado, x=1 a do
// outro; y=0 a linha lateral esquerda, y=1 a direita — sem nenhum campo a dizer qual baliza é de
// qual equipa, por isso segue-se a mesma convenção já usada no resto da app (casa à esquerda,
// fora à direita, ver .mt-teams-top). Documentação confirma "disponível só para ligas
// selecionadas" — jogo sem esta tecnologia devolve lista vazia, mostrado como tal, nunca inventado.
// hasCoverage só fica true depois de recebermos uma resposta real da API com pelo menos um ponto
// para este jogo — nunca assumido antecipadamente.
let trackerBallState = { eventId: null, points: [], fetchedAt: 0, hasCoverage: false };
// 2.5s: reduz o atraso QUE NÓS acrescentamos por cima do atraso já existente na Sportmonks (a
// documentação real colada pelo utilizador confirma "slight delay of ~15 seconds" do lado deles,
// que não desaparece por pedirmos mais depressa — isto só evita somar mais espera nossa a isso).
const TRACKER_BALL_REFRESH_MS = 2500;
function openTracker() {
  document.getElementById("tracker-modal").classList.add("open");
  showTrackerPitchView();
  if (currentMarketEvent) {
    renderTrackerHeader(currentMarketEvent);
    refreshBallPositionIfNeeded(currentMarketEvent, true);
  }
}
function closeTracker() {
  document.getElementById("tracker-modal").classList.remove("open");
  // O <canvas> 2D partilhado (ver mountTracker2D em tracker2d.js) ficava preso dentro do modal —
  // reancora-o de volta ao mini campo compacto do cabeçalho, se ainda fizer sentido mostrá-lo ali.
  if (currentMarketEvent) renderMatchHeaderVisual(currentMarketEvent);
}
// Alterna Campo/Estatísticas dentro do MESMO cartão do modal (pedido explícito do utilizador, a
// partir do modelo BET62trackerpreview.html) em vez de duas telas separadas.
function showTrackerPitchView() {
  document.getElementById("tracker-btn-pitch").classList.add("is-selected");
  document.getElementById("tracker-btn-stats").classList.remove("is-selected");
  document.getElementById("tracker-pitch-wrap").classList.remove("hidden");
  document.getElementById("tracker-stats-wrap").classList.add("hidden");
}
function showTrackerStatsView() {
  document.getElementById("tracker-btn-stats").classList.add("is-selected");
  document.getElementById("tracker-btn-pitch").classList.remove("is-selected");
  document.getElementById("tracker-pitch-wrap").classList.add("hidden");
  document.getElementById("tracker-stats-wrap").classList.remove("hidden");
  if (currentMarketEvent) renderTrackerStatsPanel(currentMarketEvent);
}
// Estatísticas reais da partida dentro do próprio Tracker — reaproveita EXATAMENTE a mesma fonte
// já confirmada e usada na aba Estatísticas > Jogo (API-Football via Bet62Api.getTeamStats, ver
// TEAM_STAT_LABELS mais abaixo), só com um visual compacto próprio deste cartão. Nunca inventa
// uma linha para um tipo de estatística que a API não devolveu para este jogo.
let trackerStatsLoadedForEventId = null;
async function renderTrackerStatsPanel(e) {
  const el = document.getElementById("tracker-stats-wrap");
  if (!el) return;
  if (e.sport !== "football") {
    el.innerHTML = '<div class="empty-note">Estatísticas detalhadas disponíveis só para futebol, por agora</div>';
    return;
  }
  if (trackerStatsLoadedForEventId === e.id) return;
  el.innerHTML = '<div class="empty-note">A carregar…</div>';
  try {
    const { response } = await Bet62Api.getTeamStats(e.id);
    if (!currentMarketEvent || currentMarketEvent.id !== e.id) return; // saiu deste evento entretanto
    trackerStatsLoadedForEventId = e.id;
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
      <div class="bt-stat-team-labels"><span>${e.home.toUpperCase()}</span><span>${e.away.toUpperCase()}</span></div>
      ${rows.map((r) => trackerStatRowHtml(r.label, r.homeVal, r.awayVal)).join("")}`;
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar as estatísticas</div>';
  }
}
function trackerStatRowHtml(label, homeVal, awayVal) {
  const homeNum = parseFloat(String(homeVal).replace(",", "."));
  const awayNum = parseFloat(String(awayVal).replace(",", "."));
  const homeSafe = Number.isFinite(homeNum) ? Math.max(0, homeNum) : 0;
  const awaySafe = Number.isFinite(awayNum) ? Math.max(0, awayNum) : 0;
  const total = homeSafe + awaySafe;
  const homePct = total > 0 ? (homeSafe / total) * 100 : 50;
  const awayPct = 100 - homePct;
  return `
    <div class="bt-stat-item">
      <div class="bt-stat-values"><b>${homeVal}</b><span>${label}</span><b>${awayVal}</b></div>
      <div class="bt-stat-bar"><i style="width:${homePct}%"></i><i style="width:${awayPct}%"></i></div>
    </div>`;
}
function trackerIsLiveFootball(e) {
  return !!e && e.sport === "football" && (e._isLive || e.status === "live") && !e._finished;
}
// Iniciais reais derivadas do nome da equipa (primeiras letras das duas primeiras palavras, ou os
// 2 primeiros caracteres se só houver uma palavra) — nunca um crest/logo inventado, só texto
// extraído do nome real do evento.
function teamInitials(name) {
  if (!name) return "—";
  const words = name.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}
// Imagem de equipa: <img> com logótipo se `url` for truthy (Sportmonks image_path já vem preenchido
// em LiveEvent.homeLogo/awayLogo — ver backend), senão vazio. O onerror troca a img por um dataURI
// 1x1 transparente para não aparecer o "broken image" e o fallback visual (sigla/cor) já existente
// no container fica visível (não desaparece).
function teamLogoImg(url, size, alt) {
  if (!url) return "";
  const cls = size === "sm" ? "tlogo sm" : size === "bt" ? "tlogo bt" : "tlogo";
  const a = (alt || "").replace(/"/g, "");
  return `<img class="${cls}" src="${url}" alt="${a}" referrerpolicy="no-referrer" onerror="this.removeAttribute('src');this.style.display='none';try{const p=this.parentElement;if(p&&p.dataset.initialFallback){p.textContent=p.dataset.initialFallback}}catch(_){}">`;
}
// Imagem de jogador para linha do tempo/topscorers. Mesmo fallback: onerror limpa a imagem sem ícone
// partido. Tamanho por defeito 16px (sm), igual aos logos de equipa "sm". Retorna HTML vazio se não
// houver foto para não quebrar layouts sem suporte a jogador.
function playerImg(photoUrl, name) {
  if (!photoUrl) return "";
  const a = (name || "").replace(/"/g, "");
  return `<img class="tlogo sm" src="${photoUrl}" alt="${a}" referrerpolicy="no-referrer" onerror="this.removeAttribute('src');this.style.display='none'">`;
}
// Troca o texto (iniciais) de um .bt-team-mark (ex: #tracker-home-mark) por <img> com o logo, se
// existir. Mantém o dataset de fallback para o onerror o repôr caso o CDN devolva 404.
function applyTeamLogoToMark(el, logoUrl, fallbackName) {
  if (!el) return;
  const fallback = teamInitials(fallbackName);
  el.dataset.initialFallback = fallback;
  if (!logoUrl) { el.textContent = fallback; return; }
  el.innerHTML = `<img class="bt-team-img" src="${logoUrl}" alt="${(fallbackName||"").replace(/"/g,'')}" referrerpolicy="no-referrer" onerror="this.removeAttribute('src');this.remove();const p=this.parentElement;if(p&&p.dataset.initialFallback){p.textContent=p.dataset.initialFallback}">`;
}
// Cabeçalho do modal — placar integrado no visual pedido pelo utilizador (modelo
// BET62trackerpreview.html): marca redonda com iniciais + nome + placar dividido + relógio +
// competição. O painel do mini campo (pitchHeaderHtml) deixa de repetir esta linha dentro do
// modal (skipTeamBar) para não duplicar — mantém só a pílula de parte do jogo.
function renderTrackerHeader(e) {
  const homeEl = document.getElementById("tracker-home");
  if (!homeEl) return;
  homeEl.textContent = e.home;
  document.getElementById("tracker-away").textContent = e.away;
  applyTeamLogoToMark(document.getElementById("tracker-home-mark"), e.homeLogo, e.home);
  applyTeamLogoToMark(document.getElementById("tracker-away-mark"), e.awayLogo, e.away);
  const hasScore = e.homeScore !== undefined && e.awayScore !== undefined;
  document.getElementById("tracker-home-score").textContent = hasScore ? e.homeScore : "–";
  document.getElementById("tracker-away-score").textContent = hasScore ? e.awayScore : "–";
  document.getElementById("tracker-clock").textContent = e.minuteOrPeriod || "–";
  document.getElementById("tracker-clock-badge").classList.toggle("clock-missing", isClockMissing(e));
  document.getElementById("tracker-league").textContent = e.league || "";
}
// Pulsa o nome da equipa no placar do modal quando a bola real está na zona de perigo perto da
// baliza da OUTRA equipa (mesma lógica/disciplina de pitchHeaderHtml — zona real, nunca "posse").
function applyZonePulseToScoreboard(latest) {
  const homeEl = document.getElementById("tracker-home");
  const awayEl = document.getElementById("tracker-away");
  if (!homeEl || !awayEl) return;
  const inDanger = !!latest && ballDangerZone(latest.x) === "danger";
  homeEl.classList.toggle("zone-pulse", inDanger && latest.x >= 0.5);
  awayEl.classList.toggle("zone-pulse", inDanger && latest.x < 0.5);
}
// Chamado em todo render do Match Tracker no cabeçalho (WS/poll), independentemente de o modal
// estar aberto — o cabeçalho precisa dos mesmos dados para decidir entre mini campo e gráfico.
async function refreshBallPositionIfNeeded(e, force) {
  const modal = document.getElementById("tracker-modal");
  const modalOpen = !!modal && modal.classList.contains("open");
  if (modalOpen) renderTrackerHeader(e);
  if (!trackerIsLiveFootball(e)) {
    if (modalOpen) {
      applyZonePulseToScoreboard(null);
      const wrap = document.getElementById("tracker-pitch-wrap");
      if (wrap) wrap.innerHTML = '<div class="empty-note">Posição da bola disponível só para jogos de futebol ao vivo</div>';
    }
    return;
  }
  if (trackerBallState.eventId !== e.id) trackerBallState = { eventId: e.id, points: [], fetchedAt: 0, hasCoverage: false };
  const now = Date.now();
  if (!force && now - trackerBallState.fetchedAt < TRACKER_BALL_REFRESH_MS) {
    if (modalOpen) renderPitchInto(document.getElementById("tracker-pitch-wrap"), trackerBallState.points, e, { compact: false });
    return;
  }
  trackerBallState.fetchedAt = now;
  try {
    const { points } = await Bet62Api.getBallPosition(e.id);
    if (trackerBallState.eventId !== e.id) return; // saiu deste evento entretanto
    trackerBallState.points = points || [];
    trackerBallState.hasCoverage = !!(points && points.length);
  } catch {
    /* mantém o rasto já mostrado */
  }
  if (currentMarketEvent && currentMarketEvent.id === e.id) {
    renderMatchHeaderVisual(e);
    if (modal && modal.classList.contains("open")) {
      renderPitchInto(document.getElementById("tracker-pitch-wrap"), trackerBallState.points, e, { compact: false });
    }
  }
}
// Zona de perigo real, derivada só da coordenada x confirmada da bola (0 = baliza casa, 1 = baliza
// fora) — nunca rotulada como "posse de bola" (não existe sinal de posse instantânea confirmado em
// nenhum provedor desta app; a única stat de posse existente, "Ball Possession %", é cumulativa do
// jogo todo, não instantânea — ver TEAM_STAT_LABELS). É só "a bola está perto de que baliza agora".
function ballDangerZone(x) {
  const distToGoal = Math.min(x, 1 - x);
  if (distToGoal < 0.14) return "danger";
  if (distToGoal < 0.32) return "mid";
  return "safe";
}
// Zona de canto real: bola confirmada dentro do raio do arco de canto (extremos de x, extremos de
// y) — não finge que um canto foi marcado (não existe esse evento confirmado, ver
// MatchEventRow.kind), é só "a bola está mesmo ali agora".
const CORNER_ZONE_X = 0.045;
const CORNER_ZONE_Y = 0.09;
function nearestCorner(x, y) {
  const cx = x < 0.5 ? 0 : 1;
  const cy = y < 0.5 ? 0 : 1;
  return { cx, cy };
}
function isInCornerZone(x, y) {
  const { cx, cy } = nearestCorner(x, y);
  return Math.abs(x - cx) < CORNER_ZONE_X && Math.abs(y - cy) < CORNER_ZONE_Y;
}
// Deteta um golo NOVO comparando a contagem de eventos "goal" reais já confirmados na linha do
// tempo (matchPulseState.events, a mesma fonte da aba Eventos) com a última contagem vista — nunca
// antecipa/infere um golo a partir da posição da bola.
let trackerLastGoalCount = { eventId: null, count: 0 };
function detectNewGoal(e) {
  if (matchPulseState.eventId !== e.id) return null;
  const goals = matchPulseState.events.filter((ev) => ev.kind === "goal");
  if (trackerLastGoalCount.eventId !== e.id) {
    trackerLastGoalCount = { eventId: e.id, count: goals.length };
    return null;
  }
  if (goals.length > trackerLastGoalCount.count) {
    const latest = goals[goals.length - 1];
    trackerLastGoalCount.count = goals.length;
    return latest || null;
  }
  trackerLastGoalCount.count = goals.length;
  return null;
}
// Deriva a parte do jogo (1ª/2ª parte/prorrogação) a partir do minuto real já usado no resto da
// app (currentMatchMinute) — não é um campo confirmado à parte de nenhum provedor, é a mesma
// leitura direta que a linha "45'"/"67'" já mostrada no relógio, só arredondada às faixas normais
// de um jogo de futebol (0-45, 45-90, 90+). Nunca inventa intervalo/prorrogação sem o minuto real
// já apontar para lá.
function deriveHalfLabel(e) {
  const minute = currentMatchMinute(e);
  if (minute === null) return null;
  if (minute <= 45) return "1ª PARTE";
  if (minute <= 90) return "2ª PARTE";
  return "PRORROGAÇÃO";
}
// Cabeçalho embutido no próprio painel do mini campo (relógio + equipas + placar + AO VIVO),
// pedido explícito do utilizador com uma referência visual — cores da própria app (dourado=casa,
// branco=fora, mesma convenção já usada no gráfico de eventos), nunca as cores da imagem de
// referência. Substitui o bloco #mt-basic-header separado que ficava duplicado por cima do mini
// campo (ver renderMatchHeaderVisual).
//
// "latest" (ponto mais recente da bola, ou undefined sem cobertura) só pulsa o nome da equipa
// quando a bola está mesmo na zona de perigo real (ballDangerZone, coordenada x confirmada) —
// pedido explícito do utilizador para destacar "quem está a atacar". Pulsa a equipa que NÃO é
// dona da baliza ameaçada (ela é quem está a pressionar ali), nunca rotulado como "posse de
// bola": continua sem existir nenhum sinal de posse instantânea confirmado em nenhum provedor
// desta app — isto é só "a bola está mesmo perto de que baliza agora".
// skipTeamBar: o modal do Match Tracker agora tem o seu próprio placar rico no topo do cartão
// (.bt-scoreboard, com marca redonda + "Casa"/"Fora" + competição — ver renderTrackerHeader), por
// isso o painel do campo dentro do modal salta esta barra para não a duplicar; mantém só a
// pílula de parte do jogo. O cabeçalho compacto do topo de página (sem .bt-scoreboard) continua a
// mostrar a barra completa.
function pitchHeaderHtml(e, latest, opts) {
  const skipTeamBar = !!(opts && opts.skipTeamBar);
  const hasScore = e.homeScore !== undefined && e.awayScore !== undefined;
  const half = deriveHalfLabel(e);
  const clockClass = isClockMissing(e) ? " clock-missing" : "";
  let homePulse = "", awayPulse = "";
  if (latest && ballDangerZone(latest.x) === "danger") {
    if (latest.x < 0.5) awayPulse = " zone-pulse";
    else homePulse = " zone-pulse";
  }
  const bar = skipTeamBar
    ? ""
    : `<div class="tp-header-bar">
      <div class="tp-clock-badge${clockClass}">${e.minuteOrPeriod || "-"}</div>
      <div class="tp-team-cluster">
        <div class="tp-team-bar home${homePulse}">${teamLogoImg(e.homeLogo,"sm",e.home)}<span class="tp-team-dot"></span>${e.home}</div>
        <div class="tp-score-block">${hasScore ? `${e.homeScore} - ${e.awayScore}` : "vs"}</div>
        <div class="tp-team-bar away${awayPulse}">${e.away}${teamLogoImg(e.awayLogo,"sm",e.away)}<span class="tp-team-dot"></span></div>
      </div>
      <div class="tp-live-badge"><span class="dot"></span>AO VIVO</div>
    </div>`;
  return `${bar}${half ? `<div class="tp-period-pill">${half}</div>` : ""}`;
}
// Barra de estatísticas por baixo do campo, pedida pelo utilizador com uma referência visual —
// só mostra métricas com dado real confirmado (relógio, placar, cantos já usados no resto da app
// via e.statistics, ver redCardsHtml) e "há Xs" a partir do momento real do último pedido à API.
// Deliberadamente SEM posse de bola: não existe sinal de posse instantânea confirmado em nenhum
// provedor desta app (ver comentário de ballDangerZone acima) — mostrar isso seria inventar.
function pitchStatBarHtml(e) {
  const hasScore = e.homeScore !== undefined && e.awayScore !== undefined;
  const homeCorners = e.statistics?.home?.corners;
  const awayCorners = e.statistics?.away?.corners;
  const hasCorners = Number.isFinite(homeCorners) && Number.isFinite(awayCorners);
  const secondsAgo = trackerBallState.fetchedAt ? Math.max(0, Math.round((Date.now() - trackerBallState.fetchedAt) / 1000)) : null;
  return `<div class="tp-stat-bar">
    <div class="tp-stat-box">🕐 ${e.minuteOrPeriod || "-"}</div>
    ${hasScore ? `<div class="tp-stat-box">👕 ${e.homeScore} - ${e.awayScore}</div>` : ""}
    ${hasCorners ? `<div class="tp-stat-box">🚩 ${homeCorners}-${awayCorners} cantos</div>` : ""}
    ${secondsAgo !== null ? `<div class="tp-stat-box">🔄 há ${secondsAgo}s</div>` : ""}
  </div>`;
}

// Flash de golo — camada HTML normal por cima do <canvas> 2D (dentro do .tp-canvas-frame onde a
// bola está montada agora, ver tracker2d.js/ensureTracker2DCanvas), acionada só por um golo novo
// e confirmado na linha do tempo real. Chamada pelo motor 2D via window.showGoalFlashOverlay
// (lookup fraco, ver comentário no topo de tracker2d.js).
function showGoalFlashOverlay(goalEvent) {
  const st = typeof ensureTracker2DCanvas === "function" ? ensureTracker2DCanvas() : null;
  const frame = st && st.mountedIn;
  if (!frame) return;
  const flash = document.createElement("div");
  flash.className = "tp-goal-flash";
  flash.innerHTML = `<span class="tp-goal-net">⚽🥅</span><span>GOLO!</span>${goalEvent.playerName ? `<span class="tp-goal-player">${playerImg(goalEvent.playerPhotoUrl, goalEvent.playerName)}${goalEvent.playerName} (${goalEvent.team})</span>` : ""}`;
  frame.appendChild(flash);
  setTimeout(() => flash.remove(), 4000);
}

// Ponto de entrada partilhado entre o cabeçalho compacto (#mt-pulse) e o modal cheio
// (#tracker-pitch-wrap). Constrói o "chrome" HTML (cabeçalho + barra de estatísticas) em
// torno de um .tp-canvas-frame vazio, e usa o MESMO <canvas> partilhado do motor 2D
// (tracker2d.js), reancorando-o de cabeçalho ↔ modal tal como o 3D fazia antes.
function renderPitchInto(el, points, e, opts) {
  if (!el) return;
  const compact = !!(opts && opts.compact);
  const latest = points.length ? points[0] : null;
  if (!compact) applyZonePulseToScoreboard(latest);
  const header = pitchHeaderHtml(e, latest, { skipTeamBar: !compact });

  if (!points.length) {
    el.innerHTML = `<div class="tp-panel">${header}<div class="empty-note">${compact ? "Sem dados de posição da bola" : "Sem dados de posição da bola disponíveis para este jogo"}</div></div>`;
    return;
  }

  el.innerHTML = `<div class="tp-panel">${header}<div class="tp-canvas-frame"></div>${pitchStatBarHtml(e)}</div>`;
  const frame = el.querySelector(".tp-canvas-frame");
  // Motor 2D é síncrono (não há bundle para carregar) — pinta imediatamente.
  // (frame pode já ter sido montado por outro caller — o mount é idempotente.)
  mountTracker2D(frame);
  updateTracker2DFromPoints(e, points, compact);
}

// ====================== ESTATÍSTICAS (Margens de Vitória / H2H / Classificação) ======================
// Pedido explícito do utilizador (referência visual de uma casa de apostas grande): ao abrir
// Estatísticas, os mercados/odds desaparecem e a área central passa a mostrar só as estatísticas
// — já não é um modal/overlay por cima da página, é a própria página de mercado a trocar de
// conteúdo (ver #market-stats-inline em index.html).
function openStats() {
  if (!currentMarketEvent) return;
  document.getElementById("featured-combo").classList.add("hidden");
  document.getElementById("market-filter-bar").classList.add("hidden");
  document.getElementById("market-groups").classList.add("hidden");
  document.getElementById("market-stats-inline").classList.remove("hidden");
  switchStatsTab("prob");
}
function closeStats() {
  document.getElementById("market-stats-inline").classList.add("hidden");
  document.getElementById("featured-combo").classList.remove("hidden");
  document.getElementById("market-filter-bar").classList.remove("hidden");
  document.getElementById("market-groups").classList.remove("hidden");
}
function switchStatsTab(tab) {
  document.getElementById("stats-tab-prob").classList.toggle("active", tab === "prob");
  document.getElementById("stats-tab-h2h").classList.toggle("active", tab === "h2h");
  document.getElementById("stats-tab-teamstats").classList.toggle("active", tab === "teamstats");
  document.getElementById("stats-tab-table").classList.toggle("active", tab === "table");
  document.getElementById("stats-tab-topscorers").classList.toggle("active", tab === "topscorers");
  document.getElementById("stats-tab-form").classList.toggle("active", tab === "form");
  document.getElementById("stats-tab-timeline").classList.toggle("active", tab === "timeline");
  document.getElementById("stats-body-prob").classList.toggle("hidden", tab !== "prob");
  document.getElementById("stats-body-h2h").classList.toggle("hidden", tab !== "h2h");
  document.getElementById("stats-body-teamstats").classList.toggle("hidden", tab !== "teamstats");
  document.getElementById("stats-body-table").classList.toggle("hidden", tab !== "table");
  document.getElementById("stats-body-topscorers").classList.toggle("hidden", tab !== "topscorers");
  document.getElementById("stats-body-form").classList.toggle("hidden", tab !== "form");
  document.getElementById("stats-body-timeline").classList.toggle("hidden", tab !== "timeline");
  if (tab === "prob") renderWinProbability(currentMarketEvent);
  if (tab === "h2h") renderH2H(currentMarketEvent);
  if (tab === "teamstats") renderTeamStats(currentMarketEvent);
  if (tab === "table") renderStandings(currentMarketEvent);
  if (tab === "topscorers") renderTopscorers(currentMarketEvent);
  if (tab === "form") renderTeamForm(currentMarketEvent);
  if (tab === "timeline") renderTimeline(currentMarketEvent);
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

// Linha de comparação em barra dupla (casa à esquerda em --red, fora à direita em --gold) — ao
// estilo Golos/xG/Posse de bola/Remates de uma referência visual pedida pelo utilizador, mas com
// a paleta própria da app em vez das cores da referência ("não quero com as cores que estão aí").
// Extrai o número de dentro de valores como "55%"/"12" para calcular a proporção da barra; "-"/
// sem número em nenhum dos dois lados cai numa barra 50/50 neutra em vez de esconder a linha.
function jogoStatRowHtml(label, homeVal, awayVal) {
  const homeNum = parseFloat(String(homeVal).replace(",", "."));
  const awayNum = parseFloat(String(awayVal).replace(",", "."));
  const homeSafe = Number.isFinite(homeNum) ? Math.max(0, homeNum) : 0;
  const awaySafe = Number.isFinite(awayNum) ? Math.max(0, awayNum) : 0;
  const total = homeSafe + awaySafe;
  const homePct = total > 0 ? (homeSafe / total) * 100 : 50;
  const awayPct = 100 - homePct;
  return `
    <div class="jogo-stat-row">
      <div class="jogo-stat-values">
        <span class="jogo-val home">${homeVal}</span>
        <span class="jogo-stat-label">${label}</span>
        <span class="jogo-val away">${awayVal}</span>
      </div>
      <div class="jogo-bar-track">
        <div class="jogo-bar-home" style="width:${homePct}%"></div>
        <div class="jogo-bar-away" style="width:${awayPct}%"></div>
      </div>
    </div>`;
}

// Estatísticas completas por equipa via API-Football (só futebol — a API-Football não cobre
// outros desportos).
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
    el.innerHTML = rows.map((r) => jogoStatRowHtml(r.label, r.homeVal, r.awayVal)).join("");
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
          <span class="st-rank">#</span><span class="st-team">Equipa</span><span class="st-pts">Pts</span><span class="st-pj">J</span><span class="st-gd">SG</span><span class="st-form"></span>
        </div>
        ${standings
          .map(
            (r) => `
          <div class="standings-row${r.team === e.home || r.team === e.away ? " highlight" : ""}"${standingsZoneStyle(r.zoneLabel)}>
            <span class="st-rank">${r.rank}</span><span class="st-team">${r.team}</span><span class="st-pts">${r.points}</span><span class="st-pj">${r.played}</span><span class="st-gd">${r.goalsDiff > 0 ? "+" : ""}${r.goalsDiff}</span><span class="st-form">${Array.isArray(r.form) ? r.form.map(formDot).join("") : ""}</span>
          </div>`
          )
          .join("")}
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar a classificação</div>';
  }
}

// Cor da faixa lateral por zona da classificação (Sportmonks `rule.type.name`, ex: "CONMEBOL
// Libertadores", "CONMEBOL Sudamericana", "Relegation") — reconhecimento por palavra-chave, mesmo
// padrão heurístico já usado em MARKET_FILTER_CATEGORIES abaixo. Linhas sem zona (`zoneLabel`
// undefined, meio da tabela) ficam sem faixa nenhuma.
function standingsZoneStyle(zoneLabel) {
  if (!zoneLabel) return "";
  let color = null;
  if (/relegation/i.test(zoneLabel)) color = "var(--red)";
  else if (/libertadores/i.test(zoneLabel)) color = "var(--gold)";
  else if (/sudamericana/i.test(zoneLabel)) color = "#3b82f6";
  return color ? ` style="border-left:3px solid ${color}"` : "";
}

// Bolinha de forma recente (Sportmonks, "W"/"D"/"L") — só aparece quando a fonte devolve o campo
// (Sportmonks); jogos da API-Football continuam sem esta coluna, exatamente como antes.
function formDot(letter) {
  const cls = letter === "W" ? "st-form-dot-w" : letter === "L" ? "st-form-dot-l" : "st-form-dot-d";
  return `<span class="st-form-dot ${cls}"></span>`;
}

// Artilheiros da época via Sportmonks (só jogos da Sportmonks — ver GET /events/:id/topscorers)
// — sem equivalente para jogos da Pulsescore/API-Football, esses devolvem lista vazia do backend
// e caem na mensagem "sem dados" abaixo, nunca um erro.
let topscorersLoadedForEventId = null;
async function renderTopscorers(e) {
  const el = document.getElementById("stats-body-topscorers");
  if (e.sport !== "football") {
    el.innerHTML = '<div class="empty-note">Artilheiros disponíveis só para futebol, por agora</div>';
    return;
  }
  if (topscorersLoadedForEventId === e.id) return;
  el.innerHTML = '<div class="empty-note">A carregar…</div>';
  try {
    const { topscorers } = await Bet62Api.getTopscorers(e.id);
    topscorersLoadedForEventId = e.id;
    if (!topscorers || !topscorers.length) {
      el.innerHTML = '<div class="empty-note">Sem artilheiros disponíveis para esta competição</div>';
      return;
    }
    el.innerHTML = `
      <div class="standings-table">
        <div class="standings-row standings-header">
          <span class="st-rank">#</span><span class="st-team">Jogador</span><span class="st-pts">Golos</span>
        </div>
        ${topscorers
          .map(
            (r) => `
          <div class="standings-row">
            <span class="st-rank">${r.rank}</span><span class="st-team">${playerImg(r.playerPhoto, r.playerName)}${teamLogoImg(r.teamLogo, "sm", r.team)} ${r.playerName} <span style="color:var(--muted)">— ${r.team}</span></span><span class="st-pts">${r.goals}</span>
          </div>`
          )
          .join("")}
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar os artilheiros</div>';
  }
}

// Forma recente/próximos jogos das duas equipas via Sportmonks (só jogos da Sportmonks — ver GET
// /events/:id/form) — mesma disciplina das abas acima: jogos da Pulsescore vêm com home/away
// null do backend e caem na mensagem "sem dados", nunca um erro.
let teamFormLoadedForEventId = null;
function formBadge(result) {
  if (!result) return '<span class="form-badge form-badge-none">?</span>';
  return `<span class="form-badge form-badge-${result}">${result}</span>`;
}
function renderTeamFormColumn(name, form) {
  if (!form || (!form.recent.length && !form.upcoming.length)) {
    return `<div class="form-team"><div class="form-team-name">${name}</div><div class="empty-note">Sem dados de forma</div></div>`;
  }
  const badges = form.recent.map((m) => formBadge(m.result)).join("");
  const wins = form.recent.filter((m) => m.result === "V").length;
  const draws = form.recent.filter((m) => m.result === "E").length;
  const losses = form.recent.filter((m) => m.result === "D").length;
  const totalResults = wins + draws + losses;
  const summaryHtml = totalResults
    ? `
    <div class="forma-summary">
      <div class="forma-summary-counts"><span class="fc-v">${wins}V</span><span class="fc-e">${draws}E</span><span class="fc-d">${losses}D</span></div>
      <div class="forma-bar-track">
        <div class="forma-bar-seg v" style="width:${(wins / totalResults) * 100}%"></div>
        <div class="forma-bar-seg e" style="width:${(draws / totalResults) * 100}%"></div>
        <div class="forma-bar-seg d" style="width:${(losses / totalResults) * 100}%"></div>
      </div>
    </div>`
    : "";
  const recentRows = form.recent
    .map(
      (m) => `
      <div class="standings-row">
        <span class="st-team">${formBadge(m.result)} ${m.isHome ? "vs" : "@"} ${m.opponent}</span><span class="st-pts">${m.score ?? ""}</span>
      </div>`
    )
    .join("");
  const upcomingRows = form.upcoming
    .map(
      (m) => `
      <div class="standings-row">
        <span class="st-team">${m.isHome ? "vs" : "@"} ${m.opponent}</span><span class="st-pj">${new Date(m.date).toLocaleDateString("pt-PT", { timeZone: BET62_TIMEZONE })}</span>
      </div>`
    )
    .join("");
  return `
    <div class="form-team">
      <div class="form-team-name">${name} <span class="form-badges">${badges}</span></div>
      ${summaryHtml}
      <div class="standings-table">${recentRows || '<div class="empty-note">Sem jogos recentes</div>'}</div>
      ${form.upcoming.length ? `<div class="form-section-label">Próximos jogos</div><div class="standings-table">${upcomingRows}</div>` : ""}
    </div>`;
}
async function renderTeamForm(e) {
  const el = document.getElementById("stats-body-form");
  if (e.sport !== "football") {
    el.innerHTML = '<div class="empty-note">Forma disponível só para futebol, por agora</div>';
    return;
  }
  if (teamFormLoadedForEventId === e.id) return;
  el.innerHTML = '<div class="empty-note">A carregar…</div>';
  try {
    const { home, away } = await Bet62Api.getTeamForm(e.id);
    teamFormLoadedForEventId = e.id;
    if (!home && !away) {
      el.innerHTML = '<div class="empty-note">Sem dados de forma disponíveis para este jogo</div>';
      return;
    }
    el.innerHTML = renderTeamFormColumn(e.home, home) + renderTeamFormColumn(e.away, away);
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar a forma das equipas</div>';
  }
}

// Linha do tempo do jogo (golos/cartões/substituições/revisões VAR) via Sportmonks (só jogos da
// Sportmonks — ver GET /events/:id/timeline) — sem equivalente para jogos da Pulsescore, esses
// devolvem lista vazia do backend e caem na mensagem "sem dados" abaixo, nunca um erro.
let timelineLoadedForEventId = null;
const TIMELINE_EVENT_ICON = { goal: "⚽", yellowcard: "🟨", redcard: "🟥", substitution: "🔄", var: "📺", penalty: "🎯", goal_disallowed: "⛔", other: "•" };
async function renderTimeline(e) {
  const el = document.getElementById("stats-body-timeline");
  if (e.sport !== "football") {
    el.innerHTML = '<div class="empty-note">Eventos disponíveis só para futebol, por agora</div>';
    return;
  }
  if (timelineLoadedForEventId === e.id) return;
  el.innerHTML = '<div class="empty-note">A carregar…</div>';
  try {
    const { events } = await Bet62Api.getTimeline(e.id);
    timelineLoadedForEventId = e.id;
    if (!events || !events.length) {
      el.innerHTML = '<div class="empty-note">Sem eventos disponíveis para este jogo</div>';
      return;
    }
    el.innerHTML = `
      <div class="timeline-list">
        ${events
          .map(
            (ev) => `
          <div class="timeline-row">
            <span class="timeline-minute">${ev.minute}</span>
            <span class="timeline-icon">${TIMELINE_EVENT_ICON[ev.kind] || "•"}</span>
            <span class="timeline-text">${ev.label}${
              ev.playerName || ev.playerPhotoUrl
                ? `: ${playerImg(ev.playerPhotoUrl, ev.playerName)}<span>${ev.playerName || ""}</span>`
                : ""
            }${
              ev.relatedPlayerName || ev.relatedPlayerPhotoUrl
                ? ` <span style="color:var(--muted)">↔ ${playerImg(ev.relatedPlayerPhotoUrl, ev.relatedPlayerName)}<span>${ev.relatedPlayerName || ""}</span></span>`
                : ""
            } <span style="color:var(--muted)">(${ev.team})</span></span>
          </div>`
          )
          .join("")}
      </div>`;
  } catch {
    el.innerHTML = '<div class="empty-note">Não foi possível carregar os eventos</div>';
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
    // ==================== PRIORIDADE DE MATCH ====================
    // Regra IMPORTANTE: .find() devolve o PRIMEIRO que bater. Por isso os mercados mais
    // específicos (menos prováveis de falso positivo) vêm PRIMEIRO. Ordem final do user em
    // "Todos": Resultado, Ambas Marcam, Mais/Menos, Handicap, 1ºT, 2ºT, Placar Exato,
    // Escanteios, Cartões, Marcador, Especiais (catch-all).
    //
    // 🚨 REGRAS ANTI-FALSO POSITIVO 🚨
    // Nomes como "Full Time Result HT/FT" ou "Match Odds (1st Half Available)" NÃO PODEM ser
    // classificados como "1º Tempo" por terem a palavra "half" no texto — isso era o bug raiz
    // que fazia Handicap/Cartões aparecer ANTES de Resultado no topo da lista.
    // Para combater:
    //   1. "Resultado" vem 1º na lista de categorias; regex inclui menções explícitas a
    //      "Full Time"/"FT"/"Match Odds"/"1x2"/"3 Way"/"Winner"/"Double Chance"/"DNB" —
    //      a maioria destes SÃO o mercado principal.
    //   2. Regexes de "1º Tempo" / "2º Tempo" REJEITAM a string se ela mencionar
    //      explicitamente "Full Time", "FT", "1x2", "Match Winner", "3 Way", "Result",
    //      "Moneyline", "Draw No Bet", "Double Chance", "Both Teams", "Correct Score" em
    //      conjunto com "half" (ou seja, o nome é um mercado "Full Time Result HT/FT" — o
    //      "half" ali é só info adicional, não é um mercado de primeiro tempo).
    //   3. "Ambas Marcam", "Mais/Menos", "Handicap", "Placar Exato" são testados antes dos
    //      períodos também, por serem categorias principais.
    { label: "Resultado", test: (m) => /match odds|\b1x2\b|to win\b|match winner|\bwinner\b|double chance|draw no bet|\bdnb\b|full time result|full.?time.?1x2|ft\s*result|3.?way|money.?line|three.?way|resultado\s*final|tempo\s*inteiro/i.test(m) },
    { label: "Ambas Marcam", test: (m) => /both teams to score|\bbtts\b|both to score|ambas?\s+(marcam|equipas?\s+marcam)/i.test(m) },
    { label: "Mais/Menos", test: (m) => /over\/?under|total (goals|points|games|runs|corners|cards)|\bo\/u\b|mais\s*\/?\s*menos/i.test(m) },
    { label: "Handicap", test: (m) => /handicap|\bspread\b|asian handicap|\bah\b/i.test(m) },
    { label: "1º Tempo", test: (m) => {
      const s = String(m ?? "");
      if (!/1st half|first half|half.?time|\bht\b|\b1t\b/i.test(s)) return false;
      if (/(full time|\bft\b|\b1x2\b|match winner|3.?way|three.?way|\bresult\b|money.?line|draw no bet|double chance|both teams|correct score|btts)/i.test(s)) return false;
      return true;
    }},
    { label: "2º Tempo", test: (m) => {
      const s = String(m ?? "");
      if (!/2nd half|second half|\b2ht\b|\b2t\b/i.test(s)) return false;
      if (/(full time|\bft\b|\b1x2\b|match winner|3.?way|three.?way|\bresult\b|money.?line|draw no bet|double chance|both teams|correct score|btts)/i.test(s)) return false;
      return true;
    }},
    { label: "Placar Exato", test: (m) => /correct score|exact score|placar\s*exato|resultado\s*exato/i.test(m) },
    { label: "Escanteios", test: (m) => /\bcorner|\bcantos?\b/i.test(m) },
    { label: "Cartões", test: (m) => /\bcard|booking|cart[õo]e?s/i.test(m) },
    { label: "Marcador", test: (m) => /goalscorer|\bscorer\b|first to score|last to score|to score first|to score last|player.*(to score|goals)|marcad(or|ora)/i.test(m) },
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

// Ordem de EXIBIÇÃO dos chips de futebol na barra de filtros — pedido explícito do utilizador
// ("Todos, Bet Builder, Resultado, Ambas Marcam, Mais/menos, handicap, 1T, 2T, Placar Exatos,
// Escanteio, Cartões, Marcador, Especial"). DIFERENTE da ordem em MARKET_FILTER_CATEGORIES.football
// acima, que é a ordem de CLASSIFICAÇÃO (tem de manter "1º Tempo"/"2º Tempo" antes dos outros, para
// "1st Half Corners" cair em "1º Tempo" e não em "Escanteios" — ver comentário de
// MARKET_FILTER_CATEGORIES). Esta lista só decide a posição dos chips, nunca a prioridade de
// classificação — tem de ter exatamente os mesmos rótulos que MARKET_FILTER_CATEGORIES.football.
const FOOTBALL_FILTER_DISPLAY_ORDER = [
  "Resultado",
  "Ambas Marcam",
  "Mais/Menos",
  "Handicap",
  "1º Tempo",
  "2º Tempo",
  "Placar Exato",
  "Escanteios",
  "Cartões",
  "Marcador",
  "Especiais",
];

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
  // "To Qualify" — CONFIRMADO numa amostra real da Sportmonks (Bodø/Glimt vs NEC, eliminatória
  // europeia a duas mãos): quem passa à ronda seguinte, distinto de "Resultado Final" (quem ganha
  // ESTE jogo) — teste antes desse, para não cair lá por engano.
  if (/to qualify/i.test(m)) return "Vencedor da Eliminatória";
  // "full.?time" (não só "full time") — confirmado numa amostra real da Sportmonks em produção:
  // o mercado principal (1X2) chama-se "Fulltime Result", uma só palavra, sem espaço.
  if (/match odds|\b1x2\b|to win|winner|money.?line|full.?time result|3.?way|match winner/i.test(m)) return "Resultado Final";
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
//
// P3 — RELAXAMENTO 2026-08-26 (antes era EVERY 100% das labels, 1 label má → nome bruto).
// Motivo: Sportmonks frequentemente manda 1 label de 10 num formato ligeiramente diferente
// (ex: "1 / X" com espaços, "1:0" em vez de "1-0", nomes de equipa com hífen, etc.). A antiga
// validação EVERY era demasiado conservadora e fazia TODO o mercado aparecer em inglês por 1
// exceção. Novo comportamento: pelo menos 75% das labels + pelo menos 2 labels válidas.
// Exceção: categorias de 2/3 seleções (BTTS, 1X2, Empate Anula Aposta) mantêm 100% — são tão
// poucas que uma label errada muda totalmente o sentido.
function countMatches(labels, predicate) {
  let n = 0;
  for (const l of labels) if (predicate(l)) n++;
  return n;
}
const MAJORITY_RATIO = 0.75;
function majorityMatches(labels, predicate) {
  if (!labels.length) return true;
  const hits = countMatches(labels, predicate);
  return hits >= Math.max(2, Math.ceil(labels.length * MAJORITY_RATIO));
}
// P4 — Normaliza formatos de placar exato para o padrão "X-Y" antes de regex.
// Formatos vistos na prática: "1-0" (padrão), "1:0" (Sportmonks), "1 0" (espaço), "1–0" (en-dash),
// "1—0" (em-dash), "1x0" (letra x), "1.X" (mal formado) → todos viram "1-0".
function normalizeCorrectScoreLabel(raw) {
  return String(raw)
    .trim()
    .replace(/\s+/g, "")
    .replace(/[:–—xX.]/g, "-")
    .replace(/-+/g, "-");
}
function isCorrectScoreFormat(raw) {
  return /^\d+-\d+$/.test(normalizeCorrectScoreLabel(raw));
}
// Helper para Home/Away com optional handicap (P1 já formatou no backend Sportmonks, mas
// Pulsescore por vezes envia "Home -1.5" ou "Away +1"; manter compatível e também aceitar
// nomes próprios de equipa (full match).
function isHdaSide(l, homeL, awayL) {
  const sideWords = /^(1|2|home|away|casa|fora)(\s|$|[+-])/i.test(l);
  const isTeam = (homeL && l === homeL) || (awayL && l === awayL);
  return sideWords || isTeam;
}
// Dupla Hipótese: formatos compactos ("1x", "X2"), "Equipa or/and Equipa", "Equipa + Empate"
// (forma menos frequente mas comum em ligas menores).
function isDoubleChanceFormat(l) {
  const compact = l.replace(/\s+/g, "").toLowerCase();
  if (["1x", "x1", "x2", "2x", "12"].includes(compact)) return true;
  if (/^.+\s+(and|or|e|ou)\s+.+$/i.test(l)) return true;
  if (/^(.+)\s*\+\s*(draw|empate)$/i.test(l)) return true;
  return false;
}

function marketSelectionsLookPlausible(basePt, selectionLabels, home, away) {
  if (!selectionLabels || !selectionLabels.length) return true; // nada para validar
  const norm = (s) => String(s).trim().toLowerCase();
  const labels = selectionLabels.map(norm);
  const homeL = home ? norm(home) : null;
  const awayL = away ? norm(away) : null;

  // — Categorias pequenas (2–3 seleções): mantemos 100% porque uma label errada destrói o sentido —
  if (basePt === "Ambas as Equipas Marcam" || basePt === "Haverá Tie-Break") {
    return labels.every((l) => /^(yes|sim|no|não|nao)$/.test(l));
  }
  if (basePt === "Empate Anula Aposta") {
    return labels.length === 2 && labels.every((l) => isHdaSide(l, homeL, awayL) && !/x|draw|tie|empate/i.test(l));
  }
  if (basePt === "Resultado Final" || basePt === "Resultado (Prolongamento)") {
    // 1X2 continua 100% e 3 vias c/ empate — é o mercado mais importante do boletim, não arriscamos.
    const hdaWords = (l) => /^(1|x|2|home|away|draw|tie|empate|casa|fora)$/.test(l) || l === homeL || l === awayL;
    const hasDraw = labels.some((l) => ["x", "draw", "tie", "empate"].includes(l));
    return labels.length >= 3 && hasDraw && labels.every(hdaWords);
  }

  // — Categorias numerosas (≥4+ labels): maioria 75% min 2 matches —
  if (basePt === "Cantos Ímpar/Par" || basePt === "Cartões Ímpar/Par" || basePt === "Golos Ímpar/Par") {
    return majorityMatches(labels, (l) => /^(odd|even|ímpar|impar|par)$/.test(l));
  }
  if (basePt === "Resultado Exato" || basePt === "Resultado Exato (Prolongamento)") {
    return majorityMatches(labels, isCorrectScoreFormat);
  }
  if (basePt === "Dupla Hipótese") {
    return majorityMatches(labels, isDoubleChanceFormat);
  }
  if (basePt === "Total da Equipa" || /^mais\/menos de/i.test(basePt)) {
    return majorityMatches(labels, (l) => /\b(over|under|mais|menos)\b/.test(l));
  }
  return true; // sem vocabulário fixo confirmado — sem validação adicional
}

// `line` (linha numérica de Handicap/Total — ex: -1.5, 2.5) é opcional e só passado por quem já a
// tem à mão (ver LiveOdds.line em types.ts). Necessário porque a Pulsescore sempre embutia esse
// número em texto — no nome bruto do mercado (ex: "Handicap +1.5", capturado pelo regex do
// Over/Under acima) ou na própria seleção (ex: "Home -1.5", tratado em translateSelectionLabel) —
// mas a Sportmonks manda a linha SÓ no campo numérico separado, nunca em texto nenhum. Sem isto,
// vários jogos do mesmo mercado com linhas diferentes (ex: Handicap -1, Handicap +2, Cantos
// Mais/Menos 8.5, Mais/Menos 9.5...) ficavam todos com o cabeçalho idêntico e pareciam
// duplicados/errados — reportado pelo utilizador como "tudo com valores errados".
// Rótulos genéricos que cobrem VÁRIOS nomes brutos distintos (ex: cantos por equipa, por parte,
// handicap de cantos — tudo o que não bateu numa regra mais específica cai neste balde). Mostrar
// só "Cantos" repetido várias vezes sem forma de os distinguir foi reportado pelo utilizador
// ("temos lá vários nomes de Cantos mas não temos o nome do canto específico") — junta-se o nome
// bruto ao lado até haver uma amostra real que permita uma tradução mais específica para cada um.
const GENERIC_AMBIGUOUS_LABELS = new Set(["Cantos", "Total de Cantos", "Total de Cartões"]);

function translateMarketDisplayName(rawName, sport, selectionLabels, home, away, line) {
  if (!rawName) return rawName;
  const base = translateMarketBaseName(rawName, sport);
  const plausible = base && marketSelectionsLookPlausible(base, selectionLabels, home, away);
  let name = plausible ? base + extractPeriodSuffix(rawName) : rawName; // não reconhecido/implausível — mantém o nome original
  if (plausible && GENERIC_AMBIGUOUS_LABELS.has(base) && rawName.toLowerCase() !== base.toLowerCase()) {
    name = `${name} — ${rawName}`;
  }
  return typeof line === "number" && !/\d/.test(name) ? `${name} (${line})` : name;
}

const SELECTION_WORD_MAP = {
  home: "Casa",
  away: "Fora",
  draw: "Empate",
  tie: "Empate",
  // "1"/"X"/"2" — rótulos CONFIRMADOS do mercado principal em Ao Vivo (Sportmonks, endpoint
  // /odds/inplay/fixtures/{id}, ver comentário de HOME_DRAW_AWAY_PRIORITY em sportmonks/client.ts
  // no backend), diferentes de "Home"/"Draw"/"Away" usados no pré-jogo — sem esta tradução
  // ficavam a aparecer como "1"/"X"/"2" em vez de "Casa"/"Empate"/"Fora" como o resto da app.
  1: "Casa",
  x: "Empate",
  2: "Fora",
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
  // Dupla Hipótese: rótulos reais vêm como "<Equipa> and Draw" / "<Equipa1> and <Equipa2>"
  // (Pulsescore, confirmado) ou "<Equipa> or Draw" (Sportmonks, confirmado numa amostra real de
  // produção: "Abha or Draw") — só a palavra de ligação ("and"→"e"/"or"→"ou") e "Draw"→"Empate"
  // são traduzidos, os nomes das equipas (não vocabulário fixo) passam exatamente como vieram.
  const doubleChanceMatch = trimmed.match(/^(.+?)\s+(and|or)\s+(.+)$/i);
  if (doubleChanceMatch) {
    const side = (s) => (/^draw$/i.test(s) ? "Empate" : s);
    const connector = doubleChanceMatch[2].toLowerCase() === "or" ? "ou" : "e";
    return `${side(doubleChanceMatch[1])} ${connector} ${side(doubleChanceMatch[3])}`;
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
  // Futebol usa a ordem de EXIBIÇÃO pedida pelo utilizador (FOOTBALL_FILTER_DISPLAY_ORDER),
  // independente da ordem de CLASSIFICAÇÃO em categories — ver comentário nas duas constantes.
  labels.push(...(e.sport === "football" ? FOOTBALL_FILTER_DISPLAY_ORDER : categories.map((c) => c.label)));
  if (e.sport === "football") labels.push(FOOTBALL_CATCHALL_LABEL);
  el.innerHTML = labels
    .map((label) =>
      label === BET_BUILDER_LABEL
        ? `<div class="mf-chip mf-chip-bet-builder ${selectedMarketFilter === label ? "active" : ""}" onclick='selectMarketFilter(${attrJson(label)})'><i class="fas fa-database"></i> ${label}</div>`
        : `<div class="mf-chip ${(selectedMarketFilter ?? "Todos") === label ? "active" : ""}" onclick='selectMarketFilter(${attrJson(label)})'>${label}</div>`
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
// IMPORTANTE 2026-08-26 — ESTA FUNÇÃO NUNCA PODE LANÇAR.
// Classificar mercados é uma operação de display; se uma regex rebentar por marketName ser
// null/undefined/objeto mal formado, a página de futebol fica "carregando infinito" (loading
// spinner nunca fecha). Coerção String() + try/catch garante fallback limpo para categoria.
function classifyMarket(sport, marketName) {
  const categories = MARKET_FILTER_CATEGORIES[sport];
  if (!categories) return null;
  const s = String(marketName ?? "");
  try {
    const match = categories.find((c) => c.test(s));
    if (match) return match.label;
  } catch {
    // anomalia: regex rebentou ou categoria tem erro sintático. Fallback silencioso —
    // melhor mostrar em "Especiais" (football) / sem categoria do que parar a página.
  }
  return sport === "football" ? FOOTBALL_CATCHALL_LABEL : null;
}
// Devolve só os grupos de mercado que pertencem à categoria escolhida (ou todos, sem filtro
// selecionado).
// Garantia anti-crash: se e.odds for null/undefined (evento ainda sem odds em deploy), retorna []
// em vez de throw "Cannot read properties of undefined (reading 'filter')".
function filterMarketGroups(e) {
  if (!e.odds || !Array.isArray(e.odds)) return [];
  if (!selectedMarketFilter) return e.odds;
  if (!MARKET_FILTER_CATEGORIES[e.sport]) return e.odds;
  return e.odds.filter((g) => classifyMarket(e.sport, g && g.market) === selectedMarketFilter);
}

// Linha de seleções de UM mercado bruto (`group`) — extraído do antigo renderMarketGroups() para
// ser reutilizado tanto em mercados normais (uma linha) como em cada linha de um mercado
// Mais/Menos/Handicap fundido (`withLine`, ver buildMarketDisplayGroups abaixo). Cada botão
// continua a submeter o `group.market`/`label`/`odd` EXATOS de origem — a fusão visual nunca
// sintetiza um mercado novo, só reorganiza como os mercados reais aparecem no ecrã.
function normalSelectionRowHtml(e, group, isLive, withLine) {
  const rows = orderedSelectionEntries(group.selections)
    .map(([label, sel]) => {
      const labelPt = withLine ? overUnderButtonLabel(group.market, group.line, label, translateSelectionLabel(label)) : translateSelectionLabel(label);
      const selkey = `${group.market}||${label}`;
      const oddVal = Number.isFinite(sel.odd) ? Number(sel.odd) : 0;
      // Seleção suspensa pelo bookmaker (isActive:false — ex: durante uma revisão VAR ou logo
      // após um penálti/cartão, ver LiveSelection em types.ts): mostra-se visível mas sem onclick,
      // em vez de desaparecer ou continuar clicável com uma odd desatualizada. Mesmo tratamento
      // para uma odd inválida (ex: NaN de uma transição de deploy com JS antigo em cache) — nunca
      // deixar clicar numa aposta sem preço válido.
      if (!sel.isActive || !Number.isFinite(sel.odd)) {
        return `<div class="selection-btn suspended" data-selkey="${attrJson(selkey)}" data-odd="${oddVal}">
          <span class="sel-label">${labelPt}</span><span class="sel-odd">Suspenso</span>
        </div>`;
      }
      const key = `${e.id}|${group.market}|${label}`;
      const picked = betslipSelections.has(key);
      const selection = { eventId: e.id, sport: e.sport, market: group.market, selection: label, odd: sel.odd, home: e.home, away: e.away, league: e.league, line: group.line };
      // Setas de subida/descida só em Ao Vivo — no pré-jogo o valor não costuma mudar ao ponto de
      // justificar o indicador, e não foi pedido para essa página.
      const arrow = isLive ? oddsArrowHtml(key, sel.odd) : "";
      return `<div class="selection-btn ${picked ? "picked" : ""}" data-selkey="${attrJson(selkey)}" data-odd="${oddVal}" onclick='toggleSelection(${attrJson(key)}, ${attrJson(selection)})'>
        <span class="sel-label">${labelPt}</span><span class="sel-odd">${sel.odd.toFixed(2)}${arrow}</span>
      </div>`;
    })
    .join("");
  return `<div class="selection-row">${rows}</div>`;
}

// Rótulo do botão de um mercado Mais/Menos/Handicap fundido (várias linhas do MESMO mercado bruto
// juntas num só acordeão, ver buildMarketDisplayGroups) — pedido explícito do utilizador: "dentro
// das odds aparece Mais de 0.5" em vez de só "MAIS DE" com a linha só no título de fora (que deixa
// de existir quando há mais do que uma linha). Quando o rótulo da seleção já traz o número (ex:
// "Over 2.5", ou "Home -1.5" de handicap — ambos via translateSelectionLabel), não duplica.
//
// Assinatura multi-modos (seguro, aceita 2 args antigos ou 4 args novos):
//   overUnderButtonLabel(rawLabelOrMarket, lineOrUndefined, ?rawLabel, ?translatedLabel)
// - MODO 1 (antigo, compatibilidade): 2 args, 1º arg é a raw label, 2º é line
// - MODO 2 (novo, para patch incremental): 4 args, 1º arg = market name (se necessário),
//   2º arg = line, 3º arg = raw label, 4º arg = label já traduzida (precalculada, performance)
function overUnderButtonLabel(...args) {
  let marketOrLabel, line, rawLabel, translated;
  if (args.length === 2) {
    marketOrLabel = args[0]; line = args[1];
    rawLabel = marketOrLabel;
    translated = translateSelectionLabel(rawLabel);
  } else {
    marketOrLabel = args[0]; line = args[1]; rawLabel = args[2]; translated = args[3];
  }
  if (typeof line !== "number" || /\d/.test(translated)) return translated;
  return `${translated} ${line}`;
}

// Estado de expandir/fechar dos mercados na lista ("Todos"/filtrado) — por evento (reinicia ao
// trocar de jogo), e só define os "5 primeiros abertos" UMA vez por evento (initialized), para
// não desfazer o que o utilizador já abriu/fechou manualmente a cada atualização ao vivo.
let marketAccordionState = { eventId: null, expanded: new Set(), initialized: false, autoOpenedFilter: undefined };
function ensureMarketAccordionState(eventId) {
  if (marketAccordionState.eventId !== eventId) marketAccordionState = { eventId, expanded: new Set(), initialized: false, autoOpenedFilter: undefined };
}
// ============ FLUIDEZ ACORDEÕES (OTIMIZAÇÃO 2026-08-26) ============
// Antes: toggleMarketAccordion chamava renderMarketGroups() INTEIRO a cada clique.
// Custo: um jogo com 30 mercados → 30 acordeões reconstruídos, 200+ botões refeitos → 100-300ms
// de UI presa num mid-range Android.
// Agora: TENTA primeiro update DOM local (classList.toggle('open') no nó), SEM rebuildar nada.
// Só cai no rebuild completo se o nó não existir no DOM (filtro mudou, página reiniciou).
function findAccordionElByKey(key) {
  const container = document.getElementById("market-groups");
  if (!container) return null;
  return container.querySelector(`.ml-accordion[data-mkey="${cssEscapeAttr(key)}"]`);
}
function cssEscapeAttr(s) {
  return String(s).replace(/"/g, "&quot;").replace(/\\/g, "\\\\");
}
function toggleMarketAccordion(key) {
  const isExpanding = !marketAccordionState.expanded.has(key);
  if (isExpanding) marketAccordionState.expanded.add(key);
  else marketAccordionState.expanded.delete(key);
  const el = findAccordionElByKey(key);
  if (el) {
    el.classList.toggle("open", isExpanding);
    return;
  }
  if (currentMarketEvent) renderMarketGroups(currentMarketEvent);
}
// Patch incremental para odds AO VIVO (10-15s cycle e refreshEvent do openMarket).
// Antes: um update de odds fazia renderMarketGroups() completo = rebuild de TUDO.
// Agora: percorre .selection-btn já existentes no DOM; se o dataset da odd bate, só atualiza
// o texto e a classe `suspended`; odds mudadas de valor fazem 1 micro-flash de classe para
// feedback visual. Qualquer anomalia (botão não encontrado, número de botões diferente) cai
// no rebuild completo para não divergir.
function marketSelectionButtonsSignature(container) {
  const btns = container.querySelectorAll(".selection-btn[data-selkey]");
  return Array.from(btns).map((b) => b.dataset.selkey).join("||");
}
function patchLiveMarketGroups(e) {
  const container = document.getElementById("market-groups");
  if (!container || !container.children.length) return false; // primeira render ainda não feita → full
  if (selectedMarketFilter === BET_BUILDER_LABEL) return false; // BetBuilder tem pipeline próprio
  try {
    const expected = buildMarketDisplayGroups(e);
    const expectedKeys = expected.map((en) => en.key).sort().join("||");
    const actualKeys = Array.from(container.querySelectorAll(".ml-accordion[data-mkey]"))
      .map((el) => el.dataset.mkey)
      .sort()
      .join("||");
    if (expectedKeys !== actualKeys) return false; // mercados mudaram (ex: livro abriu novas categorias) → full

    let anyMutated = false;
    for (const entry of expected) {
      const accEl = findAccordionElByKey(entry.key);
      if (!accEl) return false;
      const titleEl = accEl.querySelector(".ml-accordion-head > span:first-child");
      const first = entry.lines[0];
      const title = translateMarketDisplayName(entry.market, e.sport, Object.keys(first.selections || {}), e.home, e.away, entry.lines.length === 1 ? first.line : undefined);
      const allSuspended = entry.lines.every((g) => !g.isActive);
      if (titleEl) {
        const wanted = `${title}${allSuspended ? '<span class="market-suspended-badge">Suspenso</span>' : ""}`;
        if (titleEl.innerHTML !== wanted) { titleEl.innerHTML = wanted; anyMutated = true; }
      }
      const bodyEl = accEl.querySelector(".ml-accordion-body");
      if (!bodyEl) return false;
      const selFragments = [];
      for (let i = 0; i < entry.lines.length; i++) {
        const g = entry.lines[i];
        const withLabel = entry.lines.length > 1;
        const isFirst = i === 0;
        const keys = Object.keys(g.selections || {});
        if (entry.isPrimary && allSuspended) {
          expectedSigs.push(`__primary_suspended__`);
          selFragments.push({ kind: "suspended", label: primarySuspendedLabel(e) });
        } else {
          for (const k of keys) expectedSigs.push(k);
          selFragments.push({ kind: "selections", group: g, withLabel, isFirst, market: entry.market, line: g.line });
        }
      }
      const bodyBtns = bodyEl.querySelectorAll(".selection-btn");
      if (bodyBtns.length !== expectedSigs.length) return false; // número mudou → full rebuild

      let fragIdx = 0;
      let btnIdx = 0;
      const isLive = e._isLive || e.status === "live";
      for (const frag of selFragments) {
        if (frag.kind === "suspended") {
          const btn = bodyBtns[btnIdx++];
          if (!btn) return false;
          const span = btn.querySelector(".sel-odd");
          if (span && span.textContent !== frag.label) { span.textContent = frag.label; anyMutated = true; }
          if (!btn.classList.contains("suspended")) { btn.classList.add("suspended"); anyMutated = true; }
          continue;
        }
        const g = frag.group;
        const keys = Object.keys(g.selections || {});
        // Uma linha com N seleções corresponde a N botões consecutivos no body (ordem do HTML gerado em normalSelectionRowHtml).
        for (const k of keys) {
          const sel = g.selections[k];
          const btn = bodyBtns[btnIdx++];
          if (!btn) return false;
          const newOdd = Number(sel.odd).toFixed(2);
          const selLabel = translateSelectionLabel(k);
          const oddSpan = btn.querySelector(".sel-odd");
          const labelSpan = btn.querySelector(".sel-label");
          const oddChanged = oddSpan && Number(btn.dataset.odd) !== Number(sel.odd);
          if (oddSpan && oddSpan.textContent !== newOdd) {
            oddSpan.textContent = newOdd;
            btn.dataset.odd = String(sel.odd);
            anyMutated = true;
          }
          if (labelSpan) {
            let wantedLabel = selLabel;
            if (frag.withLabel) {
              const lineLabel = overUnderButtonLabel(frag.market, frag.line, k, selLabel);
              wantedLabel = lineLabel;
            }
            if (labelSpan.innerHTML !== wantedLabel) { labelSpan.innerHTML = wantedLabel; anyMutated = true; }
          }
          const shouldSuspend = isLive && (!sel.isActive || !g.isActive);
          if (btn.classList.toggle("suspended", shouldSuspend)) anyMutated = true;
          if (isLive && oddChanged) {
            btn.classList.remove("odd-flash");
            // force reflow p/ restart da animação CSS
            // eslint-disable-next-line no-unused-expressions
            void btn.offsetWidth;
            btn.classList.add("odd-flash");
          }
        }
        fragIdx++;
      }
    }
    return true; // patch aplicado com sucesso
  } catch {
    return false; // anomalia → rebuild completo
  }
}

// Reorganiza os mercados brutos (e.odds, já filtrados pela categoria escolhida) em entradas para
// a lista de acordeões: todas as linhas de um mesmo mercado Mais/Menos/Handicap (mesmo
// group.market, várias group.line) fundidas numa só entrada — pedido explícito do utilizador
// ("o grupo desse mercado fique dentro de um único... sem essa base retangular"); tudo o resto,
// uma entrada por mercado. Ordenado pela mesma prioridade de categoria da barra de filtros
// (FOOTBALL_FILTER_DISPLAY_ORDER) — pedido explícito: "Resultado, Ambas Marcam, Mais/Menos,
// Handicap, 1ºT, 2ºT, Placar Exato, Escanteios, Cartões, Marcador, Especial".
//
// "Marcador" NÃO tem tratamento especial (já teve uma fusão numa tabela por jogador, revertida):
// uma amostra real mostrou os rótulos "Anytime"/"First"/"Last"/"Score or Assist"/"Score" onde se
// esperava nomes de jogadores — a estrutura real deste mercado (o que é o "mercado" e o que é a
// "seleção") ainda não está confirmada. Até haver uma amostra real completa, cada mercado
// "Marcador" aparece como qualquer outro — nome traduzido, seleções tal como vêm — em vez de
// arriscar uma tabela com rótulos errados a fingir ser jogadores.
function buildMarketDisplayGroups(e) {
  const groups = filterMarketGroups(e);
  if (!groups || !groups.length) return []; // <-- anti-crash: sem odds = sem mercados, não continua
  const primaryMarket = e.odds && e.odds[0];
  const sport = e.sport;
  const order = sport === "football" ? FOOTBALL_FILTER_DISPLAY_ORDER : (MARKET_FILTER_CATEGORIES[sport] || []).map((c) => c.label);
  const rank = (label) => {
    const idx = order.indexOf(label);
    return idx === -1 ? order.length : idx;
  };

  const byMergeKey = new Map();
  const result = [];
  for (const group of groups) {
    if (!group) continue;
    const category = classifyMarket(sport, group.market);
    let entry = byMergeKey.get(group.market);
    if (!entry) {
      entry = { key: `m:${group.market}`, market: group.market, category, lines: [] };
      byMergeKey.set(group.market, entry);
      result.push(entry);
    }
    entry.lines.push(group);
  }
  // primaryMarket pode ser undefined se e.odds estiver vazio mas groups vier de
  // filterMarketGroups (selectedMarketFilter filtrou odds). includes() com undefined safe.
  for (const entry of result) entry.isPrimary = !!(primaryMarket && entry.lines.includes(primaryMarket));

  try {
    result.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || rank(a.category) - rank(b.category));
  } catch {
    // sort anomalia (NaN rank, etc.) → mantemos ordem original em vez de crashar.
  }
  return result;
}

function marketAccordionHtml(e, entry, isLive) {
  const expanded = marketAccordionState.expanded.has(entry.key);
  const first = entry.lines[0];
  const title = translateMarketDisplayName(entry.market, e.sport, Object.keys(first.selections || {}), e.home, e.away, entry.lines.length === 1 ? first.line : undefined);
  const allSuspended = entry.lines.every((g) => !g.isActive);
  const badgeHtml = allSuspended ? '<span class="market-suspended-badge">Suspenso</span>' : "";
  let bodyHtml;
  if (entry.isPrimary && allSuspended) {
    // Mercado principal (1X2/moneyline) totalmente suspenso: um único botão a cobrir a linha
    // toda em vez de 3 caixas "Suspenso" repetidas — ver primarySuspendedLabel().
    bodyHtml = `<div class="selection-row"><div class="selection-btn suspended"><span class="sel-odd">${primarySuspendedLabel(e)}</span></div></div>`;
  } else if (entry.lines.length === 1) {
    bodyHtml = normalSelectionRowHtml(e, entry.lines[0], isLive, false);
  } else {
    bodyHtml = entry.lines
      .slice()
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
      .map((g) => normalSelectionRowHtml(e, g, isLive, true))
      .join("");
  }
  return `
    <div class="ml-accordion${expanded ? " open" : ""}" data-mkey="${attrJson(entry.key)}">
      <div class="ml-accordion-head" onclick='toggleMarketAccordion(${attrJson(entry.key)})'>
        <span>${title}${badgeHtml}</span>
        <span class="ml-chevron">⌄</span>
      </div>
      <div class="ml-accordion-body">${bodyHtml}</div>
    </div>`;
}

function renderMarketGroups(e, _skipPatch = false) {
  const el = document.getElementById("market-groups");
  if (!el) return;
  if (!e.odds || !e.odds.length) {
    el.innerHTML = '<div class="empty-note">Sem mercados disponíveis para este evento</div>';
    return;
  }
  ensureMarketAccordionState(e.id);
  const isLive = e._isLive || e.status === "live";

  // OTIMIZAÇÃO FLUIDEZ: tentar patch incremental antes de rebuild completo.
  // - Apenas em AO VIVO ou quando já temos DOM renderizado anteriormente.
  // - 90% das atualizações (odds mexem 0.01 ~ 0.03, botão suspendido/não) custam ~5ms
  //   em vez de 50-300ms do rebuild completo.
  // - Se houver qualquer anomalia (chaves mudaram, #botões diferente), patchLiveMarketGroups()
  //   devolve false e fazemos o rebuild completo de segurança.
  const shouldTryPatch = !_skipPatch && (isLive || (el.children.length && marketAccordionState.eventId === e.id));
  if (shouldTryPatch) {
    const patched = patchLiveMarketGroups(e);
    if (patched) return;
  }

  const entries = buildMarketDisplayGroups(e);
  if (!entries.length) {
    el.innerHTML = '<div class="empty-note">Sem mercados nesta categoria</div>';
    return;
  }
  if (selectedMarketFilter) {
    // Categoria específica escolhida na barra de chips (ex: "Mais/Menos"): mostra tudo já aberto,
    // mas só na primeira renderização DEPOIS da troca de filtro (autoOpenedFilter) — senão um
    // fecho manual do utilizador seria reaberto de novo a cada atualização ao vivo.
    if (marketAccordionState.autoOpenedFilter !== selectedMarketFilter) {
      entries.forEach((entry) => marketAccordionState.expanded.add(entry.key));
      marketAccordionState.autoOpenedFilter = selectedMarketFilter;
    }
  } else if (!marketAccordionState.initialized) {
    // "Todos": "os 5 primeiros ficam abertos" — pedido explícito do utilizador — só na primeira
    // renderização deste evento, nunca reaplicado (ver ensureMarketAccordionState) para não
    // fechar/reabrir o que o utilizador já escolheu a cada atualização ao vivo.
    entries.slice(0, 5).forEach((entry) => marketAccordionState.expanded.add(entry.key));
    marketAccordionState.initialized = true;
  }
  el.innerHTML = entries.map((entry) => marketAccordionHtml(e, entry, isLive)).join("");
}

// ====================== MELHORES ESCOLHAS (combinações geradas automaticamente) ======================
// Pedido explícito do utilizador: o próprio sistema monta as combinações (não a Bet Builder — são
// mercados extra, incluindo Marcador/Cantos, que o Bet Builder não usa), seguindo os modelos das
// referências visuais enviadas (ver ensureAutoFeaturedCombos em featuredCombos/service.ts), com um
// "Booster" REAL — a odd boostada vem sempre calculada no servidor a partir das odds reais e
// atuais do mercado no momento da colocação, nunca uma percentagem cosmética sobre um número
// inventado. Um admin ainda pode criar combinações à mão no painel (continuam a aparecer aqui
// também) — a geração automática só preenche o que faltar. Várias combinações do mesmo evento
// aparecem lado a lado num carrossel horizontal (deslizar), como na referência visual enviada.
let featuredCombosState = { eventId: null, combos: [] };

async function renderFeaturedCombo(e) {
  const el = document.getElementById("featured-combo");
  if (!el) return;
  if (!e || e._finished) {
    el.innerHTML = "";
    return;
  }
  try {
    const { combos } = await Bet62Api.getFeaturedCombos(e.id);
    if (!currentMarketEvent || currentMarketEvent.id !== e.id) return; // saiu deste evento entretanto
    featuredCombosState = { eventId: e.id, combos: combos || [] };
  } catch {
    featuredCombosState = { eventId: e.id, combos: [] };
  }
  renderFeaturedCombosCarousel(e);
}

function renderFeaturedCombosCarousel(e) {
  const el = document.getElementById("featured-combo");
  if (!el) return;
  const combos = featuredCombosState.eventId === e.id ? featuredCombosState.combos : [];
  if (!combos.length) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <div class="combo-title">🔥 MELHORES ESCOLHAS</div>
    <div class="combo-carousel">${combos.map((c) => featuredComboCardHtml(e, c)).join("")}</div>`;
}

function featuredComboLegLabel(e, leg) {
  // translateMarketBaseName() em vez de translateMarketDisplayName(): esta é UMA perna avulsa de
  // uma combinação curada, não o grupo completo de seleções do mercado — não há como validar a
  // "forma" esperada (ex: Resultado Final precisa das 3 vias completas) com só uma seleção à
  // mão, por isso pula essa validação em vez de arriscar mostrar o nome bruto sem necessidade.
  const marketPt = translateMarketBaseName(leg.market, e.sport) || leg.market;
  return `${marketPt} - <b>${translateSelectionLabel(leg.selection)}</b>`;
}

function featuredComboCardHtml(e, combo) {
  return `
    <div class="combo-card">
      <div class="combo-boost-badge">🚀 ${combo.boostPercent}% BOOST</div>
      ${combo.legs.map((l) => `<div class="combo-leg"><span class="combo-leg-dot"></span>${featuredComboLegLabel(e, l)}</div>`).join("")}
      <div class="combo-odd-row"><span class="combo-odd-old">${combo.realCombinedOdd.toFixed(2)}</span><span class="combo-odd-new">${combo.boostedCombinedOdd.toFixed(2)}</span></div>
      <div class="combo-stake-row">
        <input type="number" min="0.5" step="0.5" placeholder="Valor (€)" id="combo-stake-${combo.id}">
        <button class="btn-save" style="width:auto;margin-top:0" onclick='submitFeaturedCombo(${attrJson(combo.id)})'>Apostar</button>
      </div>
      <div class="combo-error auth-error" id="combo-error-${combo.id}"></div>
    </div>`;
}

async function submitFeaturedCombo(comboId) {
  const input = document.getElementById(`combo-stake-${comboId}`);
  const errEl = document.getElementById(`combo-error-${comboId}`);
  if (errEl) errEl.classList.remove("show");
  const stake = Number(input?.value) || 0;
  if (stake < 0.5) {
    if (errEl) {
      errEl.textContent = "Indique o valor da aposta.";
      errEl.classList.add("show");
    }
    return;
  }
  try {
    const { bet } = await Bet62Api.placeFeaturedCombo(comboId, stake);
    alert(`✅ Aposta colocada!\nRetorno potencial: € ${Number(bet.potentialReturn).toFixed(2)}`);
    loadBalance();
    if (currentMarketEvent) renderFeaturedCombo(currentMarketEvent); // atualiza preços/lista
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message || "Não foi possível colocar a aposta.";
      errEl.classList.add("show");
    }
  }
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
      for (const [label, sel] of orderedSelectionEntries(group.selections)) {
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
        return `<div class="selection-btn ${isPicked ? "picked" : ""}" onclick='toggleBetBuilderPick(${attrJson(cat.key)}, ${attrJson(market)}, ${attrJson(label)}, ${odd})'>
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
          <div class="bs-row-sel">${translateMarketDisplayName(s.market, s.sport, [s.selection], s.home, s.away, s.line)}: <b>${translateSelectionLabel(s.selection)}</b> @ ${Number(s.odd).toFixed(2)}</div>
          ${badgeHtml}
        </div>
        <div class="bs-row-actions">
          ${
            betslipMode === "simples" && !isSuspended
              ? `<input type="number" min="0.5" step="0.5" class="bs-stake-input" value="${betslipStakes.get(key) || ""}" placeholder="€" oninput='setStake(${attrJson(key)}, this.value)'>`
              : ""
          }
          <button class="bs-remove" onclick='toggleSelection(${attrJson(key)})' aria-label="Remover">✕</button>
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
  // Feed ao vivo liga já ao carregar a app (não só quando o utilizador entra em "Ao Vivo") — sem
  // login nenhum exigido (gateway público, ver websocket/gateway.ts) — para a página "Ao Vivo" e o
  // cabeçalho do Match Tracker nunca terem de esperar pela ligação a começar do zero. Pedido
  // explícito do utilizador ("o feed tem de ser contínuo mesmo que o usuário não esteja logado").
  ensureLiveSocket();
  if (Bet62Api.isAuthenticated()) {
    await loadProfile();
  }
})();
