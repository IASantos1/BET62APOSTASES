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

## ✅ Documentação oficial da Pulsescore obtida — WebSocket confirmado

O utilizador colou a documentação oficial completa (endpoints, autenticação, WebSocket, planos,
matriz de desportos por casa de apostas). Isto confirma/corrige vários pontos:

- **Existe mesmo um produto WebSocket** — resolve a dúvida em aberto desde o início deste
  build ("Pulsescore.com plano 149€ que sai 3 websockets"). Padrão:
  `wss://api.pulsescore.net/api/{bookmaker}/ws/live?key=&sport=` — autenticação por query
  param (`key=`), não pelo header `x-secret` usado no REST. Um frame por ~1 segundo com todos
  os eventos ao vivo do desporto subscrito. Só disponível nos planos **PRO/MAX/ULTRA** (não no
  BASIC/STARTER); o plano MAX (149€/mês, 3 ligações simultâneas) é o mencionado originalmente.
  Implementado em `server/src/modules/sports/pulsescore/wsClient.ts`.
- **O frame do WebSocket inclui um campo `score`** (ex: `"1-0"`) que os endpoints REST
  `/live-events` **não têm** (confirmado por duas amostras reais). Ou seja, o placar ao vivo
  real existe — só vem pelo WebSocket, nunca pelo REST. `wsClient.ts` faz o parse de
  `score: "H-A"` para `homeScore`/`awayScore`; o REST continua sem placar (`hybridService.ts`
  usa WebSocket para até 3 desportos em simultâneo — os mais movimentados agora — e REST para
  cobrir os restantes, sem placar nesses).
- **CONFIRMADO: a 10Bet não oferece Fórmula 1.** A tabela oficial "Esportes válidos por casa de
  apostas" lista os desportos de cada bookmaker — a 10Bet(CO.UK) não inclui Fórmula 1 na lista,
  mas a Unibet AU inclui. `SPORT_BOOKMAKER_OVERRIDE` em `pulsescore/client.ts` já troca só a
  Fórmula 1 para `unibetau`, mantendo os outros 7 desportos em `10bet`. O slug exato da F1
  dentro da Unibet AU continua uma estimativa (`formula-1`) — a doc só usa o nome de exibição
  "Fórmula 1", não o slug de API.
- **Bet365 usa caminho versionado** (`/api/v3/bet365/...`); todos os outros bookmakers
  (incluindo `10bet` e `unibetau`) não são versionados. Já tratado em `wsUrlFor()`.
- ⚠️ **A doc mostra uma forma de mercados/seleções diferente da que já vimos numa resposta REST
  real.** O exemplo da doc usa `canonicalMarket: "match_winner"` (minúsculas) e
  `selections: [{name, decimal}]`; a amostra REST real (soccer, `/leagues`) tinha
  `"MATCH_RESULT"` (maiúsculas) e `{canonicalOutcome, rawName, odds, isActive, selectionId}`.
  Como discordam e só uma foi mesmo capturada de um pedido real, nenhuma das duas é tratada
  como definitiva — `orderMarketsWithPrimaryFirst()` verifica os dois nomes possíveis do
  mercado principal, e o parser do WebSocket aceita `rawName`/`name` e `odds`/`decimal`.

## ✅ Migração para a bookmaker "paddypower" — placar/cronómetro/estatísticas reais via REST

O utilizador comparou amostras reais de duas bookmakers (contagem de mercados, campos presentes)
e pediu a troca. Confirmado com pedidos/respostas reais:

```
GET /paddypower/live-events/sports
GET /paddypower/live-events?page=&limit=&sport=soccer
GET /paddypower/live-events/events/{eventId}
```

Ao contrário da "10bet" (secção anterior — placar/cronómetro confirmados **ausentes**), a
**paddypower já devolve tudo isto diretamente no REST `/live-events`**, sem precisar do
WebSocket:

```json
{
  "eventId": "35931412", "away": "NK Celje", "country": "", "home": "Slovan Bratislava",
  "league": "UEFA Champions League Qualifiers", "sport": "soccer",
  "matchClock": { "minute": 90, "second": 0, "period": "2H" },
  "statistics": { "football": { "home": {"yellowCards":2,"redCards":0,"corners":4},
                                 "away": {"yellowCards":2,"redCards":0,"corners":0} } },
  "score": { "home": "1", "away": "1" }
}
```

Pontos confirmados:
- **`matchClock`** (`minute`/`second`/`period`, ex: `"2H"`) — usado em `formatMatchClock()`
  (`pulsescore/client.ts`) para preencher `minuteOrPeriod` (ex: `"90'"`) em vez do genérico
  "AO VIVO" usado quando ausente.
- **`score`** vem como `{home, away}` (strings) — **formato diferente** do `"H-A"` string única
  documentado para o frame WebSocket oficial (`wsClient.ts`); os dois são parseados
  separadamente (`parsePulsescoreScore()` no REST, `parseScore()` no WS), não é código partilhado.
