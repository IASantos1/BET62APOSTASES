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
  { id: "baseball", label: "Beisebol", icon: "⚾" },
  { id: "volleyball", label: "Voleibol", icon: "🏐" },
  { id: "formula1", label: "Fórmula 1", icon: "🏎️" },
  { id: "mma", label: "MMA", icon: "🥋" },
];
let selectedSport = null; // null = todos

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
  renderSportSubnav();
  const active = pageHistory[pageHistory.length - 1];
  if (active === "aovivo") renderLiveEvents();
  if (active === "esportes") renderPrematchList();
}

// Odds pré-jogo estáticas de demonstração — o motor real de compilação de odds pré-jogo
// (fora do escopo desta fase) ainda não existe; isto é só para a navegação/página de
// mercados ser testável já.
function marketsFor(sport, homeScore, awayScore) {
  const h = homeScore >= awayScore ? 1.9 : 2.3;
  const a = homeScore >= awayScore ? 2.3 : 1.9;
  switch (sport) {
    case "football":
      return [
        { market: "1X2", selections: { casa: h, empate: 3.4, fora: a } },
        { market: "Total (mais/menos 2.5)", selections: { mais: 1.85, menos: 1.95 } },
        { market: "Ambas Marcam", selections: { sim: 1.7, não: 2.1 } },
      ];
    case "basketball":
      return [
        { market: "Vencedor", selections: { casa: h - 0.2, fora: a - 0.2 } },
        { market: "Hándicap (-5.5 / +5.5)", selections: { casa: 1.9, fora: 1.9 } },
      ];
    case "tennis":
      return [{ market: "Vencedor do encontro", selections: { casa: h, fora: a } }];
    case "ice_hockey":
      return [{ market: "Moneyline", selections: { casa: h, empate: 4.2, fora: a } }];
    case "baseball":
      return [{ market: "Moneyline", selections: { casa: h, fora: a } }];
    case "volleyball":
      return [{ market: "Vencedor", selections: { casa: h - 0.1, fora: a - 0.1 } }];
    case "mma":
      return [
        { market: "Vencedor do combate", selections: { casa: h, fora: a } },
        { market: "Método de vitória", selections: { ko_tko: 2.1, submissão: 3.4, decisão: 2.8 } },
      ];
    case "formula1":
      return [{ market: "Vencedor da corrida", selections: { Verstappen: 1.45, Norris: 3.6, Leclerc: 6.5 } }];
    default:
      return [];
  }
}
function inHours(h) {
  const d = new Date();
  d.setHours(d.getHours() + h, 0, 0, 0);
  return d;
}
const PREMATCH_EVENTS = [
  { id: "pm:football-1", sport: "football", league: "Primeira Liga", home: "Sporting CP", away: "Braga", kickoff: inHours(3) },
  { id: "pm:football-2", sport: "football", league: "Premier League", home: "Man City", away: "Liverpool", kickoff: inHours(26) },
  { id: "pm:tennis-1", sport: "tennis", league: "Roland Garros", home: "N. Djokovic", away: "D. Medvedev", kickoff: inHours(5) },
  { id: "pm:basketball-1", sport: "basketball", league: "NBA", home: "LA Lakers", away: "Boston Celtics", kickoff: inHours(8) },
  { id: "pm:hockey-1", sport: "ice_hockey", league: "NHL", home: "Edmonton Oilers", away: "Colorado Avalanche", kickoff: inHours(30) },
  { id: "pm:baseball-1", sport: "baseball", league: "MLB", home: "LA Dodgers", away: "Houston Astros", kickoff: inHours(20) },
  { id: "pm:volleyball-1", sport: "volleyball", league: "Superliga", home: "Benfica", away: "Sporting CP", kickoff: inHours(48) },
  { id: "pm:f1-1", sport: "formula1", league: "Fórmula 1", home: "GP de Mónaco", away: "Qualificação", kickoff: inHours(72) },
  { id: "pm:mma-1", sport: "mma", league: "UFC 310", home: "C. McGregor", away: "N. Diaz", kickoff: inHours(96) },
].map((e) => ({ ...e, homeScore: 0, awayScore: 0, odds: marketsFor(e.sport, 0, 0), status: "scheduled" }));

const prematchEventsById = new Map();

