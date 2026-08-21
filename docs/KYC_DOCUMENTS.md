# Documentos KYC — upload de documento pessoal e extrato bancário

Ficheiros: `server/src/modules/users/kycDocuments.ts`, rotas em
`server/src/modules/users/routes.ts` (`/me/kyc/documents*`) e
`server/src/modules/admin/routes.ts` (`/kyc/documents/:id/file`).

Complementa o `KycSubmission` já existente (tipo/número do documento, só texto): o utilizador
também consegue **enviar o ficheiro em si** — um documento de identidade e um extrato bancário
(para provar que o IBAN indicado num levantamento é mesmo dele) — em Perfil → Verificação de
Identidade.

## Fluxo

1. `POST /api/users/me/kyc/documents` — multipart (`type` = `ID_DOCUMENT`|`BANK_STATEMENT` +
   `file`). Validado: só JPG/PNG/WEBP/PDF, até 8MB (`ALLOWED_MIME_TYPES`/`MAX_FILE_SIZE_BYTES`
   em `kycDocuments.ts`). O ficheiro fica em memória (multer `memoryStorage`) só até ser escrito
   em disco — nunca passa por um ficheiro temporário.
2. Guardado em `KYC_UPLOAD_DIR/{userId}/{uuid}.{ext}` — **nunca** com o nome original enviado
   pelo cliente (risco de path traversal, ex: `"../../etc/passwd"`); o nome original só fica
   guardado no registo da base de dados (`KycDocument.fileName`), só para mostrar na UI.
3. `GET /api/users/me/kyc/documents` — lista os documentos já enviados (metadados, não o
   conteúdo).
4. `GET /api/users/me/kyc/documents/:id/file` — devolve o ficheiro, só se pertencer ao próprio
   utilizador autenticado (verificado sempre antes de servir, nunca por confiança no id vir de
   quem diz que é).
5. Admin: os documentos de qualquer utilizador já vêm no `GET /api/admin/users/:id` (campo
   `kycDocuments`); `GET /api/admin/kyc/documents/:id/file` serve o conteúdo (sem restrição de
   dono, só de `role:ADMIN`).

## ⚠️ Armazenamento — NEEDS VALIDATION antes de produção

Os ficheiros ficam em disco local (`KYC_UPLOAD_DIR`, por omissão `uploads/kyc` relativo à raiz
do processo). **O sistema de ficheiros de um container Railway é efémero** — um redeploy (ou
até um simples restart) apaga tudo o que lá estiver, a menos que exista um
[volume persistente](https://docs.railway.app/reference/volumes) montado nesse caminho exato.

Antes de anunciar esta funcionalidade como pronta para produção:

1. Criar um volume persistente no Railway montado em `KYC_UPLOAD_DIR` (ou apontar essa variável
   para o caminho onde o volume for montado), **ou**
2. Trocar para armazenamento externo (S3/Cloudflare R2/etc.) — `kycDocuments.ts` está escrito
   com toda a lógica de validação/nomeação isolada de `fs.writeFile`/`fs.mkdir`, para ser
   simples trocar só essas duas chamadas por um upload ao serviço externo sem mexer no resto.

Testado (Postgres + servidor real, sem rede): upload com sucesso grava o ficheiro em disco com
nome opaco, listagem e download devolvem o conteúdo correto, tipo de ficheiro não permitido
(`.txt`) e ficheiro acima de 8MB são rejeitados com uma mensagem clara (não um erro 500), um
utilizador nunca consegue descarregar o documento de outro (404), e o admin consegue ver o
documento de qualquer utilizador.
