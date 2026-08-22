# Cassino (slots) — em reconstrução

A integração com o "Cassino Gold Palace" (goldslotpalase.com) foi removida por completo em
2026-08-21 (ver histórico do git) depois de uma investigação extensa não conseguir fazer o
lançamento real de jogos funcionar em produção — `POST /v4/game/game-url` devolvia sempre
`CALLBACK_ERROR`, e por eliminação (domínio/certificado ok, URL/capitalização da rota corretos,
nenhum pedido de callback chegou aos nossos logs com diagnóstico dedicado) concluiu-se que era um
problema de rede do lado do provedor a alcançar `bet62.plus`.

Está a ser reconstruída a pedido do utilizador, desta vez **endpoint a endpoint**: só se
implementa uma chamada depois de o utilizador a confirmar ao vivo (curl real + resposta real),
em vez de assumir o contrato do Swagger antigo de uma vez. Isto evita repetir o mesmo problema —
qualquer endpoint que não se comporte como esperado em produção fica isolado e visível
imediatamente, em vez de escondido dentro de um módulo grande já todo implementado.

## Estado atual

Confirmados ao vivo pelo utilizador e implementados em `server/src/modules/casino/apiClient.ts`:

- `POST /v4/agent/info` — `getAgentInfo()`. Devolve `name`, `currency`, `balance`, `rtp`,
  `whitelist`, `client_ip`. Exposto para diagnóstico em `GET /api/admin/casino/agent-info`
  (requer sessão admin).
- `POST /v4/agent/rtp` — `setAgentRtp(rtp)`. Define o RTP por omissão do agente (`0` = RTP do
  provedor).
- `POST /v4/agent/callback-test` — `testCallback()`. O provedor testa, a partir da rede dele, se
  alcança o URL de callback configurado no painel do agente. Exposto em
  `GET /api/admin/casino/callback-test`. **Confirmado a funcionar** (`callback_url:
  "https://bet62.plus/callback"`, 554ms) — a conectividade que falhava silenciosamente na
  integração anterior (CALLBACK_ERROR) está resolvida do lado do provedor. Nota: o URL de
  callback configurado agora é `/callback` na raiz, não `/api/casino/callback` como antes — a
  rota real **já existe** (ver "Callback (autenticação + carteira em tempo real)" abaixo).
- `POST /v4/user/create` — `createCasinoUser(name)`. Chamado ao vivo com `{ name: "test" }`
  numa sessão anterior (antes de existir a rota `/callback`), devolveu `code 1015
  CALLBACK_ERROR`. Confirma que `user/create` dispara uma chamada real de callback (não só um
  teste de conectividade como `agent/callback-test`) para validar a conta antes de a criar.
  **Testado de novo já com a rota `/callback` implementada, via `POST
  /api/admin/casino/accounts/provision` — voltou a devolver `CALLBACK_ERROR`.** Causa encontrada
  e corrigida: `provisionCasinoAccount` (`casino/accountProvisioning.ts`) criava o registo local
  `CasinoAccount` **depois** de chamar `createCasinoUser`, mas o callback síncrono de
  `authenticate` que o `user/create` dispara chega **antes** disso — o nosso próprio
  `handleAuthenticate` respondia `ACCOUNT_NOT_FOUND` a esse callback (por isso o
  `agent/callback-test`, que não passa por `handleAuthenticate`, tinha funcionado mas
  `user/create` continuava a falhar). Corrigido invertendo a ordem: o `CasinoAccount` é criado
  primeiro, e só depois se chama `createCasinoUser` (com rollback do registo local se essa
  chamada falhar). **Ainda por confirmar ao vivo** se isto resolve mesmo o `CALLBACK_ERROR` —
  próximo passo é voltar a chamar `POST /api/admin/casino/accounts/provision`.
- `POST /v4/user/info` — `getUserInfo(userCode)`. Exposto em
  `GET /api/admin/casino/users/:userCode`. Só se confirmou o caso de erro (`USER_NOT_FOUND`,
  código 2002, para um `user_code` que nunca chegou a ser criado); a forma de sucesso ainda não
  foi vista, por isso `data` fica sem tipar por agora.
