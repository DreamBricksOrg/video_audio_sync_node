# Operação do servidor na AWS

Como atualizar, reiniciar e manter o servidor de produção (`https://videosync.dbpe.com.br`).

**O que já se sabe (verificado de fora):** Nginx 1.22.1 na frente do Node (Express), HTTP redireciona para HTTPS, `/health` responde. **Confirme no servidor** os itens marcados com ⚠️ (caminho do projeto, gerenciador de processo, arquivo do Nginx) e ajuste os comandos abaixo.

---

## Visão geral

```
Internet ──HTTPS──► Nginx (:443, certificado) ──HTTP──► Node server.js (:8001)
                         │  repassa WebSocket (/ws/...)
                         └─ uploads grandes (até MAX_UPLOAD_MB)
Node ──► S3 (vídeos, áudios e campanhas em <prefixo>/totems.json)
```

## 1. Pré-requisitos no servidor

```bash
node -v      # 22 ou mais novo (o projeto usa process.loadEnvFile e node:test)
ffmpeg -version && ffprobe -version   # separador de vídeo e áudio
```

Se faltar ffmpeg (Debian/Ubuntu): `sudo apt-get install -y ffmpeg`.

## 2. `.env` de produção

No diretório do projeto (⚠️ ex.: `/srv/video_audio_sync`):

```
PORT=8001
PUBLIC_URL=https://videosync.dbpe.com.br
TRUST_PROXY=1                 # atrás do Nginx: usa X-Forwarded-For para o limite por IP
ADMIN_USER=...
ADMIN_PASSWORD=...            # forte
SESSION_SECRET=...            # fixo (senão todo mundo é deslogado a cada reinício)
MAX_UPLOAD_MB=500

S3_BUCKET=dreambricks-audiosync-media
S3_REGION=sa-east-1
S3_PREFIX=audiosync           # produção. Desenvolvimento usa outro (audiosync-dev)
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
MEDIA_BASE_URL=               # vazio = URL pública do bucket
```

Nunca copie o `.env` do computador de desenvolvimento para cá (o prefixo é diferente).

## 3. Nginx

⚠️ Confira o arquivo do site (ex.: `/etc/nginx/sites-available/videosync`). Os pontos obrigatórios são **WebSocket**, **IP real** e **tamanho de upload**:

```nginx
server {
    listen 443 ssl http2;
    server_name videosync.dbpe.com.br;
    # ssl_certificate / ssl_certificate_key: os que já estão configurados

    client_max_body_size 500m;        # = MAX_UPLOAD_MB (padrão do Nginx é 1 MB!)

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_http_version 1.1;

        # WebSocket (totem, celular e correção de sincronia)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # IP real do visitante (TRUST_PROXY=1) e HTTPS
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Telas ficam conectadas por horas; separar vídeo pode levar minutos
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_request_buffering off;  # uploads vão direto para o Node (barra de progresso real)
    }
}

server {
    listen 80;
    server_name videosync.dbpe.com.br;
    return 301 https://$host$request_uri;
}
```

Depois de editar: `sudo nginx -t && sudo systemctl reload nginx`.

| Sintoma | Causa provável no Nginx |
|---|---|
| Upload de vídeo falha com **413** | `client_max_body_size` faltando ou pequeno |
| Totem não conecta / celular não sincroniza (WebSocket 400/502) | Faltam `Upgrade`/`Connection` |
| Telas desconectam a cada ~60s | `proxy_read_timeout` padrão (60s) |
| Separar vídeo grande dá 504 | `proxy_read_timeout` curto |
| Limite por IP bloqueia todo mundo junto | `TRUST_PROXY=1` sem `X-Forwarded-For` (ou o contrário) |

## 4. Processo (mantém o Node rodando e reinicia em falhas)

⚠️ Use **um** dos dois.

### Opção A — pm2

```bash
sudo npm install -g pm2
cd /srv/video_audio_sync
pm2 start server.js --name videosync
pm2 save
pm2 startup        # siga o comando que ele mostrar, para subir junto com a máquina
```

Comandos do dia a dia: `pm2 status`, `pm2 logs videosync`, `pm2 restart videosync`.

### Opção B — systemd

`/etc/systemd/system/videosync.service`:

```ini
[Unit]
Description=Video Audio Sync
After=network-online.target

[Service]
WorkingDirectory=/srv/video_audio_sync
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=www-data
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now videosync
```

Comandos do dia a dia: `systemctl status videosync`, `journalctl -u videosync -f`, `sudo systemctl restart videosync`.

## 5. Atualizar (deploy)

```bash
cd /srv/video_audio_sync          # ⚠️ caminho real
git pull origin main
npm ci --omit=dev                  # só se package.json/package-lock.json mudaram
pm2 restart videosync              # ou: sudo systemctl restart videosync
```

