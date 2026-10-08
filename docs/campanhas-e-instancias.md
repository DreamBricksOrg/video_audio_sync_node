# Campanhas e instâncias — referência da implementação

Documento de referência de tudo o que foi feito para o projeto suportar **um mesmo link de totem aberto por N telas ao mesmo tempo** (N visitantes de um site, cada um com seu iframe), com sincronia de áudio própria por tela, mais as melhorias que vieram junto (limites, "Ouvir aqui", código de incorporação, S3). Escrito para ser reaproveitado em um projeto parecido.

Período: commits `7dc1f06` → `c7301c2` na `main` (veja a lista no fim).

---

## 1. O problema

O sistema original assumia **1 totem = 1 tela**. Tudo no servidor era indexado só pelo ID do totem:

```js
const sessions = {};        // { totemId: { start_time, duration } }
const screenClients = {};   // { totemId: ws }
const mobileClients = {};   // { totemId: Set<ws> }
const driftClients = {};    // { totemId: Set<ws> }
```

Com o mesmo link aberto em várias telas (iframes em um site):

- cada tela **sobrescrevia a sessão** da anterior — um único relógio para todas;
- as telas estão em pontos diferentes do vídeo, então o celular sincronizava com o **relógio errado**;
- o aviso "celular conectado" (que esconde o QR) ia **só para a última tela** que abriu.

## 2. Conceitos

| Conceito | O que é | Onde vive |
|---|---|---|
| **Campanha** | O que o admin configura: vídeo, áudio, links da página do celular. No código e nas URLs continua se chamando `screen`/totem (não renomeamos rotas nem o `totems.json`) | `totems.json` |
| **Instância** | Uma tela tocando uma campanha: um totem físico ou o iframe de um visitante. Criada sozinha a cada carregamento da página, com **sessão de sincronia, QR e celulares próprios** | Memória do servidor (`lib/instances.js`) |

Regra de ouro: **configuração é da campanha; tempo/sincronia é da instância.**

## 3. Visão geral

```
                 ┌─────────────── Servidor (Node) ───────────────┐
 Site A          │  totems.json  ── campanha "promo"             │
 ┌──────────┐    │                  vídeo, áudio, links          │
 │ iframe   │─WS─┤                                               │
 │ totem    │    │  registro de instâncias (memória)             │
 │ inst=a1  │    │   promo ─┬─ a1: sessão(start_time) + celulares│
 └──────────┘    │          ├─ b7: sessão(start_time) + celulares│
 Site B          │          └─ default: totem físico             │
 ┌──────────┐    │                                               │
 │ iframe   │─WS─┤                                               │
 │ inst=b7  │    └───────────────────────────────────────────────┘
 └──────────┘           ▲ sync / drift (instance=b7)
      QR → celular ─────┘        vídeo/áudio ◄── S3 (MEDIA_BASE_URL)
```

## 4. Protocolo WebSocket

Todas as rotas recebem o ID da instância por query string.

| Rota | Quem conecta | Comportamento |
|---|---|---|
| `/ws/screen/<campanha>?instance=<id>` | Página do totem | Fica aberta. Envia registro e posição; recebe avisos |
| `/ws/mobile/<campanha>?instance=<id>` | Celular | Recebe um `sync` e a conexão fecha |
| `/ws/drift/<campanha>?instance=<id>` | Celular, depois de tocar | Fica aberta; troca `drift_check` / `position_report` |

`instance` é opcional: sem ele, a tela vira a instância `default` (totem antigo) e o celular segue a **instância mais recente** da campanha (QR impresso / link antigo).

### Mensagens

**Tela → servidor**

| Mensagem | Campos | Quando |
|---|---|---|
| registro (sem `type`) | `current_time`, `duration`, `mode`, `drift_enabled` | Ao abrir o socket |
| `position_update` | `current_time` | A cada 5s |

**Servidor → tela**

