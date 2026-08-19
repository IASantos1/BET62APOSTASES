# Deploy no Railway

⚠️ **Isto não pode ser feito por mim automaticamente**: eu não tenho as suas credenciais
Railway nem um token de API desta conta, por isso não consigo criar o projeto nem clicar
pelos ecrãs do painel. O que fiz foi deixar o repositório pronto para o deploy ser rápido —
os passos abaixo são o que falta clicar/colar do seu lado. Se preferir que eu corra os
comandos por si a partir daqui, veja a secção "Alternativa: Railway CLI" no fim.

## Arquitetura do deploy

Um único serviço Node no Railway serve tudo: a API Express (`server/`) e os ficheiros
estáticos do frontend (`web/`) a partir do **mesmo processo e da mesma origem**. Já não há
dois serviços nem duas Root Directories para configurar — o `package.json` na raiz do
repositório orquestra a instalação/build/arranque do `server/`, e o próprio Express
(`server/src/app.ts`) serve `web/index.html`, `web/app.js`, `web/api.js`, etc. a partir das
mesmas rotas.

Duas peças no projeto Railway:

1. **Postgres** — plugin gerido do Railway (botão "+ New" → "Database" → "PostgreSQL").
2. **Serviço único** — API + frontend juntos, deploy a partir da raiz do repositório
   (sem definir Root Directory nenhuma — a raiz já tem o `package.json` e o `railway.json`
   corretos).

Como frontend e backend passam a estar na mesma origem, não é preciso configurar
`BET62_API_BASE`/`BET62_WS_BASE` nem apontar `CORS_ORIGIN` para outro domínio — o browser
já fala com `/api/...` e `wss://<mesmo-domínio>` diretamente.

## Passo a passo

### 1. Criar o projeto
No painel Railway: **New Project → Deploy from GitHub repo** → escolher
`IASantos1/BET62APOSTASES` → branch `claude/bet62-production-platform-f9o80p` (ou `main`,
conforme o que tiver mais atual).

### 2. Adicionar o Postgres
**+ New → Database → Add PostgreSQL**. O Railway cria automaticamente a variável
`DATABASE_URL` nesse plugin — vamos referenciá-la no serviço principal a seguir.

### 3. Configurar o serviço
No serviço criado a partir do repo:
- **Settings → Root Directory**: deixe vazio (a raiz do repositório é o serviço).
- **Variables**, adicionar:
  - `DATABASE_URL` → clique em "Add Reference" e escolha a variável `DATABASE_URL` do
    plugin Postgres (não copie o valor à mão — assim atualiza sozinho se o Postgres mudar).
  - `JWT_ACCESS_SECRET` → gerar com `openssl rand -hex 48`
  - `JWT_REFRESH_SECRET` → gerar com `openssl rand -hex 48` (diferente do anterior)
  - `NODE_ENV` → `production`
  - Opcionais, deixe vazio até ter as contas aprovadas (ver `docs/PAYMENTS.md` e
    `docs/SPORTS_DATA.md`): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
    `REVOLUT_CLIENT_ID`, `REVOLUT_PRIVATE_KEY`, `REVOLUT_ACCOUNT_ID`,
    `PULSESCORE_API_KEY`, `API_FOOTBALL_KEY`
- O Railway deteta o `package.json` e o `railway.json` na raiz automaticamente: instala
  dependências (que por sua vez instalam as de `server/`, via `postinstall`), builda com
  `npm run build` e arranca com `npm start` — que já inclui `prisma migrate deploy` antes de
  o servidor arrancar, então o schema fica sempre sincronizado a cada deploy.
- **Settings → Networking → Generate Domain** para obter o URL público (algo como
  `https://bet62-production.up.railway.app`) — este único domínio serve tanto o site como
  a API (`/api/...`).

### 4. Validar
- Abra o domínio gerado no browser → deve carregar a página inicial do Bet62 diretamente
  (sem precisar de segundo domínio).
- Registe uma conta de teste → se o perfil carregar e o saldo aparecer, a ligação
  frontend → backend → Postgres está a funcionar de ponta a ponta.
- `https://<domínio>/api/health` deve devolver `{"status":"ok"}`.

### 5. Ligar Stripe/Revolut/Pulsescore/API-Football (quando tiver as contas aprovadas)
- No painel Stripe, configurar o endpoint de webhook como
  `https://<domínio>/api/payments/stripe/webhook` e copiar o `STRIPE_WEBHOOK_SECRET`
  gerado para a variável no Railway.
- Preencher as restantes variáveis (`STRIPE_SECRET_KEY`, `REVOLUT_*`, `PULSESCORE_API_KEY`,
  `API_FOOTBALL_KEY`) e redeploy do serviço.
- Sem `PULSESCORE_API_KEY`, o resto da plataforma continua a funcionar normalmente — só as
  páginas Ao Vivo e Esportes ficam sem jogos (nunca se mostram odds/eventos simulados a
  utilizadores reais).

## Alternativa: Railway CLI

Se preferir que eu execute os comandos diretamente a partir desta sessão, instale a
Railway CLI (`npm i -g @railway/cli`) na sua máquina, gere um **Project Token** em
Railway → Project Settings → Tokens, e cole-o aqui como variável de ambiente
`RAILWAY_TOKEN`. Com isso eu consigo correr `railway up`, `railway variables set`, etc.
diretamente. Sem esse token não tenho como autenticar-me na sua conta.

## Desenvolvimento local do frontend isolado (opcional)

Já não existe `web/server.js`/`web/package.json` — em desenvolvimento local, o próprio
`npm run dev` (raiz ou `server/`) já serve o frontend em `http://localhost:4000` junto com
a API, exatamente como vai acontecer em produção. Não é preciso correr o frontend à parte.
