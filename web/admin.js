/**
 * Painel administrativo do Bet62 — SPA própria, sem build step (mesmo estilo do app.js do
 * jogador), com sessão e tokens completamente separados (bet62_admin_* em vez de bet62_*) para
 * uma conta admin e uma conta de jogador poderem estar autenticadas no mesmo browser ao mesmo
 * tempo sem se pisarem.
 */
const AdminApi = (() => {
  const API_BASE = (window.BET62_CONFIG && window.BET62_CONFIG.API_BASE) || "/api";

  function getTokens() {
    return {
      accessToken: localStorage.getItem("bet62_admin_access_token"),
      refreshToken: localStorage.getItem("bet62_admin_refresh_token"),
    };
  }
  function setTokens(t) {
    if (t.accessToken) localStorage.setItem("bet62_admin_access_token", t.accessToken);
    if (t.refreshToken) localStorage.setItem("bet62_admin_refresh_token", t.refreshToken);
  }
  function clearTokens() {
    localStorage.removeItem("bet62_admin_access_token");
    localStorage.removeItem("bet62_admin_refresh_token");
  }

  let refreshPromise = null;
  async function refreshAccessToken() {
    const { refreshToken } = getTokens();
    if (!refreshToken) throw new Error("Sem refresh token");
    if (!refreshPromise) {
      refreshPromise = fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error("Falha ao renovar sessão");
          const data = await res.json();
          setTokens(data);
          return data;
        })
        .finally(() => {
          refreshPromise = null;
        });
    }
    return refreshPromise;
  }

  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  async function request(path, { method = "GET", body, retry = true } = {}) {
    const headers = { "Content-Type": "application/json" };
    const { accessToken } = getTokens();
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && retry) {
      try {
        await refreshAccessToken();
        return request(path, { method, body, retry: false });
      } catch {
        clearTokens();
        throw new ApiError(401, "UNAUTHORIZED", "Sessão expirada. Inicia sessão novamente.");
      }
    }

    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error ?? { code: "UNKNOWN", message: "Erro desconhecido" };
      throw new ApiError(res.status, err.code, err.message, err.details);
    }
    return data;
  }

  return {
    ApiError,
    isAuthenticated: () => Boolean(getTokens().accessToken),
    clearTokens,
    setTokens,
    login: (identifier, password) => request("/auth/login", { method: "POST", body: { identifier, password } }),

    dashboard: () => request("/admin/dashboard"),

    listUsers: (qs) => request(`/admin/users?${qs}`),
    getUser: (id) => request(`/admin/users/${id}`),
    setUserStatus: (id, status) => request(`/admin/users/${id}/status`, { method: "PATCH", body: { status } }),
    setUserRole: (id, role) => request(`/admin/users/${id}/role`, { method: "PATCH", body: { role } }),
    adjustBalance: (id, amount, reason) => request(`/admin/users/${id}/adjust-balance`, { method: "POST", body: { amount, reason } }),

    listKyc: (qs) => request(`/admin/kyc?${qs}`),
    reviewKyc: (id, status, rejectionReason) => request(`/admin/kyc/${id}`, { method: "PATCH", body: { status, rejectionReason } }),

    listWithdrawals: (qs) => request(`/admin/withdrawals?${qs}`),
    approveWithdrawal: (id) => request(`/admin/withdrawals/${id}/approve`, { method: "POST" }),
    rejectWithdrawal: (id, reason) => request(`/admin/withdrawals/${id}/reject`, { method: "POST", body: { reason } }),

    listDeposits: (qs) => request(`/admin/deposits?${qs}`),

    listSelfExclusions: () => request(`/admin/self-exclusions`),

    listCasinoGames: (qs) => request(`/admin/casino/games?${qs}`),
    setCasinoGameOverride: (code, enabled) => request(`/admin/casino/games/${encodeURIComponent(code)}`, { method: "PATCH", body: { enabled } }),
    listCasinoTx: (qs) => request(`/admin/casino/transactions?${qs}`),

    listAuditLogs: (qs) => request(`/admin/audit-logs?${qs}`),

    getSettings: () => request("/admin/settings"),
    updateSettings: (patch) => request("/admin/settings", { method: "PATCH", body: patch }),
  };
})();

