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
  rota real ainda não existe no backend (por implementar quando confirmado o contrato do corpo
  do callback).
- `POST /v4/user/create` — chamado ao vivo com `{ name: "test" }`, devolveu `code 1015
  CALLBACK_ERROR`. Confirma que `user/create` dispara uma chamada real de callback (não só um
  teste de conectividade como `agent/callback-test`) para validar a conta antes de a criar — e
  falha porque a rota real `/callback` ainda não existe neste backend. **Ainda não
  implementado no cliente** — falta o contrato do corpo/comando esperado pelo callback.
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
  `provider_id` 40 na resposta real.

Autenticação confirmada: header `Authorization: Bearer {CASINO_AGENT_KEY}` em todos os pedidos,
resposta sempre no formato `{ code, message, data }` (`code !== 0` é tratado como erro).

Variáveis de ambiente (`server/.env.example`): `CASINO_AGENT_KEY`, `CASINO_PROVIDER_BASE_URL`
(default `https://agent.goldslotpalase.com`).

**Ainda não implementado** (por implementar assim que confirmado): criação de utilizador no
provedor, lançamento de jogo (`game-url`), catálogo de jogos, endpoint/contrato de callback
(débito/crédito da carteira em tempo real), páginas de frontend (Cassino, Destaques, admin).

Se for preciso consultar a implementação anterior completa (catálogo, callbacks, seamless
wallet, UI) como referência, está disponível no histórico do git antes do commit de remoção.
