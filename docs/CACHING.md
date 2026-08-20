# Cache — onde está configurada e porquê

Resposta direta à pergunta "não sei se configuras sistemas de Caches no projeto": há três
camadas de cache diferentes, cada uma resolvendo um problema diferente. Nenhuma delas esconde
dados errados de propósito — todas invalidam por tempo (TTL) ou por evento real, nunca ficam
paradas para sempre a mostrar dados velhos sem uma razão documentada.

## 1. Cache TTL de respostas da API-Football (`lib/ttlCache.ts`)

Ficheiro: `server/src/lib/ttlCache.ts` (`TtlCache` + `cached()`), usada em
`sports/apifootball/client.ts`. Cada endpoint que a API-Football expõe tem o seu próprio TTL,
escolhido pela frequência real com que aquele dado muda — não um valor genérico só para "ter
cache":

| Endpoint | TTL | Porquê |
|---|---|---|
| `getFixtureStatistics` (posse, remates, faltas...) | 15s | Jogo ao vivo — muda a cada minuto; o TTL curto só apara pedidos concorrentes pelo mesmo fixture (vários utilizadores a ver o mesmo jogo ao mesmo tempo), não atrasa uma atualização real de forma percetível. |
| `getFixtureById` (placar/estado, caminho degradado do endpoint unificado) | 15s | Mesma razão. |
| `getHeadToHead` | 30 min | Histórico de jogos já terminados — só muda quando as duas equipas voltam a jogar entre si, o que nunca acontece mais do que uma vez a cada semanas/meses. |
| `getPredictions` | 15 min | O próprio modelo da API-Football só recalcula de hora a hora (confirmado via documentação pública) — pedir mais vezes do que isso não traz dado mais novo nenhum. |
| `getStandings` (classificação) | 5 min | A tabela só muda quando um jogo dessa liga termina — poucos minutos de atraso são imperceptíveis e poupam a maior parte dos pedidos repetidos de utilizadores diferentes a abrir a mesma competição. |

Cada cache também faz **coalescing**: se dois pedidos pela mesma chave chegam antes do primeiro
responder, o segundo espera pela mesma promise em vez de disparar uma segunda chamada idêntica
à API-Football — reduz o número de pedidos sob carga sem depender só do TTL. Numa falha
(rede, rate limit), a promise rejeita normalmente e **nada fica em cache** — quem chamou lida
com o erro como já lidava antes.

Antes desta camada, estes quatro endpoints batiam na API-Football em **todo** pedido de todo
utilizador para a mesma competição/jogo, sem limite — o principal risco de esgotar a quota
diária/por-minuto do plano contratado sob uso concorrente normal (vários utilizadores a ver o
mesmo jogo popular), o que por sua vez fazia endpoints como `/standings` devolverem erro (e o
frontend mostrar "Sem classificação disponível") mesmo quando o mapeamento da competição estava
correto.

## 2. Cache de eventos Pulsescore (já existia antes desta ronda)

- `sports/prematch/service.ts`: 45s por desporto (`CACHE_TTL_MS`).
- `sports/competitions/service.ts`: 60s para o top-5 de competições do dia.

Mesmo padrão (Map + `fetchedAt`), só que específico da Pulsescore. Não fundido com
`TtlCache` porque já eram simples e não valia a pena o risco de mexer neles junto com esta
mudança — candidatos naturais para migrar para `lib/ttlCache.ts` no futuro, se aparecer mais
um caso igual.

## 3. Cache permanente de identidade (mapeamento Pulsescore ↔ API-Football)

Esta é uma cache diferente por natureza — não é "poupar pedidos repetidos por um tempo", é
"nunca mais perguntar a mesma pergunta de identidade" (`TeamMapping`/`LeagueMapping`/
`FixtureMapping`, ver `docs/TEAM_MAPPING.md`). Documentada em detalhe lá; a parte relevante
para a Classificação não aparecer é que, até agora, uma falha **transitória** da pesquisa (rede
em baixo, rate limit momentâneo) na primeira vez que uma liga/equipa era vista ficava
**cacheada como "sem correspondência" para sempre** — indistinguível de um miss genuíno. Corrigido
nesta ronda (`mapping/teamMatcher.ts`, `mapping/leagueMatcher.ts`, `mapping/fixtureMatcher.ts`):
agora só uma pesquisa que **correu e não achou nada** fica em cache permanente; uma falha da
pesquisa em si não grava nada, e a próxima chamada tenta outra vez do zero.

Se uma liga/equipa específica já ficou presa em "sem correspondência" **antes** desta correção
(dado antigo, já gravado na base de dados), a correção do código não a desbloqueia sozinha —
usar **Admin → Mapeamento → Ligas/Equipas**, filtrar por confiança baixa, e clicar "Reset" na
linha em causa força uma nova tentativa imediata.