// ====================== UTILS ======================
function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtMoney(v) {
  const n = Number(v);
  return `€ ${Number.isFinite(n) ? n.toFixed(2) : "0.00"}`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("pt-PT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
const BADGE_CLASS = {
  ACTIVE: "ok", APPROVED: "ok", SUCCEEDED: "ok", PAID: "ok",
  SUSPENDED: "warn", PENDING: "warn", IN_REVIEW: "warn", REQUESTED: "warn", UNDER_REVIEW: "warn", PROCESSING: "warn",
  SELF_EXCLUDED: "bad", REJECTED: "bad", FAILED: "bad", CANCELLED: "bad",
  CLOSED: "muted", NOT_STARTED: "muted",
};
function badge(status) {
  const cls = BADGE_CLASS[status] || "muted";
  return `<span class="badge ${cls}">${esc(status || "—")}</span>`;
}
function toast(message, type = "success") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
function openModal(title, bodyHtml) {
  const root = document.getElementById("admin-overlay-root");
  root.innerHTML = `<div class="overlay" onclick="if(event.target===this) AdminApp.closeModal()">
    <div class="overlay-box"><h3>${esc(title)}</h3>${bodyHtml}</div>
  </div>`;
}
function closeModal() {
  document.getElementById("admin-overlay-root").innerHTML = "";
}
function pagerHtml(state, totalKey, reloadFn) {
  const totalPages = Math.max(Math.ceil(state.total / state.limit), 1);
  return `<div class="pager">
    <span>Página ${state.page} de ${totalPages} (${state.total} no total)</span>
    <button class="btn small outline" ${state.page <= 1 ? "disabled" : ""} onclick="${reloadFn}(${state.page - 1})">‹ Anterior</button>
    <button class="btn small outline" ${state.page >= totalPages ? "disabled" : ""} onclick="${reloadFn}(${state.page + 1})">Seguinte ›</button>
  </div>`;
}
async function withBusyButton(btn, fn) {
  if (!btn) return fn();
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "A processar…";
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// ====================== APP ======================
const AdminApp = (() => {
  const state = {
    section: "dashboard",
    users: { page: 1, limit: 20, total: 0, search: "", status: "", role: "" },
    kyc: { page: 1, limit: 20, total: 0, status: "PENDING" },
    withdrawals: { page: 1, limit: 20, total: 0, status: "" },
    deposits: { page: 1, limit: 20, total: 0, status: "" },
    casinoGames: { page: 1, limit: 24, total: 0, search: "", category: "" },
    casinoTxCursor: null,
    auditCursor: null,
  };

  // --- Auth ---

  async function init() {
    if (!AdminApi.isAuthenticated()) return showLogin();
    try {
      await enterShell();
    } catch {
      showLogin();
    }
  }

  function showLogin() {
    document.getElementById("admin-login").classList.remove("hidden");
    document.getElementById("admin-shell").classList.add("hidden");
  }

  async function login() {
    const id = document.getElementById("admin-login-id").value.trim();
    const pw = document.getElementById("admin-login-pw").value;
    const errEl = document.getElementById("admin-login-error");
    errEl.classList.add("hidden");
    if (!id || !pw) return;
    try {
      const tokens = await AdminApi.login(id, pw);
      AdminApi.setTokens(tokens);
      await enterShell();
    } catch (err) {
      AdminApi.clearTokens();
      errEl.textContent =
        err instanceof AdminApi.ApiError && err.status === 403
          ? "Esta conta não tem permissões de administrador."
          : "Credenciais inválidas.";
      errEl.classList.remove("hidden");
    }
  }

  async function enterShell() {
    const me = await AdminApi.dashboard(); // também serve para confirmar role ADMIN (403 se não for)
    document.getElementById("admin-login").classList.add("hidden");
    document.getElementById("admin-shell").classList.remove("hidden");
    document.getElementById("admin-username").textContent =
      document.getElementById("admin-login-id").value.trim() || "admin";
    renderDashboardData(me);
    refreshBadges();
    checkMaintenanceBanner();
  }

  function logout() {
    AdminApi.clearTokens();
    location.reload();
  }

  async function refreshBadges() {
    try {
      const kyc = await AdminApi.listKyc("status=PENDING&limit=1");
      setBadge("badge-kyc", kyc.total);
    } catch {}
    try {
      const wd = await AdminApi.listWithdrawals("status=REQUESTED&limit=1");
      setBadge("badge-withdrawals", wd.total);
    } catch {}
  }
  function setBadge(id, count) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count;
    el.classList.toggle("hidden", !count);
  }
  async function checkMaintenanceBanner() {
    try {
      const settings = await AdminApi.getSettings();
      document.getElementById("maintenance-banner").classList.toggle("hidden", !settings.maintenanceMode);
    } catch {}
  }

  // --- Navigation ---

  const SECTION_TITLES = {
    dashboard: "Dashboard", users: "Utilizadores", kyc: "Verificação KYC", withdrawals: "Levantamentos",
    deposits: "Depósitos", responsible: "Jogo Responsável", casino: "Cassino", audit: "Audit Log", settings: "Definições",
  };
  function showSection(name) {
    state.section = name;
    document.querySelectorAll(".admin-nav-item[data-section]").forEach((el) => el.classList.toggle("active", el.dataset.section === name));
    document.querySelectorAll('.admin-content > section[id^="section-"]').forEach((el) => el.classList.add("hidden"));
    document.getElementById(`section-${name}`).classList.remove("hidden");
    document.getElementById("admin-section-title").textContent = SECTION_TITLES[name] || name;
    const loaders = {
      dashboard: () => AdminApi.dashboard().then(renderDashboardData),
      users: () => loadUsers(1),
      kyc: () => loadKyc(1),
      withdrawals: () => loadWithdrawals(1),
      deposits: () => loadDeposits(1),
      responsible: loadResponsible,
      casino: () => loadCasinoGames(1),
      audit: () => loadAudit(true),
      settings: loadSettings,
    };
    (loaders[name] || (() => {}))().catch((err) => toast(err.message || "Erro ao carregar", "error"));
  }

  // --- Dashboard ---

  function renderDashboardData(d) {
    const el = document.getElementById("section-dashboard");
    el.innerHTML = `
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-label">Utilizadores</div><div class="kpi-value">${d.totalUsers}</div><div class="kpi-sub">${d.activeUsers} ativos · +${d.newUsersToday} hoje</div></div>
        <div class="kpi-card"><div class="kpi-label">Saldo total em carteiras</div><div class="kpi-value">${fmtMoney(d.totalWalletBalance)}</div><div class="kpi-sub">${fmtMoney(d.totalLockedBalance)} bloqueado</div></div>
        <div class="kpi-card"><div class="kpi-label">KYC pendente</div><div class="kpi-value">${d.pendingKyc}</div><div class="kpi-sub">a aguardar revisão</div></div>
        <div class="kpi-card"><div class="kpi-label">Levantamentos pendentes</div><div class="kpi-value">${d.pendingWithdrawals}</div><div class="kpi-sub">revisão AML necessária</div></div>
        <div class="kpi-card"><div class="kpi-label">Depósitos hoje</div><div class="kpi-value">${fmtMoney(d.depositsToday.total)}</div><div class="kpi-sub">${d.depositsToday.count} transações</div></div>
        <div class="kpi-card"><div class="kpi-label">Levantamentos hoje</div><div class="kpi-value">${fmtMoney(d.withdrawalsToday.total)}</div><div class="kpi-sub">${d.withdrawalsToday.count} pagos</div></div>
        <div class="kpi-card"><div class="kpi-label">Transações de cassino hoje</div><div class="kpi-value">${d.casinoTxToday}</div></div>
      </div>
      <div class="panel">
        <h2>Atividade recente</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Quando</th><th>Ação</th><th>Utilizador</th></tr></thead>
          <tbody>${
            d.recentAuditLogs.length
              ? d.recentAuditLogs.map((l) => `<tr><td class="mono">${fmtDate(l.createdAt)}</td><td>${esc(l.action)}</td><td>${esc(l.user?.username || l.user?.email || "—")}</td></tr>`).join("")
              : `<tr><td colspan="3" class="empty-note">Sem atividade registada</td></tr>`
          }</tbody>
        </table></div>
      </div>`;
  }

  // --- Users ---

  async function loadUsers(page) {
    state.users.page = page;
    const search = document.getElementById("users-search")?.value ?? state.users.search;
    const status = document.getElementById("users-status")?.value ?? state.users.status;
    const role = document.getElementById("users-role")?.value ?? state.users.role;
    state.users.search = search;
    state.users.status = status;
    state.users.role = role;

    const qs = new URLSearchParams({ page, limit: state.users.limit });
    if (search) qs.set("search", search);
    if (status) qs.set("status", status);
    if (role) qs.set("role", role);
    const data = await AdminApi.listUsers(qs.toString());
    state.users.total = data.total;
    renderUsers(data.users);
  }

  function renderUsers(users) {
    const el = document.getElementById("section-users");
    el.innerHTML = `
      <div class="panel">
        <div class="toolbar">
          <input id="users-search" type="text" placeholder="Pesquisar nome/email/username/ID" value="${esc(state.users.search)}" onkeydown="if(event.key==='Enter') AdminApp.loadUsers(1)">
          <select id="users-status" onchange="AdminApp.loadUsers(1)">
            <option value="">Todos os estados</option>
            ${["ACTIVE", "SUSPENDED", "SELF_EXCLUDED", "CLOSED"].map((s) => `<option value="${s}" ${state.users.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <select id="users-role" onchange="AdminApp.loadUsers(1)">
            <option value="">Todos os papéis</option>
            ${["USER", "SUPPORT", "ADMIN"].map((r) => `<option value="${r}" ${state.users.role === r ? "selected" : ""}>${r}</option>`).join("")}
          </select>
          <button class="btn small" onclick="AdminApp.loadUsers(1)">Pesquisar</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Utilizador</th><th>Email</th><th>Saldo</th><th>Papel</th><th>Estado</th><th>Registo</th><th></th></tr></thead>
          <tbody>${
            users.length
              ? users
                  .map(
                    (u) => `<tr>
                <td><b>${esc(u.username)}</b><br><span class="mono" style="color:var(--muted)">${esc(u.publicId)}</span></td>
                <td>${esc(u.email)}</td>
                <td class="mono">${fmtMoney(u.wallet?.balance ?? 0)}</td>
                <td>${badge(u.role)}</td>
                <td>${badge(u.status)}</td>
                <td class="mono">${fmtDate(u.createdAt)}</td>
                <td><button class="btn small outline" onclick='AdminApp.openUserDetail(${JSON.stringify(u.id)})'>Ver</button></td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="7" class="empty-note">Nenhum utilizador encontrado</td></tr>`
          }</tbody>
        </table></div>
        ${pagerHtml(state.users, "total", "AdminApp.loadUsers")}
      </div>`;
  }

  async function openUserDetail(id) {
    const u = await AdminApi.getUser(id);
    const kycLatest = u.kycSubmissions[0];
    openModal(
      `${esc(u.username)} — ${esc(u.publicId)}`,
      `
      <div class="detail-grid">
        <div class="detail-item"><div class="k">Email</div><div class="v">${esc(u.email)}</div></div>
        <div class="detail-item"><div class="k">Nome</div><div class="v">${esc(u.name || "—")}</div></div>
        <div class="detail-item"><div class="k">Saldo</div><div class="v">${fmtMoney(u.wallet?.balance ?? 0)}</div></div>
        <div class="detail-item"><div class="k">Bloqueado</div><div class="v">${fmtMoney(u.wallet?.lockedBalance ?? 0)}</div></div>
        <div class="detail-item"><div class="k">Estado</div><div class="v">${badge(u.status)}</div></div>
        <div class="detail-item"><div class="k">Papel</div><div class="v">${badge(u.role)}</div></div>
        <div class="detail-item"><div class="k">KYC</div><div class="v">${badge(kycLatest?.status || "NOT_STARTED")}</div></div>
        <div class="detail-item"><div class="k">País</div><div class="v">${esc(u.country || "—")}</div></div>
      </div>

      <div class="section-title">Ações</div>
      <div class="btn-row">
        <select id="detail-status-select">
          ${["ACTIVE", "SUSPENDED", "CLOSED"].map((s) => `<option value="${s}" ${u.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select>
        <button class="btn small" onclick='AdminApp.applyUserStatus(${JSON.stringify(u.id)})'>Aplicar estado</button>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <select id="detail-role-select">
          ${["USER", "SUPPORT", "ADMIN"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${r}</option>`).join("")}
        </select>
        <button class="btn small" onclick='AdminApp.applyUserRole(${JSON.stringify(u.id)})'>Aplicar papel</button>
      </div>
      <div class="btn-row" style="margin-top:8px">
        <button class="btn small green" onclick='AdminApp.openAdjustBalance(${JSON.stringify(u.id)})'>Ajustar saldo</button>
      </div>

      <div class="section-title">Últimos movimentos</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Quando</th><th>Tipo</th><th>Valor</th><th>Saldo após</th></tr></thead>
        <tbody>${
          u.ledgerEntries.length
            ? u.ledgerEntries.map((l) => `<tr><td class="mono">${fmtDate(l.createdAt)}</td><td>${esc(l.type)}</td><td class="mono">${fmtMoney(l.amount)}</td><td class="mono">${fmtMoney(l.balanceAfter)}</td></tr>`).join("")
            : `<tr><td colspan="4" class="empty-note">Sem movimentos</td></tr>`
        }</tbody>
      </table></div>

      <div class="btn-row" style="margin-top:16px">
        <button class="btn outline" style="width:100%" onclick="AdminApp.closeModal()">Fechar</button>
      </div>`
    );
  }

  async function applyUserStatus(id) {
    const status = document.getElementById("detail-status-select").value;
    try {
      await AdminApi.setUserStatus(id, status);
      toast("Estado atualizado");
      closeModal();
      loadUsers(state.users.page);
    } catch (err) {
      toast(err.message || "Erro ao atualizar estado", "error");
    }
  }
  async function applyUserRole(id) {
    const role = document.getElementById("detail-role-select").value;
    try {
      await AdminApi.setUserRole(id, role);
      toast("Papel atualizado");
      closeModal();
      loadUsers(state.users.page);
    } catch (err) {
      toast(err.message || "Erro ao atualizar papel", "error");
    }
  }

  function openAdjustBalance(id) {
    openModal(
      "Ajustar saldo",
      `
      <div class="field"><label>Valor (positivo credita, negativo debita)</label><input id="adjust-amount" type="number" step="0.01" placeholder="Ex: 50 ou -20"></div>
      <div class="field"><label>Motivo (obrigatório, fica no audit log)</label><textarea id="adjust-reason" placeholder="Ex: bónus de boas-vindas, correção de erro..."></textarea></div>
      <div class="btn-row">
        <button class="btn green" onclick='AdminApp.submitAdjustBalance(${JSON.stringify(id)}, this)'>Confirmar</button>
        <button class="btn outline" onclick="AdminApp.closeModal()">Cancelar</button>
      </div>`
    );
  }
  async function submitAdjustBalance(id, btn) {
    const amount = Number(document.getElementById("adjust-amount").value);
    const reason = document.getElementById("adjust-reason").value.trim();
    if (!amount) return toast("Indica um valor diferente de zero", "error");
    if (reason.length < 3) return toast("Indica o motivo do ajuste", "error");
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.adjustBalance(id, amount, reason);
        toast("Saldo ajustado");
        closeModal();
        loadUsers(state.users.page);
      } catch (err) {
        toast(err.message || "Erro ao ajustar saldo", "error");
      }
    });
  }

  // --- KYC ---

  async function loadKyc(page) {
    state.kyc.page = page;
    const status = document.getElementById("kyc-status")?.value ?? state.kyc.status;
    state.kyc.status = status;
    const qs = new URLSearchParams({ page, limit: state.kyc.limit });
    if (status) qs.set("status", status);
    const data = await AdminApi.listKyc(qs.toString());
    state.kyc.total = data.total;
    renderKyc(data.submissions);
  }

  function renderKyc(submissions) {
    const el = document.getElementById("section-kyc");
    el.innerHTML = `
      <div class="panel">
        <div class="toolbar">
          <select id="kyc-status" onchange="AdminApp.loadKyc(1)">
            <option value="">Todos os estados</option>
            ${["PENDING", "IN_REVIEW", "APPROVED", "REJECTED"].map((s) => `<option value="${s}" ${state.kyc.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Utilizador</th><th>Documento</th><th>Nº</th><th>Estado</th><th>Submetido</th><th></th></tr></thead>
          <tbody>${
            submissions.length
              ? submissions
                  .map(
                    (s) => `<tr>
                <td>${esc(s.user.username)}<br><span style="color:var(--muted);font-size:.78rem">${esc(s.user.email)}</span></td>
                <td>${esc(s.docType)}</td>
                <td class="mono">${esc(s.docNumber)}</td>
                <td>${badge(s.status)}</td>
                <td class="mono">${fmtDate(s.createdAt)}</td>
                <td>${
                  s.status === "PENDING" || s.status === "IN_REVIEW"
                    ? `<div class="btn-row">
                        <button class="btn small green" onclick='AdminApp.approveKyc(${JSON.stringify(s.id)})'>Aprovar</button>
                        <button class="btn small outline" onclick='AdminApp.openRejectKyc(${JSON.stringify(s.id)})'>Rejeitar</button>
                       </div>`
                    : esc(s.rejectionReason || "")
                }</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="6" class="empty-note">Sem submissões</td></tr>`
          }</tbody>
        </table></div>
        ${pagerHtml(state.kyc, "total", "AdminApp.loadKyc")}
      </div>`;
  }

  async function approveKyc(id) {
    try {
      await AdminApi.reviewKyc(id, "APPROVED");
      toast("KYC aprovado");
      loadKyc(state.kyc.page);
      refreshBadges();
    } catch (err) {
      toast(err.message || "Erro ao aprovar KYC", "error");
    }
  }
  function openRejectKyc(id) {
    openModal(
      "Rejeitar verificação KYC",
      `
      <div class="field"><label>Motivo (obrigatório)</label><textarea id="kyc-reject-reason" placeholder="Ex: documento ilegível, dados não coincidem..."></textarea></div>
      <div class="btn-row">
        <button class="btn" onclick='AdminApp.submitRejectKyc(${JSON.stringify(id)}, this)'>Rejeitar</button>
        <button class="btn outline" onclick="AdminApp.closeModal()">Cancelar</button>
      </div>`
    );
  }
  async function submitRejectKyc(id, btn) {
    const reason = document.getElementById("kyc-reject-reason").value.trim();
    if (reason.length < 3) return toast("Indica o motivo da rejeição", "error");
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.reviewKyc(id, "REJECTED", reason);
        toast("KYC rejeitado");
        closeModal();
        loadKyc(state.kyc.page);
        refreshBadges();
      } catch (err) {
        toast(err.message || "Erro ao rejeitar KYC", "error");
      }
    });
  }

  // --- Withdrawals ---

  async function loadWithdrawals(page) {
    state.withdrawals.page = page;
    const status = document.getElementById("withdrawals-status")?.value ?? state.withdrawals.status;
    state.withdrawals.status = status;
    const qs = new URLSearchParams({ page, limit: state.withdrawals.limit });
    if (status) qs.set("status", status);
    const data = await AdminApi.listWithdrawals(qs.toString());
    state.withdrawals.total = data.total;
    renderWithdrawals(data.withdrawals);
  }

  function renderWithdrawals(withdrawals) {
    const el = document.getElementById("section-withdrawals");
    el.innerHTML = `
      <div class="panel">
        <div class="toolbar">
          <select id="withdrawals-status" onchange="AdminApp.loadWithdrawals(1)">
            <option value="">Todos os estados</option>
            ${["REQUESTED", "UNDER_REVIEW", "APPROVED", "PROCESSING", "PAID", "REJECTED", "FAILED"].map((s) => `<option value="${s}" ${state.withdrawals.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Utilizador</th><th>IBAN</th><th>Valor</th><th>Estado</th><th>Pedido em</th><th></th></tr></thead>
          <tbody>${
            withdrawals.length
              ? withdrawals
                  .map(
                    (w) => `<tr>
                <td>${esc(w.user.username)}<br><span style="color:var(--muted);font-size:.78rem">${esc(w.user.email)}</span></td>
                <td class="mono">${esc(w.bankAccount?.iban || "—")}</td>
                <td class="mono">${fmtMoney(w.amount)}</td>
                <td>${badge(w.status)}</td>
                <td class="mono">${fmtDate(w.createdAt)}</td>
                <td>${
                  w.status === "REQUESTED" || w.status === "UNDER_REVIEW"
                    ? `<div class="btn-row">
                        <button class="btn small green" onclick='AdminApp.approveWithdrawal(${JSON.stringify(w.id)}, this)'>Aprovar</button>
                        <button class="btn small outline" onclick='AdminApp.openRejectWithdrawal(${JSON.stringify(w.id)})'>Rejeitar</button>
                       </div>`
                    : esc(w.rejectionReason || "")
                }</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="6" class="empty-note">Sem levantamentos</td></tr>`
          }</tbody>
        </table></div>
        ${pagerHtml(state.withdrawals, "total", "AdminApp.loadWithdrawals")}
      </div>`;
  }

  async function approveWithdrawal(id, btn) {
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.approveWithdrawal(id);
        toast("Levantamento aprovado e pago");
        loadWithdrawals(state.withdrawals.page);
        refreshBadges();
      } catch (err) {
        toast(err.message || "Erro ao aprovar levantamento", "error");
      }
    });
  }
  function openRejectWithdrawal(id) {
    openModal(
      "Rejeitar levantamento",
      `
      <div class="field"><label>Motivo (obrigatório)</label><textarea id="wd-reject-reason" placeholder="Ex: suspeita de fraude, dados bancários inválidos..."></textarea></div>
      <div class="btn-row">
        <button class="btn" onclick='AdminApp.submitRejectWithdrawal(${JSON.stringify(id)}, this)'>Rejeitar</button>
        <button class="btn outline" onclick="AdminApp.closeModal()">Cancelar</button>
      </div>`
    );
  }
  async function submitRejectWithdrawal(id, btn) {
    const reason = document.getElementById("wd-reject-reason").value.trim();
    if (reason.length < 3) return toast("Indica o motivo da rejeição", "error");
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.rejectWithdrawal(id, reason);
        toast("Levantamento rejeitado");
        closeModal();
        loadWithdrawals(state.withdrawals.page);
        refreshBadges();
      } catch (err) {
        toast(err.message || "Erro ao rejeitar levantamento", "error");
      }
    });
  }

  // --- Deposits (read-only) ---

  async function loadDeposits(page) {
    state.deposits.page = page;
    const status = document.getElementById("deposits-status")?.value ?? state.deposits.status;
    state.deposits.status = status;
    const qs = new URLSearchParams({ page, limit: state.deposits.limit });
    if (status) qs.set("status", status);
    const data = await AdminApi.listDeposits(qs.toString());
    state.deposits.total = data.total;
    renderDeposits(data.deposits);
  }

  function renderDeposits(deposits) {
    const el = document.getElementById("section-deposits");
    el.innerHTML = `
      <div class="panel">
        <div class="toolbar">
          <select id="deposits-status" onchange="AdminApp.loadDeposits(1)">
            <option value="">Todos os estados</option>
            ${["PENDING", "PROCESSING", "SUCCEEDED", "FAILED", "CANCELLED"].map((s) => `<option value="${s}" ${state.deposits.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Utilizador</th><th>Método</th><th>Valor</th><th>Estado</th><th>Quando</th></tr></thead>
          <tbody>${
            deposits.length
              ? deposits
                  .map(
                    (d) => `<tr>
                <td>${esc(d.user.username)}<br><span style="color:var(--muted);font-size:.78rem">${esc(d.user.email)}</span></td>
                <td>${esc(d.provider)}</td>
                <td class="mono">${fmtMoney(d.amount)}</td>
                <td>${badge(d.status)}</td>
                <td class="mono">${fmtDate(d.createdAt)}</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5" class="empty-note">Sem depósitos</td></tr>`
          }</tbody>
        </table></div>
        ${pagerHtml(state.deposits, "total", "AdminApp.loadDeposits")}
      </div>`;
  }

  // --- Responsible gambling ---

  async function loadResponsible() {
    const exclusions = await AdminApi.listSelfExclusions();
    const el = document.getElementById("section-responsible");
    el.innerHTML = `
      <div class="panel">
        <h2>Autoexclusões ativas</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Utilizador</th><th>Desde</th><th>Até</th><th>Motivo</th></tr></thead>
          <tbody>${
            exclusions.length
              ? exclusions
                  .map(
                    (x) => `<tr>
                <td>${esc(x.user.username)}<br><span style="color:var(--muted);font-size:.78rem">${esc(x.user.email)}</span></td>
                <td class="mono">${fmtDate(x.startAt)}</td>
                <td class="mono">${x.endAt ? fmtDate(x.endAt) : "Permanente"}</td>
                <td>${esc(x.reason || "—")}</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="4" class="empty-note">Sem autoexclusões ativas</td></tr>`
          }</tbody>
        </table></div>
      </div>`;
  }

  // --- Casino ---

  let casinoTab = "games";
  function setCasinoTab(tab) {
    casinoTab = tab;
    if (tab === "games") loadCasinoGames(1);
    else loadCasinoTx(true);
  }

  async function loadCasinoGames(page) {
    state.casinoGames.page = page;
    const search = document.getElementById("casino-search")?.value ?? state.casinoGames.search;
    state.casinoGames.search = search;
    const qs = new URLSearchParams({ page, limit: state.casinoGames.limit });
    if (search) qs.set("search", search);
    const data = await AdminApi.listCasinoGames(qs.toString());
    state.casinoGames.total = data.total;
    renderCasino("games", data.games);
  }

  async function loadCasinoTx(reset) {
    if (reset) state.casinoTxCursor = null;
    const qs = new URLSearchParams({ limit: 30 });
    if (state.casinoTxCursor) qs.set("cursor", state.casinoTxCursor);
    const data = await AdminApi.listCasinoTx(qs.toString());
    state.casinoTxCursor = data.nextCursor;
    renderCasino("tx", data.entries, Boolean(data.nextCursor));
  }

  function renderCasino(tab, rows, hasMore) {
    casinoTab = tab;
    const el = document.getElementById("section-casino");
    const tabsHtml = `<div class="toolbar">
      <button class="btn small ${tab === "games" ? "" : "outline"}" onclick="AdminApp.setCasinoTab('games')">Jogos</button>
      <button class="btn small ${tab === "tx" ? "" : "outline"}" onclick="AdminApp.setCasinoTab('tx')">Transações</button>
    </div>`;

    if (tab === "games") {
      el.innerHTML = `<div class="panel">
        ${tabsHtml}
        <div class="toolbar">
          <input id="casino-search" type="text" placeholder="Pesquisar jogo" value="${esc(state.casinoGames.search)}" onkeydown="if(event.key==='Enter') AdminApp.loadCasinoGames(1)">
          <button class="btn small" onclick="AdminApp.loadCasinoGames(1)">Pesquisar</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Jogo</th><th>Categoria</th><th>Catálogo</th><th>Override</th><th>Estado efetivo</th><th></th></tr></thead>
          <tbody>${rows
            .map(
              (g) => `<tr>
                <td><b>${esc(g.gameName)}</b><br><span class="mono" style="color:var(--muted)">${esc(g.gameCode)}</span></td>
                <td>${esc(g.category)}</td>
                <td>${g.catalogEnabled ? badge("ACTIVE") : badge("CLOSED")}</td>
                <td>${g.overrideEnabled === null ? '<span class="badge muted">—</span>' : g.overrideEnabled ? badge("ACTIVE") : badge("CLOSED")}</td>
                <td>${g.effectiveEnabled ? badge("ACTIVE") : badge("CLOSED")}</td>
                <td>
                  ${
                    g.effectiveEnabled
                      ? `<button class="btn small outline" onclick='AdminApp.toggleGame(${JSON.stringify(g.gameCode)}, false)'>Desativar</button>`
                      : `<button class="btn small green" onclick='AdminApp.toggleGame(${JSON.stringify(g.gameCode)}, true)'>Ativar</button>`
                  }
                </td>
              </tr>`
            )
            .join("")}</tbody>
        </table></div>
        ${pagerHtml(state.casinoGames, "total", "AdminApp.loadCasinoGames")}
      </div>`;
    } else {
      el.innerHTML = `<div class="panel">
        ${tabsHtml}
        <div class="table-wrap"><table>
          <thead><tr><th>Quando</th><th>Utilizador</th><th>Tipo</th><th>Jogo</th><th>Valor</th></tr></thead>
          <tbody>${
            rows.length
              ? rows
                  .map(
                    (t) => `<tr>
                <td class="mono">${fmtDate(t.createdAt)}</td>
                <td>${esc(t.wallet?.user?.username || "—")}</td>
                <td>${badge(t.type)}</td>
                <td class="mono">${esc(t.gameCode)}</td>
                <td class="mono">${fmtMoney(t.amount)}</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5" class="empty-note">Sem transações</td></tr>`
          }</tbody>
        </table></div>
        <div class="pager"><button class="btn small outline" ${hasMore ? "" : "disabled"} onclick="AdminApp.loadCasinoTx(false)">Carregar mais</button></div>
      </div>`;
    }
  }

  async function toggleGame(code, enabled) {
    try {
      await AdminApi.setCasinoGameOverride(code, enabled);
      toast(enabled ? "Jogo ativado" : "Jogo desativado");
      loadCasinoGames(state.casinoGames.page);
    } catch (err) {
      toast(err.message || "Erro ao atualizar jogo", "error");
    }
  }

  // --- Audit log ---

  async function loadAudit(reset) {
    if (reset) state.auditCursor = null;
    const userId = document.getElementById("audit-user")?.value.trim() || undefined;
    const action = document.getElementById("audit-action")?.value.trim() || undefined;
    const qs = new URLSearchParams({ limit: 50 });
    if (userId) qs.set("userId", userId);
    if (action) qs.set("action", action);
    if (!reset && state.auditCursor) qs.set("cursor", state.auditCursor);
    const data = await AdminApi.listAuditLogs(qs.toString());
    state.auditCursor = data.nextCursor;
    renderAudit(data.entries, Boolean(data.nextCursor), reset);
  }

  function renderAudit(entries, hasMore, reset) {
    const el = document.getElementById("section-audit");
    const tbody = entries
      .map(
        (l) => `<tr>
          <td class="mono">${fmtDate(l.createdAt)}</td>
          <td>${esc(l.action)}</td>
          <td>${esc(l.user?.username || l.user?.email || "sistema")}</td>
          <td class="mono" style="max-width:320px;overflow-wrap:anywhere">${esc(JSON.stringify(l.metadata || {}))}</td>
        </tr>`
      )
      .join("");

    if (reset || !el.querySelector("tbody")) {
      el.innerHTML = `<div class="panel">
        <div class="toolbar">
          <input id="audit-user" type="text" placeholder="ID de utilizador (opcional)" onkeydown="if(event.key==='Enter') AdminApp.loadAudit(true)">
          <input id="audit-action" type="text" placeholder="Filtrar por ação (ex: KYC)" onkeydown="if(event.key==='Enter') AdminApp.loadAudit(true)">
          <button class="btn small" onclick="AdminApp.loadAudit(true)">Filtrar</button>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>Quando</th><th>Ação</th><th>Utilizador</th><th>Detalhes</th></tr></thead>
          <tbody>${tbody || `<tr><td colspan="4" class="empty-note">Sem registos</td></tr>`}</tbody>
        </table></div>
        <div class="pager"><button class="btn small outline" ${hasMore ? "" : "disabled"} onclick="AdminApp.loadAudit(false)">Carregar mais</button></div>
      </div>`;
    } else {
      el.querySelector("tbody").insertAdjacentHTML("beforeend", tbody);
      el.querySelector(".pager button").disabled = !hasMore;
    }
  }

  // --- Settings ---

  async function loadSettings() {
    const s = await AdminApi.getSettings();
    const el = document.getElementById("section-settings");
    el.innerHTML = `
      <div class="panel">
        <h2>Modo de manutenção</h2>
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
          <input type="checkbox" id="setting-maintenance" ${s.maintenanceMode ? "checked" : ""} style="width:18px;height:18px">
          Bloquear a plataforma para jogadores (a API responde 503 exceto login/refresh/logout e este painel)
        </label>
      </div>
      <div class="panel">
        <h2>Limites por omissão</h2>
        <div class="detail-grid">
          <div class="field"><label>Depósito mínimo (€)</label><input id="setting-minDepositEur" type="number" step="1" value="${s.minDepositEur}"></div>
          <div class="field"><label>Depósito máximo (€)</label><input id="setting-maxDepositEur" type="number" step="1" value="${s.maxDepositEur}"></div>
          <div class="field"><label>Levantamento mínimo (€)</label><input id="setting-minWithdrawalEur" type="number" step="1" value="${s.minWithdrawalEur}"></div>
          <div class="field"><label>Levantamento máximo (€)</label><input id="setting-maxWithdrawalEur" type="number" step="1" value="${s.maxWithdrawalEur}"></div>
          <div class="field"><label>KYC obrigatório acima de (€)</label><input id="setting-kycRequiredAboveEur" type="number" step="1" value="${s.kycRequiredAboveEur}"></div>
        </div>
        <div class="field-hint" style="margin-bottom:10px">Nota: estes limites ainda não estão ligados à validação dos pedidos de depósito/levantamento — ficam guardados e visíveis aqui, prontos a ligar quando esse trabalho avançar.</div>
        <button class="btn" onclick="AdminApp.saveSettings(this)">Guardar definições</button>
      </div>`;
  }

  async function saveSettings(btn) {
    const patch = {
      maintenanceMode: document.getElementById("setting-maintenance").checked,
      minDepositEur: Number(document.getElementById("setting-minDepositEur").value),
      maxDepositEur: Number(document.getElementById("setting-maxDepositEur").value),
      minWithdrawalEur: Number(document.getElementById("setting-minWithdrawalEur").value),
      maxWithdrawalEur: Number(document.getElementById("setting-maxWithdrawalEur").value),
      kycRequiredAboveEur: Number(document.getElementById("setting-kycRequiredAboveEur").value),
    };
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.updateSettings(patch);
        toast("Definições guardadas");
        checkMaintenanceBanner();
      } catch (err) {
        toast(err.message || "Erro ao guardar definições", "error");
      }
    });
  }

  return {
    init, login, logout, showSection, closeModal,
    loadUsers, openUserDetail, applyUserStatus, applyUserRole, openAdjustBalance, submitAdjustBalance,
    loadKyc, approveKyc, openRejectKyc, submitRejectKyc,
    loadWithdrawals, approveWithdrawal, openRejectWithdrawal, submitRejectWithdrawal,
    loadDeposits,
    setCasinoTab, loadCasinoGames, loadCasinoTx, toggleGame,
    loadAudit,
    saveSettings,
  };
})();

AdminApp.init();
