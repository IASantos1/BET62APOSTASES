# Cassino (slots) — Cassino Gold Palace

## O que foi confirmado

O utilizador colou a documentação oficial da API do "Cassino Gold Palace" (provedor de
conteúdo de slots, réplicas de jogos populares — catálogo real recebido é maioritariamente
Pragmatic Play). Dessa documentação, o que está **confirmado** (frase/exemplo real dado pelo
provedor, não inventado):

- **Fuso horário da API**: UTC.
- **Um único URL de callback** (`POST`, configurado no painel do provedor), que recebe **seis
  comandos diferentes** — `authenticate`, `balance`, `bet`, `win`, `cancel`, `status` —
  distinguidos pelo campo `command` do corpo, todos com o mesmo cabeçalho obrigatório
  `Callback-Token: <segredo>` e `Content-Type: application/json`:
  - `authenticate` — confirma que a conta do jogador existe (ex: ao abrir o jogo).
  - `balance` — confirma o saldo atual, sem alterar nada.
  - `bet` — debita o valor apostado (**não estava documentado nem implementado até agora** —
    ver "Corrigido: CALLBACK_ERROR" abaixo).
  - `win` — credita o prémio ganho pelo jogador.
  - `cancel` — estorna uma transação anterior (bet ou win), identificada por `cancel_trans_guid`.
  - `status` — consulta o estado de uma transação (`trans_guid`) sem alterar nada.
- Forma do corpo de cada callback: `{ command, data: {...}, timestamp, check }`, onde `check` é
  uma lista de códigos (`21` confirmação do utilizador, `22` utilizador ativo, `31` saldo, `41`
  transação já processada, `42`/`43` existência do ID da transação/transação cancelada) que o
  provedor pede para validarmos antes de aceitar o pedido.
- Resposta esperada: `{ result, status, data: { balance } }`. **Confirmado** pela amostra de
  implementação PHP oficial colada pelo utilizador (ver "Corrigido: códigos de resultado do
  callback" abaixo): `result` de erro é o próprio número do item de `check` que falhou (`21`
  utilizador não encontrado, `22` inativo, `31` saldo insuficiente, `41` `trans_guid` já
  processado, `42`/`43` `trans_guid`/`cancel_trans_guid` inexistente), mais `100` (token de
  callback inválido) e `99` (erro genérico ao processar). `0` = sucesso.
- **Bonus Call Feature**: chamada de bónus aplicada a um jogo em curso; ganhos por bonus call
  chegam como `BonusCall(32)` em vez de `Win(2)` (a doc não detalha um campo explícito no corpo
  do callback `win` para distinguir isto — implementado a assumir que a presença de `call_id`
  não-vazio no callback indica uma bonus call).
- **Status da empresa/jogo**: `Normal(1)` / `Maintenance(2)`; acesso a um jogo em manutenção
  devolve `UNDER_MAINTENANCE(1)`. Ainda sem uso no nosso código (não há endpoint de status de
  jogo/empresa por vir do lado do provedor para nós consultarmos — só foi dado o significado dos
  valores).
- **Catálogo de jogos**: uma resposta real de lista de jogos foi colada — `{code, message, data:
  [{provider_id, game_code, game_name, locale_name, game_image, launch_enable, category,
  reg_date}]}`. Guardada tal como veio (sem inventar campos) em
  `server/src/modules/casino/data/games.json` — 490 jogos reais e distintos por `game_code`
  (o corpo original tinha alguns duplicados de `game_code` com `reg_date` diferente; mantida
  apenas a entrada mais recente de cada).

## ✅ Lançamento de jogo — confirmado e implementado

Confirmado via Swagger real (`agent.goldslotpalase.com/swagger/v4/swagger.json`): a "Agent API"
do provedor, autenticada por `Authorization: Bearer {CASINO_AGENT_KEY}`, com dois passos —
`POST /v4/user/create` (obtém/cria o `user_code` do jogador) e `POST /v4/game/game-url` (devolve
o `game_url`, válido 10min, uso único). Implementado em
`server/src/modules/casino/apiClient.ts`, ligado a `requestGameLaunch()` em `service.ts`.
Falta apenas preencher `CASINO_AGENT_KEY` (dada pelo provedor à conta de agente) e
`CASINO_PROVIDER_BASE_URL` em produção (Railway) — testado localmente com uma Agent API mock.

## Corrigido: `CALLBACK_ERROR` ao pedir o `game-url`

Depois de implementado o lançamento, o pedido real a `/v4/game/game-url` em produção devolvia
`Cassino: CALLBACK_ERROR`. Causa: a doc "Callback API Example" colada pelo utilizador revelou
que o contrato real tem **um único URL de callback** com 6 comandos (`authenticate`, `balance`,
`bet`, `win`, `cancel`, `status`) — não 3 URLs separadas para `win`/`cancel`/`status` como se
tinha assumido antes. O provedor testa `authenticate` nesse URL antes de aceitar o pedido de
`game-url`; como não existia rota nenhuma capaz de responder a esse formato, o teste falhava e
o provedor recusava o lançamento com `CALLBACK_ERROR`.

