# Motor de apostas — colocação, débito e liquidação

Ficheiros: `server/src/modules/betting/{service,settlement,settlementRules,routes}.ts`,
`web/app.js` (secção `DEPOSIT`... procurar `submitBetslip`).

## Colocação

`POST /api/bets` — `{ mode: "SIMPLES"|"MULTIPLA", selections: [...], stake? }`.

- **Simples**: cada seleção do boletim vira o seu próprio `Bet` (1 seleção, stake próprio,
  vindo de `selections[].stake`). Uma seleção pode falhar (odd mudou entretanto, mercado
  suspenso) sem impedir as outras — a resposta `{ bets, errors }` diz quais foram colocadas e
  porque é que as outras não foram.
- **Múltipla**: todas as seleções combinadas num único `Bet` (stake combinado, vindo do campo
  `stake` de topo), odd total = produto das odds individuais. Tudo-ou-nada: uma seleção
  inválida (odd mudou, mercado suspenso, duas seleções do mesmo evento) rejeita o pedido
  inteiro, nada é colocado.

Antes de debitar, cada seleção é revalidada contra os dados **atuais** (ao vivo via
`hybridSportsService`, ou pré-jogo via `getPrematchEvents`) — a odd que o cliente mandou nunca
é confiada, só usada para detetar se mudou desde que o utilizador viu o boletim. O débito da
carteira (`applyLedgerMovement`, tipo `BET_PLACED`, valor negativo) acontece dentro da mesma
transação Prisma que cria o(s) `Bet`/`BetSelection` — insuficiência de saldo faz tudo reverter
junto, nunca fica um bilhete criado sem o dinheiro correspondente debitado.

## Liquidação

A Pulsescore **nunca reporta um estado "finished" explícito** no feed ao vivo — um jogo
simplesmente desaparece do próximo snapshot. Por isso a liquidação é disparada pelo evento
`"remove"` do `hybridSportsService` (`server/src/server.ts`), que agora carrega consigo o
**último estado conhecido** desse evento (incluindo o placar final) — o único momento em que
esse dado ainda está disponível.

### O que é liquidado automaticamente

Só para futebol/basquetebol/hóquei de gelo/beisebol (`SCORE_SETTLEABLE_SPORTS` em
`settlementRules.ts` — ténis e voleibol contam por sets, não por `homeScore`/`awayScore`, e
Fórmula 1/MMA não têm essa forma de placar; nenhum destes é liquidado automaticamente, ver
abaixo) e só para mercados classificados com confiança suficiente pelo nome bruto do mercado:

| Categoria | Exemplos de nome de mercado | Precisa de |
|---|---|---|
| Resultado (1X2) | "Match Odds", "1X2", "To Win", "Winner" | placar final |
| Dupla Chance | "Double Chance" | placar final |
| Empate Anula Aposta | "Draw No Bet" | placar final (empate = VOID) |
| Mais/Menos golos/pontos | "Over/Under", "Total Goals/Points" | placar final + linha (extraída do nome do mercado ou da seleção) |
| Mais/Menos cantos | mesmo, com "corner" no nome | `event.statistics.home/away.corners` finais (se a Pulsescore os deu) |
| Mais/Menos cartões | mesmo, com "card"/"booking" no nome | `event.statistics.home/away.{yellowCards,redCards}` finais |
| Ambas Marcam | "Both Teams to Score", "BTTS" | placar final |
| Placar Exato | "Correct Score" | placar final (seleção tem de ser literalmente "H-A") |

Qualquer mercado de **uma parte específica** (1º Tempo, 2º Quarto, 1º Set...) é **sempre**
excluído da liquidação automática, mesmo que a categoria acima o cobrisse para o jogo inteiro —
resolver isso exigiria o placar naquele momento específico (ex: ao intervalo), que este sistema
não guarda, só o placar final. Handicap/Spread também ficam de fora de propósito: o formato
exato da seleção nunca foi confirmado contra uma amostra real da Pulsescore.

### O que fica para revisão manual do admin

Tudo o que não bate nas regras acima (`BetSelectionStatus.NEEDS_REVIEW` → o `Bet` inteiro fica
`NEEDS_REVIEW` assim que todas as suas seleções estiverem decididas) aparece em
**Admin → `GET /api/admin/bets/needs-review`**. `POST /api/admin/bets/selections/:id/settle`
(`{ outcome: "WON"|"LOST"|"VOID" }`) resolve manualmente uma seleção — o mesmo cálculo de
payout da liquidação automática aplica-se assim que todas as seleções do bilhete estiverem
decididas (WON/LOST/VOID em qualquer combinação, nunca mais PENDING/NEEDS_REVIEW).

### Regra de payout numa Múltipla com seleções VOID

Uma seleção VOID (evento cancelado/adiado) é tratada como odd 1.0 — sai do cálculo sem anular
o bilhete inteiro ("empate anula aposta" clássico): se todas as OUTRAS seleções ganharam, o
bilhete é WON com a odd recalculada só sobre as seleções que realmente ganharam. Se todas as
seleções ficarem VOID, o bilhete inteiro é VOID (stake devolvido). Se qualquer seleção (não
VOID) perder, o bilhete inteiro é LOST — nenhum crédito.

### Nunca dois sítios a decidir "já paguei"

O crédito da carteira só acontece dentro de `applyFinalOutcome` (chamada pela liquidação
automática e pela manual, nunca duplicada) — mesmo quando a `PaymentIntent`/estado já vem
"resolvido" antes disso, o pagamento em si não é aplicado ali, evitando dois caminhos capazes
de creditar o mesmo bilhete.

## Vassoura de segurança

`sweepStaleBets()` (chamada a cada 30 minutos, `server.ts`) cobre o caso raro de o processo
reiniciar a meio de um jogo — o mapa em memória do `hybridSportsService` reconstrói-se do zero
num restart, por isso o evento `"remove"` desse jogo específico nunca chegaria a disparar.
Marca para revisão manual (nunca inventa um resultado) qualquer `BetSelection` ainda `PENDING`
cujo `kickoffAt` já passou há mais de 6 horas.

## Testado

Contra Postgres de teste (sem rede): colocação Simples/Múltipla com débito atómico, rejeição
por odd desatualizada, rejeição por saldo insuficiente (rollback completo), liquidação
1X2/Dupla Chance/Mais-Menos/Ambas Marcam/Placar Exato/Empate Anula Aposta, idempotência
(reenviar o mesmo evento não credita duas vezes), mercado não reconhecido → NEEDS_REVIEW →
resolução manual do admin com payout correto.
