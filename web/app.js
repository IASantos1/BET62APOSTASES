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

function renderSportsMenu() {
  const el = document.getElementById("sports-menu-list");
  if (!el) return;
  el.innerHTML = SPORTS_META.map(
    (s) => `
    <div class="sports-menu-item ${selectedSport === s.id ? "active" : ""}" onclick="selectSport('${s.id}'); if (!['esportes','aovivo'].includes(pageHistory[pageHistory.length - 1])) showPage('esportes'); closeDrawers();">
      ${s.icon} ${s.label}
    </div>`
  ).join("");
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

  const events = realEvents;

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
        <div class="lc-top"><span>${icon[e.sport] || ""} ${e.league}</span><span>${formatKickoff(e.startTime)}</span></div>
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
  closeDrawers();

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
      const showScore = typeof e.homeScore === "number" && typeof e.awayScore === "number";
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
  renderBetslipPanel();
}

function renderMatchTracker(e) {
  const el = document.getElementById("match-tracker");
  const isLive = e._isLive || e.status === "live";

  if (!isLive) {
    el.innerHTML = `
      <div class="mt-scheduled">
        <span class="status-badge status-pending">PRÉ-JOGO</span>
        <div class="big" style="margin-top:10px">${formatKickoff(e.startTime)}</div>
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

  const hasScore = typeof e.homeScore === "number" && typeof e.awayScore === "number";
  el.innerHTML = `
    <div class="mt-live"><span class="dot"></span> AO VIVO</div>
    <div class="mt-teams">
      <div class="mt-team">${e.home}</div>
      ${hasScore ? `<div class="mt-score">${e.homeScore} - ${e.awayScore}</div>` : '<div style="color:var(--muted);font-size:.85rem">vs</div>'}
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
          const selection = { eventId: e.id, market: group.market, selection: label, odd, home: e.home, away: e.away, league: e.league };
          return `<div class="selection-btn ${picked ? "picked" : ""}" onclick='toggleSelection(${JSON.stringify(key)}, ${JSON.stringify(selection)})'>
            <span class="sel-label">${label}</span><span class="sel-odd">${Number(odd).toFixed(2)}</span>
          </div>`;
        })
        .join("");
      return `<div class="market-group"><h4>${group.market}</h4><div class="selection-row">${rows}</div></div>`;
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
  const inlineCount = document.getElementById("betslip-count");
  if (inlineCount) inlineCount.textContent = selections.length ? `${selections.length} seleção(ões)` : "Nenhuma seleção";

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
