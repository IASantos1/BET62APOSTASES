# Mapeamento Pulsescore ↔ API-Football

## Decisão de arquitetura

A **Pulsescore continua a conduzir a lista de eventos e as odds** — é a única fonte com
mercados de apostas reais (bookmaker paddypower por trás). A **API-Football não tem odds
nenhumas**, só estatísticas/fixtures/classificações/previsões — por isso não pode decidir
que jogos aparecem no site sem risco de mostrar jogos sem odds ou esconder jogos que a
Pulsescore cobre mas a API-Football não tem no calendário (confirmado com o utilizador antes
de implementar).

A API-Football entra como **camada de identificação/enriquecimento por baixo**: cada evento
Pulsescore é ligado (com cache permanente) ao seu fixture/equipas/liga correspondentes na
API-Football, e essa ligação é que alimenta H2H, previsões, classificação e estatísticas
detalhadas por equipa.

## Por que não usar o nome como chave

As duas fontes escrevem os nomes de forma diferente (`Manchester United` vs `Man Utd`,
`Internazionale` vs `Inter`, `Paris Saint Germain` vs `PSG`...). Comparar strings a cada
pedido é caro (pesquisa na API-Football) e frágil (nunca aprende com o que já foi resolvido).
A regra do sistema: **nome não é identidade** — a identidade é o par de ids (Pulsescore não
tem id de equipa estável, ver abaixo) mais o mapping confirmado; o nome só serve para a
descoberta inicial da correspondência.

## Limitação real dos dados: Pulsescore não tem id de equipa

Em nenhuma amostra real confirmada até agora a Pulsescore devolve um id de equipa estável —
só o nome (`home`/`away`) dentro de cada evento. Por isso `TeamMapping.pulsescoreName`/
`normalizedPulsescoreName` (dentro do mesmo desporto) fazem esse papel de identidade do lado
Pulsescore, com os dados que realmente existem — não um `pulsescore_team_id` inventado.

## Arquitetura

```
LiveEvent (Pulsescore)
  → mapping/service.ts (resolveFixtureForEvent / resolveTeamsForEvent / resolveLeagueForEvent)
    → mapping/fixtureMatcher.ts (cache FixtureMapping por pulsescoreEventKey)
      → mapping/teamMatcher.ts (cache TeamMapping por sport+normalizedPulsescoreName)
        → mapping/aliasStore.ts (dicionário de aliases, TeamAlias)
        → mapping/normalize.ts (normalizeTeamName, calculateTeamSimilarity — puras, sem I/O)
        → apifootball/client.ts (searchTeamCandidates — pesquisa crua na API-Football)
      → mapping/leagueMatcher.ts (cache LeagueMapping, mesma lógica para ligas)
      → apifootball/client.ts (findFixtureId — id do fixture por equipas+data)
```

`routes.ts` (h2h/predictions/standings) e `hybridService.ts` (getStatistics) só falam com
`mapping/service.ts` — nunca diretamente com teamMatcher/fixtureMatcher/leagueMatcher.

## Prioridade de correspondência (teamMatcher.ts/leagueMatcher.ts/fixtureMatcher.ts)

1. **Mapping já em cache** (`TeamMapping`/`LeagueMapping`/`FixtureMapping`) — reaproveitado
   sem nova pesquisa, incluindo correções manuais do admin (nunca sobrescritas
   automaticamente).
2. **Alias conhecido** (`TeamAlias`) — resolve acrónimos sem sobreposição textual nenhuma com
   o nome completo (`PSG` → `Paris Saint Germain`), que a semelhança de texto pura não apanha.
3. **Nome normalizado exato** — depois de remover acentos, sufixos genéricos (FC/CF/AC/...) e
   pontuação.
4. **Semelhança de texto** (`calculateTeamSimilarity` — sobreposição de palavras + distância
   de edição, com prefixos curtos tipo "Man"→"Manchester" já contados como fortes).

Abaixo de **70% de confiança, nunca associa automaticamente** — fica guardado com
`apiFootballTeamId`/`apiFootballFixtureId` a `null`, disponível para revisão manual no painel
admin (`/admin` → Mapeamento), em vez de arriscar mostrar a equipa/fixture errada.