| Mensagem | Campos | Quando |
|---|---|---|
| `session_created` | `screen_id`, `instance` | Depois do registro |
| `change_video` | `filename`, `url`, `audio` | No registro e quando o admin troca vídeo/áudio. `url`/`audio` já vêm prontos (S3 ou `/media`) |
| `change_screen` | `screen` | Campanha renomeada no admin → a página recarrega com `?screen=<novo>` |
| `mobile_connected` | — | Um celular sincronizou **com esta instância** → esconde o QR por 2 loops |

**Servidor → celular**

| Mensagem | Campos |
|---|---|
| `sync` | `instance` (a instância resolvida — o celular usa no drift), `start_time`, `duration`, `server_time`, `drift_enabled`, `audio`, `promo` |
| `drift_check` | `expected_position`, `server_time`, `start_time`, `duration`, `threshold_ms` |
| `drift_correction` | `mode` (`HARD` → `target_time` / `SOFT` → `playback_rate`), `drift_ms` |
| `drift_ok` | — |

**Códigos de fechamento**: `4004` sessão/instância não encontrada; `4029` limite atingido (tela espera 60s para tentar de novo).

## 5. Registro de instâncias — `lib/instances.js`

Módulo puro, sem dependências, testado com relógio falso.

```js
const instances = createInstanceRegistry({ now, graceSeconds: 120 });

instances.register(campaign, instanceId, ws)   // conecta/reconecta; id inválido → "default"
instances.startSession(inst, { current_time, duration, mode, drift_enabled })
instances.updatePosition(inst, currentTime)    // start_time = agora(servidor) − posição
instances.resolve(campaign, instanceId?)       // instância com sessão; sem id → a mais recente online
instances.disconnect(inst, ws)                 // ignora socket antigo (reconexão já trocou o ws)
instances.online(campaign)                     // telas conectadas agora
instances.campaignsOnline()                    // campanhas com ≥1 tela
instances.stats(campaign)                      // { instances, mobiles }
instances.sweep()                              // remove fechadas há > graceSeconds e sem celulares
instances.totals()                             // { instances, online, mobiles }
```

Decisões que importam:

- **ID gerado pelo cliente, um por carregamento da página** (`crypto.randomUUID()` com fallback — `randomUUID` só existe em https/localhost). Validado no servidor com `/^[A-Za-z0-9_-]{1,64}$/`.
- **Reconexão reaproveita a instância**: o ID fica numa variável da página, não muda quando o WebSocket cai e volta. Celulares já sincronizados não perdem a sessão.
- **Não persistir o ID** (sessionStorage etc.): iframes do mesmo site compartilham sessionStorage e acabariam com o mesmo ID.
- **"Mais recente" por número de sequência**, não por timestamp (duas telas no mesmo segundo).
- **Limpeza com folga** (`sweep` a cada 30s, folga de 120s) e **nunca** apagar instância com celular ouvindo — o drift dele continua funcionando mesmo com a tela fechada.
- **Relógio do servidor** para `start_time`: a tela manda a posição do vídeo; o servidor calcula `start_time = agora − posição`. Tudo no mesmo domínio de tempo.

## 6. Mudanças no servidor (`server.js`)

> Desde 2026-10-08 o `server.js` só liga as peças; o código está em `src/`:
> `settings.js` (.env), `campaigns.js` (config compartilhada, conteúdo no ar, envio às telas),
> `auth.js` (login e sessões), `stats-service.js`, `media-library.js`, `routes/` (public, media,
> campaigns) e `realtime.js` (WebSockets). As referências abaixo a "`server.js`" valem para esses módulos.


**WebSocket**
- Um único `upgrade` com regex `/^\/ws\/(screen|mobile|drift)\/([^/]+)$/` lendo `instance` da query e o IP do cliente.
- `handleScreen` / `handleMobile` / `handleDrift` passam a trabalhar sobre a instância (`instances.register` / `instances.resolve`).
- Removido o log de `position_update` (5s por tela vira ruído com muitos visitantes).

**Broadcast por campanha**
- `sendToCampaign(campaign, msg)` envia para **todas** as telas abertas da campanha. Usado em: troca de vídeo/áudio no admin, criar totem, renomear totem (`change_screen`), renomear mídia.
- `videoMessage(campaign)` monta o `change_video` (vídeo + URL + áudio) a partir da config — um único lugar.
- `mobile_connected` vai **só** para a instância escaneada.