Conferir depois:

1. Logs da partida mostram `Media library: s3://.../audiosync/ (N files)` e `Campaigns config: s3://.../audiosync/totems.json`.
2. `curl -s https://videosync.dbpe.com.br/health` responde `"status":"ok"`.
3. No admin, nenhum card com o aviso vermelho "Arquivo não encontrado".

### Primeira atualização com as campanhas no S3

A partir do commit `f6f023f`, as campanhas ficam no bucket (`audiosync/totems.json`). Na primeira partida, **se o bucket ainda não tiver esse arquivo, ele é criado a partir do `totems.json` deste servidor**. Então, antes de reiniciar:

- Confira o `totems.json` do servidor (é ele que vira a configuração de produção).
- Garanta que nenhuma outra máquina rode com `S3_PREFIX=audiosync` antes (ela criaria o arquivo com a configuração dela).
- Depois de subir, se algum card mostrar "Arquivo não encontrado" (ex.: `totem1` apontando para `99_video2.mp4`), escolha o arquivo certo e clique em **Aplicar**.

### `totems.json` fora do git

Desde a arrumação de 2026-10-07 o `totems.json` não é mais versionado (há um `totems.example.json` de modelo). No servidor, o próximo `git pull` **apaga o `totems.json` local** — sem problema no modo S3, porque as campanhas já estão no bucket (`audiosync/totems.json`) e o arquivo local só serve de semente para um prefixo novo. Se quiser guardar uma cópia antes: `cp totems.json ~/totems.backup.json`.

Para um ambiente novo no modo local: `cp totems.example.json totems.json` (ou comece sem o arquivo e crie as campanhas no admin).

## 6. Voltar uma versão (rollback)

```bash
git log --oneline -5               # escolha o commit anterior
git checkout <commit>
npm ci --omit=dev
pm2 restart videosync              # ou systemctl restart
```

Para voltar à `main` depois: `git checkout main && git pull`.

⚠️ Versões anteriores a `f6f023f` leem as campanhas do `totems.json` **local**, não do bucket. Num rollback para antes disso, mudanças feitas no admin depois da atualização não aparecem.

## 7. Monitoramento

### Disponibilidade: `/health`

`/health` (sem login) responde **200** com `"status": "ok"` quando tudo funciona e **503** com `"status": "degraded"` quando a biblioteca de mídia, as campanhas ou as sessões não conseguem falar com o S3 — o campo `checks` diz qual. Também mostra a versão (`version`, com o commit), telas abertas, celulares ouvindo e memória.

Monitor gratuito com o [UptimeRobot](https://uptimerobot.com): *Add New Monitor* → tipo **HTTP(s)**, URL `https://videosync.dbpe.com.br/health`, intervalo 5 min, e o seu e-mail nos contatos de alerta. Ele avisa quando o servidor cai **e** quando o S3 falha (503).

### Alertas de erro: Sentry (opcional)

1. Crie uma conta gratuita em [sentry.io](https://sentry.io) e um projeto **Node.js / Express**.
2. Copie o DSN (Settings → Client Keys) para o `.env` do servidor: `SENTRY_DSN=https://...@....ingest.sentry.io/...`
3. Reinicie. O console mostra `🚨 Error alerts: Sentry on`.

Vão para o Sentry: erros registrados pelo servidor (falha no S3, upload, separador…), erros de rota e travamentos. Uma falha que se repete (ex.: S3 fora do ar, conferido a cada 15s) gera **um** alerta, não um por tentativa. Nenhum dado pessoal é enviado. `SENTRY_ENVIRONMENT` separa produção de testes (padrão: o `S3_PREFIX`).

### Logs

`pm2 logs videosync` ou `journalctl -u videosync -f`. Linhas úteis: `[Screen]`, `[Media]`, `[Config]`, `[Admin]`, `[Auth]`, `[Stats]`.

Com `LOG_FORMAT=json` cada linha vira um JSON (`time`, `level`, `scope`, `msg` e `error` com o stack) — útil para CloudWatch Logs ou outra ferramenta de busca. Ex.: `pm2 logs videosync --raw | grep '"level":"error"'`.

### Carga

`npm run load-test -- --url https://videosync.dbpe.com.br --campaign <id> --screens 50` **fora do horário de uso** (as telas falsas aparecem no admin).

## 8. Backup

- Vídeos, áudios e campanhas estão no S3. Para proteger contra exclusão acidental, ative **Versioning** no bucket com uma regra de ciclo de vida apagando versões antigas depois de 30 dias.
- O `.env` do servidor não está no git: guarde uma cópia num cofre de senhas.
