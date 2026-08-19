# Bet62

Plataforma de apostas desportivas — backend real (Node/TypeScript/Express/Prisma/PostgreSQL)
+ frontend estático, com depósitos via Stripe (cartão, MB WAY, Multibanco), levantamentos via
Revolut Business, e dados desportivos ao vivo num sistema híbrido Pulsescore (websocket:
futebol, ténis, basquete) + API-Football (estatísticas).

## Estrutura

```
server/   Backend (Express + Prisma + PostgreSQL)
web/      Frontend estático (HTML/CSS/JS puro, sem build step)
docs/     Documentação de pagamentos, dados desportivos e conformidade legal
```

## Estado atual (esta fase)

Construído e testado nesta sessão (registo, login, perfil, saldo, KYC, limites e o gate de
levantamento foram validados de ponta a ponta com uma base de dados PostgreSQL real):

- ✅ Autenticação JWT (registo, login, refresh, logout)
- ✅ Carteira com ledger atómico (sem drift entre saldo e histórico)
- ✅ Perfil, KYC (submissão), limites de jogo responsável, autoexclusão
- ✅ Depósitos via Stripe (Payment Intents: cartão / MB WAY / Multibanco) — sandbox, sem chave configurada nesta sessão
- ✅ Levantamentos via Revolut Business, com aprovação manual de compliance obrigatória
- ✅ Feed híbrido de desporto ao vivo (Pulsescore + API-Football) com fallback simulado — testado com dados simulados
- ✅ Frontend ligado à API real (sem localStorage a simular utilizador)

**Não construído nesta fase** (fora do escopo definido para esta sessão — ver
`docs/COMPLIANCE.md` secção 5 para a lista completa):
- Licenciamento SRIJ / aprovação de gambling na Stripe e Revolut Business (decisão/execução do operador, não código)
- Interface de back-office para aprovar KYC e levantamentos
- Stripe.js/Elements no frontend para confirmar pagamentos com cartão
- Motor de apostas em si (seleção de mercados, criação de bilhetes, liquidação de apostas)
- Casino (os jogos no frontend são placeholders visuais)

## Como correr localmente

Ver `server/README.md` para instruções detalhadas do backend.

```bash
cd server
cp .env.example .env   # preencher DATABASE_URL e os segredos JWT no mínimo
npm install
npx prisma migrate dev
npm run dev             # API em http://localhost:4000
```

```bash
cd web
python3 -m http.server 5500   # ou qualquer servidor estático
# abrir http://localhost:5500 — por defeito aponta para a API em http://localhost:4000/api
```

## Segurança

Se encontrar um segredo (token, chave de API) commitado no repositório, revogue-o
imediatamente e substitua por um placeholder — não depende de reescrever o histórico do git
para deixar de ser um risco ativo, mas considere isso também. Ver o histórico de commits desta
sessão para um exemplo real que foi corrigido.