**Admin / API**
- `GET /api/totems` → por campanha: `is_online`, `instances` (telas abertas), `mobile_count` (celulares ouvindo = sockets de drift; antes contava só sockets de sync em trânsito, quase sempre 0).
- `GET /health` → `sessions`, `screens_online`, `mobile_clients`, `memory_mb`.

**Proteção para sites públicos**
- `MAX_SCREENS_PER_IP` (20) e `MAX_INSTANCES_PER_CAMPAIGN` (2000); reconectar uma instância conhecida é sempre permitido.
- IP via `X-Forwarded-For` só com `TRUST_PROXY=1`. Sem isso, conexões de loopback (túnel local tipo ngrok) **não** são limitadas por IP — senão todo mundo contaria como um só visitante.
- Removida a "API key" do totem: estava no JS público e o servidor nunca validava. A proteção real são os limites.
- **CORS desligado por padrão** (antes era `*` em tudo, inclusive a API do admin). `CORS_ORIGINS` libera só `/media` e `/health`. Iframes e a página do celular não precisam de CORS — são do mesmo servidor.

**Robustez**
- `totems.json` gravado de forma atômica (`lib/atomic-write.js`: arquivo temporário + `fsync` + `rename`).
- `TOTEMS_FILE`, `ASSETS_DIR` e `ENV_FILE` configuráveis (essencial para os testes não tocarem nos dados reais).

## 7. Mudanças nos clientes

**Página do totem** (`static/totem.html`, `js/totem.js`, `css/totem.css`)
- Gera `INSTANCE_ID` por carregamento; usa no WebSocket e no QR (`mobile.html?screen=X&instance=Y`).
- **Responsiva** (antes fixa em 1080×1920): ocupa 100% do iframe; tamanhos do cartão do QR em `vmin` com `clamp()`, calibrados para ficar igual ao original em 1080×1920; QR gerado em 480px e reduzido por CSS (nítido em qualquer tamanho); em quadros largos (≥ 4:3) o QR vai para o canto inferior direito.
- Parâmetros: `fit=contain` (vídeo inteiro, com faixas), `showqr=false`, `listen=auto|on|off`.
- **QR clicável**: o cartão é um `<a target="_blank">` para o mesmo link do QR (nova aba, para não trocar a página do site que embute o iframe).
- **"Ouvir aqui"**: em tela de toque com até 820px (celular do visitante), no lugar do QR aparece um botão que toca o áudio da campanha **no próprio aparelho**, sincronizado localmente com o `<video>` (`js/local-audio.js`: desvio com volta no loop; ressincroniza acima de 0,2s). O áudio **acompanha o vídeo**: pausa em `pause`/`waiting`, volta em `playing`.
- Fechamento `4029` → espera 60s para reconectar.

**Celular** (`js/mobile.js`, `js/mobile_debug.js`)
- Lê `instance` da URL e envia no sync.
- O drift usa `syncData.instance` (a instância que o servidor de fato resolveu) — importante para QR sem instância.
- O debug mostra a campanha + início do ID da instância.

**QR em iframe separado** (`/qr` → `static/qr.html`, `js/qr.js`, `js/qr-channel.js`)
- O site coloca o vídeo (`showqr=false`) e o QR (`/qr?screen=X`) em dois iframes da mesma página.
- **Pareamento sem servidor** por `BroadcastChannel` (`audiosync-qr:<campanha>[:<pair>]`): o totem publica `{instance, mobileUrl, hidden}`; o QR pede o estado ao abrir (`hello`) e segue as mudanças. Ao sair (`pagehide`) o totem avisa `gone` → o QR mostra "Aguardando o vídeo…".
- Atualiza sozinho: nova instância quando o vídeo recarrega; "Celular conectado" enquanto o QR do totem estaria escondido (`mobile_connected`, 2 loops) — a contagem de loops roda mesmo com `showqr=false`.
- `pair` separa vários vídeos da mesma campanha na mesma página. Iframes do mesmo servidor na mesma página compartilham o canal (o navegador particiona por site de topo, então funciona dentro de sites de terceiros).
- Testável no Node (`BroadcastChannel` é global): `tests/qr-channel.test.js`.

