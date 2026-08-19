# Dados Desportivos — Sistema Híbrido Pulsescore + API-Football

## Desportos cobertos

Futebol, ténis, basquete, hóquei de gelo, beisebol, voleibol, Fórmula 1 e MMA (8 no total).

⚠️ **Nota sobre o plano Pulsescore**: o plano de 149€ mencionado inicialmente cobria 3 canais
(futebol/ténis/basquete). Expandir para os 8 desportos acima pode exigir um plano superior —
confirmar com a Pulsescore, e ver também a nota sobre slugs por confirmar mais abaixo.

A Fórmula 1 não tem o formato "casa vs fora" dos outros desportos (é uma corrida com vários
pilotos, não um confronto direto). Para não criar uma segunda estrutura de dados só para ela,
o tipo `LiveEvent` é reaproveitado: `home`/`away` guardam o nome do Grande Prémio e o tipo de
sessão, e a grelha de pilotos vai nas seleções do mercado "Vencedor da corrida" — ver
`server/src/modules/sports/mockFeed.ts`. Não há confirmação de que a Pulsescore cubra F1/MMA
neste formato — ver secção seguinte.

## ✅ Contrato Pulsescore confirmado (via exemplo real fornecido)

Ao contrário da primeira versão deste documento, o essencial da integração Pulsescore já não é
suposição — foi confirmado com um pedido/resposta reais fornecidos durante esta construção:

```
GET https://api.pulsescore.net/api/10bet/soccer/leagues?page=1&limit=5
Headers: accept: */*, x-secret: <segredo>, Accept-Encoding: gzip
```

Factos confirmados por este exemplo (não suposição):
- **Host real**: `api.pulsescore.net` — não `.com` como assumido inicialmente.
- **É uma API REST paginada, não um websocket.** Não há nada no exemplo que sugira a existência
  de um produto de streaming — a arquitetura foi ajustada para *polling* em vez de ligação
  persistente (ver `server/src/modules/sports/hybridService.ts`, ciclo a cada 25s).
- **Autenticação**: header `x-secret: <segredo>`, não query param.
- **Forma do caminho**: `/{bookmaker}/{sport}/leagues` — a Pulsescore agrega odds por casa de
  apostas de origem; `10bet` foi a casa usada no exemplo.
- **Paginação**: `?page=&limit=`, resposta com `total/page/limit/totalPages/hasNextPage/hasPrevPage`.
- **Forma da resposta**:
  ```
  { leagues: [{ name, sport, events: [{
      sport, league, eventId, home, away, live, startTime,
      markets: [{ canonicalMarket, rawName, period, isActive, marketId, selections: [
        { canonicalOutcome, rawName, odds, isActive, selectionId, line?, metadata? }
      ]}]
  }]}]}
  ```
- **`live: false`/`live: true` no próprio evento é o que distingue pré-jogo de ao vivo** — não
  é preciso um endpoint nem parâmetro separado para isso. É por isso que
  `server/src/modules/sports/prematch/service.ts` e `hybridService.ts` filtram pelo mesmo
  campo `live` em vez de assumirem uma rota `/live` que nunca foi confirmada.
- `rawName` em cada mercado/seleção já vem pronto a mostrar (ex: "Full Time Result", "Under",
  nome da equipa) — é por isso que `normalizeMarket()` em `pulsescore/client.ts` usa
  `rawName` diretamente como rótulo em vez de inventar tradução própria.
- Existe também `GET /{bookmaker}/{sport}/leagues/{leagueName}/events` para pedir os eventos de
  **uma liga específica pelo nome** (ex: `leagues/Premier%20League/events`), em vez de paginar
  todas as ligas de um desporto. Implementado em `fetchLeagueEvents()` — só o pedido foi
  confirmado, não a resposta, por isso o parsing é defensivo (aceita `{ events: [...] }`,
  `{ league: { events: [...] } }`, ou um array direto). Útil como otimização futura para pedir
  só um conjunto curado de ligas em vez de tudo, mas ainda não está ligado ao polling principal
  em `hybridService.ts` — decidir a lista de ligas a priorizar por desporto é decisão de
  produto, não algo para adivinhar aqui.
