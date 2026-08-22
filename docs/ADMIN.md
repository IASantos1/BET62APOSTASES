# Painel Administrativo — Bet62

SPA própria em `/admin` (`web/admin.html` + `web/admin.js`), separada da app do jogador
(`/`), com login e tokens próprios (`bet62_admin_access_token`/`bet62_admin_refresh_token`
em `localStorage`, chaves diferentes das do jogador — uma conta admin e uma conta jogador
podem estar ambas autenticadas no mesmo browser sem se pisarem). Autenticação reutiliza o
mesmo `POST /api/auth/login` do jogador; o que muda é a permissão exigida: todas as rotas
`/api/admin/*` (`server/src/modules/admin/routes.ts`) exigem `requireAuth` +
`requireRole("ADMIN")` — uma conta `USER`/`SUPPORT` recebe 403 em qualquer chamada.

## Como promover a primeira conta admin

Não existe (propositadamente) nenhum endpoint self-serve para virar admin — seria uma
escalada de privilégio óbvia. A conta tem de existir primeiro como registo normal
(`/registo`), depois promovida diretamente na base de dados:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = 'teu-email@exemplo.com';
```

No Railway: abre a Console do serviço do backend (o mesmo sítio onde já correste os `curl`
de diagnóstico da API-Football) e usa `psql "$DATABASE_URL" -c "UPDATE ..."`, ou liga por
`prisma studio` localmente apontado ao `DATABASE_URL` de produção. A partir daí, essa conta
já entra em `/admin` com o mesmo email/password.

## O que o painel cobre

- **Dashboard** — utilizadores totais/ativos/novos hoje, saldo total em carteiras, KYC e
  levantamentos pendentes, depósitos/levantamentos/transações de cassino do dia, atividade
  recente (audit log).
- **Utilizadores** — pesquisa/filtro por estado e papel, ficha detalhada (carteira, KYC,
  autoexclusões, últimos movimentos/depósitos/levantamentos), mudar estado
  (ACTIVE/SUSPENDED/CLOSED), mudar papel (USER/SUPPORT/ADMIN), ajuste manual de saldo
  (crédito/débito com motivo obrigatório — grava um `LedgerEntry` tipo `ADJUSTMENT` e uma
  entrada no audit log).
- **KYC** — fila de submissões pendentes, aprovar/rejeitar (rejeitar exige motivo).
- **Levantamentos** — a revisão AML já existia no backend
  (`payments/revolut/service.ts::approveAndPayWithdrawal`/`rejectWithdrawal`, já protegida
  por `requireRole("SUPPORT","ADMIN")`) mas não tinha UI nem uma listagem admin-wide (a
  rota do jogador só lista os seus próprios); o painel só acrescentou isso.
- **Depósitos** — só leitura (o estado é dirigido pelo webhook do Stripe, não há ação manual
  aqui).
- **Jogo Responsável** — lista de autoexclusões ativas, para monitorização.
- **Audit Log** — todas as ações administrativas (e a maior parte das ações do jogador que
  já eram registadas) com filtro por utilizador/ação.
- **Definições** — modo de manutenção (bloqueia `/api/*` para jogadores com 503, exceto
  login/refresh/logout e o próprio `/api/admin/*` — ver `maintenanceGate.ts`) e limites
  informativos de depósito/levantamento/KYC (guardados em `PlatformSetting`, **ainda não
  ligados** à validação real dos pedidos de depósito/levantamento — isso fica para quando
  esse trabalho avançar, não é fingido como já estando ativo).

## O que NÃO está aqui (e porquê)

Gestão de risco de apostas por evento/mercado (exposição, limites por jogador em tempo
real) não está implementada porque **não existe ainda um motor de apostas real** — o
boletim do jogador (`placeBetDemo()` em `web/app.js`) ainda é só navegação de mercados,
sem colocação/liquidação de apostas persistida. Construir essa gestão de risco antes do
motor existir seria mostrar dados inventados como se fossem reais. Quando o motor de
apostas for implementado, a base já está pronta para acrescentar essa secção (o
`AuditLog`, o `requireRole`, e o padrão de módulo admin já existem).
