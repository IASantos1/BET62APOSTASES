// Service worker mínimo — existe só para tornar o site instalável como PWA (critério do Chrome/
// Android: precisa de um service worker com um handler "fetch") e dar uma casca offline básica.
// Estratégia "network-first": tenta sempre a rede primeiro e só usa a cópia em cache quando a
// rede falha mesmo (offline) — nunca serve uma cópia desatualizada só porque está em cache. É o
// mesmo cuidado já tomado em server/src/app.ts com os cabeçalhos Cache-Control (ver comentário
// lá) para não prender o utilizador numa versão antiga em modo standalone no iOS/Android.
// Sobe esta versão sempre que app.js/index.html mudarem de forma significativa — força o
// service worker a ser tratado como "novo" (o browser só verifica bytes-diferentes do próprio
// ficheiro service-worker.js de vez em quando; subir a versão aqui garante um novo install/
// activate imediato, o que já se confirmou ser necessário para o modo PWA standalone do iOS não
// prender uma versão antiga durante muito tempo).
const CACHE_NAME = "bet62-shell-v3";
const SHELL_FILES = ["/", "/index.html", "/app.js", "/api.js", "/manifest.json", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Nunca cacheia a API, /config.js (gerado em runtime) nem /admin — só a casca estática da
  // app de jogador. Dados dinâmicos têm de vir sempre da rede.
  if (url.pathname.startsWith("/api/") || url.pathname === "/config.js" || url.pathname.startsWith("/admin")) return;

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match("/index.html")))
  );
});
