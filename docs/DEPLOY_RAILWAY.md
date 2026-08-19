# Deploy no Railway

⚠️ **Isto não pode ser feito por mim automaticamente**: eu não tenho as suas credenciais
Railway nem um token de API desta conta, por isso não consigo criar o projeto nem clicar
pelos ecrãs do painel. O que fiz foi deixar o repositório pronto para o deploy ser rápido —
os passos abaixo são o que falta clicar/colar do seu lado. Se preferir que eu corra os
comandos por si a partir daqui, veja a secção "Alternativa: Railway CLI" no fim.

## Arquitetura do deploy

Três peças no mesmo projeto Railway:

1. **Postgres** — plugin gerido do Railway (botão "+ New" → "Database" → "PostgreSQL").
2. **Serviço `server`** — a API Node/Express (pasta `server/`).
3. **Serviço `web`** — o frontend estático servido por `web/server.js` (pasta `web/`).

São dois serviços porque o repositório é um monorepo com dois `package.json` distintos —
é o padrão recomendado pelo próprio Railway para monorepos.

## Passo a passo

### 1. Criar o projeto
No painel Railway: **New Project → Deploy from GitHub repo** → escolher
`IASantos1/BET62APOSTASES` → branch `claude/bet62-production-platform-f9o80p` (ou `main`,
conforme o que tiver mais atual).

### 2. Adicionar o Postgres
**+ New → Database → Add PostgreSQL**. O Railway cria automaticamente a variável
`DATABASE_URL` nesse plugin — vamos referenciá-la no serviço `server` a seguir.

### 3. Configurar o serviço `server`
No primeiro serviço criado a partir do repo (ou crie um novo apontando ao mesmo repo):
- **Settings → Root Directory**: `server`
- **Variables**, adicionar:
  - `DATABASE_URL` → clique em "Add Reference" e escolha a variável `DATABASE_URL` do
    plugin Postgres (não copie o valor à mão — assim atualiza sozinho se o Postgres mudar).
  - `JWT_ACCESS_SECRET` → gerar com `openssl rand -hex 48`
  - `JWT_REFRESH_SECRET` → gerar com `openssl rand -hex 48` (diferente do anterior)
  - `NODE_ENV` → `production`
  - `CORS_ORIGIN` → o domínio do serviço `web` (só sabe o valor final depois do passo 5;
    pode voltar aqui para o ajustar)
  - Opcionais, deixe vazio até ter as contas aprovadas (ver `docs/PAYMENTS.md` e
    `docs/SPORTS_DATA.md`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
    `REVOLUT_CLIENT_ID`, `REVOLUT_PRIVATE_KEY`, `REVOLUT_ACCOUNT_ID`,
    `PULSESCORE_API_KEY`, `API_FOOTBALL_KEY`
- O Railway deteta o `railway.json` em `server/` automaticamente (build com
  `npm run build`, arranque com `npm start`, que já inclui `prisma migrate deploy` antes de
  o servidor arrancar — o schema fica sempre sincronizado a cada deploy).
- **Settings → Networking → Generate Domain** para obter o URL público (algo como
  `https://bet62-server-production.up.railway.app`).

### 4. Configurar o serviço `web`
**+ New → GitHub Repo** (mesmo repositório outra vez, como segundo serviço):
- **Settings → Root Directory**: `web`
- **Variables**:
  - `BET62_API_BASE` → `https://<domínio-do-server>/api` (o domínio do passo 3)
  - `BET62_WS_BASE` → `wss://<domínio-do-server>` (mesmo domínio, `wss://` em vez de
    `https://`)
- O `web/railway.json` já configura build/arranque automaticamente.
- **Settings → Networking → Generate Domain** para obter o URL público do site.

### 5. Fechar o CORS
Volte ao serviço `server` → Variables → `CORS_ORIGIN` → cole o domínio gerado para o `web`
no passo 4 (ex: `https://bet62-web-production.up.railway.app`, sem barra final). Guarde —
isto reinicia o serviço automaticamente.

### 6. Validar
- Abra o domínio do `web` no browser → deve carregar a página inicial do Bet62.
- Registe uma conta de teste → se o perfil carregar e o saldo aparecer, a ligação
  frontend → backend → Postgres está a funcionar de ponta a ponta.
- `https://<domínio-do-server>/api/health` deve devolver `{"status":"ok"}`.

### 7. Ligar Stripe/Revolut/Pulsescore/API-Football (quando tiver as contas aprovadas)
- No painel Stripe, configurar o endpoint de webhook como
  `https://<domínio-do-server>/api/payments/stripe/webhook` e copiar o
  `STRIPE_WEBHOOK_SECRET` gerado para a variável no Railway.
- Preencher as restantes variáveis (`STRIPE_SECRET_KEY`, `REVOLUT_*`, `PULSESCORE_API_KEY`,
  `API_FOOTBALL_KEY`) e redesploy do serviço `server`.
- Sem `PULSESCORE_API_KEY`, o sistema continua a funcionar com o feed de desporto simulado
  (`SPORTS_DATA_MOCK_FALLBACK=true` por defeito) — não é bloqueante para o resto da
  plataforma funcionar.

## Alternativa: Railway CLI

Se preferir que eu execute os comandos diretamente a partir desta sessão, instale a
Railway CLI (`npm i -g @railway/cli`) na sua máquina, gere um **Project Token** em
Railway → Project Settings → Tokens, e cole-o aqui como variável de ambiente
`RAILWAY_TOKEN`. Com isso eu consigo correr `railway up`, `railway variables set`, etc.
diretamente. Sem esse token não tenho como autenticar-me na sua conta.
