// ====================== STATE ======================
let currentProfile = null;
let currentBalance = null;
let pageHistory = ["destaques"];
let selectedDepositMethod = "STRIPE_CARD";
let liveSocket = null;
const liveEventsById = new Map();

// ====================== NAVIGATION ======================
function showPage(page) {
  if (pageHistory[pageHistory.length - 1] !== page) pageHistory.push(page);

  ["destaques", "profile", "esportes", "aovivo", "casino"].forEach((p) => {
    const el = document.getElementById("page-" + p);
    if (el) el.classList.toggle("hidden", p !== page);
  });
  document.querySelectorAll(".top-nav-item").forEach((t) => {
    t.classList.toggle("active", t.dataset.page === page);
  });

  const showBack = page === "profile" || pageHistory.length > 1;
  document.getElementById("btn-back").classList.toggle("hidden", !showBack || page === "destaques");
  document.getElementById("btn-menu").classList.toggle("hidden", showBack && page === "profile");

  if (page === "profile") loadProfile();
  if (page === "aovivo") ensureLiveSocket();
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
      container.innerHTML = '<div style="color:var(--muted);font-size:.8rem;text-align:center;padding:10px 0">Sem levantamentos ainda</div>';
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
    const result = await Bet62Api.createDeposit(selectedDepositMethod, amountEur, phone || undefined);
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
  liveSocket = new WebSocket(`${window.BET62_CONFIG.WS_BASE}/ws/live?sports=football,tennis,basketball`);

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
  };
}

function renderLiveEvents() {
  const container = document.getElementById("live-list");
  const events = [...liveEventsById.values()];
  if (!events.length) {
    container.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px 0">Sem eventos ao vivo neste momento</div>';
    return;
  }
  const sportIcon = { football: "⚽", tennis: "🎾", basketball: "🏀" };
  container.innerHTML = events
    .map((e) => {
      const odds = e.odds?.[0]?.selections;
      return `
        <div class="live-card">
          <div class="lc-top"><span>${sportIcon[e.sport] || ""} ${e.league}</span><span>${e.minuteOrPeriod}</span></div>
          <div class="lc-teams">
            <span>${e.home}</span>
            <span class="lc-score">${e.homeScore} - ${e.awayScore}</span>
            <span>${e.away}</span>
          </div>
          ${
            odds
              ? `<div class="lc-odds">
                  <div>1<br>${odds.home?.toFixed ? odds.home.toFixed(2) : odds.home}</div>
                  <div>X<br>${odds.draw?.toFixed ? odds.draw.toFixed(2) : odds.draw ?? "-"}</div>
                  <div>2<br>${odds.away?.toFixed ? odds.away.toFixed(2) : odds.away}</div>
                </div>`
              : ""
          }
        </div>`;
    })
    .join("");
}

// ====================== INIT ======================
(async function init() {
  updateHeader();
  showPage("destaques");
  if (Bet62Api.isAuthenticated()) {
    await loadProfile();
  }
})();
