import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, captureSchema, checkConstraints, normalizeSql, sha256 } from './lib/d1-schema-canonical.mjs';
import { validateRehearsal } from './phase-10-d1-evidence-repair.mjs';
import { legacyExpression, parserCompatibilityGuard, partialBaselineModel, repairedExpression, triggerRepairs, validatePartialProductionObservation } from './lib/d1-0009-repair-guards.mjs';

const cases = [];
async function test(name, work) {
  try { await work(); cases.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, status: 'FAIL' }); console.error(`FAIL ${name}`, error); }
}
const adapter = (database, reverse = false) => ({
  prepare(sql) { return { async all() { const results = database.prepare(sql).all(); return { success: true, results: reverse ? results.reverse() : results }; } }; },
  async batch(statements) { return Promise.all(statements.map(statement => statement.all())); },
});

await test('canonical JSON sorts object keys but preserves array order and one LF', () => {
  assert.equal(canonicalJson({ second: 2, first: { zebra: 1, alpha: [2, 1] } }), '{"first":{"alpha":[2,1],"zebra":1},"second":2}\n');
  assert.throws(() => canonicalJson({ invalid: undefined }));
  assert.throws(() => canonicalJson({ invalid: Infinity }));
});
await test('SQL whitespace comments and punctuation normalize without changing tokens', () => {
  assert.equal(normalizeSql('CREATE TABLE sample(id INTEGER, value TEXT); -- comment\r\n'), normalizeSql('CREATE\r\nTABLE sample ( id INTEGER , /* ignored */ value TEXT ) ;'));
});
await test('literal whitespace escaping comments and newline remain significant', () => {
  assert.notEqual(normalizeSql("DEFAULT 'a  b'"), normalizeSql("DEFAULT 'a b'"));
  assert.equal(normalizeSql("SELECT 'a--b/*c*/', 'it''s', X'ABCD';"), "SELECT 'a--b/*c*/' , 'it''s' , X'ABCD' ;");
  assert.notEqual(normalizeSql("SELECT 'a\r\nb'"), normalizeSql("SELECT 'a\nb'"));
  assert.notEqual(normalizeSql('DEFAULT 1'), normalizeSql('DEFAULT 2'));
  assert.notEqual(normalizeSql('value > 1'), normalizeSql('value >= 1'));
});
await test('CHECK extraction honors nesting and ignores quoted CHECK text', () => {
  assert.deepEqual(checkConstraints("CREATE TABLE sample(value TEXT CHECK(length(value)>1 AND value<>'CHECK(no)'), other INTEGER CHECK(other IN (1,2)))"),
    ["length ( value ) > 1 AND value <> 'CHECK(no)'", 'other IN ( 1 , 2 )']);
});
await test('unsupported or malformed SQL and comments fail closed', () => {
  for (const sql of ["SELECT 'unterminated", 'SELECT /* missing end', 'SELECT "unclosed', 'SELECT [unclosed', 'SELECT #unsupported']) assert.throws(() => normalizeSql(sql));
  assert.throws(() => checkConstraints('CHECK((value > 1)'));
});

