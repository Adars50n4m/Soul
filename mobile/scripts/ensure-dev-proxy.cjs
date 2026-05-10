const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SOUL_DEV_PROXY_PORT || 3000);
const HOST = '127.0.0.1';
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const SERVER_DIR = path.join(ROOT_DIR, 'server');
const LOG_DIR = path.join(SERVER_DIR, '.logs');
const LOG_FILE = path.join(LOG_DIR, 'dev-proxy.log');

let hasChecked = false;

const isPortOpen = (callback) => {
  const socket = new net.Socket();
  let settled = false;

  const done = (open) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    callback(open);
  };

  socket.setTimeout(250);
  socket.once('connect', () => done(true));
  socket.once('timeout', () => done(false));
  socket.once('error', () => done(false));
  socket.connect(PORT, HOST);
};

module.exports = function ensureDevProxy() {
  if (hasChecked || process.env.CI || process.env.SOUL_SKIP_DEV_PROXY === '1') return;
  hasChecked = true;

  isPortOpen((open) => {
    if (open) return;

    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const out = fs.openSync(LOG_FILE, 'a');
      const child = spawn('npm', ['start'], {
        cwd: SERVER_DIR,
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, PORT: String(PORT) },
      });
      child.unref();
      console.log(`[dev-proxy] Started Soul server proxy on ${HOST}:${PORT} (log: ${LOG_FILE})`);
    } catch (error) {
      console.warn(`[dev-proxy] Failed to start Soul server proxy: ${error.message}`);
    }
  });
};