- `POST /v4/game/providers` — `getGameProviders(lang)`. Exposto em
  `GET /api/admin/casino/providers`. Lista 17 provedores confirmados (Pragmatic Play, CQ9,
  Pocket Games Soft, Booongo, Playson, Habanero, JiLi, Tydo, PlayStar, XGaming, Spribe, Hacksaw,
  Palace, BGaming, TADA, Amusnet, EGT, Inout) com `provider_id`/`status`; o significado exato de
  cada valor de `status` (visto 1 e 2 na resposta real) ainda não foi confirmado.
- `POST /v4/game/games` — `getGames(providerId, lang)`. Exposto em
  `GET /api/admin/casino/providers/:providerId/games`. Testado com `provider_id: 1` (Pragmatic
  Play): mais de 500 jogos devolvidos, todos `category: "Slots"`, `launch_enable: true`. Campos
  confirmados: `game_code`, `game_name`, `locale_name`, `game_image`, `game_image_narrow`,
  `launch_enable`, `category`, `reg_date`.
- `POST /v4/game/all` — `getAllGames(lang)`. Exposto em `GET /api/admin/casino/games/all`.
  Devolve o catálogo completo de jogos de todos os provedores numa só chamada (sem
  `provider_id`), a mesma forma de item que `/v4/game/games`. Confirmado com provedores até
  `provider_id` 40 na resposta real. **Resposta muito grande** (milhares de jogos) — este
  endpoint é só diagnóstico; ver "Catálogo local" abaixo para o que o frontend/admin devem
  consultar no dia a dia.

- `POST /v4/game/game-url` — `launchGame(options)`. Exposto em
  `POST /api/admin/casino/games/launch`. Chamado ao vivo com um `user_code` inexistente
  (`400000001`), devolveu `USER_NOT_FOUND` (código 2002) — confirma o formato do corpo
  (`user_code`, `provider_id`, `game_symbol`, `lang`, `return_url`, `rtp`,
  `is_finish_jackpot`), mas a forma de sucesso (o URL de lançamento) ainda não foi vista.
  **Continua bloqueado**: só vai funcionar depois de `user/create` funcionar (ver abaixo), já
  que precisa de um `user_code` real.

- `POST /v4/game/online-games` — `getOnlineGames()`. Exposto em
  `GET /api/admin/casino/games/online`. Devolveu `data: []` (nenhum jogador em jogo, esperado —
  ninguém ainda conseguiu lançar um jogo de verdade). Forma de cada item ainda não vista.
- `POST /v4/game/call_config` — `getCallConfig()`. Exposto em `GET /api/admin/casino/call-config`.
  Devolveu `{ call_min: 10 }`. O significado exato de `call_min` ainda não foi confirmado (só se
  guarda o campo tal como veio).

- `POST /v4/game/call_start` — `callStart(options)`. Exposto em
  `POST /api/admin/casino/call-start`. Chamado ao vivo com `{ gplay_id: 0, set_point: 0, type: 0,
  memo: "string" }`, devolveu `PERMISSION_ERROR` (código 1010) — diferente do `USER_NOT_FOUND`
  visto noutros endpoints, sugere que precisa de mais do que um `user_code` válido (ex: sessão de
  jogo ativa, ou `gplay_id` real em vez de 0). Significado de `gplay_id`/`set_point`/`type` e a
  forma de sucesso ainda por confirmar.

- `POST /v4/game/call_cancel` — `callCancel(callId)`. Exposto em
  `POST /api/admin/casino/call-cancel`. Chamado ao vivo com `{ call_id: 0 }`, devolveu
  `RESOURCE_NOT_FOUND` (código 1005) — esperado, esse `call_id` nunca existiu (`call_start`
  nunca chegou a criar um de verdade). Forma de sucesso ainda por confirmar.

- `POST /v4/game/freeround/create` — `createFreeround(options)`. Exposto em
  `POST /api/admin/casino/freerounds`. Chamado ao vivo com `expirationDate: 0`, devolveu um erro
  de validação (código 1002): *"[expirationDate] must be at least 30 minutes from now"* —
  confirma que `expirationDate` é um epoch em milissegundos e que o provedor exige pelo menos
  30 minutos no futuro. Forma de sucesso ainda por confirmar.

- `POST /v4/game/freeround/cancel` — `cancelFreeround(frId)`. Exposto em
  `POST /api/admin/casino/freerounds/cancel`. Chamado ao vivo com `{ fr_id: "string" }`,
  devolveu `FREEROUND_NO_EXIST` (código 2020) — esperado, nenhum freeround real foi criado
  ainda. Forma de sucesso ainda por confirmar.

