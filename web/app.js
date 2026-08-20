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

const prematchEventsById = new Map();

function clearLeagueFilter() {
  selectedLeague = null;
  renderSportsMenu();
  renderPrematchList();
}

async function renderPrematchList() {
  const container = document.getElementById("prematch-list");
  const requestToken = ++renderPrematchList._token;
  container.innerHTML = '<div class="empty-note">A carregar…</div>';

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

  const events = selectedLeague
    ? realEvents.filter((e) => e.league && e.league.toLowerCase().includes(selectedLeague.toLowerCase()))
    : realEvents;

  prematchEventsById.clear();
  events.forEach((e) => prematchEventsById.set(e.id, e));

  if (!events.length) {
    container.innerHTML = '<div class="empty-note">Sem jogos agendados para este desporto neste momento</div>';
    return;
  }
  const icon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
  container.innerHTML = events
    .map((e) => {
      const odds = activeSelectionEntries(e.odds?.[0]);
      return `
      <div class="live-card" onclick="openMarket('${e.id}', false)">
        <div class="lc-top"><span>${icon[e.sport] || ""} ${e.league}</span><span>${formatKickoff(e.startTime)}</span></div>
        <div class="lc-teams"><span>${e.home}</span><span style="color:var(--muted);font-size:.8rem">vs</span><span>${e.away}</span></div>
        ${
          odds.length
            ? `<div class="lc-odds">${odds.slice(0, 3).map(([k, v]) => `<div>${k}<br>${v.odd.toFixed(2)}</div>`).join("")}</div>`
            : ""
        }
      </div>`;
    })
    .join("");
}
renderPrematchList._token = 0;
function formatKickoff(d) {
  const date = new Date(d);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `Hoje, ${time}` : date.toLocaleDateString("pt-PT", { day: "2-digit", month: "2-digit" }) + `, ${time}`;
}

// ====================== STATE ======================
let currentProfile = null;
let currentBalance = null;
let pageHistory = ["destaques"];
let selectedDepositMethod = "STRIPE_CARD";
let liveSocket = null;
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

  ["destaques", "profile", "esportes", "aovivo", "casino", "promocao", "market"].forEach((p) => {
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
  if (page === "aovivo") { renderSportSubnav(); ensureLiveSocket(); }
  if (page === "esportes") { renderSportSubnav(); renderPrematchList(); }
  if (page === "casino") renderCasinoPage();
  if (page === "destaques") renderDestaquesCasinoRow();
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
// existem (chips de desporto, carrossel do casino, linhas de odds, etc.).
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
    const tokens = await Bet62Api.register({ name, email, username, password, birthDate, acceptedTerms });
    Bet62Api.setTokens(tokens);
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
    const tokens = await Bet62Api.login(identifier, password);
    Bet62Api.setTokens(tokens);
    closeAuth();
    await afterAuthSuccess();
  } catch (err) {
    showAuthError(err.message || "Não foi possível iniciar sessão.");
  } finally {
    btn.disabled = false;
  }
}

