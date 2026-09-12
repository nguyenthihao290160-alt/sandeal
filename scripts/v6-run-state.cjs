/* eslint-disable @typescript-eslint/no-require-imports */
// Generated evidence contains paths and SHA-256 hashes only, never file contents.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const statePath = path.join(root, 'docs/v6/LONG_RUN_STATE.json');
const evidenceRoot = path.join(root, 'docs/v6/evidence');
const hash = value => createHash('sha256').update(value).digest('hex');
function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
function fingerprint() {
  const names = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0'))]
    .filter(name => name && name !== 'docs/v6/LONG_RUN_STATE.json' && !name.startsWith('docs/v6/evidence/'))
    .filter(name => !/(^|\/)\.env(\.|$)/.test(name) || name === '.env.example').sort();
  const files = Object.fromEntries(names.map(name => [name, fs.existsSync(path.join(root, name)) ? hash(fs.readFileSync(path.join(root, name))) : 'DELETED']));
  return { sha256: hash(JSON.stringify(files)), files };
}
function readState() { return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {}; }
function writeState(patch) {
  const previous = readState(), current = fingerprint();
  const initialPath = path.join(evidenceRoot, 'resume-3-baseline.json');
  fs.mkdirSync(evidenceRoot, { recursive: true });
  if (!fs.existsSync(initialPath)) fs.writeFileSync(initialPath, JSON.stringify(current, null, 2), { flag: 'wx' });
  const baseline = JSON.parse(fs.readFileSync(initialPath, 'utf8')).files;
  const changes = [...new Set([...Object.keys(baseline), ...Object.keys(current.files)])].filter(name => baseline[name] !== current.files[name]);
  const state = { program: 'SANDEAL_V6_RESUME_LONG_RUN_3', currentPhase: 'RECONSTRUCT', currentStep: 'Inspect persisted evidence', result: 'IN_PROGRESS',
    completedCheckpoints: [], verifiedTestEvidence: [], nextStep: 'Revalidate only unproven affected checks', blockers: [], ...previous, ...patch,
    branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'), workingTreeFingerprint: current.sha256,
    workingTreeFingerprintPolicy: 'SHA256 of sorted Git tracked and nonignored untracked path/content hashes; excludes this generated state, evidence, and secret environment files',
    filesChangedSinceEvidence: changes, filesChangedSinceEvidenceBaseline: 'docs/v6/evidence/resume-3-baseline.json', updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  return state;
}
function recordEvidence(name, result) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('EVIDENCE_NAME_INVALID');
  const manifest = fingerprint();
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const relative = `docs/v6/evidence/${name}.json`;
  fs.writeFileSync(path.join(root, relative), JSON.stringify({ capturedAt: new Date().toISOString(), ...result, manifest }, null, 2) + '\n');
  const previous = readState();
  writeState({ verifiedTestEvidence: [...(previous.verifiedTestEvidence || []).filter(item => item.name !== name), { name, path: relative, ...result }] });
  return relative;
}
if (require.main === module) {
  const [phase, step, result = 'IN_PROGRESS', nextStep = 'Continue current phase'] = process.argv.slice(2);
  const previous = readState();
  const state = writeState({ ...(phase ? { currentPhase: phase, currentStep: step, result, nextStep } : {}),
    ...(result === 'PASS' ? { completedCheckpoints: [...new Set([...(previous.completedCheckpoints || []), `${phase}: ${step}`])] } : {}) });
  console.log(JSON.stringify({ phase: state.currentPhase, step: state.currentStep, result: state.result, fingerprint: state.workingTreeFingerprint }));
}
module.exports = { root, hash, fingerprint, readState, writeState, recordEvidence };