- **`statistics.football`** (cartões amarelos/vermelhos, cantos, por equipa) — bónus não pedido
  mas presente; mapeado para `LiveEvent.statistics` (`types.ts`), ainda sem UI dedicada.
- **`country`** (ISO 2 letras, ou `""` para competições internacionais/qualificação) — mapeado
  para `LiveEvent.country`; ainda não usado no frontend (o menu lateral usa uma lista curada
  `FOOTBALL_LEAGUES_BY_COUNTRY` em `web/app.js`, não este campo — trocar seria um passo futuro).
- **Cobertura de mercados muito maior**: até 47 mercados por jogo (vs. 5–17 na 10bet para os
  mesmos jogos), com vários `canonicalMarket` novos (`WIN_TO_NIL`, `CORRECT_SCORE_COMBINATIONS`,
  `HALF_TIME_FULL_TIME`, `RESULT_BOTH_TEAMS_TO_SCORE`, `WINNING_MARGIN`, `CORNERS_RACE_TO`,
  `PLAYER_CARDS`, `ANYTIME_GOALSCORER`, etc.) — nenhum exigiu mudanças de código, mercados nunca
  passaram por uma lista fixa.
- Uma amostra de `/{sport}/events` (não `/live-events`) trouxe uma entrada promocional/lixo
  ("Football Boosts", `away: ""`, `startTime` de 2017) misturada com jogos reais — `extractEvents()`
  em `client.ts` agora descarta qualquer evento sem `home`/`away` preenchidos.

