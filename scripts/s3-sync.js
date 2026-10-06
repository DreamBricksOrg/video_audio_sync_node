#!/usr/bin/env node
/**
 * Envia para o S3 os vídeos e áudios de assets/ que ainda não estão lá (ou
 * mudaram de tamanho). Use uma vez ao ligar o S3, ou para conferir.
 *
 *   npm run s3-sync              envia o que falta
 *   npm run s3-sync -- --dry-run só mostra o que seria enviado
 *
 * Lê as mesmas variáveis do servidor: S3_BUCKET, S3_REGION, S3_PREFIX,
 * S3_ENDPOINT (opcional) e as credenciais AWS (.env ou ambiente).
 */
const fs = require("fs");
const path = require("path");
const { createS3Storage } = require("../lib/s3-storage");

try {
  process.loadEnvFile(path.join(__dirname, "..", ".env"));
} catch (_) {}

const ASSETS_DIR = process.env.ASSETS_DIR || path.join(__dirname, "..", "assets");
const MIME_TYPES = {
  ".mp4": "video/mp4", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
};

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const storage = createS3Storage({
    bucket: process.env.S3_BUCKET,
    region: process.env.S3_REGION,
    prefix: process.env.S3_PREFIX,
    endpoint: process.env.S3_ENDPOINT,
    contentTypeFor: f => MIME_TYPES[path.extname(f).toLowerCase()] || "application/octet-stream",
  });
  if (!storage.enabled) {
    console.error("S3_BUCKET não definido no .env — nada a fazer.");
    process.exitCode = 1;
    return;
  }

  const files = fs.readdirSync(ASSETS_DIR)
    .filter(f => !f.startsWith(".") && MIME_TYPES[path.extname(f).toLowerCase()])
    .sort();
  console.log(`${files.length} arquivo(s) em ${ASSETS_DIR} → ${storage.describe()}${dryRun ? " (simulação)" : ""}`);

  let sent = 0, failed = 0;
  for (const f of files) {
    const localPath = path.join(ASSETS_DIR, f);
    const size = fs.statSync(localPath).size;
    try {
      if (!(await storage.needsUpload(f, size))) {
        console.log(`  = ${f} já está no S3`);
        continue;
      }
      if (dryRun) {
        console.log(`  ↑ ${f} seria enviado (${(size / 1024 / 1024).toFixed(1)} MB)`);
        continue;
      }
      await storage.upload(localPath, f);
      sent++;
      console.log(`  ↑ ${f} enviado (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${f}: ${err.message || err.name}`);
    }
  }
  console.log(`Pronto: ${sent} enviado(s), ${failed} com erro.`);
  if (failed) process.exitCode = 1;
}

main();
