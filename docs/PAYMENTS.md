# Pagamentos — Stripe (depósitos) + Revolut Business (levantamentos)

⚠️ **Nota de validação**: este ambiente de build tem o proxy de rede a bloquear
`docs.stripe.com`, `developer.revolut.com` e outros domínios externos, por isso não foi
possível confirmar os detalhes abaixo diretamente contra a documentação oficial durante a
construção. Cada secção assinala com **NEEDS VALIDATION** os pontos que têm de ser
confirmados manualmente antes de ligar chaves reais em produção. O código já está escrito
para esse formato — só os nomes exatos de parâmetros/endpoints precisam de confirmação.

## Depósitos — Stripe (Checkout Sessions)

Ficheiros: `server/src/modules/payments/stripe/{client,service,routes}.ts`

**Mudança de arquitetura**: a primeira versão usava `PaymentIntents` diretamente, o que exige
Stripe.js/Elements no frontend para confirmar o cartão (3DS) e para ler
`next_action.multibanco_display_details` e mostrar o voucher — essa parte do frontend nunca
chegou a ser implementada (ficava só um alert a dizer "ainda não configurado"), por isso os
depósitos não funcionavam de ponta a ponta. Trocado para **Checkout Sessions**: uma página
paga hospedada pela própria Stripe, que já trata do 3DS, do pedido do número de telemóvel da
MB WAY, e da apresentação da entidade/referência Multibanco — o frontend só precisa de
redirecionar para `checkoutUrl`, sem Stripe.js nem chave publicável nenhuma.

Métodos suportados, mapeados para `payment_method_types` do Stripe Checkout:

| Bet62 (`DepositProvider`) | Stripe `payment_method_types` | Notas |
|---|---|---|
| `STRIPE_CARD` | `card` | 3DS tratado pela própria página da Stripe. |
| `STRIPE_MBWAY` | `mb_way` | O número de telemóvel é pedido na página da Stripe, não no nosso formulário. **NEEDS VALIDATION**: confirmar com um pagamento de teste real (disponibilidade pode depender de aprovação regional na conta Stripe). |
| `STRIPE_MULTIBANCO` | `multibanco` | Voucher-based (entidade + referência), moeda EUR obrigatória, liquidação diferida (o cliente paga num prazo, tipicamente até 7 dias) — a entidade/referência aparecem na própria página da Stripe. |

Fluxo implementado:

1. `POST /api/payments/stripe/deposits` — cria um registo `Deposit` (`PENDING`), depois uma
   `checkout.sessions.create` na Stripe (`mode: "payment"`, `locale: "pt"`), atualiza o
   `Deposit` para `PROCESSING` e devolve `{ depositId, checkoutUrl }`. O frontend
   (`web/app.js::submitDeposit`) redireciona a página inteira para `checkoutUrl`.
2. `success_url`/`cancel_url` apontam de volta para a própria SPA
   (`/?deposit=success&session_id=...` / `/?deposit=cancel`), lidos no arranque
   (`web/app.js::handleDepositRedirect`) só para mostrar uma mensagem — **nunca creditam o
   saldo por si só** (ver regra de segurança abaixo).
3. Webhook `POST /api/payments/stripe/webhook` (montado com `express.raw` antes do
   `express.json`, ver `app.ts`) — valida a assinatura com `STRIPE_WEBHOOK_SECRET`, e em
   `checkout.session.completed` (quando `payment_status:"paid"`, cobre cartão/MB WAY) ou
   `checkout.session.async_payment_succeeded` (cobre Multibanco, que só confirma dias
   depois), credita a carteira do utilizador através do ledger (`applyLedgerMovement`).
   `checkout.session.async_payment_failed`/`checkout.session.expired` marcam o depósito como
   falhado/cancelado.
4. Proteções antes de creditar: idempotência (ignora se o depósito já estiver `SUCCEEDED` —
   a Stripe pode reenviar o mesmo evento), e confere o valor/moeda do evento contra o
   depósito guardado antes de aplicar o crédito.
5. Regras de jogo responsável aplicadas antes de criar a sessão: montante entre 5€ e 5000€,
   dentro do limite diário de depósito do utilizador, conta não autoexcluída.
6. `client.ts::getStripeClient()` recusa arrancar se `STRIPE_MODE` (sandbox/live) não bater
   certo com o prefixo da chave configurada (`sk_test_`/`sk_live_`) — protege contra ligar a
   plataforma ao modo errado sem dar por isso.

### Passagem para produção (LIVE, não sandbox)

1. **Aprovação de gambling na Stripe primeiro** (ver `docs/COMPLIANCE.md`) — sem isso a conta
   Stripe pode nem aceitar processar estes pagamentos, mesmo com chaves live.
2. No [Stripe Dashboard](https://dashboard.stripe.com) → **Developers → API keys**: copiar
   `sk_live_...` para `STRIPE_SECRET_KEY` nas variáveis de ambiente do Railway (nunca no
   código, nunca colado em chat/commit).
3. **Developers → Webhooks → Add endpoint**: apontar para
   `https://<domínio-real-em-produção>/api/payments/stripe/webhook` (confirma o domínio
   exato que está ligado no Railway — ver `docs/DEPLOY_RAILWAY.md`), selecionar os eventos
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`. Copiar o
   `whsec_...` gerado para `STRIPE_WEBHOOK_SECRET`.
4. Mudar `STRIPE_MODE=live` no Railway (tem de bater certo com `sk_live_`, ver ponto 6 acima
   — o servidor recusa arrancar depósitos se não bater).
5. Confirmar `apiVersion` do Stripe (fixado em `2024-06-20` no `client.ts` — **NEEDS
   VALIDATION** contra a versão atual da conta no dashboard).
6. Fazer um depósito real pequeno (5€) com cada um dos 3 métodos antes de anunciar a
   plataforma como "live" — confirmar que o webhook chega, credita o saldo, e que reenviar o
   mesmo evento (dashboard → Webhooks → esse evento → "Resend") não credita a segunda vez.

### Ícones dos métodos de pagamento

`web/index.html` (secção `#deposit-modal`) mostra um ícone/badge por método (cartão, MB WAY,
Multibanco) no seletor da BET62 — **não são os logótipos oficiais registados** da MB WAY/
Multibanco (este ambiente de build não teve acesso à internet para obter os ficheiros de
marca reais), são badges próprios em cores aproximadas da marca, só para indicar visualmente
o método antes de avançar. A página de pagamento real que o cliente vê a seguir
(`checkoutUrl`, hospedada pela Stripe) já mostra os logótipos oficiais geridos pela própria
Stripe. Se quiseres os logótipos exatos no nosso próprio seletor, os ficheiros de marca
oficiais (SVG) podem ser obtidos em sites de imprensa/marca da SIBS (Multibanco/MB WAY) e
trocados diretamente no HTML.

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
