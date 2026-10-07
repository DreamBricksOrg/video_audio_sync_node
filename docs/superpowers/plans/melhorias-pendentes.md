# Melhorias pendentes

Backlog do que ainda falta implementar. Os planos de **Campanhas e Instâncias (Partes 1 e 2)** foram concluídos e removidos desta pasta — a referência do que foi feito está em [`docs/campanhas-e-instancias.md`](../../campanhas-e-instancias.md) (os planos originais seguem no histórico do git, commit `7dc1f06`).

Antes de implementar um item, gere um plano detalhado com a skill **superpowers:writing-plans** (arquivo `YYYY-MM-DD-<nome>.md` nesta pasta).

Atualizado em 2026-10-07.

---

## Já concluído (não refazer)

- Campanhas e instâncias (N telas por link, sincronia por instância, compatibilidade com QR sem instância)
- QR clicável; página do totem responsiva para iframes
- **QR em iframe separado** (`/qr`): segue o vídeo da mesma página (`BroadcastChannel`, `pair=`); admin gera os dois códigos em caixas separadas
- Limites de telas por IP e por campanha (`TRUST_PROXY`)
- "Ouvir aqui" (áudio no próprio celular do visitante)
- Código de incorporação no admin
- Vídeo otimizado para sites no separador
- Teste de carga (`npm run load-test`) e memória no `/health`
- CI no GitHub Actions; branch mesclada na `main`
- Remoção da API key pública; CORS restrito
- Gravação atômica do `totems.json`
- Biblioteca de mídia **só no S3** (`S3_BUCKET`), `npm run s3-sync`, mídia local removida do repositório
- **Servidor de produção na AWS** com domínio e HTTPS (`videosync.dbpe.com.br`)

---

## Alta — antes de colocar em sites de verdade

### 1. Configuração das campanhas fora do disco
Os vídeos já estão no S3, mas `totems.json` (campanhas, vídeo/áudio, links do celular) ainda é arquivo local de cada servidor. **Já causou problema**: o computador de desenvolvimento e a AWS usam o mesmo bucket, um arquivo foi renomeado em um deles e a configuração do outro ficou apontando para um nome que não existe mais (403 no vídeo). Opções: guardar o JSON no próprio S3 (com controle de versão/ETag para não sobrescrever) ou um banco simples (SQLite/Postgres). Manter a interface atual (`totemsConf` + `saveTotemsConf`).

### 2. Admin avisar arquivo que não existe
Hoje o servidor só confere se o vídeo/áudio existe ao criar ou editar um totem pelo formulário. O botão "Aplicar" (`POST /api/totem/:id/config`) e o carregamento não conferem, e o card não avisa. Fazer: o card mostrar um alerta ("vídeo não encontrado no S3") e o "Aplicar" recusar arquivos inexistentes.

### 3. Prefixo do S3 separado por ambiente
Configuração, sem código: no `.env` de desenvolvimento usar outro prefixo (ex.: `S3_PREFIX=audiosync-dev`) para testes locais não mexerem nos arquivos de produção. Documentar no guia de produção.

### 4. Vulnerabilidades do `npm audit`
`body-parser` e `brace-expansion` (dependências antigas). Atualizar e rodar `npm test`.

### 5. Testes no navegador
Playwright para totem (QR, "Ouvir aqui", responsivo, QR separado), celular (sincronia) e admin (upload, incorporar, CRUD). Os testes atuais cobrem só o servidor; os bugs do "Ouvir aqui" (pausa/`stalled`) e de layout só apareceram no teste manual.

### 6. Documentar a operação do servidor da AWS
O servidor já roda na AWS; falta registrar como ele é atualizado e mantido: processo gerenciado (pm2/systemd), Nginx repassando WebSocket (`Upgrade`/`Connection`), `TRUST_PROXY=1`, passo a passo de deploy (`git pull` + reiniciar). Opcional: `Dockerfile`.

---

## Média — experiência e operação

### 7. Envio direto do navegador para o S3
Hoje o upload passa pelo servidor antes de ir para o bucket. Com URLs pré-assinadas, o admin envia direto ao S3 (mais rápido, sem usar a banda do servidor); o servidor só registra. O separador continua passando pelo servidor (precisa do ffmpeg).

### 8. CloudFront na frente do S3
Quando o tráfego crescer. Já documentado em `docs/incorporacao-e-producao.md`; só troca `MEDIA_BASE_URL`.

### 9. Estatísticas por campanha
Escaneamentos, tempo médio ouvindo, site de origem (referrer do iframe), telas abertas ao longo do dia; painel no admin e exportação.

### 10. Agendamento e playlists
Campanha com data de início/fim e vários vídeos em sequência.

### 11. Vídeo em várias qualidades (HLS)
Para conexões lentas; o separador geraria as variantes.

### 12. Sessão de login revogável
Hoje "Sair" não invalida um cookie copiado. Guardar sessões no servidor + "desconectar todos".

### 13. Página de debug protegida
`mobile_debug.html` é pública; exigir login do admin.

### 14. Limite de conexões dos celulares
Só as telas têm limite por IP; aplicar o mesmo aos sockets de sync/drift.

### 15. Totem com tela de toque
Parâmetro `?qrlink=false` para o toque no QR não abrir uma aba por cima do vídeo.

---

## Baixa — código e manutenção

16. Dividir o `server.js` (~1.100 linhas) em módulos: auth, mídia, totens, WebSocket.
17. Juntar a lógica repetida de `mobile.js` e `mobile_debug.js`.
18. Remover rotas antigas `/api/videos` e `/api/audios` (substituídas por `/api/media`).
19. Logs estruturados, alerta de erros (Sentry ou similar) e monitor de disponibilidade no `/health`.
20. Vários usuários no admin, com permissões e registro de quem fez o quê.
21. Redis para várias instâncias do servidor — só se o teste de carga mostrar necessidade.

## Arrumação rápida

- Apagar a branch `feat/campaign-instances` (já está toda na `main`).
- Tirar `totems.json` do git (dados de uso) e versionar um `totems.example.json`.
- Conferir o resultado do CI na aba **Actions** do GitHub.

## Fora do escopo (decidido não implementar)

- Áudio em vários idiomas por campanha.
- Controles na tela de bloqueio do celular (Media Session API).
