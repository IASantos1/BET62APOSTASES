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

### Generalizado: layout "por sets" ativado por dados, não por desporto — e cartões unificados

O utilizador corrigiu um ponto: **voleibol também se joga por sets** no mundo real (tal como
ténis), mas **beisebol não** — joga-se por *innings*, um conceito diferente. Em vez de fixar o
layout acima só a `sport === "tennis"`, `renderLiveEvents()` (`web/app.js`) passou a decidir pelo
próprio formato dos dados: `if (e.statistics?.sets) return renderSetsCard(...)`. Assim, assim que
a paddypower devolver `statistics.sets` para voleibol (ainda não confirmado com uma amostra real —
`/paddypower/live-events/sports` só mostrou eventos ao vivo de futebol/ténis/basebol/esports/
ténis de mesa no momento testado), o cartão de voleibol muda sozinho para o layout de sets, sem
precisar de mais código; beisebol nunca ativa este caminho, corretamente, por não ter essa forma
de dados.

Ao mesmo tempo, o cartão genérico (futebol, basquete, hóquei, beisebol, MMA, Fórmula 1) também foi
redesenhado — pedido explícito do utilizador: em vez do antigo placar único ao centro (`"1 - 1"`
entre os dois nomes, que podia parecer descentrado consoante o tamanho dos nomes das equipas),
`renderGenericCard()` mostra casa/fora um embaixo do outro com o placar de cada equipa alinhado
à direita, na mesma posição em todos os cartões da lista (`.event-row-score{min-width:1.4em;
text-align:right}`) — mesmo com nomes de equipa muito compridos. `renderSetsCard()` e
`renderGenericCard()` partilham as mesmas classes CSS (`.event-rows`/`.event-row`/`.event-team`/
`.event-row-score`), só o cartão de sets acrescenta bandeira, ponto de serviço e a pontuação do
jogo atual centralizada por cima.

⚠️ **Por confirmar**: a paddypower cobre basquete/hóquei de gelo/voleibol/MMA da mesma forma **ao
vivo**? `/paddypower/live-events/sports` só mostrou eventos ao vivo reais para futebol, ténis,
basebol, esports e ténis de mesa no momento da amostra — os outros desportos podem simplesmente
não ter jogos a decorrer agora, ou podem não ser suportados por esta bookmaker. Fórmula 1
mantém-se em `unibetau` via `SPORT_BOOKMAKER_OVERRIDE` (sem evidência de cobertura pela
paddypower).

### ✅ Confirmado: pré-jogo (não ao vivo) rico para basquete, hóquei de gelo, voleibol, ténis e MMA

O utilizador colou cinco amostras reais de `/events?page=1&limit=5` (a mesma forma
`{total,page,limit,...,events:[...PulsescoreEvent]}` já confirmada), uma por desporto:
voleibol (Campeonato Europeu Feminino), MMA (UFC), hóquei de gelo (Champions Hockey League,
PWHL), ténis (challengers/UTR) e basquete (WNBA, FIBA, ligas universitárias/nacionais). Todas
`live:false`, sem `matchClock`/`score`/`statistics` (esperado — são jogos ainda não começados),
mas com uma cobertura de mercados tão rica quanto a já vista em futebol/beisebol: até ~30
mercados por jogo em basquete (incluindo mercados por quarto — `FIRST_QUARTER`,
`SECOND_QUARTER`, etc. —, `PLAYER_POINTS_ASSISTS`, `WINNING_MARGIN`, `RACE_TO_POINTS`), mercados
por set em ténis/voleibol (`SET_WINNER`, `SET_BETTING`, hándicaps por set), e mercados completos
de luta em MMA (método de vitória, combinações método+assalto, ida à distância).

Isto **resolve a dúvida em aberto sobre o pré-jogo** destes quatro desportos — a mesma
bookmaker por omissão (`PULSESCORE_BOOKMAKER`) que já cobre bem futebol/ténis/beisebol também
devolve pré-jogo rico para basquete, hóquei de gelo, voleibol e MMA. A dúvida que continua em
aberto é só sobre `/live-events` (ao vivo), não testada por estas amostras.

