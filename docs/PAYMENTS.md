# Pagamentos — Stripe (depósitos) + Revolut Business (levantamentos)

⚠️ **Nota de validação**: este ambiente de build tem o proxy de rede a bloquear
`docs.stripe.com`, `developer.revolut.com` e outros domínios externos, por isso não foi
possível confirmar os detalhes abaixo diretamente contra a documentação oficial durante a
construção. Cada secção assinala com **NEEDS VALIDATION** os pontos que têm de ser
confirmados manualmente antes de ligar chaves reais em produção. O código já está escrito
para esse formato — só os nomes exatos de parâmetros/endpoints precisam de confirmação.

## Depósitos — Stripe

Ficheiros: `server/src/modules/payments/stripe/{client,service,routes}.ts`

Métodos suportados, mapeados para `payment_method_types` do Stripe:

| Bet62 (`DepositProvider`) | Stripe `payment_method_types` | Notas |
|---|---|---|
| `STRIPE_CARD` | `card` | Fluxo standard com SCA/3DS; requer Stripe.js/Elements no frontend com a chave publicável para confirmar o `client_secret` (**não implementado no frontend nesta fase** — falta a chave publicável). |
| `STRIPE_MBWAY` | `mb_way` | **NEEDS VALIDATION**: confirmar o nome exato do payment method type e a forma de passar o telemóvel na conta Stripe real (disponibilidade pode depender de aprovação regional). |
| `STRIPE_MULTIBANCO` | `multibanco` | Voucher-based (entidade + referência), moeda EUR obrigatória, liquidação diferida (o cliente paga num prazo, tipicamente até 7 dias). **NEEDS VALIDATION**: confirmar como ler `next_action.multibanco_display_details` e mostrar isso ao utilizador — o backend ainda não expõe esse campo na resposta do endpoint `/payments/stripe/deposits`. |

Fluxo implementado:

1. `POST /api/payments/stripe/deposits` — cria um registo `Deposit` (`PENDING`), depois um
   `PaymentIntent` na Stripe, atualiza o `Deposit` para `PROCESSING` e devolve o
   `clientSecret`.
2. Webhook `POST /api/payments/stripe/webhook` (montado com `express.raw` antes do
   `express.json`, ver `app.ts`) — valida a assinatura com `STRIPE_WEBHOOK_SECRET` e, em
   `payment_intent.succeeded`, credita a carteira do utilizador através do ledger
   (`applyLedgerMovement`), de forma idempotente (ignora se o depósito já estiver
   `SUCCEEDED`).
3. Regras de jogo responsável aplicadas antes de criar o `PaymentIntent`: montante entre 5€
   e 5000€, dentro do limite diário de depósito do utilizador, conta não autoexcluída.

### Antes de produção

- Confirmar `apiVersion` do Stripe (fixado em `2024-06-20` no `client.ts` — **NEEDS VALIDATION** contra a versão atual da conta).
- Implementar Stripe.js/Elements no frontend para confirmar o `card` PaymentIntent e mostrar
  o voucher Multibanco.
- Pedir aprovação de gambling à Stripe (ver `docs/COMPLIANCE.md`).
- Configurar o endpoint de webhook no dashboard da Stripe a apontar para
  `https://<seu-domínio>/api/payments/stripe/webhook` e copiar o `STRIPE_WEBHOOK_SECRET`.

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