**Correção**: `routes.ts` passou a ter um despachante único `POST /api/casino/callback` que lê
o campo `command` do corpo e chama o handler certo (`authenticate`/`balance`/`bet` são novos em
`service.ts`; `win`/`cancel`/`status` já existiam). Mantidos também os aliases
`/api/casino/callback/{authenticate,balance,bet,win,cancel,status}` (comando inferido do path
se o corpo não o trouxer), para o caso de o painel do provedor já ter sido configurado com URLs
separadas. **A URL a configurar no painel de agente é `https://<domínio-produção>/api/casino/callback`.**

Como `bet` (débito da aposta) nunca tinha sido documentado nem implementado, este acerto também
o acrescentou — sem ele, a primeira jogada real falharia sempre, mesmo com o `CALLBACK_ERROR`
resolvido.

## Corrigido: códigos de resultado do callback

O utilizador colou a implementação PHP de referência **oficial do próprio provedor** (o exemplo
"Callback Handling" completo, com as tabelas SQL `bet_casino`/`user_casino`). Isto revelou dois
erros na primeira versão dos handlers, que tinha sido construída sobre a tabela "API Response
Codes" do Swagger da Agent API de **saída** — uma família de códigos diferente, que nada tem a
ver com o que devemos devolver nos callbacks de **entrada**:

1. **Códigos de erro errados**: usava-se `USER_NOT_FOUND=2002`, `BALANCE_NOT_ENOUGH=2006`, etc.
   A amostra oficial mostra que o `result` de erro é literalmente o número do item de `check`
   que falhou (`21`/`22`/`31`/`41`/`42`/`43`), mais `100` (token inválido) e `99` (erro
   genérico). Corrigido em `CasinoResult` (`service.ts`).
2. **Duplicado tratado como sucesso idempotente — errado**: assumia-se, sem confirmação, que
   reenviar o mesmo `trans_guid` em `bet`/`win`/`cancel` devolvia `OK` com o saldo atual. A
   amostra oficial mostra o contrário: `check 41` ("já processado") é tratado como **ERRO**
   (`result: 41`), não como sucesso silencioso. Corrigido em todos os handlers de `service.ts`.

Também implementado, seguindo a amostra oficial mas adaptado ao nosso modelo (log imutável de
`CasinoTransaction`, em vez de um registo mutável com campo `sort`):
- Verificação de utilizador **ativo** (`check 22`) — usa `User.status === "ACTIVE"` (o schema já
  tinha `SUSPENDED`/`SELF_EXCLUDED`/`CLOSED`, por isso a conta suspensa/autoexcluída de um
  jogador bloqueia automaticamente novas apostas no cassino).
- `cancel` de um `cancel_trans_guid` já estornado antes devolve `OK` com o saldo atual sem
  reaplicar o estorno (equivalente ao guard `sort != 'CANCEL'` do PHP, mas consultando se já
  existe uma transação `CANCEL` com esse `cancelOfTransGuid`, em vez de mutar a linha original).
- `status` passa a reportar `trans_status: "CANCELED"` quando a transação consultada já foi
  estornada (antes devolvia sempre `"OK"`).

## O que está implementado

- `server/src/modules/casino/`:
  - `catalog.ts` — lista/pesquisa/destaques sobre o catálogo estático.
  - `apiClient.ts` — cliente da Agent API (`user/create`, `game-url`, `agent/info`,
    `providers`, `games`), autenticado por `Bearer CASINO_AGENT_KEY`.
  - `service.ts` — `handleAuthenticateCallback`, `handleBalanceCallback`, `handleBetCallback`,
    `handleWinCallback`, `handleCancelCallback`, `handleStatusCallback`; `requestGameLaunch()`.
    Os callbacks que movem saldo (`bet`/`win`/`cancel`) são idempotentes por `trans_guid`
    (tabela `CasinoTransaction`, `transGuid` com índice único — uma entrega repetida nunca é
    reaplicada).
  - `routes.ts` — `GET /api/casino/games`, `GET /api/casino/games/highlighted`,
    `GET /api/casino/image/:gameCode`, `POST /api/casino/launch` (autenticado),
    `GET /api/casino/agent-info` (SUPPORT/ADMIN), `POST /api/casino/callback` (despachante único
    por `command`) + aliases `/callback/{authenticate,balance,bet,win,cancel,status}` — todos
    verificam `Callback-Token` contra `CASINO_CALLBACK_TOKEN`.
- Wallet: apostas/créditos/estornos passam por `applyLedgerMovement()` (o mesmo motor de
  carteira já usado por depósitos/levantamentos), com `type: BET_PLACED`/`BET_WON`/`BET_REFUND`
  e `referenceType: "casino_slot"` — aparecem no extrato normal do utilizador
  (`GET /api/wallet/transactions`). Saldo insuficiente numa aposta devolve
  `BALANCE_NOT_ENOUGH(2006)` ao provedor em vez de deixar escapar um erro genérico.
