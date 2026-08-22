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

Autenticação confirmada: header `Authorization: Bearer {CASINO_AGENT_KEY}` em todos os pedidos,
resposta sempre no formato `{ code, message, data }` (`code !== 0` é tratado como erro).

Variáveis de ambiente (`server/.env.example`): `CASINO_AGENT_KEY`, `CASINO_PROVIDER_BASE_URL`
(default `https://agent.goldslotpalase.com`).

**Ainda não implementado** (por implementar assim que confirmado): criação de utilizador no
provedor, lançamento de jogo (`game-url`), catálogo de jogos, endpoint/contrato de callback
(débito/crédito da carteira em tempo real), páginas de frontend (Cassino, Destaques, admin).

Se for preciso consultar a implementação anterior completa (catálogo, callbacks, seamless
wallet, UI) como referência, está disponível no histórico do git antes do commit de remoção.
