# Camada unificada — Pulsescore (principal) + API-Football (complementar)

Confirma e formaliza a arquitetura já decidida com o utilizador (ver `docs/TEAM_MAPPING.md`):
a Pulsescore continua a ser a fonte principal de eventos/placar/estado — é a única com odds
reais. A API-Football complementa com estatísticas quando disponíveis, nunca substitui a
Pulsescore.

## Endpoint unificado

```
GET /api/sports/matches/:id/live
```

`:id` é o mesmo id já usado em todos os outros endpoints de evento (`/events/:id/h2h`,
`/events/:id/stats`, etc.) — ver nota sobre `internal_match_id` abaixo.

Resposta (`server/src/modules/sports/unified/types.ts::UnifiedMatchData`):

```json
{
  "matchId": "pulsescore:30759040",
  "sport": "football",
  "league": "Premier League",
  "home": { "name": "Manchester United" },
  "away": { "name": "Arsenal" },
  "score": { "home": 2, "away": 1, "source": "pulsescore" },
  "status": { "value": "live", "source": "pulsescore" },
  "clock": { "minuteOrPeriod": "67'", "source": "pulsescore" },
  "statistics": {
    "attacks": { "home": null, "away": null, "source": null },
    "dangerousAttacks": { "home": null, "away": null, "source": null },
    "momentum": { "home": null, "away": null, "source": null },
    "possession": { "home": 58, "away": 42, "source": "api-football" },
    "shots": { "home": 12, "away": 7, "source": "api-football" },
    "corners": { "home": 6, "away": 3, "source": "pulsescore" },
    "yellowCards": { "home": 2, "away": 1, "source": "pulsescore" }
  },
  "mapping": { "apiFootballFixtureId": 1234567, "confidence": 97, "verified": false }
}
```

Cada campo diz a sua própria fonte (`"pulsescore"` | `"api-football"` | `null`) — nunca é
preciso adivinhar de onde veio um número.

## Por que `attacks`/`dangerousAttacks`/`momentum` ficam sempre `null`

Investigado antes de implementar: **nenhuma das duas fontes fornece isto em nenhuma amostra
real confirmada até agora.**

- Pulsescore: o contrato confirmado (`pulsescore/client.ts`, `docs/SPORTS_DATA.md`) só dá
  `yellowCards`/`redCards`/`corners` por equipa como "estatísticas" — nada de ataques,
  ataques perigosos ou momentum.
- API-Football: o `/fixtures/statistics` confirmado devolve os tipos listados na secção
  seguinte — "ataques"/"momentum" não são um tipo que essa API tenha (esses dados tipicamente
  vêm de fornecedores diferentes, ex: feeds ao vivo tipo Sportradar/Betradar, não confirmados
  como disponíveis para a BET62).

