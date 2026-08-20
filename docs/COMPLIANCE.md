# Conformidade e Licenciamento — Bet62

Este documento resume o que é preciso ter em ordem, do lado legal e de compliance,
antes de esta plataforma poder aceitar dinheiro real. Nada disto é resolvido por código —
é decisão e execução do operador (empresa licenciada).

## 1. Licenciamento (Portugal)

- Apostas desportivas e jogo online a dinheiro real em Portugal requerem uma **licença do
  SRIJ** (Serviço de Regulação e Inspeção de Jogos, sob o Turismo de Portugal), ao abrigo
  do Decreto-Lei n.º 66/2015 (Regime Jurídico dos Jogos e Apostas Online — RJO).
- Sem licença SRIJ válida, operar esta plataforma com depósitos/levantamentos reais
  dirigidos a residentes em Portugal é ilegal, independentemente da qualidade técnica do
  sistema.
- A licença exige, entre outros: sistema de jogo responsável auditável, ligação técnica ao
  SRIJ para reporte de dados, fundos de jogadores segregados, e auditorias de segurança
  periódicas.

## 2. Implicações para os fornecedores de pagamento

- **Stripe**: gambling/apostas é uma categoria de negócio restrita na maioria das regiões.
  É necessário pedir aprovação prévia à Stripe e normalmente apresentar prova da licença
  SRIJ (ou equivalente) antes de conseguirem ativar `payment_method_types` de gambling na
  conta. Sem essa aprovação, a conta Stripe pode ser suspensa assim que detetarem o tipo de
  negócio.
- **Revolut Business**: transferências para clientes de uma plataforma de apostas também
  passam por due diligence reforçada (KYB/KYC da Revolut sobre o próprio operador). Preparar
  documentação societária, licença e política AML antes de pedir a ativação da conta para
  este caso de uso.
- **MB WAY / Multibanco**: acedidos através de um PSP licenciado (neste caso, Stripe) — não
  há integração direta com a SIBS a fazer pelo Bet62; a elegibilidade depende da aprovação
  do PSP.

## 3. AML / KYC implementado no backend

- `KycSubmission` (Prisma) guarda o estado de verificação (`PENDING → IN_REVIEW → APPROVED/REJECTED`).
- Levantamentos (`requestWithdrawal` em `server/src/modules/payments/revolut/service.ts`)
  **bloqueiam** com `KYC_REQUIRED` até o KYC estar `APPROVED`.
- **Ainda não implementado** (necessário antes de produção): integração com um provedor de
  verificação documental real (ex: Sumsub, Onfido, IDnow) para validar o documento
  automaticamente — atualmente o endpoint apenas regista o número do documento e fica
  `PENDING` para revisão manual por um agente com papel `SUPPORT`/`ADMIN` (a interface de
  aprovação de KYC em back-office ainda não foi construída nesta fase, só o modelo de dados
  e o gate).

## 4. Jogo Responsável — o que já está implementado

- Idade mínima de 18 anos validada no registo (`registerUser`).
- Limites de depósito diário e perda semanal (`ResponsibleGamblingLimits`), aplicados
  server-side no momento do depósito (`createDepositCheckout`).
- Reduzir limites é imediato; **aumentar** limites é bloqueado com uma mensagem a pedir
  contacto com o suporte — o período de reflexão de 24h referido no erro ainda não tem um
  fluxo assíncrono de aprovação automática implementado (fica para uma fase seguinte).
- Autoexclusão (1/7/30/90 dias ou permanente) bloqueia login e novas operações
  (`isSelfExcluded`, checado em login, depósito e levantamento).
- Reality check e limite de tempo de sessão existem como campos de dados, mas o
  **enforcement no frontend** (avisos periódicos, logout forçado ao fim do tempo) ainda não
  está implementado — é trabalho de frontend pendente.

## 5. O que falta antes de produção real

1. Obter a licença SRIJ (ou confirmar que já existe) e o número de operador para reportar ao
   SRIJ.
2. Aprovação de conta gambling na Stripe e na Revolut Business.
3. Provedor de verificação documental (KYC) integrado.
4. Auditoria de segurança independente (pentest) antes de aceitar fundos reais.
5. Política de AML formal, incluindo limites de transação que disparem reporte (ex: UIF/GAFI).
6. Registo de auditoria completo — já existe uma tabela `AuditLog` básica; expandir conforme
   exigido pelo regulador.
7. Termos e Condições e Política de Privacidade reais (RGPD) — os botões existentes no
   frontend são placeholders.