Nota curiosa confirmada numa amostra de hóquei de gelo: o mercado `MATCH_RESULT`/"Match Odds"
inclui uma seleção `DRAW`/"Tie" com odd real — ao contrário do beisebol (que nunca empata), o
hóquei de gelo tem mesmo um mercado de empate genuíno no tempo regulamentar (antes de
prolongamento/shootout), por isso não precisa da mesma proteção que foi adicionada para
beisebol em `orderMarketsWithPrimaryFirst()`.

### Ajustes de layout pedidos + correção de um bug real (eventos terminados presos na página)

Confirmado com uma amostra real de `/paddypower/live-events?sport=baseball` e `.../events/{id}`
que o beisebol, ao contrário do futebol/ténis, **não devolve `matchClock`/`score`/`statistics`
nenhum** neste momento (nem sequer no endpoint de evento único) — o utilizador mostrou uma
captura de outra bookmaker com um placar por entrada (linescore) como referência de layout
desejável, mas isso fica para quando tivermos uma amostra real confirmada com esses campos; não
foi inventado nada para o beisebol.

Quatro pedidos de UI implementados em `web/app.js`/`index.html`:

1. **Placar antes do nome nos cartões genéricos** (futebol, basquete, hóquei, beisebol, MMA, F1):
   `renderGenericCard()` agora põe `event-row-score` antes de `event-team` (via `order:-1` CSS,
   classe `.score-left`) — só o ténis/voleibol (`renderSetsCard()`, cartão "por sets") mantém o
   placar do lado direito, como pedido explicitamente.
2. **Grelha de sets sempre visível** (ténis/voleibol): `renderSetsCard()` deixou de mostrar só o
   último set (`sets.home[sets.home.length-1]`) e passou a desenhar uma coluna por set jogado
   (`S1 S2 S3...`), fixas — o placar do 1º set não desaparece quando o 2º começa. O indicador de
   set atual no canto superior direito (`Sn`, derivado de `matchClock.period`) continua a servir
   de estado "ao vivo", separado da grelha histórica.
3. **Ordem fixa dos desportos na página Ao Vivo**: `SPORT_ORDER` em `web/app.js` (reaproveita o
   índice de `SPORTS_META`) ordena a lista antes de desenhar — Futebol primeiro, Ténis segundo,
   Basquete terceiro, resto abaixo — independentemente da ordem de chegada dos snapshots.
4. **Bug real corrigido: jogos terminados nunca desapareciam da página Ao Vivo sem reload.**
   `hybridService.ts` já removia eventos do seu `Map` interno quando saíam de um snapshot
   (`applySportSnapshot()`), mas nunca emitia nada a avisar — o gateway WebSocket
   (`websocket/gateway.ts`) só reencaminhava `{type:"update"}` para eventos que continuavam a
   existir, nunca um aviso de remoção. `hybridService` passou a emitir `"remove"` com o `id`, o
   gateway reencaminha `{type:"remove", id}`, e `web/app.js` remove esse id de `liveEventsById`
   assim que o frame chega (e marca `_finished` se for o evento aberto no Match Tracker, mostrando
   um estado "ENCERRADO" em vez de ficar preso a mostrar dados obsoletos).

Testado com Playwright: ordem Futebol→Ténis→Beisebol confirmada, grelha de sets com S1/S2/S3
todos visíveis, placar à esquerda do nome nos cartões genéricos, e remoção de um evento do
`liveEventsById` a refletir-se imediatamente na lista renderizada.

### Beisebol migrado para "bet365" (placar real confirmado) + bug de caminho REST corrigido

O utilizador enviou uma amostra real de `/bet365/live-events?sport=baseball` (ficheiro grande,
lido com Python em vez do Read normal por exceder o limite) que confirma o que a paddypower nunca
devolveu: `score: {home, away}` preenchido com valores reais (ex: `ARI Diamondbacks 1 - 2 BOS Red
Sox`), não sempre "0"-"0". A forma dos dados (`moreInfo` com chaves `FI`/`NA`/`SS`/`TM`/`TS`/`TT`)
é claramente o padrão interno da Bet365, distinto de tudo o resto visto neste projeto.

- `SPORT_BOOKMAKER_OVERRIDE` (`pulsescore/client.ts`) ganhou `baseball: "bet365"` — mesmo
  mecanismo já usado para `formula1: "unibetau"`.
