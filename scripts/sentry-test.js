#!/usr/bin/env node
/**
 * Checks the Sentry setup: sends one test error through the same path the
 * server uses (log.error → Sentry) and shows Sentry's answer.
 *
 *   npm run sentry-test
 *
 * Reads SENTRY_DSN (and SENTRY_ENVIRONMENT) from .env. Run it on each server
 * whose alerts you want to confirm; the event shows up in the Sentry project
 * as "Sentry test from <host>".
 */
const os = require("os");
require("../src/settings"); // loads .env
const { log } = require("../src/log");
const { initSentry, flushSentry } = require("../src/sentry");

const dsn = process.env.SENTRY_DSN || "";
if (!dsn) {
  console.error("❌ SENTRY_DSN não está definido no .env");
  process.exit(1);
}
let host;
try {
  const u = new URL(dsn);
  if (!u.username || !/\/\d+$/.test(u.pathname)) throw new Error("formato");
  host = u.host;
} catch (_) {
  console.error("❌ SENTRY_DSN inválido. Formato esperado: https://<chave>@<host>/<id-do-projeto>");
  process.exit(1);
}

const release = require("../package.json").version;
if (!initSentry({ release })) {
  console.error("❌ Sentry não ligou");
  process.exit(1);
}

const Sentry = require("@sentry/node");
let answer = null;
Sentry.getClient().on("afterSendEvent", (event, response) => {
  answer = { id: event.event_id, status: response && response.statusCode };
});

console.log(`Enviando um erro de teste para ${host} (ambiente "${process.env.SENTRY_ENVIRONMENT || process.env.S3_PREFIX || "production"}")…`);
log.error("SentryTest", "Erro de teste (pode ignorar):", new Error(`Sentry test from ${os.hostname()}`));

flushSentry(10000).then(() => {
  if (!answer) {
    console.error("❌ O Sentry não respondeu em 10s (rede bloqueada? DSN de outra região?)");
    process.exit(1);
  }
  if (answer.status && answer.status >= 300) {
    console.error(`❌ O Sentry recusou o evento (HTTP ${answer.status}). Confira se o DSN é deste projeto e se a chave está ativa.`);
    process.exit(1);
  }
  console.log(`✅ Recebido pelo Sentry (HTTP ${answer.status || 200}). Evento ${answer.id}`);
  console.log('   Procure no projeto por "Sentry test from" — e defina um alerta por e-mail em Alerts, se ainda não tiver.');
  process.exit(0);
});
