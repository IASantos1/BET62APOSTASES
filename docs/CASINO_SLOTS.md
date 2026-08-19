# Cassino (slots) — Cassino Gold Palace

## O que foi confirmado

O utilizador colou a documentação oficial da API do "Cassino Gold Palace" (provedor de
conteúdo de slots, réplicas de jogos populares — catálogo real recebido é maioritariamente
Pragmatic Play). Dessa documentação, o que está **confirmado** (frase/exemplo real dado pelo
provedor, não inventado):

- **Fuso horário da API**: UTC.
- **Três callbacks HTTP** que o provedor chama para o nosso servidor (`POST` para uma URL nossa
  configurada no painel do provedor), todos com o mesmo cabeçalho obrigatório
  `Callback-Token: <segredo>` e `Content-Type: application/json`:
  - `win` — credita o prémio ganho pelo jogador.
  - `cancel` — estorna uma transação anterior, identificada por `cancel_trans_guid`.
  - `status` — consulta o estado de uma transação (`trans_guid`) sem alterar nada.
- Forma do corpo de cada callback: `{ command, data: {...}, timestamp, check }`, onde `check` é
  uma lista de códigos (`21` confirmação do utilizador, `22` utilizador ativo, `31` saldo, `41`
  transação já processada, `42`/`43` existência do ID da transação/transação cancelada) que o
  provedor pede para validarmos antes de aceitar o pedido.
- Resposta esperada: `{ result, status, data: { balance } }`, com `result` a usar os códigos 0,
  1 e 1001 — a doc cita estes três valores mas **não** dá a tabela de significados. Neste
  código, `0` = sucesso (confirmado pelo exemplo de resposta), `1` = erro genérico e `1001` =
  transação já processada são a leitura padrão para este tipo de contrato seamless — **não
  confirmado** com uma resposta real de erro do provedor.
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

## ⚠️ Por confirmar — falta o endpoint de lançamento de jogo

A documentação recebida cobre **só o lado dos callbacks** (o provedor a chamar-nos para
debitar/creditar a carteira do jogador). **Não** inclui o endpoint que NÓS precisamos de chamar
para pedir uma sessão/URL de jogo ao provedor antes de o jogador conseguir sequer começar a
jogar — falta a base URL, o formato de autenticação de agente e a forma da resposta (URL do
iframe do jogo, token de sessão, etc.).

Sem isso, `POST /api/casino/launch` (autenticado) devolve sempre um erro 400 claro em vez de
inventar uma chamada HTTP para um endpoint nunca confirmado — `requestGameLaunch()` em
`server/src/modules/casino/service.ts`. As variáveis `CASINO_PROVIDER_BASE_URL` e
`CASINO_AGENT_KEY` (`server/src/config/env.ts`) estão prontas mas por preencher até essa parte
da doc chegar.

## O que está implementado

- `server/src/modules/casino/`:
  - `catalog.ts` — lista/pesquisa/destaques sobre o catálogo estático.
  - `service.ts` — `handleWinCallback`, `handleCancelCallback`, `handleStatusCallback`,
    idempotentes por `trans_guid` (tabela `CasinoTransaction`, `transGuid` com índice único —
    uma entrega repetida do mesmo callback nunca é reaplicada).
  - `routes.ts` — `GET /api/casino/games`, `GET /api/casino/games/highlighted`,
    `POST /api/casino/launch` (autenticado), `POST /api/casino/callback/{win,cancel,status}`
    (verificam `Callback-Token` contra `CASINO_CALLBACK_TOKEN`).
- Wallet: os créditos/estornos passam por `applyLedgerMovement()` (o mesmo motor de carteira já
  usado por depósitos/levantamentos), com `type: BET_WON`/`BET_REFUND` e
  `referenceType: "casino_slot"` — aparecem no extrato normal do utilizador
  (`GET /api/wallet/transactions`).
- **Limite conhecido**: a doc dada não inclui um callback "bet" (débito da aposta) — só
  `win`/`cancel`/`status`. `handleCancelCallback()` já está pronto para estornar um `BET`
  também (a lógica de reversão trata os dois casos), mas isso só ficará ativo quando esse
  callback em falta for confirmado e implementado.
- Frontend (`web/app.js`, `web/index.html`):
  - Página **Cassino** com grelha real (pesquisa por nome, `GET /api/casino/games`).
  - Fila **"Cassino em destaque"** na página Destaques com 6 jogos reais e curados
    (`GET /api/casino/games/highlighted`), a substituir os 4 emojis fixos anteriores.
  - `playGame(gameCode, gameName)` chama `POST /api/casino/launch` — mostra a mensagem de erro
    real do backend enquanto o endpoint de lançamento não estiver confirmado, em vez de um
    alerta genérico "não implementado".

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
- ✅ `POST /api/casino/callback/win` credita a carteira (saldo 0 → 1000), idempotência
  confirmada (reenvio do mesmo `trans_guid` devolve `result: 1001` sem duplicar o crédito).
- ✅ `POST /api/casino/callback/status` devolve o estado da transação.
- ✅ `POST /api/casino/callback/cancel` estorna o `win` anterior (saldo volta a 0).
- ✅ `Callback-Token` inválido/em falta é recusado (`result: 1`) em vez de aceite.
- ✅ `POST /api/casino/launch` devolve erro claro (autenticado e não-autenticado testados).
- ✅ Frontend testado com Playwright: fila de destaques (6 jogos) e página Cassino (grelha +
  pesquisa a filtrar corretamente) renderizam com dados reais da API.
- ⛔ Imagens dos jogos (`api.playxspin.com`) não carregam **neste ambiente de build** (proxy de
  rede da sessão bloqueia o domínio) — não é um bug do código, confirmar em produção/local com
  acesso à internet.