- **Bug real corrigido**: a versão REST desta bookmaker é versionada
  (`/api/v3/bet365/...`, confirmado na documentação oficial e já tratado para o WebSocket em
  `wsUrlFor()`), mas os 7 pontos onde o REST deste cliente constrói URLs (`fetchLeaguesPage`,
  `fetchLeagueEventsRaw`, `fetchEventsFlatPage`, `fetchEventById`, `fetchLiveSportsWithEvents`,
  `fetchLiveEventsPage`, `fetchLiveEventById`) ainda montavam `/api/{bookmaker}/...` sem essa
  versão — nunca tinha sido testado porque nenhum sport usava bet365 no REST até agora. Novo
  helper `bookmakerPathSegment()` resolve isto uma vez só, usado em todos os 7 sítios.
- `hybridService.ts`: `baseball` passou a ser sempre incluído no ciclo de polling
  (`live.add("baseball")`), tal como já acontecia com `formula1` — o resumo
  `/live-events/sports` que decide que desportos vale a pena consultar continua a vir da
  bookmaker por omissão (paddypower), que não é fiável para saber se a bet365 tem jogos de
  beisebol ao vivo agora.
- `selectionId` (em `PulsescoreSelection`) passou a opcional — a amostra da bet365 não o tem
  (usa `moreInfo.ID` em vez disso), mas esse campo nunca foi lido por `normalizeMarket()`, por
  isso não há impacto funcional, só uma correção de tipo.
- **Sem `matchClock` nem `statistics`** nesta amostra (nem para innings) — só o placar. O
  relógio deste desporto continua a cair no fallback "AO VIVO" (a vermelho, já implementado) até
  surgir uma amostra com esse campo preenchido.

### Beisebol não tem empate — corrigida a escolha do mercado principal do cartão

O utilizador lembrou uma regra real do desporto: **um jogo de beisebol nunca empata** (é sempre
casa ou fora, prolonga-se em innings extra se necessário), ao contrário do 1X2 do futebol. A
amostra real da bet365 confirmou um risco concreto disto correr mal: o evento **não tinha nenhum
mercado `MATCH_RESULT`** — o moneyline vinha só como duas seleções ("Money") dentro de um mercado
misto ("Game Lines", junto com Run Line e Total) — e havia um mercado real separado, "3-Way
Handicap", com uma seleção genuína "Tie - ARI Diamondbacks" (empate no hándicap de corridas, um
tipo de aposta real, não um erro de dados). Sem mercado principal reconhecido,
`orderMarketsWithPrimaryFirst()` escolhia às cegas o primeiro mercado do array para a
pré-visualização do cartão (que não mostra o nome do mercado) — se esse "3-Way Handicap" alguma
vez calhasse em primeiro lugar, o cartão pareceria um 1X2 com empate, o que não existe no
beisebol.

Corrigido em `pulsescore/client.ts`: `orderMarketsWithPrimaryFirst()` agora, quando não encontra
nenhum mercado principal reconhecido, empurra para trás qualquer mercado com uma seleção de
empate (`canonicalOutcome === "DRAW"` ou `rawName` a conter "tie"/"empate") em vez de o deixar
ficar em primeiro por acaso. Testado com a amostra real: nos 5 eventos de beisebol testados,
"Game Lines" já vinha primeiro por acaso (não tem empate), por isso o comportamento visível não
mudou nesta amostra específica — mas a proteção evita que aconteça com outra ordem de array.

### Mercados "Mais/Menos X.5" fora de ordem numérica

Reportado pelo utilizador com captura de ecrã real: os mercados "Over/Under 0.5 Goals",
"Over/Under 1.5 Goals" etc. (uma linha diferente por mercado, não um único mercado com várias
linhas) apareciam na página de Mercados na ordem "0.5, 1.5, 4.5, 2.5, 3.5" — a bookmaker não
garante nenhuma ordem numérica entre estas variantes, cada uma chega como um mercado
independente na posição em que a API decidiu devolver.

