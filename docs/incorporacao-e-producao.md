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

## Próximos passos

- **Mídia no S3 (planejado):** hoje cada visitante baixa o vídeo do próprio servidor. A próxima etapa é enviar os arquivos para o S3 automaticamente pelo admin e servir de lá (ou de um CloudFront na frente), reduzindo o tráfego do servidor.

## Limites conhecidos

- As sessões ficam na memória de **um** processo Node. Para rodar mais de um processo/servidor, seria preciso mover o registro de instâncias para um armazenamento compartilhado (ex.: Redis) e usar sessão fixa no balanceador. Um processo atende com folga centenas a alguns milhares de telas simultâneas — use o teste de carga para medir.
- Ao reiniciar o servidor, as telas reconectam sozinhas; celulares que estavam ouvindo precisam escanear de novo.
