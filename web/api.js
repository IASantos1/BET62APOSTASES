/**
 * Cliente HTTP Bet62. Usa cookies HttpOnly (bet62_access / bet62_refresh) emitidos pelo
 * backend em login/register/refresh para autenticação — NÃO guarda JWTs em localStorage
 * (defesa contra XSS). Para mutações (POST/PATCH/DELETE), lê o token CSRF do cookie
 * bet62_csrf (definido pelo backend em /api/auth/csrf, /api/auth/session ou qualquer
 * resposta autenticada) e envia-o no header X-CSRF-Token — mitigação de CSRF.
 *
 * O modo Bearer Authorization ainda é suportado pelo backend (para admin.js e integrações
 * externas que usam tokens explícitos), mas o cliente principal do jogador NÃO o usa.
 */
const Bet62Api = (() => {
  const API_BASE = window.BET62_CONFIG.API_BASE;
  const CSRF_COOKIE = "bet62_csrf";

  /**
   * @param {string} name
   * @returns {string | null}
   */
  function readCookie(name) {
    const match = document.cookie.match(
      "(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)"
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  function setCookieForDev(name, value) {
    document.cookie = `${name}=${value}; path=/; samesite=lax`;
  }

  /** @type {{ authenticated: boolean; user?: unknown; csrfToken?: string } | null} */
  let cachedSession = null;

  /** @returns {Promise<string>} */
  async function getCsrfToken() {
    const fromCookie = readCookie(CSRF_COOKIE);
    if (fromCookie) return fromCookie;
    try {
      const data = await request("/auth/csrf", { auth: false, retry: false });
      const token = data?.csrfToken;
      if (token) {
        setCookieForDev(CSRF_COOKIE, token);
        return token;
      }
    } catch {}
    return "";
  }

  /** @type {Promise<any> | null} */
  let refreshPromise = null;

  async function refreshAccessToken() {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        const csrf = await getCsrfToken();
        /** @type {Record<string, string>} */
        const headers = { "Content-Type": "application/json" };
        if (csrf) headers["X-CSRF-Token"] = csrf;
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          clearSession();
          throw new Error("Falha ao renovar sessão");
        }
        return res.json().catch(() => ({}));
      })();
      refreshPromise.finally(() => {
        refreshPromise = null;
      });
    }
    return refreshPromise;
  }

  /**
   * @param {string} path
   * @param {{ method?: string; body?: unknown; auth?: boolean; retry?: boolean }} [opts]
   */
  async function request(path, opts = {}) {
    const { method = "GET", body, auth = true, retry = true } = opts;
    /** @type {Record<string, string>} */
    const headers = { "Content-Type": "application/json" };
    if (auth && method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const csrf = await getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }

    const res = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (res.status === 401 && auth && retry) {
      try {
        await refreshAccessToken();
        return request(path, { method, body, auth, retry: false });
      } catch {
        clearSession();
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

  /**
   * @param {string} path
   * @param {FormData} formData
   * @param {boolean} [retry]
   */
  async function requestMultipart(path, formData, retry = true) {
    /** @type {Record<string, string>} */
    const headers = {};
    const csrf = await getCsrfToken();
    if (csrf) headers["X-CSRF-Token"] = csrf;

    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers,
      body: formData,
    });

    if (res.status === 401 && retry) {
      try {
        await refreshAccessToken();
        return requestMultipart(path, formData, false);
      } catch {
        clearSession();
        throw new ApiError(401, "UNAUTHORIZED", "Sessão expirada. Faça login novamente.");
      }
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error ?? { code: "UNKNOWN", message: "Erro desconhecido" };
      throw new ApiError(res.status, err.code, err.message, err.details);
    }
    return data;
  }

  function clearSession() {
    cachedSession = null;
    try {
      document.cookie = "bet62_access=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
      document.cookie = "bet62_refresh=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
    } catch {}
  }

  function migrateOldTokensIfAny() {
    try {
      localStorage.removeItem("bet62_access_token");
      localStorage.removeItem("bet62_refresh_token");
    } catch {}
  }
  migrateOldTokensIfAny();

  class ApiError extends Error {
    /**
     * @param {number} status
     * @param {string} code
     * @param {string} message
     * @param {unknown} [details]
     */
    constructor(status, code, message, details) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  return {
    ApiError,
    clearTokens: clearSession,
    clearSession,

    isAuthenticated: () => {
      if (cachedSession?.authenticated) return true;
      return Boolean(readCookie("bet62_access"));
    },

    getSession: async () => {
      if (cachedSession) return cachedSession;
      try {
        const data = await request("/auth/session", { auth: false, retry: false });
        cachedSession = data;
        return data;
      } catch {
        return { authenticated: false };
      }
    },

    /** @param {unknown} payload */
    register: (payload) =>
      request("/auth/register", { method: "POST", body: payload, auth: false }).then((r) => {
        cachedSession = null;
        return r;
      }),

    /**
     * @param {string} identifier
     * @param {string} password
     */
    login: (identifier, password) =>
      request("/auth/login", {
        method: "POST",
        body: { identifier, password },
        auth: false,
      }).then((r) => {
        cachedSession = null;
        return r;
      }),

    logout: async () => {
      try {
        const csrf = await getCsrfToken();
        /** @type {Record<string, string>} */
        const headers = { "Content-Type": "application/json" };
        if (csrf) headers["X-CSRF-Token"] = csrf;
        await fetch(`${API_BASE}/auth/logout`, {
          method: "POST",
          credentials: "include",
          headers,
          body: JSON.stringify({}),
        }).catch(() => {});
      } catch {}
      clearSession();
    },

    // Profile
    getProfile: () => request("/users/me"),
    /** @param {unknown} payload */
    updatePersonal: (payload) => request("/users/me", { method: "PATCH", body: payload }),
    /** @param {unknown} payload */
    updatePreferences: (payload) =>
      request("/users/me/preferences", { method: "PATCH", body: payload }),
    /**
     * @param {unknown} docType
     * @param {unknown} docNumber
     */
    submitKyc: (docType, docNumber) =>
      request("/users/me/kyc", { method: "POST", body: { docType, docNumber } }),
    /**
     * @param {unknown} type
     * @param {File} file
     */
    uploadKycDocument: (type, file) => {
      const formData = new FormData();
      formData.append("type", String(type));
      formData.append("file", file);
      return requestMultipart("/users/me/kyc/documents", formData);
    },
    listMyKycDocuments: () => request("/users/me/kyc/documents"),
    /** @param {unknown} payload */
    updateLimits: (payload) =>
      request("/users/me/limits", { method: "PATCH", body: payload }),
    /**
     * @param {unknown} days
     * @param {unknown} reason
     */
    selfExclude: (days, reason) =>
      request("/users/me/self-exclusion", { method: "POST", body: { days, reason } }),

    // Wallet
    getBalance: () => request("/wallet/balance"),
    /** @param {string} [cursor] */
    getTransactions: (cursor) =>
      request(`/wallet/transactions${cursor ? `?cursor=${cursor}` : ""}`),

    // Payments
    /**
     * @param {unknown} provider
     * @param {unknown} amountEur
     * @param {unknown} [phone]
     */
    createDeposit: (provider, amountEur, phone) =>
      request("/payments/stripe/deposits", {
        method: "POST",
        body: { provider, amountEur, phone },
      }),
    /** @param {string} depositId */
    getDepositStatus: (depositId) =>
      request(`/payments/stripe/deposits/${encodeURIComponent(depositId)}`),
    /** @param {unknown} payload */
    saveBankAccount: (payload) =>
      request("/payments/revolut/bank-accounts", { method: "POST", body: payload }),
    listBankAccounts: () => request("/payments/revolut/bank-accounts"),
    /**
     * @param {unknown} amountEur
     * @param {unknown} bankAccountId
     */
    requestWithdrawal: (amountEur, bankAccountId) =>
      request("/payments/revolut/withdrawals", {
        method: "POST",
        body: { amountEur, bankAccountId },
      }),
    listWithdrawals: () => request("/payments/revolut/withdrawals"),

    // Apostas
    /**
     * @param {unknown} mode
     * @param {unknown[]} selections
     * @param {unknown} [stake]
     */
    placeBets: (mode, selections, stake) =>
      request("/bets", { method: "POST", body: { mode, selections, stake } }),
    /** @param {string} [cursor] */
    listMyBets: (cursor) =>
      request(`/bets${cursor ? `?cursor=${cursor}` : ""}`),
    /** @param {string} betId */
    getCashOutOffer: (betId) => request(`/bets/${betId}/cashout`),
    /** @param {string} betId */
    cashOutBet: (betId) => request(`/bets/${betId}/cashout`, { method: "POST" }),

    // Sports
    /** @param {string} [sport] */
    getLiveEvents: (sport) =>
      request(`/sports/events${sport ? `?sport=${sport}` : ""}`, { auth: false }),
    /** @param {string} sport */
    getPrematchEvents: (sport) =>
      request(`/sports/prematch?sport=${sport}`, { auth: false }),
    /**
     * @param {string} eventId
     * @param {string} sport
     */
    refreshEvent: (eventId, sport) =>
      request(`/sports/events/${encodeURIComponent(eventId)}/refresh?sport=${sport}`, {
        auth: false,
      }),
    getCompetitions: () => request("/sports/competitions", { auth: false }),
    /** @param {string} eventId */
    getUnifiedMatch: (eventId) =>
      request(`/sports/matches/${encodeURIComponent(eventId)}/live`, { auth: false }),
    /** @param {string} eventId */
    getH2H: (eventId) =>
      request(`/sports/events/${encodeURIComponent(eventId)}/h2h`, { auth: false }),
    /** @param {string} eventId */
    getPredictions: (eventId) =>
      request(`/sports/events/${encodeURIComponent(eventId)}/predictions`, { auth: false }),
    /** @param {string} eventId */
    getTeamStats: (eventId) =>
      request(`/sports/events/${encodeURIComponent(eventId)}/stats`, { auth: false }),
    /** @param {string} eventId */
    getStandings: (eventId) =>
      request(`/sports/events/${encodeURIComponent(eventId)}/standings`, { auth: false }),

    // Cassino
    /**
     * @param {{ page?: number; limit?: number; tag?: string; search?: string; sort?: string }} [opts]
     */
    getCasinoGames: (opts = {}) => {
      const { page, limit, tag, search, sort } = opts;
      const params = new URLSearchParams();
      if (page) params.set("page", String(page));
      if (limit) params.set("limit", String(limit));
      if (tag) params.set("tag", tag);
      if (search) params.set("search", search);
      if (sort) params.set("sort", sort);
      const qs = params.toString();
      return request(`/casino/games${qs ? `?${qs}` : ""}`, { auth: false });
    },
    /** Garante que a conta cassino existe no provedor (idempotente) */
    provisionCasinoAccount: () => request("/casino/account/provision", { method: "POST" }),
    /**
     * Lança um jogo real (chama provisionamento automaticamente se preciso)
     * @param {string} gameCode
     */
    launchCasinoGame: (gameCode) =>
      request(`/casino/games/${encodeURIComponent(gameCode)}/launch`, { method: "POST" }),
  };
})();
