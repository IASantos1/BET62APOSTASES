# Dados Desportivos — Sistema Híbrido Pulsescore + API-Football

## Desportos cobertos

Futebol, ténis, basquete, hóquei de gelo, beisebol, voleibol, Fórmula 1 e MMA (8 no total).

⚠️ **Nota sobre o plano Pulsescore**: o plano de 149€ mencionado inicialmente cobria 3 canais
(futebol/ténis/basquete). Expandir para os 8 desportos acima pode exigir um plano superior ou
canais adicionais — confirmar com a Pulsescore antes de assumir que os 8 cabem no mesmo preço.

A Fórmula 1 não tem o formato "casa vs fora" dos outros desportos (é uma corrida com vários
pilotos, não um confronto direto). Para não criar uma segunda estrutura de dados só para ela,
o tipo `LiveEvent` é reaproveitado: `home`/`away` guardam o nome do Grande Prémio e o tipo de
sessão, e a grelha de pilotos vai nas seleções do mercado "Vencedor da corrida" — ver
`server/src/modules/sports/mockFeed.ts`.

⚠️ **Nota de validação**: `pulsescore.com` e `www.api-football.com` estavam bloqueados pelo
proxy de rede deste ambiente durante a construção, por isso os detalhes de integração da
Pulsescore abaixo (URL de ligação, formato de mensagens, autenticação) são um **contrato de
integração assumido**, não confirmado contra a documentação real. A API-Football é mais
conhecida publicamente, mas os nomes de headers/endpoints também devem ser confirmados.

## Arquitetura

```
Pulsescore (WS)  ──┐
                    ├──▶ HybridSportsService ──▶ WebSocket Gateway (/ws/live) ──▶ Frontend
Mock feed (fallback)┘         │
                               └──▶ API-Football (REST, sob pedido) ── estatísticas de futebol
```

Ficheiros:
- `server/src/modules/sports/pulsescore/client.ts` — cliente WebSocket para a Pulsescore
  (futebol, ténis, basquete — os 3 canais do plano a 149€ mencionado).
- `server/src/modules/sports/apifootball/client.ts` — cliente REST da API-Football, usado só
  para enriquecer eventos de futebol com estatísticas detalhadas.
- `server/src/modules/sports/hybridService.ts` — agrega tudo num único store em memória e
  reemite eventos normalizados (`LiveEvent`, ver `types.ts`).
- `server/src/modules/sports/mockFeed.ts` — gerador de eventos simulados, usado
  automaticamente quando `PULSESCORE_API_KEY` não está definida (ou a ligação falha),
  controlado por `SPORTS_DATA_MOCK_FALLBACK=true`. **Isto é o que permite testar e demonstrar
  a plataforma de ponta a ponta sem pagar a Pulsescore já.**
- `server/src/modules/sports/websocket/gateway.ts` — expõe `/ws/live?sports=football,tennis`
  para o frontend consumir; envia um snapshot inicial e depois um stream de atualizações.

## Pulsescore — o que precisa de confirmação

1. **URL de ligação real** — hoje assumido como `wss://stream.pulsescore.com/v1` (variável
   `PULSESCORE_WS_URL`), com a chave passada como query param `apiKey`. Confirmar no painel
   Pulsescore após a subscrição do plano.
2. **Mensagem de subscrição** — o cliente envia
   `{ "action": "subscribe", "channels": ["football", "tennis", "basketball"] }` após o
   `open`. **NEEDS VALIDATION**.
3. **Formato do payload de atualização** — a função `normalize()` em `pulsescore/client.ts`
   assume campos como `matchId`, `home.name`, `home.score`, `odds[].market`,
   `odds[].selections`. Isto é o único ponto do código a atualizar quando o formato real for
   conhecido — todo o resto do sistema já consome o tipo normalizado `LiveEvent`.
4. **Reconexão** — implementada com backoff exponencial (2s → 30s); confirmar se a Pulsescore
   exige heartbeat/ping explícito ou tem um token de retoma de sessão.

## API-Football — o que precisa de confirmação

- Autenticação assumida via header `x-apisports-key` (ligação direta a
  `v3.football.api-sports.io`). Se a subscrição for feita via RapidAPI, trocar para
  `x-rapidapi-key` + `x-rapidapi-host` e a base URL da RapidAPI.
- Limites de taxa dependem do plano — respeitar os headers `x-ratelimit-*` da resposta.
- Usado apenas sob pedido (`GET /api/sports/events/:id/stats`), não em polling constante,
  para poupar quota — só faz sentido para eventos de futebol com
  `apiFootballFixtureId` conhecido (ligação entre o ID Pulsescore e o ID API-Football ainda
  **não está implementada** — é preciso um mapeamento entre os dois provedores, tipicamente
  por nomes de equipa + hora de início, ou uma tabela de correspondência mantida
  manualmente).

## Testado nesta build

- ✅ Feed simulado a gerar eventos de futebol, ténis e basquete em tempo real.
- ✅ `GET /api/sports/events` a devolver o snapshot atual.
- ✅ WebSocket `/ws/live` a enviar snapshot + updates para um cliente ligado.
- ⛔ Ligação real à Pulsescore — não testável sem chave de API e sem acesso à documentação
  neste ambiente.
- ⛔ Estatísticas via API-Football — não testável sem chave de API.

## Antes de produção

1. Subscrever o plano Pulsescore (149€) e confirmar o contrato de integração real.
2. Subscrever a API-Football e mapear os fixtures aos eventos Pulsescore.
3. Definir `PULSESCORE_API_KEY` e `API_FOOTBALL_KEY` nas variáveis de ambiente do servidor.
4. Considerar desativar `SPORTS_DATA_MOCK_FALLBACK` em produção depois de confirmada a
   ligação real, para nunca mostrar dados simulados a utilizadores reais.
