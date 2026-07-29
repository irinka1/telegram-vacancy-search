const fs = require('fs');
const path = require('path');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const env = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    env[key] = value;
  }

  return env;
}

function loadEnv() {
  const rootDir = path.join(__dirname, '..', '..');
  const primaryEnv = parseEnvFile(path.join(rootDir, '.env'));
  const legacyEnv = parseEnvFile(path.join(rootDir, 'keys.env'));

  const getValue = (name, fallback = '') => {
    if (process.env[name]) return process.env[name];
    if (primaryEnv[name]) return primaryEnv[name];
    if (legacyEnv[name]) return legacyEnv[name];
    return fallback;
  };

  return {
    BOT_TOKEN: getValue('TELEGRAM_BOT_TOKEN'),
    MINIAPP_URL: getValue('MINIAPP_URL', 'http://localhost:3000'),
    PORT: Number(getValue('PORT', '3000')),
    VACANCY_POLL_INTERVAL_MS: Number(getValue('VACANCY_POLL_INTERVAL_MS', '180000')),
    RATE_LIMIT_WINDOW_MS: Number(getValue('RATE_LIMIT_WINDOW_MS', '60000')),
    RATE_LIMIT_MAX: Number(getValue('RATE_LIMIT_MAX', '20')),
    BAN_DURATION_MS: Number(getValue('BAN_DURATION_MS', '3600000')),
    WEBHOOK_PATH: '/telegram/webhook'
  };
}

module.exports = {
  loadEnv
};