**Admin** (`static/admin.html`, `js/admin.js`, `js/embed-code.js`)
- Card mostra **Telas abertas** e **Celulares ouvindo**.
- Ícone `</>` → modal de **incorporação**: largura/altura, responsivo (wrapper com `aspect-ratio`), ajuste do vídeo, QR, "Ouvir aqui"; gera o `<iframe>` pronto (com `allow="autoplay; fullscreen"`) e copia.

## 8. Mídia

- **Separador** (`lib/media-splitter.js`, ffmpeg): opção `web` gera vídeo H.264 leve (CRF 28, ~2,5 Mbps, lado maior ≤ 1920px) para sites. Admin: "Otimizar para sites"; CLI: `npm run split -- arquivo --web`.
- **S3 como biblioteca única** (`lib/media-store.js` + `lib/s3-storage.js`): com `S3_BUCKET`, o admin lista/envia/separa/substitui/renomeia/exclui direto no bucket (índice em memória, recarregado a cada 60s); o servidor só cria arquivos temporários; `/media/<arquivo>` redireciona (302) para o S3. Sem `S3_BUCKET`, pasta `assets/` local. Mesma interface nos dois modos.
- **URLs de mídia** (`lib/media-url.js`): `MEDIA_BASE_URL` (bucket ou CloudFront); vazio no modo S3 → URL pública do bucket derivada de bucket/região/prefixo.
- Objetos gravados com `Content-Type` correto e `Cache-Control: public, max-age=60` (arquivo substituído aparece em até ~1 min, também via CloudFront).
- `npm run s3-sync [-- --dry-run]` migra uma pasta local para o bucket (envia só o que falta ou mudou de tamanho).
- Configuração do bucket (policy pública, CORS, IAM com `s3:ListBucket`) em [`incorporacao-e-producao.md`](incorporacao-e-producao.md).

## 9. Configuração (`.env`)

| Variável | Padrão | Para quê |
|---|---|---|
| `MAX_SCREENS_PER_IP` | 20 | Telas abertas por IP |
| `MAX_INSTANCES_PER_CAMPAIGN` | 2000 | Telas abertas por campanha |
| `TRUST_PROXY` | 0 | `1` atrás de proxy/túnel (usa `X-Forwarded-For`) |
| `CORS_ORIGINS` | vazio | Origens liberadas para `/media` e `/health` |
| `S3_BUCKET`, `S3_REGION`, `S3_PREFIX` | vazio | Liga o modo S3. **Região tem que ser a do bucket** |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | — | Usuário IAM do servidor |
| `S3_ENDPOINT` | vazio | MinIO / Cloudflare R2 / testes |
| `MEDIA_BASE_URL` | URL do bucket | De onde os visitantes baixam (troque pelo CloudFront depois) |
| `TOTEMS_FILE`, `ASSETS_DIR`, `ENV_FILE` | arquivos do projeto | Usados pelos testes |

## 10. Testes

`npm test` → `node --test "tests/**/*.test.js"` (sem dependências novas). 68 testes.

- **Unitários** de módulos puros: registro de instâncias (relógio falso), escrita atômica, URLs, armazém de mídia, cliente S3 (cliente falso que grava os comandos), código de incorporação, desvio do áudio local.
- **Integração** sobe o `server.js` **de verdade** em porta aleatória (`tests/helpers/server.js`) e conversa por WebSocket/HTTP (`tests/helpers/ws.js`): sessões separadas por instância, `mobile_connected` só na tela certa, QR sem instância, drift na linha do tempo certa, contadores do admin, broadcast, limites por IP/campanha, CORS, mensagens de vídeo, modo S3.
- **S3 falso** (`tests/helpers/fake-s3.js`): servidor HTTP mínimo compatível (PUT, cópia via `x-amz-copy-source`, HEAD, GET, DELETE, ListObjectsV2). O SDK real da AWS conversa com ele via `S3_ENDPOINT`.
- **Isolamento**: o helper usa `totems.json`, `assets/` e `.env` **temporários** (`ENV_FILE` aponta para um arquivo vazio).
- **CI**: `.github/workflows/test.yml` (Node 22 + ffmpeg) em push na `main` e PRs.
- `npm run load-test -- --screens N --phones M` simula carga (referência: 100 telas + 200 celulares ≈ 55 MB, conexão em 0,4s).

