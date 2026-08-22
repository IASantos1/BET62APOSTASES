# Cassino (slots) — removido

A integração com o "Cassino Gold Palace" (goldslotpalase.com) foi **removida por completo** a
pedido explícito do utilizador (2026-08-21), depois de uma investigação extensa não conseguir
fazer o lançamento real de jogos funcionar em produção.

## Porquê

O lançamento de um jogo passava por dois pedidos à Agent API do provedor: `POST
/v4/user/create` seguido de `POST /v4/game/game-url`. O segundo devolvia sempre
`CALLBACK_ERROR` — o provedor testa o nosso URL de callback (`/api/casino/callback`) antes de
conceder o link do jogo, e esse auto-teste nunca chegava ao nosso servidor.

Investigado a fundo com o utilizador, por eliminação:
- Confirmado que `https://bet62.plus/api/health` responde corretamente a partir do browser dele
  — o domínio de produção estava bem ligado ao backend (não era DNS/certificado/routing).
- Confirmado que o URL de callback configurado no painel do provedor
  (`https://bet62.plus/api/Casino/callback`) batia certo com a rota real do backend (Express não
  é sensível a maiúsculas/minúsculas por omissão — testado localmente).
- Nenhuma linha "callback recebido" apareceu nos logs do Railway (com registo de diagnóstico
  dedicado, adicionado especificamente para investigar isto) ao tentar abrir um jogo — o pedido
  de auto-teste do provedor nunca chegava ao servidor.
- Conclusão: o problema estava do lado da rede do provedor a alcançar `bet62.plus` (o mesmo tipo
  de bloqueio já confirmado antes com `api.playxspin.com`, que dava timeout a partir do Railway
  ao carregar imagens de jogos — desta vez na direção inversa). Não era algo corrigível por
  código deste lado; precisava de ser resolvido pelo suporte técnico do provedor.

Nenhuma transação real de jogo chegou a ser processada em produção (o lançamento nunca
funcionou), por isso não havia histórico financeiro real a perder com a remoção.

## O que foi removido

- Backend: `server/src/modules/casino/` (módulo inteiro — catálogo, cliente da Agent API,
  callbacks, proxy de imagens), a rota `/api/casino` em `app.ts`, os endpoints de gestão em
  `admin/routes.ts`/`admin/service.ts` (jogos/transações/agent-info), as variáveis de ambiente
  `CASINO_AGENT_KEY`/`CASINO_CALLBACK_TOKEN`/`CASINO_PROVIDER_BASE_URL`, e os modelos Prisma
  `CasinoTransaction`/`CasinoGameOverride`/`CasinoTxType` (ver migração
  `20260821200000_remove_casino_integration`).
- Frontend: a página Cassino, o item de navegação, a fila "Cassino em Destaque" na página
  Destaques, e a secção de gestão no painel admin.

Se algum dia se quiser retomar um fornecedor de cassino (o mesmo ou outro), a implementação
completa (contrato confirmado via Swagger real, seamless wallet, todos os 6 comandos de
callback) continua disponível no histórico do git deste branch antes desta remoção.
