const WebSocket = require("ws");

// Opens a socket and records every JSON message it receives.
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.on("message", raw => messages.push(JSON.parse(raw)));
    ws.once("error", reject);
    ws.once("open", () => {
      resolve({
        ws,
        messages,
        send: data => ws.send(JSON.stringify(data)),
        next: (type, timeout = 3000) => waitFor(ws, messages, type, timeout),
        received: type => messages.some(m => m.type === type),
        close: () => ws.close(),
      });
    });
  });
}

function waitFor(ws, messages, type, timeout) {
  const found = messages.find(m => m.type === type);
  if (found) return Promise.resolve(found);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timeout waiting for "${type}"`));
    }, timeout);
    function onMessage(raw) {
      const msg = JSON.parse(raw);
      if (msg.type !== type) return;
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(msg);
    }
    ws.on("message", onMessage);
  });
}

// Registers a totem screen like static/js/totem.js does.
async function registerScreen(wsBase, campaign, { instance, currentTime = 0, duration = 30 } = {}) {
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : "";
  const screen = await connect(`${wsBase}/ws/screen/${campaign}${query}`);
  screen.send({ current_time: currentTime, duration, mode: "sync", drift_enabled: true });
  screen.session = await screen.next("session_created");
  return screen;
}

// Phone sync: the server sends one "sync" and closes. Resolves { code, sync }.
function mobileSync(wsBase, campaign, instance) {
  const query = instance ? `?instance=${encodeURIComponent(instance)}` : "";
  return new Promise(resolve => {
    const ws = new WebSocket(`${wsBase}/ws/mobile/${campaign}${query}`);
    let sync = null;
    ws.on("message", raw => {
      const msg = JSON.parse(raw);
      if (msg.type === "sync") sync = msg;
    });
    ws.on("close", code => resolve({ code, sync }));
    ws.on("error", () => {});
  });
}

module.exports = { connect, registerScreen, mobileSync };
