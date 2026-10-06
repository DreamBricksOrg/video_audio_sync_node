#!/usr/bin/env node
/**
 * Separa vídeo e áudio de um ou mais arquivos.
 *
 *   npm run split -- <arquivo...> [--out <pasta>] [--overwrite]
 *
 * Ex.: npm run split -- promo.mp4 --out assets
 *      → assets/promo_video.mp4 + assets/promo_audio.mp3
 */

const path = require("path");
const fs = require("fs");
const { splitMedia } = require("../lib/media-splitter");

function usage() {
  console.log(`Uso: npm run split -- <arquivo...> [--out <pasta>] [--overwrite]

  --out <pasta>   onde salvar (padrão: mesma pasta do arquivo)
  --overwrite     substitui arquivos de saída que já existam
  --web           gera um vídeo menor, próprio para sites

Gera <nome>_video.<ext> (sem áudio) e <nome>_audio.mp3.`);
}

async function main() {
  const args = process.argv.slice(2);
  const files = [];
  let outDir = null;
  let overwrite = false;
  let web = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") return usage();
    if (a === "--overwrite") overwrite = true;
    else if (a === "--web") web = true;
    else if (a === "--out") outDir = args[++i];
    else files.push(a);
  }
  if (!files.length || (outDir === undefined)) {
    usage();
    process.exitCode = 1;
    return;
  }

  let failed = 0;
  for (const file of files) {
    const started = Date.now();
    process.stdout.write(`▶ ${file} ... `);
    try {
      const r = await splitMedia(file, { outDir, overwrite, web });
      const mb = p => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
      console.log(`ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      console.log(`   vídeo: ${path.relative(process.cwd(), r.video)} (${mb(r.video)} MB)`);
      console.log(`   áudio: ${path.relative(process.cwd(), r.audio)} (${mb(r.audio)} MB)`);
    } catch (err) {
      failed++;
      console.log("erro");
      console.error(`   ${err.message.replace(/\n/g, "\n   ")}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main();
