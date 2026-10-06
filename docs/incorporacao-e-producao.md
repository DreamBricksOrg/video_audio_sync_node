# Incorporação em sites e produção

## Conceitos

- **Campanha**: o que se configura no admin (vídeo, áudio, links do celular). No código e nas URLs ainda se chama `screen`/totem.
- **Instância**: cada tela tocando a campanha — um totem físico ou o iframe aberto por um visitante. É criada sozinha ao abrir a página e tem QR e sincronia próprios. O admin mostra quantas estão abertas ("Telas abertas") e quantos celulares estão ouvindo.

## Como incorporar

1. No admin, clique em `</>` no card da campanha.
2. Ajuste tamanho, ajuste do vídeo, QR e comportamento no celular.
3. Copie o código e cole no HTML do site.

Parâmetros da URL `/static/totem.html`:

| Parâmetro | Valores | Padrão |
|---|---|---|
| `screen` | ID da campanha | obrigatório |
| `fit` | `contain` mostra o vídeo inteiro | preenche e corta |
| `showqr` | `false` esconde o QR | mostra |
| `listen` | `on` / `off` / `auto` — botão "Ouvir aqui" no lugar do QR | `auto` (celular) |

- O QR também é clicável: abre a página do celular daquela tela em uma nova aba.
- **"Ouvir aqui"** aparece no lugar do QR quando a página é aberta em um celular (tela de toque com até 820px). O áudio toca no próprio aparelho, sincronizado com o vídeo. Um totem físico de 1080px continua mostrando o QR.

## Checklist de produção

- [ ] Servidor com domínio próprio e **HTTPS** (não usar ngrok em produção).
- [ ] `ffmpeg` e `ffprobe` instalados (separador de vídeo e áudio).
- [ ] `.env` com `ADMIN_USER`, `ADMIN_PASSWORD` forte e `SESSION_SECRET` fixo.
- [ ] `PUBLIC_URL` com o domínio final.
- [ ] Atrás de proxy ou túnel (Nginx, Cloudflare, ngrok): `TRUST_PROXY=1`, e o proxy repassando WebSocket (`Upgrade`/`Connection`). Sem isso, o limite por IP não consegue distinguir os visitantes.
- [ ] Limites: `MAX_SCREENS_PER_IP` (padrão 20) e `MAX_INSTANCES_PER_CAMPAIGN` (padrão 2000) de acordo com o público esperado. Uma tela barrada tenta de novo depois de 1 minuto.
- [ ] Vídeos de campanha separados com **"Otimizar para sites"** (vídeo bem menor para cada visitante baixar).
- [ ] Processo gerenciado (pm2, systemd ou o serviço da nuvem) para reiniciar em falhas.
- [ ] Rodar `npm run load-test -- --url <servidor> --campaign <id> --screens <N> --phones <M>` contra um ambiente de teste com o volume esperado. Referência local: 100 telas + 200 celulares usaram ~55 MB de memória.
- [ ] Mídia no S3 + CloudFront (abaixo), para os visitantes não baixarem os vídeos do servidor.
- [ ] `CORS_ORIGINS` vazio, a não ser que outro site precise ler `/media` direto.

## Mídia no S3 + CloudFront

O servidor continua guardando os arquivos em `assets/` (fonte de verdade). Com o S3 ligado, todo envio, separação, substituição, renomear e exclusão feito no admin é **replicado no bucket automaticamente**, e os visitantes baixam de lá.

1. **Bucket**: crie um bucket S3 (ex.: região `sa-east-1`).
2. **Usuário IAM** só para o servidor, com esta política (troque `MEU-BUCKET`):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::MEU-BUCKET/*"
     }]
   }
   ```

   `CopyObject` (renomear) usa `GetObject` + `PutObject`; `HeadObject` (usado pelo `s3-sync`) usa `GetObject`.
3. **CloudFront** (recomendado): crie uma distribuição com o bucket como origem, usando *Origin Access Control* (o bucket continua privado). Cache policy `CachingOptimized` respeita o `Cache-Control: max-age=60` que o servidor grava — um arquivo substituído aparece em até ~1 minuto.
   - Sem CloudFront, o bucket precisa permitir leitura pública dos objetos.
4. **CORS no bucket** — obrigatório: o celular baixa o áudio com `fetch()` para sincronizar. Em *Permissions → CORS* do bucket:

   ```json
   [{
     "AllowedOrigins": ["https://SEU-DOMINIO"],
     "AllowedMethods": ["GET", "HEAD"],
     "AllowedHeaders": ["Range"],
     "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
     "MaxAgeSeconds": 3600
   }]
   ```

   Com CloudFront, use uma *response headers policy* com CORS (ou repasse o header `Origin` para a origem).
5. **`.env`** do servidor:

   ```
   S3_BUCKET=MEU-BUCKET
   S3_REGION=sa-east-1
   S3_PREFIX=audiosync
   AWS_ACCESS_KEY_ID=...
   AWS_SECRET_ACCESS_KEY=...
   MEDIA_BASE_URL=https://dxxxxxxxx.cloudfront.net/audiosync
   ```

6. **Arquivos que já existem**: `npm run s3-sync -- --dry-run` para conferir e `npm run s3-sync` para enviar.
7. Reinicie o servidor. O console mostra `Media mirrored to s3://MEU-BUCKET/audiosync/ — served from ...`.

Se o S3 falhar num envio, o arquivo fica salvo no servidor e o admin avisa ("falhou no S3"); rode `npm run s3-sync` depois para acertar. Armazenamentos compatíveis (MinIO, Cloudflare R2) funcionam com `S3_ENDPOINT`.

## Limites conhecidos

- As sessões ficam na memória de **um** processo Node. Para rodar mais de um processo/servidor, seria preciso mover o registro de instâncias para um armazenamento compartilhado (ex.: Redis) e usar sessão fixa no balanceador. Um processo atende com folga centenas a alguns milhares de telas simultâneas — use o teste de carga para medir.
- Ao reiniciar o servidor, as telas reconectam sozinhas; celulares que estavam ouvindo precisam escanear de novo.
