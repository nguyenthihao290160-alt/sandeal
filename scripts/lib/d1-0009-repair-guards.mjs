import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalJson, sha256, sqlTokens } from './d1-schema-canonical.mjs';

export const incidentHead = '833ba419280edbe6d0e2e10abe07a50160762771';
export const incidentFile = 'docs/v6/evidence/phase10-d1-production-migration.json';
export const incidentSha256 = '83486a4b548c9d12c79f6706a300fb71726f038db483f4b8c3e65de2b984ab9b';
export const forensicDirectory = '.test-tmp/phase10-0009-forensics';
export const forensicArtifacts = [
  ['d1-stats.cjs', 'Ad hoc remote read-only incident statistics helper; never executed during this task.'],
  ['fix.py', 'One-off trigger replacement attempt, not a maintained migration tool.'],
  ['test_local_d1.mjs', 'Ad hoc disposable-D1 smoke test, superseded by the evidence harness.'],
  ['test_trigger.sql', 'Minimal standalone immutable-trigger parser reproduction.'],
  ['wrangler.production.toml', 'Untracked incident migration target configuration; not a deployment source.'],
  ['wrangler.test.toml', 'Isolated parser reproduction configuration pointing at .test-tmp/isolated.'],
  ['wrangler.test2.toml', 'Isolated parser reproduction configuration pointing at .test-tmp/isolated2.'],
  ['wrangler.test3.toml', 'Ad hoc parser reproduction configuration with a synthetic D1 ID.'],
  ['.test-tmp/isolated/0001_test.sql', 'Byte-identical copy of pre-repair 0009 renamed as the first isolated parser test migration.'],
  ['.test-tmp/bisect/0001_base.sql', 'Byte-identical copy of 0001 used as a forensic bisection baseline.'],
];
export const triggerRepairs = [
  { name: 'content_source_cap', predicate: '(SELECT count(*) FROM (SELECT content_id FROM content_lifecycle_sources WHERE product_id=NEW.product_id LIMIT 16))>=16', error: 'CONTENT_PRODUCT_CAP' },
  { name: 'content_audit_cap', predicate: '(SELECT audit_count FROM content_lifecycle_sources WHERE origin=NEW.origin AND content_id=NEW.content_id)>=256', error: 'CONTENT_AUDIT_CAP' },
];
export const legacyExpression = repair => `SELECT CASE WHEN ${repair.predicate} THEN RAISE(ABORT,'${repair.error}') END;`;
export const repairedExpression = repair => `SELECT RAISE(ABORT,'${repair.error}') WHERE ${repair.predicate};`;

export function parserCompatibilityGuard(sql) {
  const statements = sql.split('-- statement-breakpoint');
  for (const repair of triggerRepairs) {
    const matches = statements.filter(statement => {
      const tokens = sqlTokens(statement);
      return tokens[0]?.toUpperCase() === 'CREATE' && tokens[1]?.toUpperCase() === 'TRIGGER' && tokens[2] === repair.name;
    });
    assert.equal(matches.length, 1, `MISSING_OR_DUPLICATE_TRIGGER_${repair.name}`);
    const tokens = sqlTokens(matches[0]);
    const begin = tokens.findIndex(token => token.toUpperCase() === 'BEGIN');
    assert.ok(begin > 0);
    const body = tokens.slice(begin + 1);
    assert.ok(!body.some(token => token.toUpperCase() === 'CASE'), `REMOTE_PARSER_CASE_REGRESSION_${repair.name}`);
    assert.deepEqual(body, [...sqlTokens(repairedExpression(repair)), 'END', ';'], `CAP_POLICY_DRIFT_${repair.name}`);
  }
  return { status: 'PASS', triggers: triggerRepairs.map(repair => repair.name), forbiddenShape: 'CASE_WHEN_THEN_RAISE_END_INSIDE_TRIGGER',
    scope: 'LOCAL_STATIC_REGRESSION_GUARD_NOT_PROOF_OF_REMOTE_EXECUTION' };
}