## Pontuação de confiança

- **97-98%**: nome normalizado bate exatamente (ou via alias, +1pp).
- **85-95%**: alias conhecido + boa semelhança de texto.
- **proporcional à semelhança** (até ~90%) nos restantes casos.
- **+5** se o país da equipa bate certo, **-15** se não bate (quando ambos conhecidos).
- Ao nível do fixture: **+10** se o fixture do dia foi mesmo encontrado na API-Football
  (equipas+data), **-20** se as equipas foram identificadas mas nenhum fixture correspondeu
  (pode ser um jogo que a API-Football não cobre), **+3** se a liga também foi identificada.

Testado com os pares reais/adversariais do pedido original (ver
`server/src/modules/sports/mapping/normalize.ts` para os casos cobertos e os que
precisam mesmo do dicionário de aliases, como `PSG`/`Paris Saint Germain`).

## Cache permanente (nunca repete a pesquisa)

- `TeamMapping`/`LeagueMapping`: uma linha por `(sport, normalizedPulsescoreName)`.
- `FixtureMapping`: uma linha por `pulsescoreEventKey` (o `LiveEvent.id` completo, ex:
  `"pulsescore:30759040"`).

Um resultado "sem correspondência" (confiança baixa) também fica em cache — nunca repete a
pesquisa cara para o mesmo evento/equipa a cada pedido; fica disponível para revisão manual
em vez de martelar a API-Football sem necessidade. Para forçar uma nova tentativa (ex: a
API-Football passou entretanto a cobrir essa equipa), o admin pode "Reset" o mapping no
painel — isso apaga a linha e a próxima resolução tenta outra vez do zero.

## Painel admin (`/admin` → Mapeamento)

- **Equipas/Ligas**: listar, filtrar por confiança baixa, corrigir manualmente (id + nome
  oficial na API-Football → fica `MANUAL`, `verified:true`, confiança 100%) ou reiniciar.
- **Fixtures**: fila de revisão (confiança < 70%), mostra as duas equipas + liga + o motivo
  registado (`reason`, ex: `home=ALIAS(98) away=NORMALIZED(97) league=SIMILARITY(82)
  fixtureFound=true`), corrigir manualmente o id do fixture ou reiniciar.
- **Aliases**: adicionar/remover sem precisar de deploy (`POST/DELETE
  /api/admin/mapping/aliases`) — semeado inicialmente com os aliases mais óbvios
  (`mapping/aliasSeed.ts`), crescendo daqui em diante só pela BD.

## Logs `[MATCHING]`

Cada resolução de equipa/liga/fixture regista um log estruturado (`logger.info`, pino) com
`pulsescoreName`/`bestMatch`/`similarity`/`confidence`/`method`/`linked` — grep por
`[MATCHING]` nos logs do Railway para acompanhar o que está a ser ligado automaticamente e o
que está a cair na fila de revisão.

## O que ficou de fora conscientemente

- **Comparação de horário exato (±10min)**: o par (equipas+data) já é o segundo sinal de
  confirmação usado por `findFixtureId()` — pedir também o fixture exato só para comparar o
  horário seria mais uma chamada à API por evento para um ganho marginal (as mesmas duas
  equipas jogarem duas vezes no mesmo dia é excecional). O `kickoffPulsescore` fica guardado
  em `FixtureMapping` para o admin ver no painel, mesmo sem ser usado na pontuação.
- **Job diário automático de descoberta de equipas novas** (spec original pedia um cron):
  não há infraestrutura de scheduler (`node-cron` ou equivalente) neste projeto — em vez
  disso, a fila de revisão no painel admin (fixtures/equipas/ligas com confiança < 70%) já
  dá a mesma visibilidade sob pedido, sem adicionar uma dependência nova só para isto. Se um
  scheduler vier a ser adicionado por outro motivo, é trivial ligar aqui.
- **Limites de depósito/levantamento nas Definições do admin** (`minDepositEur` etc.) ainda
  não estão ligados à validação real dos pedidos — isso é uma peça diferente (gestão de
  risco financeiro, não de mapeamento), documentado em `docs/ADMIN.md`.