## 11. Armadilhas encontradas (e como foram resolvidas)

1. **Vários iframes com o mesmo ID**: persistir o ID em sessionStorage faria iframes do mesmo site compartilharem a instância → gerar a cada carregamento, guardar só em variável.
2. **QR sem instância + drift**: o celular precisa usar a instância **que o servidor resolveu** (`sync.instance`) no drift, senão pode cair em outra tela.
3. **Limite por IP atrás de túnel**: sem `TRUST_PROXY`, todos os visitantes do ngrok chegam como `127.0.0.1` → limite por IP não se aplica a loopback.
4. **"Ouvir aqui" adiantando**: com o vídeo pausado (aba em segundo plano) ou carregando, o áudio continuava → seguir `pause`/`waiting`/`playing` do vídeo. **Não usar `stalled`**: dispara com o vídeo ainda tocando e não tem evento de volta (o áudio ficava parado).
5. **Teste síncrono travando**: rodar o `s3-sync` com `execFileSync` dentro do teste congelava o processo onde roda o S3 falso → `execFile` assíncrono.
6. **Testes lendo o `.env` real**: com S3 configurado no `.env` do desenvolvedor, os servidores de teste entraram em modo S3 apontando para o bucket real → `ENV_FILE` vazio nos testes.
7. **`ASSETS_DIR` fixo**: a primeira rodada de testes de S3 gravou arquivos na pasta real → tornar o caminho configurável **antes** de testar.
8. **Nome sanitizado**: o servidor remove `_`/`.` do início do nome (`_teste.mp3` → `teste.mp3`); testes e scripts devem usar o nome devolvido pela API.
9. **`UnknownError` do S3**: `HEAD` não tem corpo de erro; um 301 (região errada) aparece como "UnknownError". Diagnóstico: olhar `$metadata.httpStatusCode` e o header `x-amz-bucket-region`.
10. **Checksums do SDK v3**: versões novas mandam corpo em `aws-chunked` com trailers; para S3 compatível/testes, `requestChecksumCalculation: "WHEN_REQUIRED"`.
11. **Navegador de automação com janela oculta**: o Chrome não carrega mídia em aba oculta (`document.visibilityState === "hidden"`) — vídeo "preto" nos testes manuais não é bug do código.

## 12. Checklist para portar para outro projeto

1. Separar no modelo de dados o que é **configuração** (campanha) do que é **tempo real** (instância).
2. Copiar `lib/instances.js` + `tests/instances.test.js` (sem dependências).
3. Em cada rota WebSocket, aceitar `?instance=` e trocar mapas por campanha pelo registro (`register` na tela, `resolve` no cliente/celular).
4. Fazer o servidor devolver a instância resolvida ao cliente e o cliente usá-la nas conexões seguintes.
5. Trocar envios "para a tela X" por `sendToCampaign` (config) ou pela instância específica (eventos de uma tela só).
6. Cliente da tela: gerar o ID por carregamento, colocar no WebSocket e no QR/links; reconectar com o mesmo ID.
7. Manter compatibilidade: sem ID → instância `default` na tela e "mais recente" no cliente.
8. Limpeza periódica com folga e sem derrubar quem ainda está conectado.
9. Limites por IP/campanha + `TRUST_PROXY`; CORS fechado por padrão.
10. Admin mostrando instâncias abertas e clientes conectados.
11. Testes de integração subindo o servidor real com arquivos/`.env` temporários.
12. Teste de carga antes de publicar.

## 13. Commits

