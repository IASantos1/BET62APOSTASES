# Pagamentos — Stripe (depósitos) + Revolut Business (levantamentos)

⚠️ **Nota de validação**: este ambiente de build tem o proxy de rede a bloquear
`docs.stripe.com`, `developer.revolut.com` e outros domínios externos, por isso não foi
possível confirmar os detalhes abaixo diretamente contra a documentação oficial durante a
construção. Cada secção assinala com **NEEDS VALIDATION** os pontos que têm de ser
confirmados manualmente antes de ligar chaves reais em produção. O código já está escrito
para esse formato — só os nomes exatos de parâmetros/endpoints precisam de confirmação.

## Depósitos — Stripe (PaymentIntents, confirmados dentro do próprio layout)

Ficheiros: `server/src/modules/payments/stripe/{client,service,routes}.ts`,
`web/{index.html,app.js,api.js}` (secção `#deposit-modal`/`DEPOSIT`).

**Mudança de arquitetura (2ª vez)**: a versão anterior usava Checkout Sessions — uma página
hospedada pela Stripe, para onde a app inteira redirecionava (`window.location.href =
checkoutUrl`). Funcionava, mas o utilizador pediu explicitamente para **nunca abrir uma segunda
página** — o número de telemóvel MB WAY, os dados do cartão e a entidade/referência Multibanco
têm de aparecer dentro do próprio layout da BET62. Reescrito para **PaymentIntents diretas**,
uma abordagem diferente por método consoante o que cada um realmente precisa do browser:

| Bet62 (`DepositProvider`) | Como confirma | Precisa de Stripe.js no browser? |
|---|---|---|
| `STRIPE_CARD` | Cliente, com `stripe.confirmCardPayment()` usando um Card Element montado dentro do nosso modal (`#card-element`). | **Sim** — é o único caso: o número do cartão tem de nascer e morrer num iframe da própria Stripe (exigência de PCI-DSS, o nosso JS/servidor nunca o vê), mas esse iframe fica dentro do nosso modal, não numa página à parte. Um eventual desafio 3DS aparece como sobreposição na mesma página. |
| `STRIPE_MBWAY` | Servidor, com `confirm:true` + `billing_details.phone` (formato E.164, ex: `+351912345678` — **confirmado** via pesquisa à documentação pública, já que `docs.stripe.com` está bloqueado neste ambiente de build). | **Não.** A "confirmação" acontece na app MB WAY do telemóvel do cliente, não no browser — por isso o número fica só no nosso formulário e o pedido é confirmado diretamente no backend. O frontend passa a sondar `GET /deposits/:id` (a cada 3s, até ~90s) à espera que o cliente aprove. |
| `STRIPE_MULTIBANCO` | Servidor, com `confirm:true` + `billing_details.email` (o e-mail da própria conta BET62 do utilizador, sem pedir de novo). | **Não.** É um voucher estático — a resposta já vem com `next_action.multibanco_display_details.{entity,reference,expires_at}` (**confirmado** via `.d.ts` do SDK `stripe@22.5.0`), mostrado diretamente no nosso layout. Propositadamente **não** se usa `stripe.confirmMultibancoPayment()` no cliente — essa função de Stripe.js abre automaticamente o seu próprio modal com o voucher, o que voltaria a fugir do nosso layout. |

Em nenhum dos três casos o crédito da carteira acontece na resposta síncrona — mesmo quando o
estado já vem `"succeeded"` — só o webhook credita (`creditDepositFromIntent`), fonte única de
verdade idempotente (regra herdada da versão anterior, só mudou o nome dos campos).

Fluxo implementado:

1. `POST /api/payments/stripe/deposits` — recebe `{ provider, amountEur, phone? }` (`phone` só
   para `STRIPE_MBWAY`, validado/normalizado para E.164 antes de qualquer chamada à Stripe —
   um formato inválido nunca chega a criar um registo `Deposit`). Cria o `Deposit` (`PENDING`
   → `PROCESSING`) e devolve conforme o método:
   - Cartão: `{ depositId, clientSecret }`.
   - MB WAY: `{ depositId, status }` (`status` = estado da `PaymentIntent`, tipicamente
     `"processing"` — a aguardar aprovação no telemóvel).
   - Multibanco: `{ depositId, entity, reference, expiresAt }`.