Corrigido com `sortNumericMarketFamilies()` (`pulsescore/client.ts`, aplicado tanto no caminho
REST — `normalizeEvent()` — como no WebSocket — `wsClient.ts::normalizeWsEvent()`): agrupa
mercados com o mesmo nome depois de remover o número (ex: "Over/Under Goals") e ordena cada
grupo pelo número ascendente, mantendo esse grupo exatamente na posição onde o seu primeiro
membro apareceu — nunca reordena mercados sem número nem mistura duas famílias diferentes (ex:
"Total Corners" e "Over/Under Goals" continuam cada uma com a sua própria ordem, independente
uma da outra). Testado com a sequência exata da captura ("0.5, 1.5, 4.5, 2.5, 3.5, 5.5") e com
famílias intercaladas.

⚠️ **Nota**: mesmo com esta correção, "Game Lines" (o mercado que acaba por ser mostrado como
pré-visualização) continua a ser um mercado misto (Run Line + Total + Money juntos), não um
1X2/moneyline limpo — a bet365 não expõe um mercado moneyline autónomo para este jogo.

### Seguimento: extraído o moneyline limpo do mercado misto (com um limite deliberado)

O utilizador colou exatamente o que a app real estava a mostrar — confirmou o problema descrito
acima ("Run Line 1.63 / Total 1.80 / Money 1.04" nos 5 cartões de beisebol da bet365). Como o
nome de seleção `"Money"` apareceu consistente nos 5 eventos reais (Nicaragua CNBS, MLB x3,
Triple A Minor League), `withSyntheticMoneyline()` (`pulsescore/client.ts`) passou a extrair as
duas seleções `"Money"` para o seu próprio mercado sintético `MATCH_RESULT`/"Moneyline" — sem
inventar nenhuma odd, só reagrupando as duas que já vinham reais — e a removê-las do mercado
misto original (não ficam duplicadas na lista completa de mercados). Só ativa quando não existe
já um mercado `MATCH_RESULT` real, para não interferir com futebol/ténis/etc.

⚠️ **Limite deliberado**: as duas seleções ficam com o nome real `"Money"` tal como vêm — **não**
foram trocadas pelo nome da equipa (casa/fora). Ao tentar confirmar qual pertence a qual equipa,
descobriu-se que `canonicalOutcome: "HOME"` da bet365, no mesmo evento, aponta para o Arizona
Diamondbacks — que o campo `event.home` diz ser a equipa **visitante** (Boston Red Sox é a casa
segundo o próprio evento). Ou seja, os campos HOME/AWAY (e o `moreInfo.OR` associado) desta
bookmaker não são fiáveis para saber qual `"Money"` pertence a qual equipa neste mercado — atribuir
a odd errada à equipa errada seria pior do que mostrar "Money" duas vezes, por isso ficou por
resolver deliberadamente em vez de adivinhar.

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

### Corrigido: Match Tracker podia perder mercados ao "atualizar" um evento (todos os desportos)

O utilizador reportou que, no pré-jogo, só apareciam as odds principais — nenhum mercado extra —
independentemente do desporto. Investigado o caminho `openMarket()` → `renderMarketGroups()` em
`web/app.js`: a lista de pré-jogo/ao vivo já chega rica em mercados (confirmado com uma amostra
real de beisebol enviada pelo utilizador: 23–34 mercados por jogo via `GET /events?page=&limit=`),
e `renderMarketGroups()` desenha `e.odds` inteiro sem cortar nada — por isso o problema não estava
nesses dois pontos.

O suspeito é `openMarket()`: assim que a página do Match Tracker abre, chama sempre
`Bet62Api.refreshEvent()` → `GET /events/{id}?sport=` no backend (`fetchEventById()` em
`pulsescore/client.ts`) para trazer dados frescos, e **substituía incondicionalmente** os mercados
já mostrados pelo que esse pedido devolvesse. Esse endpoint em particular nunca teve a forma da
resposta confirmada com um pedido real (está assinalado como tal no código desde o início desta
integração) — ao contrário do endpoint de lista, que já foi confirmado por duas vezes. Se ele
devolver menos mercados (ou vier numa forma que o parser interprete de forma mais pobre), a troca
incondicional apagava os mercados ricos que já estavam no ecrã, sobrando só o principal — em
qualquer desporto, porque é o mesmo código partilhado por todos.

