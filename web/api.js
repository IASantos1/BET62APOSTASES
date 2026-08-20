/**
 * Cliente HTTP fino para a API do Bet62. Guarda os tokens JWT em localStorage
 * (aceitável para uma demo; para produção, considerar cookies httpOnly + CSRF token,
 * documentado em docs/COMPLIANCE.md) e renova automaticamente o access token
 * usando o refresh token quando uma chamada responde 401.
 */
const Bet62Api = (() => {
  const API_BASE = window.BET62_CONFIG.API_BASE;

  function getTokens() {
    return {
      accessToken: localStorage.getItem("bet62_access_token"),
      refreshToken: localStorage.getItem("bet62_refresh_token"),
    };
  }

  function setTokens(tokens) {
    if (tokens.accessToken) localStorage.setItem("bet62_access_token", tokens.accessToken);
    if (tokens.refreshToken) localStorage.setItem("bet62_refresh_token", tokens.refreshToken);
  }

  function clearTokens() {
    localStorage.removeItem("bet62_access_token");
    localStorage.removeItem("bet62_refresh_token");
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

  async function request(path, { method = "GET", body, auth = true, retry = true } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (auth) {
      const { accessToken } = getTokens();
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
    }

    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && auth && retry) {
      try {
        await refreshAccessToken();
        return request(path, { method, body, auth, retry: false });
      } catch {
        clearTokens();
        throw new ApiError(401, "UNAUTHORIZED", "Sessão expirada. Faça login novamente.");
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

  class ApiError extends Error {
    constructor(status, code, message, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  return {
    ApiError,
    isAuthenticated: () => Boolean(getTokens().accessToken),
    clearTokens,
    setTokens,

    // Auth
    register: (payload) => request("/auth/register", { method: "POST", body: payload, auth: false }),
    login: (identifier, password) =>
      request("/auth/login", { method: "POST", body: { identifier, password }, auth: false }),
    logout: async () => {
      const { refreshToken } = getTokens();
      if (refreshToken) {
        await request("/auth/logout", { method: "POST", body: { refreshToken }, auth: false }).catch(() => {});
      }
      clearTokens();
    },

    // Profile
    getProfile: () => request("/users/me"),
    updatePersonal: (payload) => request("/users/me", { method: "PATCH", body: payload }),
    updatePreferences: (payload) => request("/users/me/preferences", { method: "PATCH", body: payload }),
    submitKyc: (docType, docNumber) => request("/users/me/kyc", { method: "POST", body: { docType, docNumber } }),
    updateLimits: (payload) => request("/users/me/limits", { method: "PATCH", body: payload }),
    selfExclude: (days, reason) => request("/users/me/self-exclusion", { method: "POST", body: { days, reason } }),

    // Wallet
    getBalance: () => request("/wallet/balance"),
    getTransactions: (cursor) => request(`/wallet/transactions${cursor ? `?cursor=${cursor}` : ""}`),

    // Payments
    // Devolve { depositId, checkoutUrl } — checkoutUrl é a página hospedada da própria Stripe
    // (Checkout Session), que já trata do 3DS do cartão, do pedido de telemóvel da MB WAY e da
    // apresentação da entidade/referência Multibanco, sem o frontend precisar de Stripe.js.
    createDeposit: (provider, amountEur) => request("/payments/stripe/deposits", { method: "POST", body: { provider, amountEur } }),
    saveBankAccount: (payload) => request("/payments/revolut/bank-accounts", { method: "POST", body: payload }),
    listBankAccounts: () => request("/payments/revolut/bank-accounts"),
    requestWithdrawal: (amountEur, bankAccountId) =>
      request("/payments/revolut/withdrawals", { method: "POST", body: { amountEur, bankAccountId } }),
    listWithdrawals: () => request("/payments/revolut/withdrawals"),

    // Sports
    getLiveEvents: (sport) => request(`/sports/events${sport ? `?sport=${sport}` : ""}`, { auth: false }),
    getPrematchEvents: (sport) => request(`/sports/prematch?sport=${sport}`, { auth: false }),
    refreshEvent: (eventId, sport) => request(`/sports/events/${encodeURIComponent(eventId)}/refresh?sport=${sport}`, { auth: false }),
    getCompetitions: () => request("/sports/competitions", { auth: false }),
    // Placar/estado/cartões/cantos da Pulsescore + estatísticas complementares da API-Football
    // (posse, remates, faltas, passes...) num único objeto, cada campo com a sua fonte
    // explícita — ver docs/UNIFIED_MATCH_DATA.md. Não usado ainda pelo Match Tracker (que já
    // atualiza score/relógio ao vivo via WebSocket, mais rápido do que um pedido REST desta
    // API conseguiria); disponível para quem precisar de um só pedido com tudo já combinado.
    getUnifiedMatch: (eventId) => request(`/sports/matches/${encodeURIComponent(eventId)}/live`, { auth: false }),
    getH2H: (eventId) => request(`/sports/events/${encodeURIComponent(eventId)}/h2h`, { auth: false }),
    getPredictions: (eventId) => request(`/sports/events/${encodeURIComponent(eventId)}/predictions`, { auth: false }),
    getTeamStats: (eventId) => request(`/sports/events/${encodeURIComponent(eventId)}/stats`, { auth: false }),
    getStandings: (eventId) => request(`/sports/events/${encodeURIComponent(eventId)}/standings`, { auth: false }),

    // Casino
    getCasinoGames: (opts = {}) => {
      const params = new URLSearchParams();
      if (opts.search) params.set("search", opts.search);
      if (opts.category) params.set("category", opts.category);
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.offset) params.set("offset", opts.offset);
      const qs = params.toString();
      return request(`/casino/games${qs ? `?${qs}` : ""}`, { auth: false });
    },
    getCasinoHighlights: () => request("/casino/games/highlighted", { auth: false }),
    launchCasinoGame: (gameCode) => request("/casino/launch", { method: "POST", body: { game_code: gameCode } }),
  };
})();