| Commit | Descrição |
|---|---|
| `7dc1f06` | Planos de implementação (MVP + melhorias) |
| `f4bcf24` | `node:test` e `TOTEMS_FILE` configurável |
| `428b2ff` | Registro de instâncias por campanha |
| `4654802` | Testes de integração (escritos antes) |
| `3d35de3` | Sessões por instância nos sockets de tela, celular e drift |
| `c4c4e7a` | Broadcast por campanha; instâncias no admin e no `/health` |
| `67096cc` | Totem gera ID de instância (WS e QR) |
| `cb0c54e` | Celular sincroniza e corrige drift na instância escaneada |
| `760d407` | Admin: telas abertas e celulares ouvindo |
| `ba28bda` | QR clicável |
| `697ea78` | Limites por IP e por campanha |
| `6c5a14c` | `change_video` com o áudio da campanha |
| `19b4d2e` | "Ouvir aqui" |
| `0de0faf` | Código de incorporação no admin |
| `650a30a` | Vídeo otimizado para sites no separador |
| `bc382b4` | Teste de carga e memória no `/health` |
| `efa1868` | Guia de incorporação e produção |
| `3b961c4` | Áudio local acompanha pausa/carregamento do vídeo |
| `5dba226` | Ajuste de layout do separador |
| `3752c8a` | `totems.json` gravado de forma atômica |
| `1f75056` | Remoção da API key pública |
| `77a1bbe` | CORS restrito |
| `09bb61d` | URLs de mídia por `MEDIA_BASE_URL` |
| `89d1757` | Módulo de armazenamento S3 |
| `e56d850` | Replicação no S3 e `npm run s3-sync` (substituído pelo modo só S3) |
| `a29b22b` | CI no GitHub Actions |
| `a21eb13` | Biblioteca de mídia só no S3 |
| `c7301c2` | Mídia local removida do repositório |

## 14. Evolução: playlists e agendamento

Uma campanha pode ter **vários vídeos em sequência**, cada um com o próprio áudio, e um **período no ar**.

**Config** (`totems.json`): `playlist: [{ video, audio }]` (só com 2+ itens; `video`/`audio` continuam espelhando o primeiro item, para versões antigas) e `schedule: { start, end, fallback }` (datas ISO em UTC). Fora do período a campanha mostra o conteúdo da campanha `fallback`; sem ela, tela preta com o logo. A decisão fica em uma função pura, `activeContent()` em `lib/campaign-content.js` (com proteção contra ciclos de fallback).

**Linha do tempo:** a sincronia continua sendo um ciclo único (`start_time` + `duration` no relógio do servidor). Com playlist, o ciclo é a soma dos vídeos:

1. A tela mede a duração de cada vídeo (metadados) e registra `{ current_time: posição no ciclo, duration: total, items: [d1, d2, …] }`. Registra de novo sempre que carrega conteúdo novo.
2. O `sync` do celular traz `items: [{ audio, start, duration }]`. Sem durações coerentes da tela, vai um item só (o primeiro áudio no ciclo inteiro).
3. O celular (`static/js/sync-player.js`, compartilhado por `mobile.js` e `mobile_debug.js`) localiza o item pela posição no ciclo e agenda cada áudio no relógio do Web Audio, sem intervalo entre um e outro. O desvio (`drift_check`/`position_report`) continua em posições do ciclo.
4. A tela usa dois `<video>` alternados: enquanto um toca, o outro carrega o próximo.

**Mensagens novas:** `change_video` ganhou `playlist`, `idle`, `source` e `key` (a tela ignora uma `key` repetida). O servidor confere a cada 5 s, e depois de cada mudança de config, se o conteúdo de alguma campanha mudou (agendamento começando ou terminando, outro servidor), envia às telas e manda `content_changed` aos celulares ouvindo, que pedem um `sync` novo. Sem nada no ar, o `/ws/mobile` responde `{ type: "idle" }` e fecha com o código **4010**; o celular tenta de novo a cada 30 s.

**Testes:** `tests/campaign-content.test.js`, `tests/sync-player.test.js`, `tests/playlist.integration.test.js` e, com mídia real gerada pelo ffmpeg (WebM/WAV), `e2e/playlist.spec.js` — confere que o celular fica a menos de 0,3 s da linha do tempo enquanto troca de áudio.
