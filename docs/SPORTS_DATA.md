# Dados Desportivos — Sistema Híbrido Pulsescore + API-Football

## Desportos cobertos

Futebol, ténis, basquete, hóquei de gelo, beisebol, voleibol, Fórmula 1 e MMA (8 no total).

⚠️ **Nota sobre o plano Pulsescore**: o plano de 149€ mencionado inicialmente cobria 3 canais
(futebol/ténis/basquete). Expandir para os 8 desportos acima pode exigir um plano superior —
confirmar com a Pulsescore, e ver também a nota sobre slugs por confirmar mais abaixo.

A Fórmula 1 não tem o formato "casa vs fora" dos outros desportos (é uma corrida com vários
pilotos, não um confronto direto). Para não criar uma segunda estrutura de dados só para ela,
o tipo `LiveEvent` é reaproveitado: `home`/`away` guardariam o nome do Grande Prémio e o tipo
de sessão, e a grelha de pilotos iria nas seleções do mercado "Vencedor da corrida" — mas isto
ainda não foi testado com dados reais (ver "Ainda por confirmar" abaixo). O MMA já está
confirmado a existir no formato normal "liga → eventos" (ver abaixo, liga real "UFC"), a
Fórmula 1 continua por confirmar.

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
  `{ league: { events: [...] } }`, ou um array direto). Ainda não ligado ao polling principal —
  decidir a lista de ligas a priorizar por desporto é decisão de produto.
- E mais dois: `GET /{bookmaker}/{sport}/events?page=&limit=` (lista plana de eventos, sem
  passar pelas ligas — `fetchEventsFlat()`) e `GET /{bookmaker}/{sport}/events/{eventId}`
  (**um evento específico** — `fetchEventById()`). Este último já está ligado ao frontend: ao
  abrir o Match Tracker de um evento com `source: "pulsescore"`, `openMarket()` em `web/app.js`
  chama `GET /api/sports/events/:id/refresh?sport=` para pedir dados frescos em vez de confiar
  só na última leitura em cache — se falhar, fica com os dados em cache, sem quebrar a UI.

## ✅ Família `/live-events` — a primeira resposta real desde o exemplo inicial

Existe uma família de endpoints **separada**, dedicada a eventos ao vivo, distinta da
`/{sport}/leagues` e `/{sport}/events` acima:

```
GET /{bookmaker}/live-events/sports
GET /{bookmaker}/live-events?page=&limit=&sport={slug}
GET /{bookmaker}/live-events/events/{eventId}
```

`/live-events/sports` teve a **resposta confirmada** (a primeira desde o exemplo original de
`leagues`):

```json
{
  "total": 189,
  "sports": [
    { "name": "soccer", "eventCount": 26 },
    { "name": "tennis", "eventCount": 72 },
    { "name": "ice_hockey", "eventCount": 6 },
    { "name": "basketball", "eventCount": 2 },
    { "name": "baseball", "eventCount": 20 },
    { "name": "volleyball", "eventCount": 2 },
    { "name": "badminton", "eventCount": 5 },
    { "name": "cricket", "eventCount": 9 },
    { "name": "darts", "eventCount": 1 },
    { "name": "esports", "eventCount": 25 },
    { "name": "table_tennis", "eventCount": 21 }
  ]
}
```

Isto é o que `hybridService.ts` agora usa como primeiro passo de cada ciclo de polling: chama
`/live-events/sports` (leve) para saber que desportos têm pelo menos um evento ao vivo agora, e
só pede `/live-events?sport=` para esses — em vez de percorrer os 8 às cegas a cada 25s.
`/live-events/events/{eventId}` não leva o desporto no caminho (ao contrário do
`/{sport}/events/{id}` sport-scoped) — o desporto vem do próprio campo `sport` da resposta do
evento. As respostas de `/live-events?sport=` e `/live-events/events/{id}` em si ainda não
foram confirmadas, por isso `fetchLiveEvents()`/`fetchLiveEventById()` usam o mesmo parsing
defensivo dos outros endpoints não confirmados.

⚠️ **Correção importante**: esta resposta revelou que o slug correto do hóquei de gelo é
`ice_hockey` (underscore) — **não** `ice-hockey` (hífen) como tinha sido marcado "confirmado"
antes (esse "confirmado" só validava que o pedido tinha a forma certa, nunca a resposta). Já
corrigido em `SPORT_SLUGS`.

Também confirma que a lista de desportos com eventos ao vivo neste momento **não inclui MMA nem
Fórmula 1** — o que não prova que não existam (MMA já está confirmado a existir via
`leagues/UFC/events`; só significa que não há nenhum combate a decorrer agora), mas continua a
não confirmar a Fórmula 1 de forma nenhuma.

## ✅ Resposta de `/live-events?sport=` confirmada (testado via Console da Railway)

Amostras reais para futebol (`soccer`) e basquete (`basketball`), ambos com `live:true`:

```json
{"total":55,"page":1,"limit":1,"totalPages":55,"hasNextPage":true,"hasPrevPage":false,
 "sport":"soccer","events":[{"eventId":"30759040","away":"Panionios","home":"Niki Volou",
 "league":"Greece - Cup","live":true,"markets":[...]}]}
```

Confirma a paginação (`total`/`hasNextPage`/etc., igual à `/leagues`) e a forma do evento —
mas com uma descoberta importante:

⚠️ **Placar e cronómetro não existem nesta API.** Nenhum dos dois exemplos `live:true` (futebol
e basquete) tem qualquer campo de placar ou minuto/tempo de jogo — só `eventId`, `home`,
`away`, `league`, `live`, `markets`. Este contrato da Pulsescore é puramente um feed de odds,
não um provedor de placar ao vivo. `normalizeEvent()` em `pulsescore/client.ts` deixou de
inventar `homeScore: 0, awayScore: 0` (era enganoso, um placar fixo em "0-0" nunca refletia o
jogo real) — `LiveEvent.homeScore`/`awayScore` ficam `undefined` para eventos reais, e o
frontend (`web/app.js`) esconde a linha de placar quando ausente, mostrando só "AO VIVO".

Também confirmado (mesma amostra): `startTime` **não aparece em eventos `live:true`** — só em
`live:false` (pré-jogo). Ajustado em `PulsescoreEvent.startTime` (agora opcional).

## ✅ Mercado principal identificado: `canonicalMarket === "MATCH_RESULT"`

Uma amostra de `/soccer/leagues` devolveu os valores distintos de `canonicalMarket` presentes:
`DRAW_NO_BET`, `HALF_TIME_RESULT`, `OTHER`, `MATCH_RESULT`, `BOTH_TEAMS_TO_SCORE`,
`EUROPEAN_HANDICAP`, `OVER_UNDER`, `HALF_TIME_OVER_UNDER`, `HOME_OVER_UNDER`. `MATCH_RESULT` é
o 1X2/vencedor — o mercado que o cartão de evento deve mostrar em destaque. Isto importava
porque a ordem dos mercados na resposta é arbitrária (um exemplo real de um jogo da NBA trazia
"Total Points Group 10 Points" como primeiro mercado, não o vencedor). `normalizeEvent()` agora
reordena os mercados ativos para pôr `MATCH_RESULT` primeiro quando presente
(`orderMarketsWithPrimaryFirst()`), mantendo os restantes; sem isso, o cartão (que só lê
`odds[0]`) podia mostrar um mercado sem relação com o resultado do jogo.

## ⚠️ Ainda por confirmar

1. **Slug da Fórmula 1** — os outros 7 desportos já têm o slug confirmado: futebol (`soccer`),
   ténis (`tennis`), voleibol (`volleyball`), MMA (`mma`), hóquei de gelo (`ice_hockey`),
   basquete (`basketball`) e beisebol (`baseball`). Só falta a Fórmula 1 (`formula-1` em
   `pulsescore/client.ts`, constante `SPORT_SLUGS`), que continua a ser estimativa. Se o slug
   estiver errado, esse desporto simplesmente devolve vazio/404 — o código já trata isso por
   desporto (não derruba o ciclo inteiro), mas os dados não aparecem até confirmar.
2. **Fórmula 1 pode nem existir** nesta forma "liga → eventos casa/fora" — motorsport é o único
   dos 8 desportos que não encaixa claramente num modelo de dois competidores (todos os outros
   7, incluindo o MMA que também parecia arriscado, já foram confirmados). Confirmar no
   catálogo da Pulsescore se a Fórmula 1 está disponível e em que forma. Um exemplo à parte
   testou `unibetau/formula-1/leagues` (casa de apostas diferente de `10bet`, usada em todos os
   outros 7 desportos) — ainda por validar se é mesmo preciso trocar de bookmaker só para F1,
   ou se `10bet/formula-1/...` também funciona.
3. **Resposta de `/live-events/events/{id}`** — só o pedido foi confirmado; a forma exata da
   resposta continua por confirmar (`fetchLiveEventById()` usa o mesmo parsing defensivo dos
   outros endpoints não confirmados).
4. **Casa de apostas (`bookmaker`)** — `10bet` foi a usada no exemplo (`PULSESCORE_BOOKMAKER`,
   por defeito `10bet`); pode haver outras disponíveis por desporto que dêem melhor cobertura.
5. **Limites de taxa / custo por pedido** — mesmo com o `/live-events/sports` a poupar pedidos
   desnecessários, convém validar o volume total contra os limites do plano antes de produção
   (ajustar `POLL_INTERVAL_MS` e `maxPages` em `hybridService.ts` se necessário).
6. **Fonte alternativa para placar/cronómetro ao vivo** — já que a Pulsescore não os fornece
   (ver acima), a única forma de mostrar placar real ao vivo seria via API-Football (só
   futebol, e só depois de mapear `apiFootballFixtureId` a cada evento Pulsescore — ainda por
   fazer) ou aceitar mostrar só "AO VIVO" sem placar para todos os desportos, como está agora.

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
  mantém o snapshot em memória e reemite atualizações (`LiveEvent`, ver `types.ts`). Sem
  `PULSESCORE_API_KEY`, ou se um ciclo não devolver nada ao vivo, a lista fica simplesmente
  vazia — nunca se inventam eventos/odds fictícios (removido de propósito: um sistema de
  apostas real não pode mostrar dados simulados a utilizadores reais).
- `server/src/modules/sports/competitions/service.ts` — top-5 ligas com jogos hoje para o menu
  lateral "Competições", com preferência para ligas grandes (lista `BIG_LEAGUES`) e desempate
  por número de jogos; reutiliza a mesma cache do `prematch/service.ts`.
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

1. Confirmar o slug/bookmaker da Fórmula 1 (ver "Ainda por confirmar" acima).
2. Subscrever a API-Football e mapear os fixtures aos eventos Pulsescore, para poder mostrar
   estatísticas detalhadas (e eventualmente placar ao vivo real de futebol).
3. Ajustar `POLL_INTERVAL_MS` / `maxPages` em `hybridService.ts` conforme os limites de taxa
   reais do plano, à medida que o tráfego real crescer.
