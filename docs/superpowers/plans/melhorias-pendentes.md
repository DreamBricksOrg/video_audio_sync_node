# Melhorias pendentes

Backlog do que ainda falta implementar. Os planos de **Campanhas e Instâncias (Partes 1 e 2)** foram concluídos e removidos desta pasta — a referência do que foi feito está em [`docs/campanhas-e-instancias.md`](../../campanhas-e-instancias.md) (os planos originais seguem no histórico do git, commit `7dc1f06`).

Antes de implementar um item, gere um plano detalhado com a skill **superpowers:writing-plans** (arquivo `YYYY-MM-DD-<nome>.md` nesta pasta).

Atualizado em 2026-10-07 (alta prioridade e média — menos 8 e 11 — concluídas).

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
- **Servidor de produção na AWS** com domínio e HTTPS (`videosync.dbpe.com.br`); guia de operação em [`docs/operacao-aws.md`](../../operacao-aws.md)
- **Campanhas no bucket** (`<prefixo>/totems.json`), compartilhadas entre servidores, com gravação condicional por ETag e sincronização a cada 15s
- **Admin avisa arquivo inexistente** no card; "Aplicar" recusa arquivos que não existem
- **Um prefixo do S3 por ambiente** (`audiosync` produção, `audiosync-dev` desenvolvimento)
- `npm audit` zerado (`express` atualizado, `yamljs` trocado por `yaml`)
- **Testes no navegador** com Playwright (`npm run test:e2e`), também no CI
- **Totem com tela de toque**: `?qrlink=false` (QR visível, mas não clicável)
- **Página de debug** (`mobile_debug.html`) só com login do admin
- **Limites dos celulares** por IP: `MAX_PHONES_PER_IP` (ouvindo ao mesmo tempo) e `MAX_SYNCS_PER_IP_PER_MINUTE`
- **Sessão de login revogável**: sessões em `sessions.json` (no bucket no modo S3), "Sair" encerra de verdade, botão "Desconectar outros aparelhos"
- **Envio direto do navegador para o S3** com URL pré-assinada (10 min, só aquele arquivo/tamanho); sem CORS de PUT no bucket, cai no envio pelo servidor
- **Estatísticas por campanha**: telas abertas, escaneamentos, celulares ouvindo, tempo médio, sites; um arquivo por dia (90 dias), gráfico e CSV no admin
- **Playlists e agendamento**: vários vídeos em sequência, cada um com seu áudio (o celular troca junto); período no ar com campanha padrão ou tela preta com logo
- Lógica do celular unificada em `static/js/sync-player.js` (antigo item 17)
- Arrumação: branch `feat/campaign-instances` apagada; `totems.json` fora do git (modelo em `totems.example.json`)

---

## Produção — pendente desde a atualização de 2026-10-07

`git pull` e `npm ci` já rodaram no servidor. Falta:

1. **Reiniciar o Node** (`pm2 restart videosync` ou `systemctl restart`): até reiniciar, o processo antigo continua rodando com os arquivos novos.
2. **CORS do bucket**: adicionar a regra de PUT (só `https://videosync.dbpe.com.br` e `http://localhost:8001`) — ver `docs/incorporacao-e-producao.md`, seção 3. Sem ela o envio continua passando pelo servidor.
3. **Login de novo** no admin (o formato do cookie mudou; acontece uma vez).
4. **Testar num iPhone de verdade** uma campanha com 2+ vídeos (troca de áudio no celular) e o "Ouvir aqui" no totem.
5. Conferir o painel **Estatísticas** no dia seguinte (os números aparecem a cada minuto).

---

## Alta

Nada pendente — os 6 itens de alta prioridade foram concluídos em 2026-10-07 (veja acima).

---

## Média — experiência e operação

Concluída em 2026-10-07, menos estes dois (adiados por decisão):

### 8. CloudFront na frente do S3
Quando o tráfego crescer. Já documentado em `docs/incorporacao-e-producao.md`; só troca `MEDIA_BASE_URL`.

### 11. Vídeo em várias qualidades (HLS)
Para conexões lentas; o separador geraria as variantes. Exige trocar o `<video>` por um player HLS (hls.js) no totem.

---

## Baixa — código e manutenção

16. Dividir o `server.js` (~1.500 linhas) em módulos: auth, mídia, totens, estatísticas, WebSocket.
18. Remover rotas antigas `/api/videos` e `/api/audios` (substituídas por `/api/media`).
19. Logs estruturados, alerta de erros (Sentry ou similar) e monitor de disponibilidade no `/health`.
20. Vários usuários no admin, com permissões e registro de quem fez o quê.
21. Redis para várias instâncias do servidor — só se o teste de carga mostrar necessidade.


## Fora do escopo (decidido não implementar)

- Áudio em vários idiomas por campanha.
- Controles na tela de bloqueio do celular (Media Session API).