async function renderPrematchList() {
  const container = document.getElementById("prematch-list");
  const requestToken = ++renderPrematchList._token;
  container.innerHTML = '<div class="empty-note">A carregar…</div>';

  const sports = selectedSport ? [selectedSport] : SPORTS_META.map((s) => s.id);
  const realEvents = [];
  const results = await Promise.allSettled(sports.map((s) => Bet62Api.getPrematchEvents(s)));
  if (requestToken !== renderPrematchList._token) return; // uma seleção mais recente já está a carregar

  results.forEach((r) => {
    if (r.status === "fulfilled" && r.value.source === "pulsescore") realEvents.push(...r.value.events);
  });

  // Para os desportos sem dados reais (Pulsescore não configurada ou sem jogos agendados),
  // completa com os dados de demonstração estáticos para a navegação continuar testável.
  const sportsWithRealData = new Set(realEvents.map((e) => e.sport));
  const fallbackEvents = PREMATCH_EVENTS.filter((e) => (!selectedSport || e.sport === selectedSport) && !sportsWithRealData.has(e.sport));
  const events = [...realEvents, ...fallbackEvents];

  prematchEventsById.clear();
  events.forEach((e) => prematchEventsById.set(e.id, e));

  if (!events.length) {
    container.innerHTML = '<div class="empty-note">Sem jogos agendados para este desporto neste momento</div>';
    return;
  }
  const icon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
  container.innerHTML = events
    .map((e) => {
      const odds = e.odds?.[0]?.selections;
      return `
      <div class="live-card" onclick="openMarket('${e.id}', false)">
        <div class="lc-top"><span>${icon[e.sport] || ""} ${e.league}</span><span>${formatKickoff(e.startTime || e.kickoff)}</span></div>
        <div class="lc-teams"><span>${e.home}</span><span style="color:var(--muted);font-size:.8rem">vs</span><span>${e.away}</span></div>
        ${
          odds
            ? `<div class="lc-odds">${Object.entries(odds).slice(0, 3).map(([k, v]) => `<div>${k}<br>${Number(v).toFixed(2)}</div>`).join("")}</div>`
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

// ====================== NAVIGATION ======================
function showPage(page) {
  if (pageHistory[pageHistory.length - 1] !== page) pageHistory.push(page);

  ["destaques", "profile", "esportes", "aovivo", "casino", "market"].forEach((p) => {
    const el = document.getElementById("page-" + p);
    if (el) el.classList.toggle("hidden", p !== page);
  });
  document.querySelectorAll(".top-nav-item").forEach((t) => {
    t.classList.toggle("active", t.dataset.page === page);
  });
  document.getElementById("sport-subnav").classList.toggle("hidden", page !== "esportes" && page !== "aovivo");

  const showBack = page !== "destaques";
  document.getElementById("btn-back").classList.toggle("hidden", !showBack);
  document.getElementById("btn-menu").classList.toggle("hidden", showBack && page === "profile");

  if (page === "profile") loadProfile();
  if (page === "aovivo") { renderSportSubnav(); ensureLiveSocket(); }
  if (page === "esportes") { renderSportSubnav(); renderPrematchList(); }
}

function goBack() {
  if (pageHistory.length > 1) {
    pageHistory.pop();
    showPage(pageHistory[pageHistory.length - 1]);
  } else {
    showPage("destaques");
  }
}

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

function playGame(name) {
  if (!Bet62Api.isAuthenticated()) return openAuth("login");
  alert("🎮 Abrindo " + name + " (integração de casino ainda não implementada nesta fase)");
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
    }
    renderLiveEvents();
    if (currentMarketEvent && liveEventsById.has(currentMarketEvent.id)) {
      currentMarketEvent = liveEventsById.get(currentMarketEvent.id);
      if (pageHistory[pageHistory.length - 1] === "market") renderMarketPage();
    }
  };
}

function renderLiveEvents() {
  const container = document.getElementById("live-list");
  const events = [...liveEventsById.values()].filter((e) => !selectedSport || e.sport === selectedSport);
  if (!events.length) {
    container.innerHTML = '<div class="empty-note">Sem eventos ao vivo para este desporto neste momento</div>';
    return;
  }
  const sportIcon = Object.fromEntries(SPORTS_META.map((s) => [s.id, s.icon]));
  container.innerHTML = events
    .map((e) => {
      const odds = e.odds?.[0]?.selections;
      const showScore = e.sport !== "formula1";
      return `
        <div class="live-card" onclick='openMarket(${JSON.stringify(e.id)}, true)'>
          <div class="lc-top"><span>${sportIcon[e.sport] || ""} ${e.league}</span><span>${e.minuteOrPeriod}</span></div>
          <div class="lc-teams">
            <span>${e.home}</span>
            ${showScore ? `<span class="lc-score">${e.homeScore} - ${e.awayScore}</span>` : '<span style="color:var(--muted);font-size:.8rem">AO VIVO</span>'}
            <span>${e.away}</span>
          </div>
          ${
            odds
              ? `<div class="lc-odds">${Object.entries(odds).slice(0, 3).map(([k, v]) => `<div>${k}<br>${Number(v).toFixed(2)}</div>`).join("")}</div>`
              : ""
          }
        </div>`;
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
    Bet62Api.refreshEvent(eventId, event.sport)
      .then((res) => {
        if (pageHistory[pageHistory.length - 1] !== "market" || !currentMarketEvent || currentMarketEvent.id !== eventId) return;
        currentMarketEvent = res.event;
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
  updateBetslipBar();
}

function renderMatchTracker(e) {
  const el = document.getElementById("match-tracker");
  const isLive = e._isLive || e.status === "live";

  if (!isLive) {
    el.innerHTML = `
      <div class="mt-scheduled">
        <span class="status-badge status-pending">PRÉ-JOGO</span>
        <div class="big" style="margin-top:10px">${formatKickoff(e.startTime || e.kickoff)}</div>
        <div style="color:var(--muted);font-size:.82rem;margin-top:6px">${e.home} vs ${e.away}</div>
      </div>`;
    return;
  }

  if (e.sport === "formula1") {
    el.innerHTML = `
      <div class="mt-live"><span class="dot"></span> AO VIVO</div>
      <div style="text-align:center">
        <div style="font-weight:700;font-size:1.05rem">${e.home}</div>
        <div class="mt-period" style="margin-top:8px">${e.minuteOrPeriod}</div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="mt-live"><span class="dot"></span> AO VIVO</div>
    <div class="mt-teams">
      <div class="mt-team">${e.home}</div>
      <div class="mt-score">${e.homeScore} - ${e.awayScore}</div>
      <div class="mt-team">${e.away}</div>
    </div>
    <div class="mt-period">${e.minuteOrPeriod}</div>`;
}

function renderMarketGroups(e) {
  const el = document.getElementById("market-groups");
  if (!e.odds || !e.odds.length) {
    el.innerHTML = '<div class="empty-note">Sem mercados disponíveis para este evento</div>';
    return;
  }
  el.innerHTML = e.odds
    .map((group) => {
      const rows = Object.entries(group.selections)
        .map(([label, odd]) => {
          const key = `${e.id}|${group.market}|${label}`;
          const picked = betslipSelections.has(key);
          return `<div class="selection-btn ${picked ? "picked" : ""}" onclick='toggleSelection(${JSON.stringify(key)}, ${JSON.stringify({ eventId: e.id, market: group.market, selection: label, odd })})'>
            <span class="sel-label">${label}</span><span class="sel-odd">${Number(odd).toFixed(2)}</span>
          </div>`;
        })
        .join("");
      return `<div class="market-group"><h4>${group.market}</h4><div class="selection-row">${rows}</div></div>`;
    })
    .join("");
}

function toggleSelection(key, selection) {
  if (betslipSelections.has(key)) betslipSelections.delete(key);
  else betslipSelections.set(key, selection);
  renderMarketGroups(currentMarketEvent);
  updateBetslipBar();
}

function updateBetslipBar() {
  const n = betslipSelections.size;
  document.getElementById("betslip-count").textContent = n ? `${n} seleção(ões)` : "Nenhuma seleção";
}

function placeBetDemo() {
  if (!Bet62Api.isAuthenticated()) return openAuth("login");
  if (!betslipSelections.size) return alert("Escolha pelo menos uma seleção nos mercados acima.");
  alert(
    `🧾 Boletim com ${betslipSelections.size} seleção(ões).\n\nO motor de apostas (criação de bilhete, cálculo de retorno e liquidação) ainda não foi implementado nesta fase — esta é só a navegação de mercados. As seleções foram mantidas.`
  );
}

// ====================== INIT ======================
(async function init() {
  applyAutoTheme();
  updateHeader();
  showPage("destaques");
  if (Bet62Api.isAuthenticated()) {
    await loadProfile();
  }
})();