**Correção** (`web/app.js`, `openMarket()`): antes de trocar `currentMarketEvent` pelo resultado
do refresh, compara o número de mercados. Só troca a lista de mercados se a resposta fresca vier
com pelo menos tantos quanto já tínhamos; caso contrário mantém os mercados antigos (mais ricos) e
só deixa os outros campos (placar, relógio, estatísticas) atualizarem-se com os dados frescos —
esses sim beneficiam de vir sempre atualizados. Continua por confirmar com um pedido real a
`GET /events/{id}` o que este endpoint devolve de facto; esta correção protege a UI
independentemente da resposta, sem inventar dados.

### Corrigida a causa real: pré-jogo trocado de `/leagues` para `/events`

Depois da correção acima, o utilizador confirmou que os mercados continuavam a não aparecer no
pré-jogo — e explicou que ainda não tinha colado nenhuma amostra real de pré-jogo nesta
conversa. Entretanto colou sete amostras reais de `/events?page=1&limit=5`, uma por desporto
(beisebol, voleibol, MMA, hóquei de gelo, ténis, basquete e futebol), todas consistentemente
ricas em mercados (até ~30 por jogo).

Isto expôs a causa raiz: `getPrematchEvents()` (`server/src/modules/sports/prematch/service.ts`)
usava `fetchEvents()`, que chama `/{bookmaker}/{sport}/leagues` — **não** o endpoint `/events`
de onde vêm todas estas amostras reais. O `/leagues` tem a mesma forma de dados e foi o primeiro
endpoint alguma vez confirmado neste projeto (a amostra original de futebol, no início desta
build), mas a sua riqueza de mercados nunca foi reconfirmada desde então — todas as amostras
reais mais recentes, de qualquer desporto, vieram sempre de `/events`.

**Correção**: `getPrematchEvents()` passou a usar `fetchEventsFlat()` (`/events`, já
implementado e usado por outro lado nenhum) em vez de `fetchEvents()` (`/leagues`). Mesma
assinatura, mesmo tipo de retorno (`LiveEvent[]`), mesmo `normalizeEvent()` por baixo — troca
mínima, sem tocar em mais nada. `fetchEvents()`/`/leagues` fica por usar por agora mas continua
implementado, caso volte a ser útil (ex: pedir os jogos de uma liga específica de forma mais
barata).

## Mercados/seleções suspensos (pedido: "botões não clicáveis" em momentos críticos)

O utilizador pediu suspensão de odds em momentos críticos do futebol (Grande Chance, Revisão
VAR, Pênalti, Cartões) — investigado o contrato real confirmado, e a Pulsescore **não** expõe
nenhum campo com o motivo da suspensão, só um sinal genérico ligado/desligado: `isActive` em
cada mercado e em cada seleção (`{canonicalMarket, rawName, period, isActive, marketId,
selections: [{canonicalOutcome, rawName, odds, isActive, selectionId, ...}]}`, ver acima).

Antes desta correção, o código **descartava em silêncio** tudo o que vinha com `isActive:
false` (`e.markets.filter((m) => m.isActive)` em `normalizeEvent()`,
`m.selections.filter((s) => s.isActive)` em `normalizeMarket()`, e o equivalente no WS) — um
mercado suspenso simplesmente desaparecia da lista em vez de aparecer suspenso, e voltava a
aparecer do nada quando reativado.

**Correção**: `LiveOdds`/`LiveSelection` (`types.ts`) passam a carregar `isActive` explícito a
dois níveis (mercado e seleção), e os dois normalizadores (`pulsescore/client.ts` REST,
`pulsescore/wsClient.ts` WS) deixam de filtrar — tudo o que a Pulsescore envia chega ao
frontend. `web/app.js` (`renderMarketGroups`) mostra uma seleção inativa visível mas sem
`onclick` (bloco cinzento "Suspenso", em vez do valor da odd), e um mercado totalmente inativo
ganha uma etiqueta "SUSPENSO" no cabeçalho. Os cartões compactos (pré-jogo/ao vivo) e o cálculo
de probabilidade pelas odds (aba "Margens de Vitória") passam a usar só as seleções ativas.