2. `GET /api/payments/stripe/deposits/:id` — estado atual do depósito, sondado pelo frontend
   enquanto espera a aprovação MB WAY (`web/app.js::pollDepositStatus`).
3. Webhook `POST /api/payments/stripe/webhook` (montado com `express.raw` antes do
   `express.json`, ver `app.ts`) — valida a assinatura com `STRIPE_WEBHOOK_SECRET`; em
   `payment_intent.succeeded` credita a carteira via ledger (`applyLedgerMovement`);
   `payment_intent.payment_failed`/`payment_intent.canceled` marcam o depósito
   falhado/cancelado.
4. Proteções antes de creditar: idempotência (ignora se o depósito já estiver `SUCCEEDED` — a
   Stripe pode reenviar o mesmo evento), e confere o valor/moeda da `PaymentIntent` contra o
   depósito guardado antes de aplicar o crédito. Testado (Postgres de teste + assinatura HMAC
   gerada localmente, sem depender de rede): crédito correto, reenvio do mesmo evento não
   duplica, e um valor adulterado no evento não credita.
5. Regras de jogo responsável aplicadas antes de criar a `PaymentIntent`: montante entre 10€ e
   5000€, dentro do limite diário de depósito do utilizador, conta não autoexcluída.
6. `client.ts::getStripeClient()` recusa arrancar se `STRIPE_MODE` (sandbox/live) não bater
   certo com o prefixo da chave configurada (`sk_test_`/`sk_live_`) — protege contra ligar a
   plataforma ao modo errado sem dar por isso.

### Passagem para produção (LIVE, não sandbox)

1. **Aprovação de gambling na Stripe primeiro** (ver `docs/COMPLIANCE.md`) — sem isso a conta
   Stripe pode nem aceitar processar estes pagamentos, mesmo com chaves live.
