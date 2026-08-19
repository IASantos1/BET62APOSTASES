# Bet62 — Backend

Node.js + TypeScript + Express + Prisma + PostgreSQL.

## Setup

```bash
cp .env.example .env
```

Preencher pelo menos:
- `DATABASE_URL` — ligação a um PostgreSQL (local ou gerido).
- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` — segredos aleatórios de 32+ caracteres
  (`openssl rand -hex 48`).

As restantes variáveis (Stripe, Revolut, Pulsescore, API-Football) podem ficar vazias — o
servidor arranca na mesma; cada integração só falha (com uma mensagem clara em português) se
for chamada sem a respetiva chave configurada. Sem `PULSESCORE_API_KEY`, as páginas Ao Vivo e
Esportes ficam simplesmente sem jogos — nunca se mostram dados simulados.

```bash
npm install
npx prisma migrate dev --name init
npm run dev
```

API disponível em `http://localhost:4000`. Healthcheck: `GET /api/health`.

## Scripts

| Comando | Descrição |
|---|---|
| `npm run dev` | Servidor com reload automático (tsx watch) |
| `npm run build` | Compila para `dist/` |
| `npm start` | Corre a build compilada |
| `npm run typecheck` | Verifica tipos sem gerar output |
| `npm run prisma:studio` | UI para inspecionar a base de dados |
| `npm run prisma:migrate` | Cria/aplica uma nova migração em desenvolvimento |

## Estrutura

```
src/
  config/env.ts          Validação de variáveis de ambiente (zod)
  lib/                    prisma client, logger, jwt, erros
  middleware/             auth, validação, tratamento de erros
  modules/
    auth/                 registo, login, refresh, logout
    users/                perfil, KYC, limites, autoexclusão
    wallet/                ledger + saldo
    payments/
      stripe/              depósitos (cartão, MB WAY, Multibanco)
      revolut/              levantamentos (payout + aprovação manual)
    sports/
      pulsescore/           cliente websocket (futebol/ténis/basquete)
      apifootball/           cliente REST (estatísticas)
      hybridService.ts       agrega tudo + fallback simulado
      websocket/gateway.ts   expõe /ws/live para o frontend
```

## Testado nesta sessão

Fluxo completo validado com PostgreSQL real: registo → perfil → saldo → submissão de KYC →
atualização de limites → bloqueio correto de depósito sem chave Stripe → bloqueio correto de
levantamento sem KYC aprovado → login → refresh token inválido rejeitado. WebSocket `/ws/live`
testado com odds ao vivo reais da Pulsescore (ver docs/SPORTS_DATA.md).

Não testado nesta sessão (sem credenciais/rede disponíveis): ligação real à Pulsescore,
chamadas reais à API-Football, PaymentIntents reais na Stripe, payouts reais na Revolut
Business — ver `docs/PAYMENTS.md` e `docs/SPORTS_DATA.md` para o que falta confirmar antes de
produção.