**Não implementado, por falta de dado confirmado**: etiquetas específicas por motivo ("Grande
Chance", "Revisão VAR", "Pênalti", "Cartões") — a Pulsescore não distingue isto no contrato
confirmado até agora. Se houver documentação adicional (ex: um campo `reason`/`incident` numa
amostra real ainda não vista, ou um evento WS separado do tipo "incident"), pode ser adicionado
depois; sem isso, mostrar essas etiquetas seria inventar informação que a UI apresentaria como
verdadeira sem o ser.

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

## Filtros de mercado (página de Mercados)

`web/app.js::MARKET_FILTER_CATEGORIES` — barra de chips ("Todos", "Resultado", "Mais/Menos",
"Handicap"...) entre o cabeçalho do evento e a lista de mercados, uma configuração por
desporto (futebol, basquetebol, ténis, hóquei, voleibol; os restantes desportos não têm barra
de filtros, pedido explícito do utilizador foi só para estes cinco).

⚠️ **Heurística, não uma lista fechada confirmada**: cada categoria reconhece o mercado por
palavra-chave no nome bruto que a Pulsescore envia (`group.market`, tipicamente em inglês —
"Match Odds", "Total Goals Over/Under", "Both Teams to Score"...), porque este projeto não tem
uma lista exaustiva de todos os nomes de mercado que a Pulsescore pode mandar por
desporto/liga/bookmaker (ao contrário de H2H/predictions/standings da API-Football, que foram
confirmados contra amostras reais coladas pelo utilizador antes de implementar). Cada mercado
cai numa única categoria (a primeira, pela ordem da lista, cujo padrão bater —
`classifyMarket()`); sem nenhuma bater, cai no balde "Especiais" no futebol (só aí, pedido
explícito) ou fica sem categoria nos outros desportos (só visível em "Todos"). **NEEDS
VALIDATION**: confirmar os padrões contra nomes de mercado reais de cada desporto assim que
houver amostras (a mesma metodologia já usada no resto do projeto) — um nome de mercado muito
fora do comum pode cair no filtro errado ou não bater em nenhum.

**"Escanteios"/"Cartões"/"Marcador" parecem estar em falta**: o utilizador reportou não ver
mercados de escanteios/cartões/marcador num evento. Investigado: nenhum código do backend
filtra mercados por nome/tipo — `client.ts`/`wsClient.ts` normalizam e reenviam TODOS os
mercados que a bookmaker devolveu para aquele evento, sem lista fixa (ver comentário em
`withSyntheticMoneyline()`). O filtro "Todos" da barra de chips também não esconde nada — só as
categorias específicas (ex: clicar em "Escanteios") restringem a lista. Já existiam categorias
"Escanteios" (`/corner/i`) e "Cartões" (`/\bcard|booking/i`) para futebol; faltava uma categoria
dedicada para mercados de marcador (ex: "Anytime Goalscorer", "First Goalscorer") — esses caíam
no balde "Especiais" em vez de terem o seu próprio chip, o que os tornava fáceis de não notar.
Adicionada a categoria "Marcador" (`/goalscorer|\bscorer\b|first to score|last to score|to
score first|to score last|player.*(to score|goals)/i`), a seguir a "Ambas Marcam" na lista.
**Continua a não ser garantido que estes mercados existam para um evento específico** — a
cobertura de mercados por jogo varia com a popularidade da liga (confirmado: 5–17 mercados por
jogo em ligas menores vs. até 47 em jogos populares, incluindo `CORNERS_RACE_TO`,
`PLAYER_CARDS`, `ANYTIME_GOALSCORER` como `canonicalMarket` — ver client.ts). Se a bookmaker não
enviar esses mercados para um jogo em concreto, continuam a não aparecer (nem no "Todos"),
porque este projeto nunca inventa mercados/odds que a fonte de dados não devolveu.

## Fallback de mercados/estatísticas entre bookmakers

Pedido explícito do utilizador (colou uma configuração `marketRouting` real, confirmada por ele
contra a documentação da Pulsescore): quando a bookmaker principal (`paddypower`) não tem um
mercado ou estatística para um jogo, ir buscá-lo a outra bookmaker da lista, **sem nunca
duplicar** o que a principal já tem — só preenche o que está mesmo em falta.

- `pulsescore/marketRouting.ts` — a configuração colada pelo utilizador, traduzida para TS:
  `MARKET_ROUTING` (lista de bookmakers por tipo de mercado, pela ordem de preferência exata que
  ele deu) e `classifyRoutingMarket()` (heurística por palavra-chave sobre o `rawName` do
  mercado, mesma abordagem já usada em `web/app.js::MARKET_FILTER_CATEGORIES` e
  `betting/settlementRules.ts` — não o `canonicalMarket`, cuja grafia já se mostrou inconsistente
  entre a documentação e amostras reais nesta integração).
  - ⚠️ **NEEDS VALIDATION — grafia dos ids de bookmaker**: este projeto já confirmou, com pedidos
    reais, que o segmento de path correto é `"paddypower"` (sem underscore — ver
    `PULSESCORE_BOOKMAKER` em env.ts), mas a configuração do utilizador escreve `"paddy_power"`
    (com underscore) para a mesma bookmaker. Só 5 dos 30 ids têm confirmação própria nesta
    integração (`paddy_power`→`paddypower`, `bet365`, `unibet_au`→`unibetau`,
    `10bet_couk`→`10bet`, `pinnacle_ps3838`→`ps3838` — ver `ROUTING_ID_TO_PULSESCORE_SLUG`); os
    outros 25 passam tal como vieram como segmento do path REST, sem confirmação própria. Se
    algum estiver errado, o motor de fallback simplesmente não encontra nada nessa bookmaker
    (404/erro tratado como "sem cobertura", nunca quebra nada) — os mercados dessa bookmaker só
    vão mesmo aparecer depois de alguém confirmar o segmento real.
- `pulsescore/crossBookmakerFallback.ts` — `enrichEventFromOtherBookmakers(sport, event)`, só
  chamado em `GET /sports/events/:id/refresh` (quando o utilizador abre o Match Tracker de um
  evento em concreto) — **nunca** durante o polling em massa de `hybridService.ts`, que teria de
  repetir isto para todos os eventos ao vivo a cada ciclo (custo de pedidos multiplicado por até
  30x). Duas peças:
  1. **Casamento de jogo entre bookmakers**: cada bookmaker tem o seu próprio `eventId` para o
     mesmo confronto real (não há um id partilhado) — `matchesSameFixture()` procura o jogo
     equivalente por semelhança do nome das equipas (reaproveita
     `mapping/normalize.ts::calculateTeamSimilarity()`, já usado no motor de mapeamento com a
     API-Football) exigindo ≥72% de confiança em ambas as equipas (mesmo patamar de
     `teamMatcher.ts::MIN_CONFIDENCE_TO_LINK`), mais proximidade de horário de kickoff no
     pré-jogo (±20 min) — para nunca juntar mercados/estatísticas de um jogo diferente por
     engano (testado com um caso deliberado de equipas diferentes, confirma que recusa juntar).
  2. **Preenchimento mercado a mercado / campo a campo**: para cada mercado em falta (via
     `classifyRoutingMarket`) ou campo de estatística em falta (`statistics.home/away.
     {yellowCards,redCards,corners}` — só futebol, ver abaixo), percorre a lista de preferência
     dessa entrada, bookmaker a bookmaker, até encontrar a primeira com dados válidos (seleções
     com odd numérica, ou o campo numérico da estatística); para na primeira que encontrar.
- **Estatísticas**: só preenchidas para futebol (`STATS_FALLBACK_SPORTS`) — é o único desporto
  onde `event.statistics.home/away` (cartões/cantos) já foi confirmado em amostras reais de mais
  do que uma bookmaker (`mapStatistics()` em client.ts só popula quando o payload bruto tem uma
  chave `football` ou `sets`; basquetebol/hóquei/beisebol/MMA/Fórmula 1 nunca tiveram isto em
  nenhuma amostra vista). `sets` (ténis/voleibol, jogos por set) **nunca** é preenchido por
  fallback — tem de ficar sincronizado com o placar ao vivo já mostrado, e misturar um snapshot
  de outra bookmaker (com o seu próprio ciclo de sondagem) arriscava um placar inconsistente.
- **Controlo de custo** (a razão de isto só correr sob pedido, nunca em massa): cache de 60s por
  (desporto, bookmaker, ao vivo/pré-jogo) partilhada entre TODOS os mercados/estatísticas em
  falta de uma chamada — uma bookmaker só é mesmo pedida uma vez, mesmo que apareça na lista de
  preferência de 20 mercados diferentes; um resultado vazio (bookmaker sem o jogo) também fica em
  cache (não seria útil voltar a tentar de imediato) — testado explicitamente: uma segunda
  chamada ao mesmo evento já completo faz **zero** pedidos extra. `MAX_BOOKMAKERS_TRIED_PER_ITEM`
  (6) impede que um único mercado muito específico (ex: "assists", com poucas bookmakers reais a
  cobri-lo) esgote sozinho o orçamento antes de sequer chegar a "Escanteios"/"Cartões"/"Marcador"
  — o que o utilizador pediu para nunca faltar.
- **Testado** (scripts locais com `fetch` simulado, sem rede real): mercados em falta preenchidos
  corretamente sem duplicar os já existentes; recusa juntar mercados de um jogo com equipas
  diferentes (guarda contra falsos positivos); estatísticas em falta preenchidas campo a campo
  sem sobrescrever o que já existia; chamada repetida ao mesmo evento não faz pedidos extra.
  ⛔ Não testável contra a Pulsescore real neste ambiente (ver "Testado nesta build" abaixo) — os
  25 ids de bookmaker não confirmados precisam de validação com pedidos reais antes de se saber
  quais realmente preenchem mercados na prática.

## Ordenação de desportos (Pré-jogo e Destaques)

`web/app.js::SPORT_ORDER` fixa a ordem "futebol primeiro" (depois ténis, basquete, o resto pela
ordem de `SPORTS_META`) — já usada em `renderLiveEvents()` (Ao Vivo). `renderPrematchList()`
("Todos" os desportos na página Esportes) passou a aplicar o mesmo `sort()` explicitamente: os
pedidos por desporto já resolviam nesta ordem por construção (`Promise.allSettled` preserva a
ordem de `sports`, que começa em futebol), mas sem o `sort()` explícito bastaria futebol não ter
nenhum jogo agendado nesse instante para o desporto seguinte com jogos (ex: beisebol) aparecer
primeiro — foi o que o utilizador viu numa captura real de produção. O `sort()` garante o
agrupamento por desporto (futebol primeiro, quando existir) independentemente de quantos jogos
cada desporto tiver.

## Destaques da página inicial (`web/app.js::renderDestaquesHighlights`)

Pedido explícito do utilizador — a página Destaques (antiga só com banner promocional + cassino)
passou a mostrar duas listas de jogos reais, ambas via a mesma Pulsescore já usada nas páginas
Esportes/Ao Vivo (sem endpoints novos):

- **Pré-jogo (5)**: junta o pré-jogo de todos os desportos (`GET /sports/prematch?sport=` por
  desporto, como em `renderPrematchList()`) e ordena com preferência para ligas cujo nome contém
  "UEFA" (Champions League, Europa League, Conference League — `/uefa/i` no nome da liga), depois
  os restantes pela ordem em que chegaram; corta nos primeiros 5. Se não houver 5 jogos UEFA
  disponíveis, os restantes lugares ficam com o que sobrar (qualquer desporto), nunca inventado.
- **Ao vivo (5)**: 1 jogo de cada um dos 4 desportos-alvo (`DESTAQUES_LIVE_SPORTS = [football,
  tennis, basketball, baseball]`) + 1 vaga "bónus". A vaga bónus E qualquer vaga de um destes 4
  desportos sem jogo ao vivo neste momento são preenchidas com futebol extra (pedido explícito:
  "se algum desses não tiver acrescenta em Futebol") — nunca ficam por preencher nem mostram um
  jogo de outro desporto fora da lista-alvo nesse lugar. Busca tudo num só pedido
  (`GET /sports/events`, sem `?sport=`, que devolve `hybridSportsService.snapshot()` já com todos
  os desportos) em vez de 8 pedidos separados.

Ambas as listas reutilizam os mesmos cartões (`live-card`) e a mesma lógica de odds suspensas já
usada em Esportes/Ao Vivo — sem HTML/CSS novo, só reorganização dos dados já existentes.

## Antes de produção

1. Confirmar o slug/bookmaker da Fórmula 1 (ver "Ainda por confirmar" acima).
2. Subscrever a API-Football e mapear os fixtures aos eventos Pulsescore, para poder mostrar
   estatísticas detalhadas (e eventualmente placar ao vivo real de futebol).
3. Ajustar `POLL_INTERVAL_MS` / `maxPages` em `hybridService.ts` conforme os limites de taxa
   reais do plano, à medida que o tráfego real crescer.