const database = new DatabaseSync(':memory:');
try {
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE parent(id TEXT PRIMARY KEY NOT NULL) WITHOUT ROWID;
    CREATE TABLE child(sequence INTEGER PRIMARY KEY AUTOINCREMENT,parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE,
      value TEXT NOT NULL DEFAULT 'a  b' CHECK(length(value)>0), doubled TEXT GENERATED ALWAYS AS (value||value) VIRTUAL);
    CREATE UNIQUE INDEX child_unique ON child(value COLLATE NOCASE DESC) WHERE parent_id IS NOT NULL;
    CREATE TABLE audit(value TEXT);
    CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit(value) VALUES(NEW.value); END;
    CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT,applied_at TEXT);
    CREATE TABLE _cf_KV(key TEXT,value TEXT);
    CREATE TABLE _cf_METADATA(key TEXT,value TEXT);`);
  const original = await captureSchema(adapter(database));
  await test('canonical schema includes columns defaults PK FK CHECK indexes and triggers', () => {
    const child = original.schema.tables.find(table => table.name === 'child');
    assert.equal(original.counts.tables, 3); assert.equal(original.counts.indexes, 1); assert.equal(original.counts.triggers, 1);
    assert.equal(child.columns.find(column => column.name === 'value').default, "'a  b'");
    assert.equal(child.columns.find(column => column.name === 'value').notNull, 1);
    assert.equal(child.columns.find(column => column.name === 'doubled').hidden, 2);
    assert.deepEqual(child.primaryKey, [{ ordinal: 1, name: 'sequence' }]);
    assert.equal(child.foreignKeys[0].table, 'parent'); assert.equal(child.foreignKeys[0].onDelete, 'CASCADE');
    assert.deepEqual(child.checks, ['length ( value ) > 0']);
    assert.equal(child.indexes[0].unique, 1); assert.equal(child.indexes[0].partial, 1);
    assert.equal(child.indexes[0].columns[0].descending, 1); assert.equal(child.indexes[0].columns[0].collation, 'NOCASE');
    assert.ok(original.schema.tables.find(table => table.name === 'parent').indexes.some(index => index.origin === 'pk'));
    assert.equal(original.bytes, Buffer.byteLength(canonicalJson(original.schema)));
  });
  await test('data timestamps sequence values and infrastructure cannot change schema hash', async () => {
    database.exec("INSERT INTO parent VALUES('fixture'); INSERT INTO child(parent_id) VALUES('fixture'); INSERT INTO d1_migrations(name,applied_at) VALUES('fixture','now'); INSERT INTO _cf_KV VALUES('location','fixture'); UPDATE sqlite_sequence SET seq=900;");
    assert.equal((await captureSchema(adapter(database))).sha256, original.sha256);
  });
  await test('schema and pragma row enumeration order cannot change fingerprint', async () => {
    const reversed = adapter(database, true);
    assert.deepEqual(await captureSchema(reversed), await captureSchema(adapter(database)));
  });
  await test('trigger body changes change fingerprint', async () => {
    database.exec("DROP TRIGGER child_audit; CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit(value) VALUES('changed'); END;");
    assert.notEqual((await captureSchema(adapter(database))).sha256, original.sha256);
  });
  await test('index uniqueness and predicates change fingerprint', async () => {
    const before = await captureSchema(adapter(database));
    database.exec('DROP INDEX child_unique; CREATE INDEX child_unique ON child(value COLLATE NOCASE DESC) WHERE parent_id IS NULL;');
    assert.notEqual((await captureSchema(adapter(database))).sha256, before.sha256);
  });
} finally { database.close(); }

const root = path.resolve(import.meta.dirname, '..');
const repairedSql = fs.readFileSync(path.join(root, 'src/lib/storage/d1/migrations/0009_content_lifecycle.sql'), 'utf8');
await test('0009 remote-parser compatibility guard accepts both repaired cap triggers', () => {
  assert.equal(parserCompatibilityGuard(repairedSql).status, 'PASS');
});
for (const repair of triggerRepairs) {
  await test(`parser guard rejects reintroduced CASE shape in ${repair.name}`, () => {
    assert.throws(() => parserCompatibilityGuard(repairedSql.replace(repairedExpression(repair), legacyExpression(repair))), /REMOTE_PARSER_CASE_REGRESSION/);
  });
  await test(`parser guard rejects commented multiline CASE shape in ${repair.name}`, () => {
    const expression = legacyExpression(repair).replace('CASE WHEN', 'case /* regression */\nwhen');
    assert.throws(() => parserCompatibilityGuard(repairedSql.replace(repairedExpression(repair), expression)), /REMOTE_PARSER_CASE_REGRESSION/);
  });
  await test(`parser guard rejects removed cap policy in ${repair.name}`, () => {
    assert.throws(() => parserCompatibilityGuard(repairedSql.replace(repairedExpression(repair), 'SELECT 1;')), /CAP_POLICY_DRIFT/);
  });
  await test(`parser guard rejects weakened threshold in ${repair.name}`, () => {
    assert.throws(() => parserCompatibilityGuard(repairedSql.replace(repairedExpression(repair), repairedExpression(repair).replace('>=', '>'))), /CAP_POLICY_DRIFT/);
  });
}
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/v6/evidence/phase10-d1-clean-install-rehearsal.json'), 'utf8'));
assert.equal(evidence.schema, 'phase10-d1-rehearsal-evidence-v3', 'FRESH_REHEARSAL_REQUIRED_FOR_VERIFIER_TESTS');
const fixture = structuredClone(evidence);
fixture.quality = { status: 'PASS', harnessManifestSha256: sha256(canonicalJson(fixture.harnessSources)),
  results: ['focused-tests', 'typescript', 'eslint', 'secret-scan', 'git-diff-check'].map(name => ({ name, exitCode: 0 })) };
function rebind(report) {
  delete report.evidenceBindingSha256;
  report.evidenceBindingSha256 = sha256(canonicalJson(report));
  return report;
}
rebind(fixture);
await test('verifier accepts consistent local run fixture with synthetic quality results', () => {
  validateRehearsal(fixture, evidence.migrationSources, evidence.harnessSources, evidence.sourceHead);
});
const mutations = [
  ['source hash drift', report => { report.migrationSources[0].sha256 = '0'.repeat(64); }],
  ['source byte length drift', report => { report.migrationSources[0].bytes++; }],
  ['source HEAD drift', report => { report.sourceHead = '0'.repeat(40); }],
  ['harness drift', report => { report.harnessSources[0].sha256 = '0'.repeat(64); }],
  ['method drift', report => { report.method.version = 'unknown'; }],
  ['canonical trigger drift', report => { report.canonicalSchema.triggers[0].sql += ' changed'; }],
  ['second install mismatch', report => { report.installs[1].schemaFingerprint = '0'.repeat(64); }],
  ['nonempty baseline', report => { report.installs[0].baseline.applicationObjects = 1; }],
  ['business seed', report => { report.installs[0].data.businessRows = 1; }],
  ['concealed business seed', report => { report.installs[0].data.perTable.find(item => item.table === 'products').rows = 1; }],
  ['invented inventory counts', report => { report.installs[0].counts.tables++; report.installs[1].counts.tables++; }],
  ['missing control seed', report => { report.installs[0].data.controlRows = []; }],
  ['submitted SQL batch drift', report => { report.installs[0].steps[0].submittedStatementsSha256 = '0'.repeat(64); }],
  ['missing migration', report => { report.installs[0].steps.pop(); }],
  ['unbound migration step', report => { report.installs[0].steps[0].sha256 = '0'.repeat(64); }],
  ['missing partial resume', report => { report.partialResumes.pop(); }],
  ['missing eight-migration partial baseline', report => { report.partialResumes = report.partialResumes.filter(resume => !resume.through.startsWith('0008')); }],
  ['pre-0009 fingerprint drift', report => { report.pre0009SchemaFingerprint = '0'.repeat(64); }],
  ['partial 0009 object concealed', report => { report.partialResumes[2].before.partial0009Objects.push({ type: 'table', name: 'content_lifecycle_sources' }); }],
  ['0009 metadata present in baseline', report => { report.partialResumes[2].before.migration0009MetadataPresent = true; }],
  ['partial baseline business seed', report => { report.partialResumes[2].before.data.businessRows = 1; }],
  ['historical fingerprint claimed current', report => { report.oldFingerprintComparison.authority = 'CURRENT'; }],
  ['empty-production model regression', report => { report.partialProductionBaselineModel.productionIsEmpty = true; }],
  ['cap policy check not executed', report => { report.constraints.repairedCapPolicies.audit255To256Allowed = false; }],
  ['incident evidence changed', report => { report.incidentEvidence.sha256 = '0'.repeat(64); }],
  ['resume reapplies committed migration', report => { report.partialResumes[0].resumeSteps[0].action = 'APPLIED'; }],
  ['failure ledger mutation', report => { report.failureAtomicity.after.ledger.pop(); }],
  ['failed rollback', report => { report.failureAtomicity.schemaRolledBack = false; }],
  ['Phase 5 side effect', report => { report.phase5SideEffectAudit.after[0].sha256 = '0'.repeat(64); }],
  ['quality failure', report => { report.quality.results[1].exitCode = 1; }],
  ['remote effect', report => { report.productionEffects.PRODUCTION_D1_MIGRATIONS = 1; }],
];
for (const [name, mutate] of mutations) {
  await test(`verifier rejects ${name} even with recalculated evidence digest`, () => {
    const changed = structuredClone(fixture); mutate(changed); rebind(changed);
    assert.throws(() => validateRehearsal(changed, evidence.migrationSources, evidence.harnessSources, evidence.sourceHead));
  });
}
await test('verifier rejects an invalid whole-evidence digest', () => {
  const changed = structuredClone(fixture); changed.evidenceBindingSha256 = '0'.repeat(64);
  assert.throws(() => validateRehearsal(changed, evidence.migrationSources, evidence.harnessSources, evidence.sourceHead));
});
const expectedBaseline = partialBaselineModel(evidence);
const observation = { ...structuredClone(expectedBaseline), readOnly: true };
await test('partial production model accepts an exact synthetic read-only observation, not authorization', () => {
  assert.equal(expectedBaseline.productionIsEmpty, false);
  assert.equal(validatePartialProductionObservation(observation, expectedBaseline), 'PASS');
});
for (const [name, mutate] of [
  ['wrong account', value => { value.accountId = 'wrong-account'; }],
  ['wrong D1', value => { value.d1Id = 'wrong-database'; }],
  ['empty production', value => { value.appliedMigrations = []; }],
  ['reordered history', value => { value.appliedMigrations.reverse(); }],
  ['unknown migration', value => { value.appliedMigrations.push('0011_unknown.sql'); }],
  ['0009 already applied', value => { value.migration0009MetadataPresent = true; }],
  ['0010 already applied', value => { value.migration0010MetadataPresent = true; }],
  ['partial table', value => { value.partial0009Tables.push('content_lifecycle_sources'); }],
  ['partial index', value => { value.partial0009Indexes.push('content_sources_product'); }],
  ['partial trigger', value => { value.partial0009Triggers.push('content_source_cap'); }],
  ['partial schema effect', value => { value.partial0009SchemaEffect = 'UNKNOWN'; }],
  ['wrong fingerprint', value => { value.schemaFingerprint = evidence.schemaFingerprint; }],
  ['wrong method', value => { value.canonicalizationMethod = 'unknown'; }],
  ['nonzero business rows', value => { value.businessRows = 1; }],
  ['missing control row', value => { value.controlRows = []; }],
  ['not read only', value => { value.readOnly = false; }],
]) {
  await test(`partial production model rejects ${name}`, () => {
    const changed = structuredClone(observation); mutate(changed);
    assert.throws(() => validatePartialProductionObservation(changed, expectedBaseline));
  });
}
const passed = cases.filter(testCase => testCase.status === 'PASS').length;
const failed = cases.length - passed;
console.log(`${passed} passed, ${failed} failed, 0 skipped`);
if (failed) process.exitCode = 1;
