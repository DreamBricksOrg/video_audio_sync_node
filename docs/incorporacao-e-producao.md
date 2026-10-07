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
| `pair` | ID livre — liga o vídeo ao seu iframe de QR (abaixo) | — |

### QR em um iframe separado

Para mostrar o QR em outro lugar da página (fora do vídeo), use dois iframes **na mesma página**: o vídeo com `showqr=false` e o QR em `/qr`:

```html
<iframe src="https://SEU-SERVIDOR/static/totem.html?screen=totem1&showqr=false"
        width="360" height="640" allow="autoplay; fullscreen" style="border:0;"></iframe>

<iframe src="https://SEU-SERVIDOR/qr?screen=totem1" width="240" height="300" style="border:0;"></iframe>
```

O vídeo avisa o QR qual é a instância dele (canal do navegador, sem servidor). O QR se atualiza sozinho: troca quando o vídeo recarrega (nova instância), mostra "Celular conectado" quando alguém escaneia e "Aguardando o vídeo…" enquanto o vídeo não abriu. Se a página tiver **mais de um vídeo da mesma campanha**, use o mesmo `pair` em cada dupla (`&pair=topo` no vídeo e no QR). O admin gera esse código (opção "QR em iframe separado") e tem uma prévia com os dois iframes.

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
- [ ] Mídia no S3 (abaixo), para os visitantes não baixarem os vídeos do servidor.
- [ ] **Um `S3_PREFIX` por ambiente** (abaixo): produção e desenvolvimento nunca no mesmo prefixo.
- [ ] `CORS_ORIGINS` vazio, a não ser que outro site precise ler `/media` direto.

## Mídia no S3

Com `S3_BUCKET` no `.env`, a biblioteca de mídia fica **só no bucket**: o admin lista, envia, separa, substitui, renomeia e exclui direto no S3, e a pasta `assets/` não é usada (o servidor só cria arquivos temporários durante envio e separação). Os visitantes baixam vídeos e áudios direto do S3, e `/media/<arquivo>` redireciona para lá. Sem `S3_BUCKET`, tudo continua em `assets/` (modo local).

### 1. Bucket (S3 → Create bucket)

| Configuração | Valor |
|---|---|
| Nome | ex.: `dreambricks-audiosync-media` |
| Região | `sa-east-1` (São Paulo) |
| Object Ownership | *ACLs disabled* |
| Block Public Access | Marcar só as duas opções de **ACL**; **desmarcar** as duas de **bucket policy** |
| Versioning | *Disable* |
| Encryption | *SSE-S3* |

### 2. Leitura pública (Permissions → Bucket policy)

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadMedia",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::MEU-BUCKET/*"
  }]
}
```

Só leitura de arquivos: ninguém de fora lista, envia ou apaga.

### 3. CORS (Permissions → CORS) — obrigatório

O celular baixa o áudio com `fetch()` para sincronizar.

```json
[{
  "AllowedOrigins": ["*"],
  "AllowedMethods": ["GET", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"],
  "MaxAgeSeconds": 3600
}]
```

Para restringir, troque `"*"` em `AllowedOrigins` pelo domínio do servidor (a página do celular vem dele; os sites que só embutem o iframe não precisam entrar).

### 4. Usuário IAM do servidor

Política (troque `MEU-BUCKET`). `ListBucket` é necessário para o admin listar a biblioteca:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::MEU-BUCKET"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::MEU-BUCKET/*"
    }
  ]
}
```

Crie uma *Access key* ("Application running outside AWS"), ou use um IAM Role se o servidor rodar na AWS.

### 5. `.env`

```
S3_BUCKET=MEU-BUCKET
S3_REGION=sa-east-1        # a MESMA região do bucket
S3_PREFIX=audiosync
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
# Opcional: vazio usa https://MEU-BUCKET.s3.sa-east-1.amazonaws.com/audiosync
MEDIA_BASE_URL=
```

### 6. Migrar arquivos de uma pasta local (se houver)

`npm run s3-sync -- --dry-run` para conferir e `npm run s3-sync` para enviar o que falta.

### 7. Ligar

Reinicie o servidor. O console mostra `Media library: s3://MEU-BUCKET/audiosync/ (N files) — served from https://...`.

### Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `s3-sync` mostra `UnknownError`, ou console "Could not list the S3 bucket" com redirecionamento (301) | `S3_REGION` diferente da região do bucket |
| Biblioteca de mídia mostra "Falha no S3: Access Denied" | Falta `s3:ListBucket` na política do usuário |
| `AccessDenied` ao abrir o link de um vídeo | Bucket policy não salva, ou Block Public Access ainda bloqueando policies |
| Vídeo toca no totem, mas o celular não sincroniza | CORS do bucket faltando |
| Envio no admin falha com "Falha no S3" | Credenciais ou permissões de escrita do usuário IAM |

Arquivos alterados fora do admin (console da AWS, `s3-sync`) aparecem na biblioteca em até 1 minuto. Armazenamentos compatíveis (MinIO, Cloudflare R2) funcionam com `S3_ENDPOINT`.

### Campanhas no bucket e ambientes

No modo S3, as campanhas (o antigo `totems.json`) ficam em `<prefixo>/totems.json` no bucket — **todos os servidores com o mesmo bucket + prefixo compartilham as mesmas campanhas e os mesmos arquivos**. Cada servidor confere mudanças a cada 15s (`CONFIG_REFRESH_MS`) e troca o vídeo das telas abertas quando outro servidor altera uma campanha. Gravações simultâneas não se sobrescrevem (gravação condicional por ETag).

Por isso, **use um prefixo por ambiente**:

| Ambiente | `.env` |
|---|---|
| Produção (AWS) | `S3_PREFIX=audiosync` |
| Desenvolvimento | `S3_PREFIX=audiosync-dev` |

- Na **primeira partida** com um prefixo novo, o servidor cria o `totems.json` do bucket a partir do `totems.json` local. Depois disso o arquivo local é ignorado.
- O prefixo de desenvolvimento começa sem vídeos. Envie pelo admin, ou copie os de produção:
  `aws s3 sync s3://MEU-BUCKET/audiosync s3://MEU-BUCKET/audiosync-dev --exclude totems.json`
- Se o S3 estiver inacessível na partida, o servidor tenta 3 vezes e **não sobe** (para não rodar com campanhas vazias). Se o S3 cair com o servidor no ar, envios e alterações dão erro no admin e nada se perde.

### Opcional: CloudFront na frente

Quando o tráfego crescer, crie uma distribuição CloudFront com o bucket como origem (*Origin Access Control*), cache policy `CachingOptimized` (respeita o `Cache-Control: max-age=60` que o servidor grava) e response headers policy `CORS-With-Preflight`. Depois troque `MEDIA_BASE_URL` pela URL da distribuição — sem mudar código. Com CloudFront + OAC, o bucket pode voltar a ser privado.

## Limites conhecidos

- As sessões ficam na memória de **um** processo Node. Para rodar mais de um processo/servidor, seria preciso mover o registro de instâncias para um armazenamento compartilhado (ex.: Redis) e usar sessão fixa no balanceador. Um processo atende com folga centenas a alguns milhares de telas simultâneas — use o teste de carga para medir.
- Ao reiniciar o servidor, as telas reconectam sozinhas; celulares que estavam ouvindo precisam escanear de novo.