- Frontend (`web/app.js`, `web/index.html`):
  - Página **Cassino** com grelha real (pesquisa por nome, `GET /api/casino/games`).
  - Fila **"Cassino em destaque"** na página Destaques com 6 jogos reais e curados
    (`GET /api/casino/games/highlighted`), a substituir os 4 emojis fixos anteriores.
  - `playGame(gameCode, gameName)` abre a aba do jogo já no clique (evita bloqueio de pop-up) e
    só lhe muda o destino após receber o `game_url` real de `POST /api/casino/launch`.

### Corrigido: imagens dos jogos não carregavam em produção

O utilizador confirmou em produção (Railway) que os jogos apareciam na grelha mas sem imagem.
Investigado: `api.playxspin.com` (domínio das imagens do catálogo) dá **timeout de ligação** na
porta 443 — testado tanto a partir deste ambiente de build (bloqueado pelo proxy do sandbox,
como seria de esperar) como, mais importante, **a partir da própria Console da Railway**
(`curl -sv https://api.playxspin.com/` → `Connection timed out after 10002 milliseconds`,
confirmado pelo utilizador). Como a Railway tem rede normal (já provou alcançar a Pulsescore sem
problemas), isto indica que o domínio de imagens do provedor não aceita ligações do IP da
Railway — provavelmente falta autorizar esse IP junto do Cassino Gold Palace (o mesmo
mecanismo, aliás, que provavelmente também bloqueia o endpoint de lançamento de jogo).

**Correção** (`server/src/modules/casino/imageProxy.ts` + rota `GET /api/casino/image/:gameCode`
em `routes.ts`): em vez do frontend carregar `<img src="https://api.playxspin.com/...">`
diretamente (dependência direta do browser do jogador nesse domínio), passa a carregar de
`/api/casino/image/{game_code}`, servido pelo próprio backend. O backend tenta buscar a imagem
real do provedor (timeout de 5s); se conseguir, serve-a com cache de 6h; se falhar (como agora),
gera e serve um placeholder SVG determinístico — cores e iniciais derivadas do nome do jogo,
sempre as mesmas para o mesmo jogo — com cache curto de 2min, para tentar de novo a imagem real
em breve (ex: assim que o IP for autorizado) sem martelar o provedor a cada carregamento de
página. Nunca devolve 404 nem deixa o `<img>` com ícone partido.

Frontend (`web/app.js`, fila de destaques e grelha do Cassino): trocado `g.game_image` por
`${window.BET62_CONFIG.API_BASE}/casino/image/${g.game_code}`.

Testado localmente: placeholder gerado corretamente (confirmado com Playwright — cores
consistentes por jogo, iniciais + nome legíveis), cache de falha confirmado (segundo pedido ao
mesmo jogo instantâneo, ~8ms). Assim que o IP da Railway for autorizado pelo provedor, as
imagens reais passam a aparecer sozinhas, sem precisar de mais nenhuma alteração de código.

## Testado nesta build

- ✅ Servidor local com Postgres real: `GET /api/casino/games` (490 jogos), `.../highlighted`
  (6 jogos), pesquisa (`?search=olympus` → 5 resultados corretos).
- ✅ `POST /api/casino/launch` contra uma Agent API mock local: `user/create` + `game-url`
  encadeados, `game_url` devolvido corretamente; jogo inexistente, `game_code` em falta e
  pedido não-autenticado devolvem os erros certos; `GET /api/casino/agent-info` restrito a
  SUPPORT/ADMIN (403 para USER comum, dados corretos para ADMIN).
- ✅ `POST /api/casino/callback` (despachante único, todos os 6 comandos testados, resultados
  conferidos byte-a-byte contra a amostra PHP oficial):
  - `authenticate`/`balance` devolvem `{account, balance}`/`{balance}`; conta desconhecida →
    `result: 21`.
  - `bet` debita corretamente (30.5 após apostar 5 de 35.5); reenviar o mesmo `trans_guid` →
    `result: 41` (**erro**, não sucesso idempotente); aposta maior que o saldo → `result: 31`.
  - `win` credita corretamente.
  - `cancel` de um `bet` devolve o valor apostado (30.5 → 35.5); cancelar o mesmo
    `cancel_trans_guid` outra vez (via um `trans_guid` de cancelamento diferente) devolve `OK`
    sem reaplicar o estorno; `cancel_trans_guid` inexistente → `result: 43`.
  - `status` devolve `trans_status: "OK"` para uma transação normal e `"CANCELED"` depois de
    estornada; `trans_guid` inexistente → `result: 42`.
  - Aliases `/callback/{comando}` testados sem `command` no corpo (inferido do path).
- ✅ `Callback-Token` inválido/em falta é recusado (`result: 100`); comando desconhecido devolve
  `result: 99` em vez de rebentar.
- ✅ Frontend testado com Playwright: fila de destaques (6 jogos) e página Cassino (grelha +
  pesquisa a filtrar corretamente) renderizam com dados reais da API.
- ⛔ Imagens dos jogos (`api.playxspin.com`) não carregam **neste ambiente de build** (proxy de
  rede da sessão bloqueia o domínio) — não é um bug do código, confirmar em produção/local com
  acesso à internet.
