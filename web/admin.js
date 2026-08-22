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

    listCasinoGames: (qs) => request(`/admin/casino/games?${qs}`),
    syncCasinoGames: () => request("/admin/casino/games/sync", { method: "POST" }),
    getCasinoAgentInfo: () => request("/admin/casino/agent-info"),
    provisionCasinoAccount: (userId) => request("/admin/casino/accounts/provision", { method: "POST", body: { userId } }),

    listSelfExclusions: () => request(`/admin/self-exclusions`),

    listAuditLogs: (qs) => request(`/admin/audit-logs?${qs}`),

    getSettings: () => request("/admin/settings"),
    updateSettings: (patch) => request("/admin/settings", { method: "PATCH", body: patch }),

    listTeamMappings: (qs) => request(`/admin/mapping/teams?${qs}`),
    correctTeamMapping: (id, apiFootballTeamId, apiFootballName) =>
      request(`/admin/mapping/teams/${id}`, { method: "PATCH", body: { apiFootballTeamId, apiFootballName } }),
    resetTeamMapping: (id) => request(`/admin/mapping/teams/${id}`, { method: "DELETE" }),

    listLeagueMappings: (qs) => request(`/admin/mapping/leagues?${qs}`),
    correctLeagueMapping: (id, apiFootballLeagueId, apiFootballName, season) =>
      request(`/admin/mapping/leagues/${id}`, { method: "PATCH", body: { apiFootballLeagueId, apiFootballName, season } }),
    resetLeagueMapping: (id) => request(`/admin/mapping/leagues/${id}`, { method: "DELETE" }),

    listFixtureMappings: (qs) => request(`/admin/mapping/fixtures?${qs}`),
    correctFixtureMapping: (id, apiFootballFixtureId) => request(`/admin/mapping/fixtures/${id}`, { method: "PATCH", body: { apiFootballFixtureId } }),
    resetFixtureMapping: (id) => request(`/admin/mapping/fixtures/${id}`, { method: "DELETE" }),

    listMappingAliases: () => request("/admin/mapping/aliases"),
    createMappingAlias: (alias, canonicalName, sport) => request("/admin/mapping/aliases", { method: "POST", body: { alias, canonicalName, sport } }),
    deleteMappingAlias: (id) => request(`/admin/mapping/aliases/${id}`, { method: "DELETE" }),
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
    casino: { page: 1, limit: 20, total: 0 },
    auditCursor: null,
    mappingTeams: { page: 1, limit: 20, total: 0, search: "", maxConfidence: "" },
    mappingLeagues: { page: 1, limit: 20, total: 0, search: "", maxConfidence: "" },
    mappingFixtures: { page: 1, limit: 20, total: 0, maxConfidence: "", unlinkedOnly: false },
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
    try {
      // Abaixo do limiar de ligação automática (70, ver fixtureMatcher.ts) — fila de revisão.
      const fx = await AdminApi.listFixtureMappings("maxConfidence=69&limit=1");
      setBadge("badge-mapping", fx.total);
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
    deposits: "Depósitos", casino: "Cassino", responsible: "Jogo Responsável", mapping: "Mapeamento Pulsescore ↔ API-Football",
    audit: "Audit Log", settings: "Definições",
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
      casino: () => loadCasino(1),
      responsible: loadResponsible,
      mapping: () => loadMappingTeams(1),
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
        <button class="btn small outline" onclick='AdminApp.provisionCasino(${JSON.stringify(u.id)}, this)'>Provisionar conta Cassino</button>
      </div>
      <div class="field-hint" style="margin-top:4px">
        Cria a conta deste utilizador no provedor de Cassino (user/create) — ação real do lado
        deles, não reversível por nós. Só precisa de ser feita uma vez por utilizador.
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

  // Primeiro teste real de user/create desde que a rota /callback ficou pronta (ver
  // casino/accountProvisioning.ts) — cria a conta deste utilizador no provedor de Cassino, se
  // ainda não existir (idempotente: se já houver CasinoAccount para este utilizador, devolve o
  // que já existe em vez de tentar criar outra vez).
  async function provisionCasino(id, btn) {
    await withBusyButton(btn, async () => {
      try {
        const result = await AdminApi.provisionCasinoAccount(id);
        toast(`Conta Cassino provisionada: ${result.account}`);
        // A resposta crua de user/create nunca foi vista com sucesso antes — mostrar aqui em vez
        // de só no toast, para se poder ler/copiar com calma e confirmar se traz o user_code que
        // o lançamento de jogo (game-url) precisa (ver docs/CASINO_SLOTS.md).
        if (result.providerResult) {
          openModal(
            "Resposta do provedor (user/create)",
            `<pre style="white-space:pre-wrap;word-break:break-all;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;font-size:.8rem">${esc(JSON.stringify(result.providerResult, null, 2))}</pre>
            <div class="btn-row" style="margin-top:16px">
              <button class="btn outline" style="width:100%" onclick="AdminApp.closeModal()">Fechar</button>
            </div>`
          );
        }
      } catch (err) {
        toast(err.message || "Erro ao provisionar conta Cassino", "error");
      }
    });
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

  // --- Cassino ---
  // O catálogo local (server/src/modules/casino/catalogSync.ts) é a única fonte da página de
  // Cassino dos jogadores (GET /api/casino/games) — sem sync manual aqui, essa página fica
  // sempre vazia mesmo com CASINO_AGENT_KEY configurada e a funcionar.

  async function loadCasino(page) {
    state.casino.page = page;
    const qs = new URLSearchParams({ page, limit: state.casino.limit });
    const data = await AdminApi.listCasinoGames(qs.toString());
    state.casino.total = data.total;
    renderCasino(data.games);
  }

  function renderCasino(games) {
    const el = document.getElementById("section-casino");
    el.innerHTML = `
      <div class="panel">
        <h2>Catálogo de jogos</h2>
        <div class="field-hint" style="margin-bottom:10px">
          Isto é o que alimenta a página de Cassino dos jogadores — nunca é atualizado sozinho.
          Se essa página estiver a mostrar "Nenhum jogo encontrado", é porque o catálogo local
          está vazio (nunca foi sincronizado) ou desatualizado. Clica no botão abaixo para ir
          buscar o catálogo mais recente ao provedor.
        </div>
        <div class="btn-row">
          <button class="btn" onclick="AdminApp.syncCasino(this)">Sincronizar catálogo agora</button>
          <button class="btn outline" onclick="AdminApp.showCasinoAgentInfo(this)">Ver informação do agente</button>
        </div>
      </div>
      <div class="panel">
        <h2>Jogos no catálogo local (${state.casino.total})</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Nome</th><th>Provedor</th><th>Código</th><th>Categoria</th><th>Ativo</th></tr></thead>
          <tbody>${
            games.length
              ? games
                  .map(
                    (g) => `<tr>
                <td>${esc(g.localeName || g.gameName)}</td>
                <td class="mono">${g.providerId}</td>
                <td class="mono">${esc(g.gameCode)}</td>
                <td>${esc(g.category)}</td>
                <td>${g.launchEnable ? '<span class="badge ok">Sim</span>' : '<span class="badge bad">Não</span>'}</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5" class="empty-note">Catálogo vazio — clica em "Sincronizar catálogo agora" acima</td></tr>`
          }</tbody>
        </table></div>
        ${pagerHtml(state.casino, "total", "AdminApp.loadCasino")}
      </div>`;
  }

  async function syncCasino(btn) {
    await withBusyButton(btn, async () => {
      try {
        const result = await AdminApi.syncCasinoGames();
        toast(`Catálogo sincronizado: ${result.totalGames} jogos`);
        loadCasino(1);
      } catch (err) {
        toast(err.message || "Erro ao sincronizar catálogo — verifica CASINO_AGENT_KEY", "error");
      }
    });
  }

  // Diagnóstico para quando o sync devolve 0 jogos sem erro nenhum (autenticação aceite, mas
  // conta "vazia") — mostra a que conta de agente a CASINO_AGENT_KEY em produção pertence mesmo
  // (nome/saldo) e o IP com que o Railway está a sair (client_ip), para comparar com o painel do
  // goldslotpalase.com (chave errada/de outra conta, ou IP não autorizado, dão exatamente este
  // sintoma sem nenhum erro explícito).
  async function showCasinoAgentInfo(btn) {
    await withBusyButton(btn, async () => {
      try {
        const info = await AdminApi.getCasinoAgentInfo();
        openModal(
          "Informação do agente Cassino",
          `
          <div class="detail-grid">
            <div class="detail-item"><div class="k">Nome do agente</div><div class="v">${esc(info.name)}</div></div>
            <div class="detail-item"><div class="k">Saldo</div><div class="v">${esc(info.balance)} (moeda ${esc(info.currency)})</div></div>
            <div class="detail-item"><div class="k">RTP</div><div class="v">${esc(info.rtp)}</div></div>
            <div class="detail-item"><div class="k">IP de saída (client_ip)</div><div class="v mono">${esc(info.client_ip || "—")}</div></div>
            <div class="detail-item"><div class="k">Whitelist de IPs</div><div class="v mono">${info.whitelist && info.whitelist.length ? info.whitelist.map(esc).join(", ") : "—"}</div></div>
          </div>
          <div class="field-hint" style="margin-top:10px">
            Se "IP de saída" não estiver na "Whitelist de IPs" (quando esta não está vazia), é
            preciso adicioná-lo no painel do goldslotpalase.com. Se o nome do agente não for o que
            esperavas, a CASINO_AGENT_KEY em produção é de outra conta — confirma-a no Railway.
          </div>
          <div class="btn-row" style="margin-top:16px">
            <button class="btn outline" style="width:100%" onclick="AdminApp.closeModal()">Fechar</button>
          </div>`
        );
      } catch (err) {
        toast(err.message || "Erro ao obter informação do agente", "error");
      }
    });
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

  // --- Mapeamento Pulsescore <-> API-Football (docs/TEAM_MAPPING.md) ---
  // Sub-abas: Equipas / Ligas / Fixtures (fila de revisão, confiança < 70 — ver
  // fixtureMatcher.ts::MIN_CONFIDENCE_TO_LINK) / Aliases (dicionário editável sem deploy).

  let mappingTab = "teams";
  function setMappingTab(tab) {
    mappingTab = tab;
    const loaders = { teams: () => loadMappingTeams(1), leagues: () => loadMappingLeagues(1), fixtures: () => loadMappingFixtures(1), aliases: loadMappingAliases };
    loaders[tab]();
  }

  function confidenceBadge(n) {
    const cls = n >= 70 ? "ok" : n >= 40 ? "warn" : "bad";
    return `<span class="badge ${cls}">${n}%</span>`;
  }

  function mappingTabsHtml() {
    return `<div class="toolbar">
      ${["teams", "leagues", "fixtures", "aliases"]
        .map(
          (t) =>
            `<button class="btn small ${mappingTab === t ? "" : "outline"}" onclick="AdminApp.setMappingTab('${t}')">${
              { teams: "Equipas", leagues: "Ligas", fixtures: "Fixtures", aliases: "Aliases" }[t]
            }</button>`
        )
        .join("")}
    </div>`;
  }

  async function loadMappingTeams(page) {
    mappingTab = "teams";
    state.mappingTeams.page = page;
    const search = document.getElementById("mapping-teams-search")?.value ?? state.mappingTeams.search;
    const maxConfidence = document.getElementById("mapping-teams-maxconf")?.value ?? state.mappingTeams.maxConfidence;
    state.mappingTeams.search = search;
    state.mappingTeams.maxConfidence = maxConfidence;
    const qs = new URLSearchParams({ page, limit: state.mappingTeams.limit });
    if (search) qs.set("search", search);
    if (maxConfidence !== "") qs.set("maxConfidence", maxConfidence);
    const data = await AdminApi.listTeamMappings(qs.toString());
    state.mappingTeams.total = data.total;
    renderMappingTeams(data.mappings);
  }

  function renderMappingTeams(rows) {
    const el = document.getElementById("section-mapping");
    el.innerHTML = `<div class="panel">
      ${mappingTabsHtml()}
      <div class="toolbar">
        <input id="mapping-teams-search" type="text" placeholder="Pesquisar nome" value="${esc(state.mappingTeams.search)}" onkeydown="if(event.key==='Enter') AdminApp.loadMappingTeams(1)">
        <select id="mapping-teams-maxconf" onchange="AdminApp.loadMappingTeams(1)">
          <option value="" ${state.mappingTeams.maxConfidence === "" ? "selected" : ""}>Todas as confianças</option>
          <option value="69" ${state.mappingTeams.maxConfidence === "69" ? "selected" : ""}>Só fila de revisão (&lt;70%)</option>
        </select>
        <button class="btn small" onclick="AdminApp.loadMappingTeams(1)">Filtrar</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Pulsescore</th><th>API-Football</th><th>Confiança</th><th>Método</th><th></th></tr></thead>
        <tbody>${
          rows.length
            ? rows
                .map(
                  (m) => `<tr>
              <td>${esc(m.pulsescoreName)}<br><span style="color:var(--muted);font-size:.75rem">${esc(m.sport)}</span></td>
              <td>${m.apiFootballName ? `${esc(m.apiFootballName)} <span class="mono" style="color:var(--muted)">#${m.apiFootballTeamId}</span>` : '<span class="badge muted">sem correspondência</span>'}</td>
              <td>${confidenceBadge(m.confidence)}</td>
              <td>${badge(m.mappingMethod)}${m.verified ? " ✔" : ""}</td>
              <td><div class="btn-row">
                <button class="btn small outline" onclick='AdminApp.openCorrectTeam(${JSON.stringify(m.id)}, ${JSON.stringify(m.pulsescoreName)})'>Corrigir</button>
                <button class="btn small outline" onclick='AdminApp.resetMapping("team", ${JSON.stringify(m.id)})'>Reset</button>
              </div></td>
            </tr>`
                )
                .join("")
            : `<tr><td colspan="5" class="empty-note">Nenhum mapping encontrado</td></tr>`
        }</tbody>
      </table></div>
      ${pagerHtml(state.mappingTeams, "total", "AdminApp.loadMappingTeams")}
    </div>`;
  }

  function openCorrectTeam(id, pulsescoreName) {
    openModal(
      `Corrigir: ${esc(pulsescoreName)}`,
      `
      <div class="field"><label>ID da equipa na API-Football</label><input id="correct-team-id" type="number" placeholder="Ex: 33"></div>
      <div class="field"><label>Nome oficial na API-Football</label><input id="correct-team-name" type="text" placeholder="Ex: Manchester United"></div>
      <div class="field-hint" style="margin-bottom:10px">A correção manual fica marcada como verificada e nunca é substituída automaticamente.</div>
      <div class="btn-row">
        <button class="btn green" onclick='AdminApp.submitCorrectTeam(${JSON.stringify(id)}, this)'>Guardar</button>
        <button class="btn outline" onclick="AdminApp.closeModal()">Cancelar</button>
      </div>`
    );
  }
  async function submitCorrectTeam(id, btn) {
    const teamId = Number(document.getElementById("correct-team-id").value);
    const name = document.getElementById("correct-team-name").value.trim();
    if (!teamId || !name) return toast("Indica o id e o nome da equipa", "error");
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.correctTeamMapping(id, teamId, name);
        toast("Mapping corrigido");
        closeModal();
        loadMappingTeams(state.mappingTeams.page);
      } catch (err) {
        toast(err.message || "Erro ao corrigir mapping", "error");
      }
    });
  }

  async function resetMapping(kind, id) {
    if (!confirm("Apagar este mapping? A próxima vez que aparecer, o sistema tenta resolvê-lo outra vez do zero.")) return;
    try {
      if (kind === "team") await AdminApi.resetTeamMapping(id);
      else if (kind === "league") await AdminApi.resetLeagueMapping(id);
      else await AdminApi.resetFixtureMapping(id);
      toast("Mapping reiniciado");
      setMappingTab(mappingTab);
    } catch (err) {
      toast(err.message || "Erro ao reiniciar mapping", "error");
    }
  }

  async function loadMappingLeagues(page) {
    mappingTab = "leagues";
    state.mappingLeagues.page = page;
    const search = document.getElementById("mapping-leagues-search")?.value ?? state.mappingLeagues.search;
    state.mappingLeagues.search = search;
    const qs = new URLSearchParams({ page, limit: state.mappingLeagues.limit });
    if (search) qs.set("search", search);
    const data = await AdminApi.listLeagueMappings(qs.toString());
    state.mappingLeagues.total = data.total;
    renderMappingLeagues(data.mappings);
  }

  function renderMappingLeagues(rows) {
    const el = document.getElementById("section-mapping");
    el.innerHTML = `<div class="panel">
      ${mappingTabsHtml()}
      <div class="toolbar">
        <input id="mapping-leagues-search" type="text" placeholder="Pesquisar nome" value="${esc(state.mappingLeagues.search)}" onkeydown="if(event.key==='Enter') AdminApp.loadMappingLeagues(1)">
        <button class="btn small" onclick="AdminApp.loadMappingLeagues(1)">Filtrar</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Pulsescore</th><th>API-Football</th><th>Época</th><th>Confiança</th><th>Método</th><th></th></tr></thead>
        <tbody>${
          rows.length
            ? rows
                .map(
                  (m) => `<tr>
              <td>${esc(m.pulsescoreName)}</td>
              <td>${m.apiFootballName ? `${esc(m.apiFootballName)} <span class="mono" style="color:var(--muted)">#${m.apiFootballLeagueId}</span>` : '<span class="badge muted">sem correspondência</span>'}</td>
              <td class="mono">${m.season ?? "—"}</td>
              <td>${confidenceBadge(m.confidence)}</td>
              <td>${badge(m.mappingMethod)}${m.verified ? " ✔" : ""}</td>
              <td><div class="btn-row">
                <button class="btn small outline" onclick='AdminApp.openCorrectLeague(${JSON.stringify(m.id)}, ${JSON.stringify(m.pulsescoreName)})'>Corrigir</button>
                <button class="btn small outline" onclick='AdminApp.resetMapping("league", ${JSON.stringify(m.id)})'>Reset</button>
              </div></td>
            </tr>`
                )
                .join("")
            : `<tr><td colspan="6" class="empty-note">Nenhum mapping encontrado</td></tr>`
        }</tbody>
      </table></div>
      ${pagerHtml(state.mappingLeagues, "total", "AdminApp.loadMappingLeagues")}
    </div>`;
  }

  function openCorrectLeague(id, pulsescoreName) {
    openModal(
      `Corrigir: ${esc(pulsescoreName)}`,
      `
      <div class="field"><label>ID da liga na API-Football</label><input id="correct-league-id" type="number" placeholder="Ex: 3"></div>
      <div class="field"><label>Nome oficial na API-Football</label><input id="correct-league-name" type="text" placeholder="Ex: UEFA Europa League"></div>
      <div class="field"><label>Época</label><input id="correct-league-season" type="number" placeholder="Ex: 2026"></div>
      <div class="btn-row">
        <button class="btn green" onclick='AdminApp.submitCorrectLeague(${JSON.stringify(id)}, this)'>Guardar</button>
        <button class="btn outline" onclick="AdminApp.closeModal()">Cancelar</button>
      </div>`
    );
  }
  async function submitCorrectLeague(id, btn) {
    const leagueId = Number(document.getElementById("correct-league-id").value);
    const name = document.getElementById("correct-league-name").value.trim();
    const season = Number(document.getElementById("correct-league-season").value);
    if (!leagueId || !name || !season) return toast("Indica o id, o nome e a época da liga", "error");
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.correctLeagueMapping(id, leagueId, name, season);
        toast("Mapping corrigido");
        closeModal();
        loadMappingLeagues(state.mappingLeagues.page);
      } catch (err) {
        toast(err.message || "Erro ao corrigir mapping", "error");
      }
    });
  }

  async function loadMappingFixtures(page) {
    mappingTab = "fixtures";
    state.mappingFixtures.page = page;
    const maxConfidence = document.getElementById("mapping-fixtures-maxconf")?.value ?? state.mappingFixtures.maxConfidence;
    state.mappingFixtures.maxConfidence = maxConfidence;
    const qs = new URLSearchParams({ page, limit: state.mappingFixtures.limit });
    if (maxConfidence !== "") qs.set("maxConfidence", maxConfidence);
    const data = await AdminApi.listFixtureMappings(qs.toString());
    state.mappingFixtures.total = data.total;
    renderMappingFixtures(data.mappings);
  }

  function renderMappingFixtures(rows) {
    const el = document.getElementById("section-mapping");
    el.innerHTML = `<div class="panel">
      ${mappingTabsHtml()}
      <div class="toolbar">
        <select id="mapping-fixtures-maxconf" onchange="AdminApp.loadMappingFixtures(1)">
          <option value="" ${state.mappingFixtures.maxConfidence === "" ? "selected" : ""}>Todas as confianças</option>
          <option value="69" ${state.mappingFixtures.maxConfidence === "69" ? "selected" : ""}>Só fila de revisão (&lt;70%)</option>
        </select>
        <button class="btn small" onclick="AdminApp.loadMappingFixtures(1)">Filtrar</button>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Evento Pulsescore</th><th>Fixture API-Football</th><th>Confiança</th><th>Método</th><th>Motivo</th><th></th></tr></thead>
        <tbody>${
          rows.length
            ? rows
                .map(
                  (m) => `<tr>
              <td class="mono" style="font-size:.78rem">${esc(m.pulsescoreEventKey)}<br>${esc(m.homeTeamMapping?.pulsescoreName || "?")} vs ${esc(m.awayTeamMapping?.pulsescoreName || "?")}</td>
              <td>${m.apiFootballFixtureId ? `<span class="mono">#${m.apiFootballFixtureId}</span>` : '<span class="badge muted">não ligado</span>'}</td>
              <td>${confidenceBadge(m.confidence)}</td>
              <td>${badge(m.mappingMethod)}${m.verified ? " ✔" : ""}</td>
              <td style="max-width:240px;overflow-wrap:anywhere;font-size:.75rem;color:var(--muted)">${esc(m.reason || "")}</td>
              <td><div class="btn-row">
                <button class="btn small outline" onclick='AdminApp.openCorrectFixture(${JSON.stringify(m.id)})'>Corrigir</button>
                <button class="btn small outline" onclick='AdminApp.resetMapping("fixture", ${JSON.stringify(m.id)})'>Reset</button>
              </div></td>
            </tr>`
                )
                .join("")
            : `<tr><td colspan="6" class="empty-note">Nenhum mapping encontrado</td></tr>`
        }</tbody>
      </table></div>
      ${pagerHtml(state.mappingFixtures, "total", "AdminApp.loadMappingFixtures")}
    </div>`;
  }

  function openCorrectFixture(id) {
    openModal(
      "Corrigir fixture",
      `
      <div class="field"><label>ID do fixture na API-Football</label><input id="correct-fixture-id" type="number" placeholder="Ex: 1234567"></div>
      <div class="btn-row">
        <button class="btn green" onclick='AdminApp.submitCorrectFixture(${JSON.stringify(id)}, this)'>Guardar</button>
        <button class="btn outline" onclick="AdminApp.closeModal()">Cancelar</button>
      </div>`
    );
  }
  async function submitCorrectFixture(id, btn) {
    const fixtureId = Number(document.getElementById("correct-fixture-id").value);
    if (!fixtureId) return toast("Indica o id do fixture", "error");
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.correctFixtureMapping(id, fixtureId);
        toast("Fixture corrigido");
        closeModal();
        loadMappingFixtures(state.mappingFixtures.page);
        refreshBadges();
      } catch (err) {
        toast(err.message || "Erro ao corrigir fixture", "error");
      }
    });
  }

  async function loadMappingAliases() {
    mappingTab = "aliases";
    const rows = await AdminApi.listMappingAliases();
    renderMappingAliases(rows);
  }

  function renderMappingAliases(rows) {
    const el = document.getElementById("section-mapping");
    el.innerHTML = `<div class="panel">
      ${mappingTabsHtml()}
      <div class="section-title">Novo alias</div>
      <div class="detail-grid">
        <div class="field"><label>Alias (como aparece na Pulsescore)</label><input id="new-alias-name" type="text" placeholder="Ex: Man Utd"></div>
        <div class="field"><label>Nome canónico (usado para pesquisar na API-Football)</label><input id="new-alias-canonical" type="text" placeholder="Ex: Manchester United"></div>
        <div class="field"><label>Desporto</label><input id="new-alias-sport" type="text" value="football"></div>
      </div>
      <button class="btn" onclick="AdminApp.submitCreateAlias(this)">Adicionar alias</button>

      <div class="section-title">Aliases existentes (${rows.length})</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Alias</th><th>Nome canónico</th><th>Desporto</th><th></th></tr></thead>
        <tbody>${
          rows.length
            ? rows
                .map(
                  (a) => `<tr>
              <td>${esc(a.alias)}</td>
              <td>${esc(a.canonicalName)}</td>
              <td>${esc(a.sport)}</td>
              <td><button class="btn small outline" onclick='AdminApp.deleteAlias(${JSON.stringify(a.id)})'>Remover</button></td>
            </tr>`
                )
                .join("")
            : `<tr><td colspan="4" class="empty-note">Sem aliases</td></tr>`
        }</tbody>
      </table></div>
    </div>`;
  }

  async function submitCreateAlias(btn) {
    const alias = document.getElementById("new-alias-name").value.trim();
    const canonical = document.getElementById("new-alias-canonical").value.trim();
    const sport = document.getElementById("new-alias-sport").value.trim() || "football";
    if (!alias || !canonical) return toast("Indica o alias e o nome canónico", "error");
    await withBusyButton(btn, async () => {
      try {
        await AdminApi.createMappingAlias(alias, canonical, sport);
        toast("Alias adicionado");
        loadMappingAliases();
      } catch (err) {
        toast(err.message || "Erro ao adicionar alias", "error");
      }
    });
  }
  async function deleteAlias(id) {
    try {
      await AdminApi.deleteMappingAlias(id);
      toast("Alias removido");
      loadMappingAliases();
    } catch (err) {
      toast(err.message || "Erro ao remover alias", "error");
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
    loadUsers, openUserDetail, applyUserStatus, applyUserRole, openAdjustBalance, submitAdjustBalance, provisionCasino,
    loadKyc, approveKyc, openRejectKyc, submitRejectKyc,
    loadWithdrawals, approveWithdrawal, openRejectWithdrawal, submitRejectWithdrawal,
    loadDeposits,
    loadCasino, syncCasino, showCasinoAgentInfo,
    setMappingTab, loadMappingTeams, openCorrectTeam, submitCorrectTeam,
    loadMappingLeagues, openCorrectLeague, submitCorrectLeague,
    loadMappingFixtures, openCorrectFixture, submitCorrectFixture, resetMapping,
    loadMappingAliases, submitCreateAlias, deleteAlias,
    loadAudit,
    saveSettings,
  };
})();

AdminApp.init();