2. No [Stripe Dashboard](https://dashboard.stripe.com) → **Developers → API keys**: copiar
   `sk_live_...` para `STRIPE_SECRET_KEY` **e** `pk_live_...` para `STRIPE_PUBLISHABLE_KEY`
   nas variáveis de ambiente do Railway (a chave publicável não é secreta — é servida ao
   browser via `GET /config.js` — mas a secreta nunca deve ir para o código nem ser colada em
   chat/commit). Sem `STRIPE_PUBLISHABLE_KEY`, o Card Element não monta e o depósito por
   cartão falha com uma mensagem clara ("Pagamento por cartão indisponível") em vez de um
   comportamento estranho.
3. **Developers → Webhooks → Add endpoint**: apontar para
   `https://<domínio-real-em-produção>/api/payments/stripe/webhook` (confirma o domínio
   exato que está ligado no Railway — ver `docs/DEPLOY_RAILWAY.md`), selecionar os eventos
   `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`.
   Copiar o `whsec_...` gerado para `STRIPE_WEBHOOK_SECRET`. **Se a conta ainda tiver o
   endpoint antigo criado para Checkout Sessions** (eventos `checkout.session.*`), atualizar
   os eventos selecionados nesse mesmo endpoint em vez de criar um segundo — os eventos
   `checkout.session.*` agora são só ignorados pelo código (`default:` no switch do webhook).
4. Mudar `STRIPE_MODE=live` no Railway (tem de bater certo com `sk_live_`, ver ponto 6 acima
   — o servidor recusa arrancar depósitos se não bater).
5. `apiVersion` do Stripe fixado em `2026-07-29.dahlia` no `client.ts` — lido diretamente de
   `node_modules/stripe/.../apiVersion.d.ts` do SDK instalado (`stripe@22.5.0`), já que
   docs.stripe.com/o dashboard não são alcançáveis deste ambiente de build. Continua a valer
   a pena confirmar contra o dashboard antes de produção, caso a conta tenha uma versão fixada
   diferente.
6. **MB WAY e Multibanco têm de estar ativados na conta** (Dashboard → Settings → Payment
   methods) — como agora são confirmados diretamente no servidor (`confirm:true`), um método
   desativado na conta faz a chamada `paymentIntents.create()` falhar de imediato (o utilizador
   vê o erro na hora, o depósito fica `FAILED`), não silenciosamente como acontecia com
   Checkout Sessions.
7. Fazer um depósito real pequeno (10€, o mínimo) com cada um dos 3 métodos antes de anunciar
   a plataforma como "live" — confirmar que o webhook chega, credita o saldo, e que reenviar o
   mesmo evento (dashboard → Webhooks → esse evento → "Resend") não credita a segunda vez.

### Ícones dos métodos de pagamento

`web/index.html` (secção `#deposit-modal`) mostra um ícone/badge por método (cartão, MB WAY,
Multibanco) no seletor da BET62 — **não são os logótipos oficiais registados** da MB WAY/
Multibanco (este ambiente de build não teve acesso à internet para obter os ficheiros de
marca reais), são badges próprios em cores aproximadas da marca, só para indicar visualmente
o método. Como agora tudo acontece dentro do nosso próprio modal (sem página da Stripe a
seguir), estes são os únicos ícones que o cliente vê no processo inteiro — só o Card Element
do cartão (`#card-element`) é um iframe da própria Stripe, sem logótipo próprio visível. Se
quiseres os logótipos exatos no nosso seletor, os ficheiros de marca oficiais (SVG) podem ser
obtidos em sites de imprensa/marca da SIBS (Multibanco/MB WAY) e trocados diretamente no HTML.

## Levantamentos — Revolut Business

Ficheiros: `server/src/modules/payments/revolut/{client,service,routes}.ts`

⚠️ **NEEDS VALIDATION integral**: a Revolut Business API não é tão amplamente documentada em
conhecimento público como a Stripe; o cliente em `client.ts` está escrito seguindo o padrão
conhecido de OAuth2 com "client assertion" (JWT assinado com chave privada), mas os nomes
exatos de endpoints (`/auth/token`, `/pay`, `/counterparty`) e campos do payload têm de ser
confirmados contra `https://developer.revolut.com/docs/business/business-api` antes de
ativar em produção.

Fluxo implementado:

1. Utilizador guarda uma conta bancária (`POST /api/payments/revolut/bank-accounts`).
2. Utilizador pede um levantamento (`POST /api/payments/revolut/withdrawals`) — validação:
   valor mínimo 10€, KYC `APPROVED`, saldo disponível suficiente. Os fundos ficam
   **bloqueados** (`wallet.lockedBalance`) até o levantamento ser processado ou rejeitado.
3. Um agente com papel `SUPPORT`/`ADMIN` aprova (`POST /withdrawals/:id/approve`) — isto
   chama `sendPayout()` na Revolut Business API. Em caso de sucesso, debita a carteira e
   regista no ledger; em caso de falha, liberta o valor bloqueado e marca `FAILED`.
4. Alternativamente, um agente pode rejeitar (`POST /withdrawals/:id/reject`), o que também
   liberta o valor bloqueado.

Este desenho garante que **nenhum levantamento sai automaticamente sem revisão humana** —
decisão deliberada de compliance, não uma limitação técnica.

### Antes de produção

- Confirmar o fluxo real de autenticação (certificado + chave privada gerados no painel
  Revolut Business, endpoint de token, formato do JWT assertion).
- Confirmar se é preciso criar um "counterparty" antes de cada pagamento ou se pode ser
  passado inline.
- Construir a interface de back-office para `SUPPORT`/`ADMIN` aprovarem levantamentos (hoje
  só existe a rota de API, sem UI).
- Pedir aprovação de gambling à Revolut Business (ver `docs/COMPLIANCE.md`).
