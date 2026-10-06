# Melhorias pendentes

Backlog do que ainda falta implementar. Os planos de **Campanhas e Instâncias (Partes 1 e 2)** foram concluídos e removidos desta pasta — a referência do que foi feito está em [`docs/campanhas-e-instancias.md`](../../campanhas-e-instancias.md) (os planos originais seguem no histórico do git, commit `7dc1f06`).

Antes de implementar um item, gere um plano detalhado com a skill **superpowers:writing-plans** (arquivo `YYYY-MM-DD-<nome>.md` nesta pasta).

Atualizado em 2026-10-06.

---

## Já concluído (não refazer)

- Campanhas e instâncias (N telas por link, sincronia por instância, compatibilidade com QR sem instância)
- QR clicável; página do totem responsiva para iframes
- Limites de telas por IP e por campanha (`TRUST_PROXY`)
- "Ouvir aqui" (áudio no próprio celular do visitante)
- Código de incorporação no admin
- Vídeo otimizado para sites no separador
- Teste de carga (`npm run load-test`) e memória no `/health`
- CI no GitHub Actions; branch mesclada na `main`
- Remoção da API key pública; CORS restrito
- Gravação atômica do `totems.json`
- Biblioteca de mídia **só no S3** (`S3_BUCKET`), `npm run s3-sync`, mídia local removida do repositório

---

## Alta — antes de colocar em sites de verdade

### 1. Hospedagem de produção
Servidor com domínio e HTTPS no lugar do ngrok. Entregar `Dockerfile` (ou config do pm2), exemplo de Nginx repassando WebSocket (`Upgrade`/`Connection`) e `TRUST_PROXY=1`. Hoje tudo depende da máquina de desenvolvimento.

### 2. Configuração das campanhas fora do disco
Os vídeos já estão no S3, mas `totems.json` (campanhas, vídeo/áudio, links do celular) ainda é arquivo local — some num contêiner recriado e diverge entre servidores. Opções: guardar o JSON no próprio S3 (com controle de versão/ETag para não sobrescrever) ou um banco simples (SQLite/Postgres). Manter a interface atual (`totemsConf` + `saveTotemsConf`).

### 3. Vulnerabilidades do `npm audit`
`body-parser` e `brace-expansion` (dependências antigas). Atualizar e rodar `npm test`.

### 4. Testes no navegador
Playwright para totem (QR, "Ouvir aqui", responsivo), celular (sincronia) e admin (upload, incorporar, CRUD). Os testes atuais cobrem só o servidor; os bugs do "Ouvir aqui" (pausa/`stalled`) e de layout só apareceram no teste manual.

---

## Média — experiência e operação

### 5. Envio direto do navegador para o S3
Hoje o upload passa pelo servidor antes de ir para o bucket. Com URLs pré-assinadas, o admin envia direto ao S3 (mais rápido, sem usar a banda do servidor); o servidor só registra. O separador continua passando pelo servidor (precisa do ffmpeg).

### 6. CloudFront na frente do S3
Quando o tráfego crescer. Já documentado em `docs/incorporacao-e-producao.md`; só troca `MEDIA_BASE_URL`.

### 7. Estatísticas por campanha
Escaneamentos, tempo médio ouvindo, site de origem (referrer do iframe), telas abertas ao longo do dia; painel no admin e exportação.

### 8. Agendamento e playlists
Campanha com data de início/fim e vários vídeos em sequência.

### 9. Áudio em vários idiomas
Mais de uma faixa de áudio por campanha; o celular escolhe.

### 10. Controles na tela de bloqueio (Media Session API)
Título e capa da campanha, pausar sem abrir a página.

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