- `POST /v4/game/transaction` — `listTransactions(options)`. Exposto em
  `GET /api/admin/casino/transactions?startTime=...&endTime=...&page=&limit=`. Chamado ao vivo
  com uma janela de tempo antiga (2022-12-26), devolveu `{ total: 0, offset: 0, count: 0, list:
  [] }` — confirma o envelope de paginação (`total`/`offset`/`count`/`list`), mas a forma de
  cada item de `list` ainda não foi vista (nenhuma transação real aconteceu ainda). `start_time`
  e `end_time` confirmados como string `"YYYY-MM-DD HH:MM:SS"`.

- `POST /v4/game/transaction-id` — `listTransactionsByCursor(options)`. Exposto em
  `GET /api/admin/casino/transactions/cursor?lastId=&limit=`. Paginação por cursor
  (`last_id`/`limit`), ao contrário de `/v4/game/transaction` que é por janela de tempo.
  Chamado ao vivo com `{ last_id: 0, limit: 10 }`, devolveu **10 transações reais** de um
  `user_code` (`408951137`) já existente no provedor, com jogadas reais em `2026-08-01` —
  confirma que já há pelo menos uma conta ativa com histórico real, fora do fluxo desta
  aplicação (provavelmente uma conta de teste do provedor). Confirma a forma completa de um item
  de transação: `trans_id`, `user_code`, `round_id`, `trans_type`, `provider_id`,
  `provider_name`, `game_code`, `game_name`, `category`, `prebalance`, `trans_amount`,
  `balance`, `regdate`, `time_stamp`. Padrão observado nos dados reais (não documentado pelo
  provedor, por isso tratado como observação e não como facto): `trans_type 1` parece ser
  débito (aposta — `balance = prebalance - trans_amount`) e `trans_type 2` parece ser crédito
  (ganho, pode ser `0` se perdeu essa ronda).

- `POST /v4/game/round-details` — `getRoundDetails(options)`. Exposto em
  `POST /api/admin/casino/round-details`. Chamado ao vivo com um `user_code` inexistente (`3`)
  e um `round_id` inventado, devolveu `USER_NOT_FOUND` (código 2002) — esperado. Forma de
  sucesso ainda por confirmar; testar de novo com o `user_code` real (`408951137`) e um
  `round_id` real vistos em `/v4/game/transaction-id` (ex: `445454453023`) devia mostrar a forma
  completa.

- `POST /v4/statistics/user` — `listUserStatistics(options)`. Exposto em
  `GET /api/admin/casino/statistics/user?startTime=&endTime=&page=&limit=`. **Fora de
  `/v4/game/`** — está sob `/v4/statistics/`. Chamado ao vivo com `start_time == end_time`
  (janela zero), devolveu `{ total: 0, offset: 2147483647, count: 0, list: [] }` — confirma o
  mesmo envelope de paginação (`total`/`offset`/`count`/`list`) visto em `/v4/game/transaction`,
  mas com `start_time`/`end_time` em **ISO 8601** (`"2026-08-22T11:56:58.881Z"`), diferente do
  formato `"YYYY-MM-DD HH:MM:SS"` usado em `/v4/game/transaction` — não trocar os dois formatos
  entre endpoints. Forma de cada item de `list` ainda por confirmar.

## Callback (autenticação + carteira em tempo real)

Contrato confirmado pelo utilizador (documentação real do goldslotpalase.com, colada em chat —
não um curl+resposta ao vivo como o resto desta lista). Implementado em
`server/src/modules/casino/callback.ts`, montado em `POST /callback` (raiz, fora de `/api/`,
ver `app.ts`) — é o URL que `agent/callback-test` confirmou alcançável.

**Autenticação do pedido**: header `Callback-Token` comparado com a variável de ambiente
`CASINO_CALLBACK_TOKEN` (o segredo configurado no painel do agente). Vazio por omissão = todos
os callbacks são rejeitados — nunca aceitar um callback sem este token configurado.
**Importante**: o corpo de cada pedido também traz um campo `check` (ex: `"21"`, `"21,22,41,31"`)
cujo algoritmo o provedor **não documentou aqui** — pode ser uma assinatura a validar, ou só uma
lista de referência de que campos vêm preenchidos nesse comando (mais provável, dado o padrão:
os mesmos números repetem-se de forma consistente por comando). Este `check` **não é validado**
— é uma lacuna conhecida, a resolver se/quando o provedor confirmar o que é.

