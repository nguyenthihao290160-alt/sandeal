import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const load = createRequire(import.meta.url), recorder = load('../v6-run-state.cjs');
const directory = path.join(recorder.root, '.test-tmp/phase9-5/legacy-evidence');
let state = recorder.readState();
recorder.writeState = patch => { state = { ...state, ...patch }; return structuredClone(state); };
recorder.readState = () => structuredClone(state);
recorder.recordEvidence = (name, result) => {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('EVIDENCE_NAME_INVALID');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${name}.json`);
  fs.writeFileSync(target, JSON.stringify({ ...result, recordedFor: 'PHASE9_5_REGRESSION_ONLY' }, null, 2) + '\n');
  return path.relative(recorder.root, target).replaceAll('\\', '/');
};