export function auditRepair(root, manifest) {
  const hashes = manifest.map((source, position) => {
    const original = execFileSync('git', ['show', `${incidentHead}:${source.file}`], { cwd: root, windowsHide: true });
    const current = fs.readFileSync(path.join(root, source.file));
    assert.equal(sha256(current), source.sha256);
    if (position === 8) {
      let expected = original.toString('utf8');
      for (const repair of triggerRepairs) {
        assert.equal(expected.split(legacyExpression(repair)).length, 2);
        expected = expected.replace(legacyExpression(repair), repairedExpression(repair));
      }
      assert.deepEqual(current, Buffer.from(expected, 'utf8'), 'REPAIR_EXCEEDS_TWO_TRIGGER_EXPRESSIONS');
      assert.notEqual(sha256(original), source.sha256);
      parserCompatibilityGuard(current.toString('utf8'));
    } else assert.deepEqual(current, original, `UNEXPECTED_MIGRATION_CHANGE_${source.file}`);
    return { file: source.file, originalSha256: sha256(original), sha256: source.sha256, bytes: current.length,
      unchanged: current.equals(original), status: position === 8 ? 'CHANGED_AS_EXPECTED' : 'UNCHANGED' };
  });
  return { status: 'PASS', policySemanticsPreserved: 'PASS', comparisonHead: incidentHead, migrationHashes: hashes,
    changedTriggers: triggerRepairs, tableSemanticsChanged: false, columnDefinitionsChanged: false,
    constraintsWeakened: false, triggerPolicyWeakened: false, businessLogicRemoved: false,
    proof: 'Exact byte equality to incident HEAD after only the two enumerated expression replacements; predicates, ABORT messages and trigger WHEN clauses unchanged.' };
}

export function assertIncidentPreserved(root) {
  const bytes = fs.readFileSync(path.join(root, incidentFile));
  assert.equal(sha256(bytes), incidentSha256, 'HISTORICAL_INCIDENT_BYTES_CHANGED');
  const incident = JSON.parse(bytes);
  assert.equal(incident.status, 'FAIL');
  assert.deepEqual(incident.failedMigrations, ['0009_content_lifecycle.sql']);
  assert.equal(incident.appliedMigrations.length, 8);
  assert.equal(incident.gitHead, incidentHead);
  return { file: incidentFile, sha256: incidentSha256, bytes: bytes.length, status: 'HISTORICAL_FAIL_PRESERVED',
    firstAttemptStoppedAt: '0009_content_lifecycle.sql', productionReinspectedThisTask: false };
}

export function classifyArtifacts(root) {
  return forensicArtifacts.map(([file, reason]) => {
    const preservedAt = file.startsWith('.test-tmp/') ? file : `${forensicDirectory}/${file}.txt`;
    const location = fs.existsSync(path.join(root, file)) ? file : preservedAt;
    const bytes = fs.readFileSync(path.join(root, location));
    if (file.endsWith('0001_base.sql') || file.endsWith('0001_test.sql')) {
      const originalName = file.endsWith('0001_base.sql') ? '0001_product_storage.sql' : '0009_content_lifecycle.sql';
      const original = execFileSync('git', ['show', `${incidentHead}:src/lib/storage/d1/migrations/${originalName}`], { cwd: root, windowsHide: true });
      assert.deepEqual(bytes, original);
    }
    return { file, classification: 'TEMP_FORENSIC_ARTIFACT', reason, sha256: sha256(bytes), bytes: bytes.length,
      preservedAt, includeInCommit: false };
  });
}

export function partialBaselineModel(report) {
  const baseline = report.partialResumes.find(resume => resume.through === '0008_opportunity_experiments.sql');
  assert.ok(baseline);
  return { status: 'PASS', productionIsEmpty: false, accountId: '88d3839bee4ac092d39fbb293e3eb426',
    d1Id: 'bdf42c22-190d-4cdf-a166-a9e07ade57f2', d1Name: 'sandeal-production',
    appliedMigrations: report.migrationSources.slice(0, 8).map(source => path.basename(source.file)),
    pendingMigrations: report.migrationSources.slice(8).map(source => path.basename(source.file)),
    migration0009MetadataPresent: false, migration0010MetadataPresent: false,
    partial0009Tables: [], partial0009Indexes: [], partial0009Triggers: [], partial0009SchemaEffect: 'NONE',
    canonicalizationMethod: 'd1-schema-canonical-v1', schemaFingerprint: baseline.before.fingerprint,
    businessRows: 0, controlRows: baseline.before.data.controlRows,
    baselineCounts: baseline.before.counts, canonicalSchemaSha256: sha256(canonicalJson(baseline.before.canonicalSchema)),
    stateProvenance: 'USER_VERIFIED_INCIDENT_STATE_PLUS_LOCAL_REHEARSAL_NOT_A_FRESH_PRODUCTION_OBSERVATION',
    productionInspectedThisTask: false, requiresFreshReadOnlyProductionAudit: true };
}

export function validatePartialProductionObservation(observed, expected) {
  assert.equal(observed.readOnly, true);
  for (const field of ['accountId', 'd1Id', 'd1Name', 'appliedMigrations', 'pendingMigrations', 'migration0009MetadataPresent',
    'migration0010MetadataPresent', 'partial0009Tables', 'partial0009Indexes', 'partial0009Triggers', 'partial0009SchemaEffect',
    'canonicalizationMethod', 'schemaFingerprint', 'businessRows', 'controlRows', 'baselineCounts']) {
    assert.deepEqual(observed[field], expected[field], `PARTIAL_PRODUCTION_BASELINE_MISMATCH_${field}`);
  }
  return 'PASS';
}
