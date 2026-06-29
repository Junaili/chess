const fs = require('node:fs');
const path = require('node:path');

// Minimal .env parser (no dotenv dependency). Loads KEY=VALUE pairs from
// .env.test at the repo root into process.env without overwriting anything
// already set in the real environment (so CI secrets win over the file).
function loadTestEnv() {
  const file = path.join(__dirname, '..', '..', '.env.test');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// Returns the live-test credentials, or null if the primary user isn't set.
// Live specs call this and skip themselves when it returns null, so the suite
// still runs (and passes) on a machine without test credentials.
function testCreds() {
  const user1 = process.env.TEST_USER_1_IDENTIFIER;
  const pass1 = process.env.TEST_USER_1_PASSWORD;
  if (!user1 || !pass1) return null;
  return {
    user1: { identifier: user1, password: pass1 },
    // Optional second account — only the two-player online match test needs it.
    user2: process.env.TEST_USER_2_IDENTIFIER && process.env.TEST_USER_2_PASSWORD
      ? { identifier: process.env.TEST_USER_2_IDENTIFIER, password: process.env.TEST_USER_2_PASSWORD }
      : null,
  };
}

module.exports = { loadTestEnv, testCreds };