async function afterAuthSuccess() {
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
function openDeposit() {
  if (!Bet62Api.isAuthenticated()) return openAuth("login");
  document.getElementById("deposit-modal").classList.add("open");
  document.getElementById("deposit-error").classList.remove("show");
}
function closeDeposit() {
  document.getElementById("deposit-modal").classList.remove("open");
}
function selectDepositMethod(method) {
  selectedDepositMethod = method;
  document.querySelectorAll(".dm-btn").forEach((b) => b.classList.toggle("active", b.dataset.method === method));
  document.getElementById("deposit-phone-group").classList.toggle("hidden", method !== "STRIPE_MBWAY");
}
async function submitDeposit() {
  const amountEur = Number(document.getElementById("deposit-amount").value);
  const phone = document.getElementById("deposit-phone").value.trim();
  const errEl = document.getElementById("deposit-error");
  errEl.classList.remove("show");

  if (!amountEur || amountEur < 5) {
    errEl.textContent = "Indique um valor válido (mínimo 5€)";
    errEl.classList.add("show");
    return;
  }

  const btn = document.getElementById("btn-deposit");
  btn.disabled = true;
  try {
    await Bet62Api.createDeposit(selectedDepositMethod, amountEur, phone || undefined);
    closeDeposit();
    if (selectedDepositMethod === "STRIPE_MULTIBANCO") {
      alert("Depósito iniciado. A referência Multibanco será apresentada assim que o Stripe confirmar o pagamento (fluxo completo requer Stripe.js no frontend com a chave publicável).");
    } else if (selectedDepositMethod === "STRIPE_MBWAY") {
      alert("Pedido enviado para a app MB WAY associada a esse número. Confirme o pagamento na app.");
    } else {
      alert("PaymentIntent criado (client_secret recebido). A confirmação do cartão requer Stripe.js/Elements no frontend com a chave publicável (STRIPE_PUBLISHABLE_KEY) — ainda não configurada.");
    }
  } catch (err) {
    errEl.textContent = err.message || "Não foi possível iniciar o depósito.";
    errEl.classList.add("show");
  } finally {
    btn.disabled = false;
  }
}

// ====================== CASINO ======================
async function renderDestaquesCasinoRow() {
  const el = document.getElementById("destaques-casino-row");
  if (!el) return;
  try {
    const { games } = await Bet62Api.getCasinoHighlights();
    el.innerHTML = games
      .map(
        (g) => `
      <div class="casino-game" onclick='playGame(${JSON.stringify(g.game_code)}, ${JSON.stringify(g.game_name)})'>
        <div class="thumb"><img src="${window.BET62_CONFIG.API_BASE}/casino/image/${g.game_code}" alt="${g.game_name}" loading="lazy" onerror="this.style.display='none'"></div>
        <div class="name">${g.game_name}</div>
      </div>`
      )
      .join("");
  } catch {
    // Sem catálogo disponível (backend em baixo, etc.) — a fila fica vazia em vez de quebrar a página.
  }
}

let casinoSearchTimer = null;
function onCasinoSearch(value) {
  clearTimeout(casinoSearchTimer);
  casinoSearchTimer = setTimeout(() => renderCasinoPage(value.trim()), 250);
}

async function renderCasinoPage(search = "") {
  const grid = document.getElementById("casino-grid");
  const status = document.getElementById("casino-grid-status");
  const requestToken = ++renderCasinoPage._token;
  if (!grid) return;
  status.textContent = "A carregar…";
  try {
    const { games, total } = await Bet62Api.getCasinoGames({ search, limit: 120 });
    if (requestToken !== renderCasinoPage._token) return; // pesquisa mais recente já em curso
    grid.innerHTML = games
      .map(
        (g) => `
      <div class="casino-grid-item" onclick='playGame(${JSON.stringify(g.game_code)}, ${JSON.stringify(g.game_name)})'>
        <div class="thumb"><img src="${window.BET62_CONFIG.API_BASE}/casino/image/${g.game_code}" alt="${g.game_name}" loading="lazy" onerror="this.style.display='none'"></div>
        <div class="name">${g.game_name}</div>
      </div>`
      )
      .join("");
    status.textContent = total > games.length ? `A mostrar ${games.length} de ${total} jogos — refine a pesquisa` : `${total} jogos`;
  } catch (err) {
    if (requestToken !== renderCasinoPage._token) return;
    grid.innerHTML = "";
    status.textContent = err.message || "Não foi possível carregar o catálogo de jogos.";
  }
}
renderCasinoPage._token = 0;

async function playGame(gameCode, gameName) {
  if (!Bet62Api.isAuthenticated()) return openAuth("login");
  // Abre a aba já no clique (síncrono) para não ser bloqueada como pop-up — só lhe muda o
  // destino depois de recebermos o game_url real do provedor.
  const win = window.open("", "_blank");
  try {
    const { game_url } = await Bet62Api.launchCasinoGame(gameCode);
    if (win) win.location.href = game_url;
    else window.open(game_url, "_blank");
  } catch (err) {
    if (win) win.close();
    alert("🎰 " + (gameName || gameCode) + "\n\n" + (err.message || "Não foi possível abrir o jogo."));
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
      liveEventsById.clear();
      data.events.forEach((e) => liveEventsById.set(e.id, e));
    } else if (data.type === "update") {
      liveEventsById.set(data.event.id, data.event);
    } else if (data.type === "remove") {
      // Jogo terminado (ou já não devolvido pela Pulsescore) — sai da página Ao Vivo assim que
      // este frame chega, sem esperar por um reload (ver applySportSnapshot em hybridService.ts
      // e o relay em websocket/gateway.ts).
      liveEventsById.delete(data.id);
      if (currentMarketEvent && currentMarketEvent.id === data.id) currentMarketEvent._finished = true;
    }
    renderLiveEvents();
    if (currentMarketEvent && liveEventsById.has(currentMarketEvent.id)) {
      currentMarketEvent = liveEventsById.get(currentMarketEvent.id);
    }
    if (currentMarketEvent && pageHistory[pageHistory.length - 1] === "market") renderMarketPage();
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
    <div class="live-card" onclick='openMarket(${JSON.stringify(e.id)}, true)'>
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
    <div class="live-card" onclick='openMarket(${JSON.stringify(e.id)}, true)'>
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
  const events = [...liveEventsById.values()]
    .filter((e) => !selectedSport || e.sport === selectedSport)
    .sort((a, b) => (SPORT_ORDER[a.sport] ?? 99) - (SPORT_ORDER[b.sport] ?? 99));
  if (!events.length) {
    container.innerHTML = '<div class="empty-note">Sem eventos ao vivo para este desporto neste momento</div>';
    return;
  }
  const sportIcon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
  container.innerHTML = events
    .map((e) => {
      const primaryMarket = e.odds?.[0];
      const odds = activeSelectionEntries(primaryMarket);
      const clockClass = isClockMissing(e) ? "clock-missing" : "";
      const icon = sportIcon[e.sport] || "";
      const oddsHtml = odds.length
        ? `<div class="lc-odds">${odds
            .slice(0, 3)
            .map(([k, v]) => {
              const arrow = oddsArrowHtml(`${e.id}|${primaryMarket.market}|${k}`, v.odd);
              return `<div>${k}<br>${v.odd.toFixed(2)}${arrow}</div>`;
            })
            .join("")}</div>`
        : "";

      if (e.statistics?.sets) return renderSetsCard(e, clockClass, oddsHtml, icon);
      return renderGenericCard(e, clockClass, oddsHtml, icon);
    })
    .join("");
}

// ====================== MERCADOS + MATCH TRACKER ======================
function openMarket(eventId, isLive) {
  const event = isLive ? liveEventsById.get(eventId) : prematchEventsById.get(eventId);
  if (!event) return;
  currentMarketEvent = event;
  currentMarketEvent._isLive = isLive;
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
  renderMarketGroups(e);
  renderBetslipPanel();
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
          <span class="h2h-comp">${m.competition} • ${new Date(m.date).toLocaleDateString("pt-PT")}</span>
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

function renderMarketGroups(e) {
  const el = document.getElementById("market-groups");
  if (!e.odds || !e.odds.length) {
    el.innerHTML = '<div class="empty-note">Sem mercados disponíveis para este evento</div>';
    return;
  }
  const isLive = e._isLive || e.status === "live";
  el.innerHTML = e.odds
    .map((group, idx) => {
      // Mercado principal (1X2/moneyline, sempre o primeiro — ver orderMarketsWithPrimaryFirst
      // no backend) totalmente suspenso: em vez de 3 caixas "Suspenso" repetidas lado a lado,
      // mostra-se um único botão a cobrir a linha toda. O rótulo do mercado (group.market) pode
      // vir "Match Odds", "Grande Chance" ou até "Revisão VAR" consoante o bookmaker/desporto —
      // por isso a decisão usa a posição (idx===0), não o texto do nome.
      if (idx === 0 && !group.isActive) {
        return `<div class="market-group"><h4>${group.market}</h4><div class="selection-row">
          <div class="selection-btn suspended"><span class="sel-odd">Suspenso</span></div>
        </div></div>`;
      }
      const rows = Object.entries(group.selections)
        .map(([label, sel]) => {
          // Seleção suspensa pelo bookmaker (isActive:false — ex: durante uma revisão VAR ou
          // logo após um penálti/cartão, ver LiveSelection em types.ts): mostra-se visível mas
          // sem onclick, em vez de desaparecer ou continuar clicável com uma odd desatualizada.
          // Mesmo tratamento para uma odd inválida (ex: NaN de uma transição de deploy com JS
          // antigo em cache) — nunca deixar clicar numa aposta sem preço válido.
          if (!sel.isActive || !Number.isFinite(sel.odd)) {
            return `<div class="selection-btn suspended">
              <span class="sel-label">${label}</span><span class="sel-odd">Suspenso</span>
            </div>`;
          }
          const key = `${e.id}|${group.market}|${label}`;
          const picked = betslipSelections.has(key);
          const selection = { eventId: e.id, market: group.market, selection: label, odd: sel.odd, home: e.home, away: e.away, league: e.league };
          // Setas de subida/descida só em Ao Vivo — no pré-jogo o valor não costuma mudar
          // ao ponto de justificar o indicador, e não foi pedido para essa página.
          const arrow = isLive ? oddsArrowHtml(key, sel.odd) : "";
          return `<div class="selection-btn ${picked ? "picked" : ""}" onclick='toggleSelection(${JSON.stringify(key)}, ${JSON.stringify(selection)})'>
            <span class="sel-label">${label}</span><span class="sel-odd">${sel.odd.toFixed(2)}${arrow}</span>
          </div>`;
        })
        .join("");
      const suspendedBadge = !group.isActive ? '<span class="market-suspended-badge">Suspenso</span>' : "";
      return `<div class="market-group"><h4>${group.market}${suspendedBadge}</h4><div class="selection-row">${rows}</div></div>`;
    })
    .join("");
}

function toggleSelection(key, selection) {
  if (betslipSelections.has(key)) {
    betslipSelections.delete(key);
    betslipStakes.delete(key);
  } else {
    betslipSelections.set(key, selection);
  }
  if (currentMarketEvent) renderMarketGroups(currentMarketEvent);
  renderBetslipPanel();
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

function setStake(key, value) {
  betslipStakes.set(key, value);
  renderBetslipPanel();
}
function setBetslipMode(mode) {
  betslipMode = mode;
  renderBetslipPanel();
}
function setMultiplaStake(value) {
  multiplaStake = Number(value) || 0;
  renderBetslipPanel();
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

  panels.forEach((el) => {
    if (!selections.length) {
      el.innerHTML = '<div class="empty-note">Selecione odds nos mercados para adicionar ao boletim</div>';
      return;
    }

    const rowsHtml = selections
      .map(
        ([key, s]) => `
      <div class="bs-row">
        <div class="bs-row-info">
          <div class="bs-row-teams">${s.home || ""}${s.away ? " vs " + s.away : ""}</div>
          <div class="bs-row-sel">${s.market}: <b>${s.selection}</b> @ ${Number(s.odd).toFixed(2)}</div>
        </div>
        <div class="bs-row-actions">
          ${
            betslipMode === "simples"
              ? `<input type="number" min="0.5" step="0.5" class="bs-stake-input" value="${betslipStakes.get(key) || ""}" placeholder="€" oninput='setStake(${JSON.stringify(key)}, this.value)'>`
              : ""
          }
          <button class="bs-remove" onclick='toggleSelection(${JSON.stringify(key)})' aria-label="Remover">✕</button>
        </div>
      </div>`
      )
      .join("");

    let summaryHtml;
    if (betslipMode === "simples") {
      const totalStake = selections.reduce((sum, [key]) => sum + (Number(betslipStakes.get(key)) || 0), 0);
      const totalReturn = selections.reduce((sum, [key, s]) => sum + (Number(betslipStakes.get(key)) || 0) * s.odd, 0);
      summaryHtml = `
        <div class="bs-summary"><span>Total investido</span><span>€ ${totalStake.toFixed(2)}</span></div>
        <div class="bs-summary"><span>Retorno potencial</span><span class="bs-return">€ ${totalReturn.toFixed(2)}</span></div>`;
    } else {
      const totalOdd = selections.reduce((prod, [, s]) => prod * s.odd, 1);
      summaryHtml = `
        <div class="field" style="margin:10px 0"><label>Valor da aposta (€)</label>
          <input type="number" min="0.5" step="0.5" value="${multiplaStake || ""}" placeholder="€" oninput="setMultiplaStake(this.value)"></div>
        <div class="bs-summary"><span>Odd total</span><span>${totalOdd.toFixed(2)}</span></div>
        <div class="bs-summary"><span>Retorno potencial</span><span class="bs-return">€ ${(multiplaStake * totalOdd).toFixed(2)}</span></div>`;
    }

    el.innerHTML = `
      <div class="bs-tabs">
        <div class="bs-tab ${betslipMode === "simples" ? "active" : ""}" onclick="setBetslipMode('simples')">Simples</div>
        <div class="bs-tab ${betslipMode === "multipla" ? "active" : ""} ${canMultipla ? "" : "disabled"}" onclick="${canMultipla ? "setBetslipMode('multipla')" : ""}">Múltipla</div>
      </div>
      ${!canMultipla && selections.length >= 2 ? '<div class="field-hint" style="margin:8px 2px">Múltipla indisponível: há mais do que uma seleção do mesmo evento.</div>' : ""}
      <div class="bs-rows">${rowsHtml}</div>
      ${summaryHtml}
      <button class="btn-save" onclick="placeBetDemo()">Confirmar Aposta</button>
      <button class="btn-outline" onclick="clearBetslip()">Limpar Boletim</button>`;
  });
}

function placeBetDemo() {
  if (!Bet62Api.isAuthenticated()) return openAuth("login");
  if (!betslipSelections.size) return alert("Escolha pelo menos uma seleção nos mercados para adicionar ao boletim.");

  if (betslipMode === "simples") {
    const missing = [...betslipSelections.keys()].filter((key) => !(Number(betslipStakes.get(key)) > 0));
    if (missing.length) return alert("Indique o valor da aposta em todas as seleções do boletim.");
  } else if (!(multiplaStake > 0)) {
    return alert("Indique o valor da aposta múltipla.");
  }

  alert(
    `🧾 Boletim ${betslipMode === "simples" ? "Simples" : "Múltipla"} com ${betslipSelections.size} seleção(ões).\n\nO motor de apostas (criação de bilhete, cálculo de retorno e liquidação) ainda não foi implementado nesta fase — esta é só a navegação de mercados e o boletim. As seleções foram mantidas.`
  );
}

// ====================== INIT ======================
(async function init() {
  applyAutoTheme();
  updateHeader();
  showPage("destaques");
  renderSportsMenu();
  renderCompetitions();
  renderBetslipPanel();
  if (Bet62Api.isAuthenticated()) {
    await loadProfile();
  }
})();