Alterações de código:
- `PULSESCORE_BOOKMAKER` (`env.ts`) mudou de `"10bet"` para `"paddypower"`.
- `PulsescoreEvent` (`client.ts`) ganhou `country?`, `matchClock?`, `statistics?`, `score?`.
- `LiveEvent` (`types.ts`) ganhou `country?` e `statistics?`; `homeScore`/`awayScore` deixam de
  estar sempre `undefined` para dados reais — o comentário anterior ("Pulsescore não devolve
  placar") só era verdade para a "10bet".
- `normalizeEvent()` preenche `homeScore`/`awayScore` a partir de `score.home`/`score.away`, e
  `minuteOrPeriod` a partir de `matchClock.minute` quando presente.
- O frontend (`web/app.js`) já verificava `typeof e.homeScore === "number"` de forma defensiva —
  não precisou de nenhuma alteração, o placar real passa a aparecer automaticamente.

### Frontend ligado aos novos campos (`country` e `statistics`)

- **Menu lateral "Futebol" → países/ligas**: deixou de depender só da lista estática
  `FOOTBALL_LEAGUES_BY_COUNTRY` (`web/app.js`). Ao expandir Futebol, `loadFootballCountriesTree()`
  pede pré-jogo + ao vivo reais, agrupa por `e.country` (usando `Intl.DisplayNames(['pt'])` para
  traduzir o código ISO para um nome legível, ex: "GB" → "Reino Unido"; `""` vira "Internacional")
  e por `e.league`, e troca o menu para essa árvore real assim que chega. A lista estática
  continua a existir só como fallback instantâneo (antes dos dados reais chegarem, ou se a API
  não devolver nada).
- **Match Tracker → linha de estatísticas**: quando `e.statistics` vem preenchido (cartões
  amarelos/vermelhos, cantos, por equipa), `renderMatchTracker()`/`renderStatsRow()` desenham uma
  linha sob o cronómetro com os três valores por equipa; some por completo se `statistics` estiver
  ausente (nunca inventa zeros para um jogo sem estes dados).

### Correção: `matchClock` do ténis não tem `minute`/`second`

Uma amostra real de `/paddypower/live-events?sport=tennis` revelou que `matchClock` **não é
uniforme entre desportos**: futebol traz `{minute, second, period: "1H"/"2H"}`, mas ténis traz só
`{period: "Set 2", periodId: "2"}` — sem `minute` nem `second`. `formatMatchClock()`
(`pulsescore/client.ts`) e `formatWsMatchClock()` (`wsClient.ts`) assumiam sempre `minute`
numérico e caíam no fallback genérico "AO VIVO" para qualquer desporto sem esse campo — corrigido
para usar `clock.period` como texto quando `minute` não existir (ex: ténis mostra "Set 2" em vez
de "AO VIVO"). `PulsescoreMatchClock`/`WsMatchClock` passaram a ter todos os campos opcionais.

O mesmo exemplo mostrou `score: {home, away, info}` (ex: `{home:"4", away:"4", info:"Set 2"}` —
jogos do set atual, não o resultado final) e `statistics.sets` (array de sets por jogador, ex:
`{home:[6,6], away:[4,6], homeServe:true}`) — formas próprias do ténis, distintas de
`statistics.football`. `score.home`/`score.away` já são lidos genericamente por
`parsePulsescoreScore()`, mas `statistics.sets` ainda não tem UI própria (só `statistics.football`
tem, na linha de cartões/cantos) — fica por fazer se for pedido.

Também foi pedido, e implementado no frontend (`web/app.js`): quando um evento ao vivo não tem
relógio real nenhum (`matchClock` ausente ou numa forma não reconhecida, ficando no fallback "AO
VIVO"), o texto do relógio aparece a **vermelho** (`isClockMissing()` + classe `.clock-missing`)
em vez de se confundir com um relógio normal — tanto no cartão de "Ao Vivo" como no Match Tracker.

### Cartão de "Ao Vivo" próprio para ténis (nomes empilhados)

Pedido pelo utilizador com uma captura de outra casa de apostas como referência: o cartão de
ténis em "Ao Vivo" deixou de usar o layout genérico (casa/fora lado a lado) e passou a ter
`renderTennisCard()` próprio em `web/app.js`:

- Nome de casa em cima, nome de fora em baixo, cada um com a bandeira do país (`e.country`,
  convertido para emoji via `flagEmoji()` — dois "regional indicator symbols" Unicode, sem lista
  de países mantida à mão) e um ponto ao lado do nome de quem está a servir
  (`statistics.sets.homeServe`).
- Canto superior direito: o set atual, abreviado ("Set 2" → "S2") em vez do texto genérico da
  Match Clock.
- Centro: o placar de pontos do jogo atual (`e.homeScore`/`awayScore`, ex: "40 - 15").
- Lado direito de cada linha de equipa: jogos ganhos no set atual (`statistics.sets.home`/`away`,
  último índice do array).

Isto exigiu capturar `statistics.sets` no backend, que antes só sabia ler `statistics.football`
(cartões/cantos): `PulsescoreStatistics`/`WsEvent.statistics` (`client.ts`/`wsClient.ts`) e
`LiveStatistics` (`types.ts`) ganharam o campo `sets: {home: number[], away: number[],
homeServe?: boolean}` — CONFIRMADO na mesma amostra real de `/paddypower/live-events?sport=tennis`
(ex: `sets: {home:[6,6], away:[4,6], homeServe:false}` = 1º set 6-4, 2º set 6-6, a servir a
equipa "away"). Testado com Playwright reproduzindo os dois jogos reais da amostra (Zverev vs
Paul, Fils vs De Minaur) — bandeira, "Sn", pontos e jogos por set todos corretos.

⚠️ **Por confirmar**: a paddypower cobre basquete/hóquei de gelo/voleibol/MMA da mesma forma?
`/paddypower/live-events/sports` só mostrou eventos ao vivo reais para futebol, ténis, basebol,
esports e ténis de mesa no momento da amostra — os outros desportos podem simplesmente não ter
jogos a decorrer agora, ou podem não ser suportados por esta bookmaker. Fórmula 1 mantém-se em
`unibetau` via `SPORT_BOOKMAKER_OVERRIDE` (sem evidência de cobertura pela paddypower).

## ⚠️ Ainda por confirmar

1. **Slug exato da Fórmula 1** dentro de `unibetau` — continua uma estimativa (`formula-1`).
2. **Resposta real de `/live-events/events/{id}`** e do frame do WebSocket em produção — a
   ligação WebSocket não pôde ser testada neste ambiente (o proxy do sandbox bloqueia
   `api.pulsescore.net` por completo, para REST e WebSocket); testado apenas o comportamento de
   fallback (ambos falham de forma controlada, sem crash). Falta confirmar num ambiente com
   rede real (Railway) que a ligação WebSocket liga, recebe frames, e que o campo `score` vem
   mesmo no formato `"H-A"` assumido.
3. **Limites de taxa / custo por pedido** — mesmo com o `/live-events/sports` a poupar pedidos
   desnecessários, convém validar o volume total contra os limites do plano antes de produção
   (ajustar `POLL_INTERVAL_MS` e `maxPages` em `hybridService.ts`, e `maxConnections` em
   `wsClient.ts`, se necessário).

## Arquitetura

```
Pulsescore WebSocket (até 3 desportos, tempo real + placar) ──┐
                                                                ├──▶ HybridSportsService ──▶ WebSocket Gateway (/ws/live) ──▶ Frontend (Ao Vivo)
Pulsescore REST (polling 25s, os restantes desportos)        ──┘         │
                                                                           └──▶ API-Football (REST, sob pedido) ── estatísticas de futebol

Pulsescore (REST, sob pedido + cache 45s) ──▶ GET /api/sports/prematch?sport= ──▶ Frontend (Esportes/pré-jogo)
GET /api/sports/competitions ──▶ top-5 ligas do dia (cache 60s) ──▶ Frontend (menu lateral esquerdo)
```

Ficheiros:
- `server/src/modules/sports/pulsescore/client.ts` — cliente REST da Pulsescore (`fetchEvents`),
  com o contrato confirmado acima.
- `server/src/modules/sports/pulsescore/wsClient.ts` — cliente WebSocket (odds quase em tempo
  real + placar ao vivo), até `maxConnections` desportos em simultâneo, com reconexão automática
  e desativação limpa se o plano da conta não incluir WebSocket (código de fecho 4003).
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
