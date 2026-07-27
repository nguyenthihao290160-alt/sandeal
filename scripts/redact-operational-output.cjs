/* eslint-disable @typescript-eslint/no-require-imports */
const readline = require('node:readline');

function redact(line) {
  return String(line)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_?token|token|api_?key|signature|secret|password|authorization)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/("(?:password|authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|credential|encryptedValue)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/\b((?:PASSWORD|AUTHORIZATION|API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|PRIVATE_KEY|TOKEN_VAULT_SECRET_KEY)=)[^\s]+/gi, '$1[REDACTED]')
    .slice(0, 4_000);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => process.stdout.write(`${redact(line)}\n`));