Em vez de inventar valores só para preencher o campo, a regra da própria spec (secção 18: "se
nenhuma das duas tiver o dado, retornar null") já cobre isto exatamente — os campos existem na
resposta, com a forma certa, prontos a passar a ter dados reais assim que uma fonte que os
forneça for confirmada, sem precisar de mudar o formato da API depois.

## Estatísticas complementares que JÁ existiam (não são novas)

`getFixtureStatistics()` (API-Football) já alimentava a aba "Jogo" do Match Tracker desde
antes desta camada unificada — posssession, remates (totais/à baliza/fora/bloqueados),
cantos, faltas, fora de jogo, cartões, passes e precisão de passe já estavam confirmados e a
funcionar (`web/app.js::TEAM_STAT_LABELS`). A camada unificada só reorganiza esses mesmos
dados já reais num único objeto com fonte explícita — não inventou nenhuma estatística nova.

## `internal_match_id`

A spec original pedia um id interno da BET62 separado dos ids das duas fontes. Decisão: **não
foi criado um id novo** — `LiveEvent.id` (ex: `"pulsescore:30759040"`) já desempenha
exatamente esse papel: é opaco, único, estável durante a vida do evento, e é o identificador
que o frontend já usa em todo o lado (mercados, boletim, Match Tracker). Introduzir um segundo
id sintético só para bater certo com o nome da spec obrigaria a uma tabela `Match` nova e a
reescrever todos os pontos do frontend que já usam `LiveEvent.id` como referência, sem nenhum
ganho real — o `FixtureMapping.pulsescoreEventKey` (`docs/TEAM_MAPPING.md`) já guarda a
correspondência `LiveEvent.id ↔ apiFootballFixtureId`, que é a relação que a spec queria.

## Tolerância de horário (±10 min)

Implementada em `apifootball/client.ts::findFixtureId()` — quando a API-Football devolve mais
do que um fixture candidato para as mesmas duas equipas na mesma data (raro: taça a dobrar com
a liga no mesmo dia), escolhe-se o mais próximo do horário esperado (`event.startTime`,
comparado sempre via `Date`/UTC, nunca por string) em vez de assumir sempre o primeiro. Sem
custo extra de pedidos — a data de cada candidato já vem na mesma resposta que já se pedia. A
diferença de horário também ajusta ligeiramente a pontuação de confiança do mapping
(`fixtureMatcher.ts`): dentro da tolerância soma, fora subtrai, sem nunca anular sozinha uma
correspondência já confirmada pelos ids das equipas.

## Inversão casa/fora

`findFixtureId()` já verificava as duas ordens (a Pulsescore e a API-Football podem discordar
em qual das duas é "casa") — passou a **registar** quando isso acontece
(`invertedHomeAway` no log `[MATCHING]` e no campo `reason` do `FixtureMapping`), para
auditoria. O mandante/visitante mostrado ao utilizador continua a ser sempre o da Pulsescore —
nunca corrigido automaticamente pela API-Football (a Pulsescore continua a ser a fonte
principal do evento, spec secção 14).

## Falha da Pulsescore → API-Football como reserva temporária

Se `hybridSportsService` já não tiver o evento em memória (ex: reinício do processo, ou o
evento saiu da lista "ao vivo" da Pulsescore antes do frontend atualizar) mas já existir um
`FixtureMapping` com `apiFootballFixtureId` conhecido, `getUnifiedMatchData()` cai para
`getFixtureById()` da API-Football como substituto temporário de placar/estado/relógio — a
resposta vem com `degraded: { reason: "..." }` para o consumidor saber que estes dados não são
da fonte principal. Sem fixture mapeado, devolve 404 (nunca inventa dados).

## O que ficou de fora conscientemente

- **Lineups/jogadores/eventos individuais (golos/substituições) da API-Football**: a spec
  pede-os na forma do `UnifiedMatchData`, mas os endpoints (`/fixtures/lineups`,
  `/fixtures/events`) nunca foram testados contra uma resposta real nesta integração (ao
  contrário de statistics/H2H/predictions/standings, todos confirmados por amostras reais
  coladas pelo utilizador antes de implementar) — implementá-los às cegas arriscaria nomes de
  campos errados sem forma de verificar neste ambiente (sem acesso à internet). Fica como
  próximo passo natural quando houver uma amostra real desses endpoints para confirmar a
  forma da resposta.
- **Substituir o WebSocket ao vivo pelo endpoint unificado no frontend**: o Match Tracker já
  atualiza placar/relógio via WebSocket (~1x/segundo, ver `pulsescore/wsClient.ts`) — trocar
  isso por pedidos periódicos a este endpoint REST seria uma regressão de latência. O
  endpoint fica disponível (`Bet62Api.getUnifiedMatch()`, `web/api.js`) para quem precisar de
  um único pedido com tudo combinado, sem substituir o caminho ao vivo já mais rápido.
- **Dois processos verdadeiramente independentes** (spec secção 23): a API-Football continua
  a ser consultada sob pedido (quando alguém pede estatísticas/o endpoint unificado), com
  cache permanente do mapping — não um processo a correr em fundo a fazer polling constante
  para todos os jogos ao vivo, o que esgotaria a quota diária da API-Football rapidamente sem
  necessidade (a maioria dos jogos ao vivo nunca chega a ter as suas estatísticas pedidas).