- E mais dois: `GET /{bookmaker}/{sport}/events?page=&limit=` (lista plana de eventos, sem
  passar pelas ligas — `fetchEventsFlat()`) e `GET /{bookmaker}/{sport}/events/{eventId}`
  (**um evento específico** — `fetchEventById()`). Este último já está ligado ao frontend: ao
  abrir o Match Tracker de um evento com `source: "pulsescore"`, `openMarket()` em `web/app.js`
  chama `GET /api/sports/events/:id/refresh?sport=` para pedir dados frescos em vez de confiar
  só na última leitura em cache — se falhar, fica com os dados em cache, sem quebrar a UI.
  Também sem resposta confirmada, parsing defensivo (`extractSingleEvent()`).

## ⚠️ Ainda por confirmar

1. **Slugs de desporto** — confirmados: futebol (`soccer`) e ténis (`tennis`, mesmos 3
   endpoints repetidos com este slug, mesma forma). Os restantes 6 (`basketball`,
   `ice-hockey`, `baseball`, `volleyball`, `formula-1`, `mma` em `pulsescore/client.ts`,
   constante `SPORT_SLUGS`) continuam a ser estimativas razoáveis, não confirmadas. Se o slug
   estiver errado, esse desporto simplesmente devolve vazio/404 — o código já trata isso por
   desporto (não derruba o ciclo inteiro), mas os dados não aparecem até o slug certo ser
   confirmado.
2. **Fórmula 1 e MMA podem nem existir** nesta forma "liga → eventos casa/fora" — motorsport
   em particular não encaixa bem no modelo de duas equipas. Confirmar no catálogo da Pulsescore
   se estes desportos estão disponíveis e em que forma.
3. **Payload de um evento `live: true`** — o exemplo fornecido só mostrou eventos `live: false`
   (pré-jogo). Não se sabe se um evento ao vivo traz placar/cronómetro no mesmo payload ou
   nesses mesmos campos. Por agora, `normalizeEvent()` usa `homeScore: 0, awayScore: 0,
   minuteOrPeriod: "AO VIVO"` como placeholder para eventos ao vivo — **atualizar assim que
   houver um exemplo real de evento `live: true`**.
4. **Casa de apostas (`bookmaker`)** — `10bet` foi a usada no exemplo (`PULSESCORE_BOOKMAKER`,
   por defeito `10bet`); pode haver outras disponíveis por desporto que dêem melhor cobertura.
5. **Limites de taxa / custo por pedido** — o polling a cada 25s multiplicado por 8 desportos ×
   até 2 páginas é um volume de pedidos que convém validar contra os limites do plano antes de
   produção (ajustar `POLL_INTERVAL_MS` e `maxPages` em `hybridService.ts` se necessário).

## Arquitetura

```
Pulsescore (REST, polling 25s) ──┐
                                   ├──▶ HybridSportsService ──▶ WebSocket Gateway (/ws/live) ──▶ Frontend (Ao Vivo)
Mock feed (fallback automático)  ──┘         │
                                              └──▶ API-Football (REST, sob pedido) ── estatísticas de futebol

Pulsescore (REST, sob pedido + cache 45s) ──▶ GET /api/sports/prematch?sport= ──▶ Frontend (Esportes/pré-jogo)
```

Ficheiros:
- `server/src/modules/sports/pulsescore/client.ts` — cliente REST da Pulsescore (`fetchEvents`),
  com o contrato confirmado acima.
- `server/src/modules/sports/prematch/service.ts` — expõe os eventos `live:false` (pré-jogo)
  com uma cache de 45s por desporto, para a página Esportes.
- `server/src/modules/sports/apifootball/client.ts` — cliente REST da API-Football, usado só
  para enriquecer eventos de futebol com estatísticas detalhadas.
