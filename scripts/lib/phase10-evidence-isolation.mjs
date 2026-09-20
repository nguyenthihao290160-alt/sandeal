import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '../..');
const output = path.join(root, '.test-tmp/phase10-preauth');
const originalWrite = fs.writeFileSync.bind(fs), originalMkdir = fs.mkdirSync.bind(fs);
const recorder = load('../v6-run-state.cjs');
let state = recorder.readState();
recorder.readState = () => structuredClone(state);
recorder.writeState = patch => { state = { ...state, ...patch }; return structuredClone(state); };
recorder.recordEvidence = (name, result) => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('INVALID_EVIDENCE_NAME');
  const target = path.join(output, 'regression-evidence', `${name}.json`);
  originalMkdir(path.dirname(target), { recursive: true });
  originalWrite(target, `${JSON.stringify(result, null, 2)}\n`);
  return path.relative(root, target).replaceAll('\\', '/');
};
fs.writeFileSync = (file, ...args) => {
  if (typeof file === 'string') {
    const relative = path.relative(root, path.resolve(file)).replaceAll('\\', '/');
    if (/^\.test-tmp\/phase\d+(?:-\d+)?\/[^/]+\.json$/.test(relative)) {
      const target = path.join(output, 'regression-reports', relative.slice('.test-tmp/'.length));
      originalMkdir(path.dirname(target), { recursive: true });
      return originalWrite(target, ...args);
    }
    if (relative.startsWith('docs/v6/')) throw new Error('PHASE10_HISTORICAL_EVIDENCE_WRITE_FORBIDDEN');
  }
  return originalWrite(file, ...args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(address.hostname)) throw new Error('PHASE10_EXTERNAL_FETCH_FORBIDDEN');
  return originalFetch(input, ...args);
};