**Comandos implementados** (todos via `command` no corpo, resposta sempre `{ result: 0, status:
"OK", data: {...} }` no sucesso — forma de erro nunca confirmada, `{ result: 1, status: "..." }`
é o melhor palpite):

- `authenticate` — `{ data: { account } }` → devolve `{ account, balance }`.
- `balance` — `{ data: { account } }` → devolve `{ balance }`.
- `bet` — débito da carteira (`amount`, `trans_guid`, `round_id`, `provider_id`, `game_code`,
  ...) → devolve `{ balance }` atualizado.
- `win` — crédito da carteira, mesma forma que `bet` → devolve `{ balance }` atualizado.
- `cancel` — reverte a transação identificada por `cancel_trans_guid` (crédito se a original foi
  `bet`, débito se foi `win`) → devolve `{ balance }` atualizado.
- `status` — devolve `{ account, trans_guid, trans_status }` (`"OK"` confirmado pelo provedor;
  `"NOT_FOUND"` para um `trans_guid` desconhecido é palpite nosso).

**Mapeamento conta ↔ utilizador** (`CasinoAccount`, Prisma): uma linha por utilizador com
`account` = `user.publicId` (enviado como `name` em `user/create`, ver
`casino/accountProvisioning.ts` → `provisionCasinoAccount(userId)`, exposto em
`POST /api/admin/casino/accounts/provision`). **Assumido, não confirmado**: que o `account` que
o provedor devolve nos callbacks é exatamente o `name` que lhe enviámos — só se confirma quando
`user/create` finalmente devolver `code 0` e um `authenticate` real chegar com esse valor.

**Idempotência**: cada `bet`/`win`/`cancel` fica registado em `CasinoCallbackTransaction` por
`trans_guid` (chave única) — um reenvio do mesmo `trans_guid` pelo provedor devolve o saldo já
processado sem voltar a mexer na carteira. Movimentos de carteira reaproveitam
`applyLedgerMovement()` (`wallet/service.ts`), o mesmo helper atómico usado pelas apostas
desportivas — `bet`/`win` usam `LedgerEntryType.BET_PLACED`/`BET_WON`, `cancel` usa
`BET_REFUND`.

**Ainda por confirmar**: forma de resposta de erro, se `check` precisa de validação, e se a
escala/moeda de `balance` bate certo com o `Wallet.balance` em EUR sem multiplicador (assumido
por agora — o `balance: 12000` do exemplo do provedor é provavelmente só um número de exemplo
genérico, não uma escala real confirmada).

## Catálogo local (`CasinoGame`)

O catálogo completo (`/v4/game/all`) tem milhares de jogos — pedir isto ao provedor em cada
carregamento de página seria lento e desnecessário. Por isso existe uma tabela local
`CasinoGame` (`server/prisma/schema.prisma`) que espelha o catálogo, preenchida por um sync
manual em vez de automático (`server/src/modules/casino/catalogSync.ts`):

- `POST /api/admin/casino/games/sync` — chama `getAllGames()` e substitui por completo o
  conteúdo da tabela `CasinoGame` (apaga tudo e volta a inserir dentro de uma transação, em vez
  de N upserts). Devolve `{ totalGames, syncedAt }`.
- `GET /api/admin/casino/games` — lista o catálogo local já sincronizado, paginado
  (`page`/`limit`, por omissão 50, máx. 200) e filtrável por `providerId` e `category`.

Campos guardados por jogo: `providerId`, `gameCode`, `gameName`, `localeName`, `gameImage`,
`gameImageNarrow`, `launchEnable`, `category`, `regDate` (string tal como veio do provedor,
`"YYYY-MM-DD HH:MM:SS"`, sem parsing) — chave única `(providerId, gameCode)`.

**Ainda não implementado**: correr o sync automaticamente (cron/agendado) — por agora é sempre
manual via `POST /api/admin/casino/games/sync`.

## Rota pública (frontend do jogador)