- `server/src/modules/sports/hybridService.ts` — faz o polling, filtra os eventos `live:true`,
  mantém o snapshot em memória e reemite atualizações (`LiveEvent`, ver `types.ts`). Cai para o
  feed simulado automaticamente se nenhum desporto devolver eventos ao vivo reais num ciclo
  (chave não configurada, provedor em baixo, ou simplesmente sem jogos ao vivo agora).
- `server/src/modules/sports/mockFeed.ts` — gerador de eventos simulados, controlado por
  `SPORTS_DATA_MOCK_FALLBACK=true`. **Isto é o que permite testar e demonstrar a plataforma de
  ponta a ponta sem pagar a Pulsescore já.**
- `server/src/modules/sports/websocket/gateway.ts` — expõe `/ws/live?sports=football,tennis`
  para o frontend consumir; envia um snapshot inicial e depois um stream de atualizações. Isto
  é interno ao Bet62 (browser ↔ nosso servidor) — não confundir com a ligação real à
  Pulsescore, que é REST/polling do lado do servidor.

## API-Football — o que ainda precisa de confirmação

- Autenticação assumida via header `x-apisports-key` (ligação direta a
  `v3.football.api-sports.io`). Se a subscrição for feita via RapidAPI, trocar para
  `x-rapidapi-key` + `x-rapidapi-host` e a base URL da RapidAPI.
- Limites de taxa dependem do plano — respeitar os headers `x-ratelimit-*` da resposta.
- Usado apenas sob pedido (`GET /api/sports/events/:id/stats`), não em polling constante,
  para poupar quota — só faz sentido para eventos de futebol com
  `apiFootballFixtureId` conhecido (ligação entre o ID Pulsescore e o ID API-Football ainda
  **não está implementada** — é preciso um mapeamento entre os dois provedores, tipicamente
  por nomes de equipa + hora de início, ou uma tabela de correspondência mantida
  manualmente).

## Testado nesta build

- ✅ Feed simulado a gerar eventos dos 8 desportos em tempo real.
- ✅ `GET /api/sports/events` e `GET /api/sports/prematch?sport=` a devolver dados.
- ✅ WebSocket `/ws/live` a enviar snapshot + updates para um cliente ligado.
- ✅ Frontend (Esportes) a tentar a Pulsescore real primeiro e só usar dados de demonstração
  por desporto quando ela não está configurada ou não devolve nada.
- ⛔ Ligação real à Pulsescore — **não testável neste ambiente**: `api.pulsescore.net` está
  bloqueado pelo proxy de rede desta sessão (confirmado com `curl -v`, resposta 403 do proxy
  antes de sequer chegar à Pulsescore). O contrato foi implementado a partir do exemplo
  fornecido, mas precisa de um teste real fora deste ambiente (localmente, ou já em produção
  no Railway) antes de confiar 100% nele.
- ⛔ Estatísticas via API-Football — não testável sem chave de API.

## Antes de produção

1. Testar a ligação real à Pulsescore fora deste ambiente (o proxy daqui bloqueia o domínio) e
   confirmar os pontos da secção "Ainda por confirmar" acima — sobretudo os slugs dos outros 7
   desportos e a forma de um evento `live: true`.
2. Subscrever a API-Football e mapear os fixtures aos eventos Pulsescore.
3. Definir `PULSESCORE_API_KEY` (o valor vai no header `x-secret`) e `API_FOOTBALL_KEY` nas
   variáveis de ambiente do servidor. **Nunca commitar o valor do segredo no repositório** — só
   como variável de ambiente (no Railway: `Variables` do serviço `server`).
4. Ajustar `POLL_INTERVAL_MS` / `maxPages` em `hybridService.ts` conforme os limites de taxa
   reais do plano.
5. Considerar desativar `SPORTS_DATA_MOCK_FALLBACK` em produção depois de confirmada a
   ligação real, para nunca mostrar dados simulados a utilizadores reais.