`GET /api/casino/games` (`server/src/modules/casino/routes.ts`, montada em `/api/casino` em
`app.ts`, sem `requireAuth` — mesmo padrão de `sports/routes.ts`: navegação/consulta que qualquer
visitante pode ver antes de entrar na conta) — lista o catálogo local (`listCasinoGames`, ver
acima), sempre filtrado por `launchEnable: true` (só jogos que o jogador pode mesmo abrir).
Parâmetros de query, todos opcionais:

- `page`, `limit` (por omissão 50, máx. 200, ver `listCasinoGames`).
- `search` — correspondência parcial (case-insensitive) no `gameName`.
- `sort` — `name_asc` | `name_desc` | `newest` (por `regDate`); por omissão, `providerId` depois
  `gameName` ascendente.
- `tag` — mapeia para uma correspondência parcial no `gameName` (`TAG_KEYWORDS` no ficheiro da
  rota): `megaways`→"megaways", `jackpots`→"jackpot", `bonus`→"bonus", `freespins`→"free spins",
  `baccarat`→"baccarat", `blackjack`→"blackjack", `roulette`→"roulette". `tag=novos` não filtra
  por palavra-chave, força `sort=newest`. **Importante**: o `category` real devolvido pelo
  provedor é genérico (`"Slots"` para tudo, confirmado em `/v4/game/games` — ver acima) — estas
  "categorias" são só um filtro por nome, não um campo estruturado do provedor. `tag=populares`
  não tem efeito nenhum hoje (sem métrica real de popularidade — ver frontend abaixo).

Resposta: `{ total, page, pageSize, games }`, mesma forma do `listCasinoGames`.

## Frontend: página Cassino (`web/index.html` / `web/app.js`)

Nova página `#page-cassino` (aba "CASSINO" no menu superior), com quatro blocos, todos
alimentados só por `GET /api/casino/games` (nenhum jogo/imagem/categoria inventado):

- **Banner rotativo**: os 5 primeiros jogos de um pedido `limit=20` sem filtro, imagem de fundo
  = `gameImage` (ou `gameImageNarrow`), avança automaticamente a cada 5s ou pelas setas/pontos.
- **"Jogos populares"**: os mesmos 20 jogos do banner, em linha horizontal — não é uma métrica
  real de popularidade (o catálogo não tem uma), é só a primeira amostra do catálogo.
- **Tabs de categoria + pesquisa**: TODOS/MEGAWAYS™/JACKPOTS/COMPRAR BÓNUS/RODADAS
  GRÁTIS/NOVOS/POPULARES/BACCARAT/BLACKJACK/ROULETTE, mapeadas para `tag` acima; campo de
  pesquisa livre com debounce de 350ms, mapeado para `search`.
- **Grelha "SLOTS"**: paginada (`page`/`limit=24`), com "ORDENAR POR" (`sort`) e "CARREGAR MAIS
  JOGOS" (acumula páginas em vez de substituir).

**Por implementar**: clicar num jogo abre o modal de login se não autenticado; se autenticado,
mostra um aviso "disponível muito em breve" em vez de abrir o jogo — o lançamento real
(`game-url`) continua bloqueado até `user/create` funcionar (ver secção Callback acima).

Autenticação confirmada: header `Authorization: Bearer {CASINO_AGENT_KEY}` em todos os pedidos,
resposta sempre no formato `{ code, message, data }` (`code !== 0` é tratado como erro).

Variáveis de ambiente (`server/.env.example`): `CASINO_AGENT_KEY`, `CASINO_PROVIDER_BASE_URL`,
`CASINO_CALLBACK_TOKEN` (default `https://agent.goldslotpalase.com` para a segunda; as outras
duas vazias por omissão, obrigatórias para os callbacks/pedidos autenticados funcionarem).

**Ainda não implementado/confirmado**: `user/create` ainda não foi testado de novo desde que a
rota `/callback` passou a existir (ver "Callback" acima — é o próximo passo lógico); lançamento
de jogo real (`game-url`) continua bloqueado até `user/create` funcionar. A página Cassino do
frontend já consome o catálogo real (ver "Frontend: página Cassino" acima); a secção Destaques e
o admin ainda não.

Se for preciso consultar a implementação anterior completa (catálogo, callbacks, seamless
wallet, UI) como referência, está disponível no histórico do git antes do commit de remoção.
