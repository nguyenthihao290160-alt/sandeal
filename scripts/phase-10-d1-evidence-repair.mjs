import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { METHOD_VERSION, batchRows, canonicalJson, captureSchema, compareText, includedObject, normalizeSql, quoteIdentifier, rows, sha256, sqlTokens } from './lib/d1-schema-canonical.mjs';
import { assertIncidentPreserved, auditRepair, classifyArtifacts, forensicDirectory, incidentFile, incidentHead, legacyExpression, partialBaselineModel, parserCompatibilityGuard, repairedExpression, triggerRepairs } from './lib/d1-0009-repair-guards.mjs';

const root = path.resolve(import.meta.dirname, '..');
const scratch = '.test-tmp/phase10-d1-evidence-repair';
const rehearsalFile = 'docs/v6/evidence/phase10-d1-clean-install-rehearsal.json';
const preauthFile = 'docs/v6/evidence/phase10-d1-production-migration-preauth.json';
const methodFile = 'docs/v6/phase-10-d1-schema-fingerprint.md';
const migrationDirectory = 'src/lib/storage/d1/migrations';
const names = ['0001_product_storage.sql', '0002_event_jobs.sql', '0003_affiliate_money.sql', '0004_money_snapshot_jobs.sql',
  '0005_money_platform.sql', '0006_deal_intelligence.sql', '0007_decision_os.sql', '0008_opportunity_experiments.sql',
  '0009_content_lifecycle.sql', '0010_execution_control_plane.sql'];
const repairFiles = [rehearsalFile, preauthFile, methodFile, 'scripts/lib/d1-schema-canonical.mjs',
  'scripts/phase-10-d1-evidence-repair.mjs', 'scripts/phase-10-d1-evidence-tests.mjs',
  'scripts/lib/d1-0009-repair-guards.mjs', `${migrationDirectory}/${names[8]}`, incidentFile];
const harnessFiles = [...repairFiles.filter(file => ![rehearsalFile, preauthFile, incidentFile, `${migrationDirectory}/${names[8]}`].includes(file)), 'package.json', 'package-lock.json',
  'scripts/lib/local-d1.cjs', 'scripts/release-validation.cjs', 'tsconfig.json', 'eslint.config.mjs'].sort(compareText);
const phase5Files = ['docs/v6/evidence/phase5-accesstrade-shopee-proof.json', 'docs/v6/evidence/phase5-local-money-proof.json'];
const effects = Object.fromEntries(['PRODUCTION_D1_MIGRATIONS', 'PRODUCTION_D1_SCHEMA_MUTATIONS', 'PRODUCTION_D1_BUSINESS_DATA_MUTATIONS',
  'PRODUCTION_D1_NEW_MIGRATIONS', 'PRODUCTION_D1_ADDITIONAL_SCHEMA_MUTATIONS',
  'PRODUCTION_RESOURCE_CREATED', 'PRODUCTION_RESOURCE_MODIFIED', 'PRODUCTION_RESOURCE_DELETED', 'CLOUDFLARE_DEPLOYMENTS',
  'QUEUE_MESSAGES_SENT', 'DNS_CHANGES', 'PRODUCTION_TRAFFIC_SHIFT', 'PRODUCTION_SECRET_WRITES'].map(name => [name, 0]));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
};
const digestFile = file => {
  const bytes = fs.readFileSync(path.join(root, file));
  return { file, sha256: sha256(bytes), bytes: bytes.length };
};
const harnessManifest = () => harnessFiles.map(digestFile);
const digest = value => sha256(canonicalJson(value));

function loadMigrations() {
  assert.deepEqual(fs.readdirSync(path.join(root, migrationDirectory)).filter(name => name.endsWith('.sql')).sort(compareText), names, 'MIGRATION_SEQUENCE_INVALID');
  const scripts = names.map(name => {
    const file = `${migrationDirectory}/${name}`, bytes = fs.readFileSync(path.join(root, file));
    const sql = bytes.toString('utf8');
    assert.deepEqual(Buffer.from(sql, 'utf8'), bytes, 'MIGRATION_INVALID_UTF8');
    const statements = sql.split('-- statement-breakpoint').map(statement => statement.trim()).filter(statement => statement && !/^--[^\n]*$/.test(statement));
    assert.ok(statements.length > 0);
    return { name, file, sha256: sha256(bytes), bytes: bytes.length, statements,
      statementCount: statements.length, submittedStatementsSha256: digest(statements) };
  });
  return { scripts, manifest: scripts.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })) };
}

function changedFiles() {
  const entries = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return entries.map(entry => { assert.ok(!/^[RC]|^.[RC]/.test(entry), 'RENAME_NOT_ALLOWED'); return entry.slice(3).replaceAll('\\', '/'); }).sort(compareText);
}

function captureGate() {
  assert.ok(changedFiles().every(file => repairFiles.includes(file)), 'UNCLASSIFIED_DIRTY_FILES');
  const stagedFiles = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
  assert.ok(stagedFiles.every(file => file === incidentFile), 'UNRELATED_STAGED_FILES');
  git('diff', '--check'); git('diff', '--cached', '--check');
  const gate = { observedAt: new Date().toISOString(), branch: git('branch', '--show-current'), head: git('rev-parse', 'HEAD'),
    worktreeClean: changedFiles().length === 0, indexClean: stagedFiles.length === 0, status: git('status', '--short'),
    stagedFiles, indexDiffSha256: sha256(execFileSync('git', ['diff', '--cached', '--binary'], { cwd: root })),
    diffCheck: 'PASS', node: process.version, artifactClassification: classifyArtifacts(root),
    classifiedDirtyFiles: changedFiles().map(file => ({ ...digestFile(file), classification: 'REQUIRED_SOURCE',
      reason: file === incidentFile ? 'Preserve staged historical failed production attempt unchanged.' : 'Local repair, reproducible tests or durable authorization evidence.' })),
    unrelatedDirtyFiles: [], incident: assertIncidentPreserved(root), repairAudit: auditRepair(root, loadMigrations().manifest),
    migrationSources: loadMigrations().manifest, phase5: phase5Files.map(digestFile),
    priorEvidence: [rehearsalFile, preauthFile].map(file => ({ ...digestFile(file), authority: 'HISTORICAL_ONLY_INVALIDATED_BY_0009_REPAIR',
      outcome: readJson(file).outcome ?? readJson(file).auditStatus, schemaFingerprint: readJson(file).schemaFingerprint ?? null })) };
  writeJson(`${scratch}/initial-gate.json`, gate);
  console.log('CLASSIFIED_DIRTY_REPAIR_GATE=PASS INCIDENT_INDEX_PRESERVED=YES INITIAL_GATE_CAPTURED=YES');
}

function checkWorkspace(gate, manifest) {
  assert.deepEqual(gate.unrelatedDirtyFiles, []); assert.equal(gate.diffCheck, 'PASS');
  assert.equal(git('rev-parse', 'HEAD'), gate.head, 'HEAD_DRIFT');
  assert.equal(git('branch', '--show-current'), gate.branch, 'BRANCH_DRIFT');
  assert.equal(sha256(execFileSync('git', ['diff', '--cached', '--binary'], { cwd: root })), gate.indexDiffSha256, 'INDEX_CHANGED');
  assert.deepEqual(assertIncidentPreserved(root), gate.incident);
  assert.deepEqual(classifyArtifacts(root), gate.artifactClassification);
  assert.deepEqual(auditRepair(root, manifest), gate.repairAudit);
  assert.deepEqual(loadMigrations().manifest, manifest, 'MIGRATION_SOURCE_DRIFT');
  assert.deepEqual(manifest, gate.migrationSources, 'INITIAL_SOURCE_DRIFT');
  assert.deepEqual(phase5Files.map(digestFile), gate.phase5, 'PHASE5_EVIDENCE_DRIFT');
  const changed = changedFiles();
  assert.ok(changed.every(file => repairFiles.includes(file)), `UNRELATED_DIRTY_FILES:${changed.filter(file => !repairFiles.includes(file)).join(',')}`);
  return changed;
}

async function ledger(database) {
  if (!(await rows(database, "SELECT name FROM sqlite_schema WHERE name='d1_migrations' AND type='table'")).length) return [];
  return rows(database, 'SELECT id,name FROM d1_migrations ORDER BY id');
}

async function dataSummary(database, schema, expectEmpty = true) {
  const counts = await batchRows(database, schema.tables.map(table => `SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}`));
  const perTable = schema.tables.map((table, position) => ({ table: table.name, rows: counts[position][0].count }));
  const controlRows = schema.tables.some(table => table.name === 'affiliate_revenue_cursor')
    ? await rows(database, 'SELECT id,last_sequence,claim_key FROM affiliate_revenue_cursor ORDER BY id') : [];
  if (controlRows.length || schema.tables.some(table => table.name === 'affiliate_revenue_cursor')) {
    assert.deepEqual(controlRows, [{ id: 'revenue-v1', last_sequence: 0, claim_key: null }], 'CONTROL_SEED_DRIFT');
  }
  const businessRows = perTable.filter(table => table.table !== 'affiliate_revenue_cursor').reduce((sum, table) => sum + table.rows, 0);
  if (expectEmpty) assert.equal(businessRows, 0, 'UNEXPECTED_BUSINESS_SEED');
  return { businessRows, perTable, controlRows, controlRowCount: controlRows.length };
}

async function apply(database, sources, through = 10, expectEmpty = true) {
  const existing = await ledger(database);
  assert.deepEqual(existing.map(row => row.name), names.slice(0, existing.length), 'LEDGER_NOT_EXACT_PREFIX');
  assert.ok(existing.length <= through, 'RESUME_BASELINE_INVALID');
  await database.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)').run();
  const steps = [];
  for (const [position, source] of sources.scripts.slice(0, through).entries()) {
    const prior = existing.some(row => row.name === source.name);
    if (!prior) await database.batch([...source.statements.map(statement => database.prepare(statement)),
      database.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(source.name)]);
    const currentLedger = await ledger(database);
    if (!prior) assert.deepEqual(currentLedger.map(row => row.name), names.slice(0, position + 1));
    const snapshot = prior ? null : await captureSchema(database);
    const foreignKeyViolations = prior ? [] : await rows(database, 'PRAGMA foreign_key_check');
    assert.deepEqual(foreignKeyViolations, []);
    steps.push({ file: source.file, sha256: source.sha256, bytes: source.bytes, action: prior ? 'ALREADY_APPLIED' : 'APPLIED',
      statementCount: source.statementCount, submittedStatementsSha256: source.submittedStatementsSha256,
      ...(snapshot ? { schemaFingerprint: snapshot.sha256, counts: snapshot.counts, ledger: currentLedger,
        foreignKeyViolations, data: await dataSummary(database, snapshot.schema, expectEmpty) } : {}) });
    if (!prior) console.log(`LOCAL_APPLIED=${source.name} TABLES=${snapshot.counts.tables} INDEXES=${snapshot.counts.indexes} TRIGGERS=${snapshot.counts.triggers}`);
  }
  assert.deepEqual(loadMigrations().manifest, sources.manifest, 'MIGRATION_SOURCE_DRIFT_DURING_APPLY');
  return steps;
}

async function structuralChecks(database, snapshot) {
  assert.equal((await rows(database, 'PRAGMA foreign_keys'))[0].foreign_keys, 1, 'FOREIGN_KEYS_DISABLED');
  const violations = await rows(database, 'PRAGMA foreign_key_check'); assert.deepEqual(violations, []);
  const integrity = await rows(database, 'PRAGMA quick_check');
  assert.deepEqual(integrity.map(row => Object.values(row)[0]), ['ok']);
  const tables = new Map(snapshot.schema.tables.map(table => [table.name, table]));
  let foreignKeys = 0, indexes = 0, compiledStatements = 0;
  const compilationQueries = [];
  for (const table of tables.values()) {
    const columns = new Set(table.columns.map(column => column.name));
    for (const foreign of table.foreignKeys) {
      const parent = tables.get(foreign.table); assert.ok(parent, 'FOREIGN_TABLE_MISSING');
      for (const column of foreign.columns) {
        assert.ok(columns.has(column.from), 'FOREIGN_SOURCE_COLUMN_MISSING');
        if (column.to !== null) assert.ok(parent.columns.some(parentColumn => parentColumn.name === column.to), 'FOREIGN_TARGET_COLUMN_MISSING');
      }
      foreignKeys++;
    }
    for (const index of table.indexes) {
      assert.ok(index.columns.some(column => column.key === 1), 'INDEX_KEY_MISSING');
      for (const column of index.columns.filter(column => column.cid >= 0)) {
        assert.ok(table.columns.some(tableColumn => tableColumn.cid === column.cid && tableColumn.name === column.name), 'INDEX_COLUMN_MISSING');
      }
      indexes++;
    }
    const identifier = quoteIdentifier(table.name);
    const assignments = table.columns.filter(column => column.hidden === 0).map(column => `${quoteIdentifier(column.name)}=${quoteIdentifier(column.name)}`).join(',');
    for (const statement of [`INSERT INTO ${identifier} DEFAULT VALUES`, `UPDATE ${identifier} SET ${assignments} WHERE 0`, `DELETE FROM ${identifier} WHERE 0`]) {
      compilationQueries.push(`EXPLAIN ${statement}`); compiledStatements++;
    }
  }
  await batchRows(database, compilationQueries, 16);
  const triggerReferences = [];
  for (const trigger of snapshot.schema.triggers) {
    const table = tables.get(trigger.table); assert.ok(table, 'TRIGGER_OWNER_MISSING');
    const tokens = sqlTokens(trigger.sql);
    const update = tokens.findIndex(token => token.toUpperCase() === 'UPDATE');
    const updateOfColumns = [];
    if (update >= 0 && tokens[update + 1]?.toUpperCase() === 'OF') {
      for (let position = update + 2; position < tokens.length && tokens[position].toUpperCase() !== 'ON'; position++) {
        if (tokens[position] === ',') continue;
        const column = tokens[position].replace(/^["`\[]|["`\]]$/g, '');
        assert.ok(table.columns.some(item => item.name === column), 'TRIGGER_UPDATE_COLUMN_MISSING'); updateOfColumns.push(column);
      }
    }
    triggerReferences.push({ name: trigger.name, owner: trigger.table, updateOfColumns, compilation: 'PASS' });
  }
  for (const name of ['affiliate_money_events', 'affiliate_commission_events', 'affiliate_commissions', 'execution_proposals',
    'execution_approvals', 'execution_jobs', 'execution_receipts', 'execution_controls', 'execution_contexts', 'rollback_plans', 'execution_commit_guards']) {
    assert.ok(tables.has(name), `REQUIRED_TABLE_MISSING_${name}`);
  }
  const indexNames = new Set(snapshot.schema.tables.flatMap(table => table.indexes.map(index => index.name)));
  for (const name of ['products_status_id', 'product_source_identity_unique', 'execution_jobs_due', 'execution_approval_active',
    'execution_receipt_semantic', 'execution_rollback_receipt']) assert.ok(indexNames.has(name), `REQUIRED_INDEX_MISSING_${name}`);
  for (const table of ['affiliate_money_events', 'affiliate_commission_events', 'affiliate_conversions', 'affiliate_clicks']) {
    for (const operation of ['update', 'delete']) assert.ok(snapshot.schema.triggers.some(trigger => trigger.name === `${table}_immutable_${operation}`));
  }
  const queryPlans = [];
  for (const [sql, values] of [
    ['SELECT id FROM execution_jobs WHERE environment=? AND status=? AND available_at<=? ORDER BY available_at,id LIMIT 10', ['LOCAL', 'PENDING', 0]],
    ['SELECT sequence FROM affiliate_money_events WHERE effect_key=? LIMIT 1', ['fixture-only']],
  ]) {
    const plans = await rows(database, `EXPLAIN QUERY PLAN ${sql}`, values);
    assert.ok(plans.some(row => /SEARCH.*INDEX/.test(row.detail))); assert.ok(plans.every(row => !/\bSCAN\b/.test(row.detail)));
    queryPlans.push({ sql, details: plans.map(row => row.detail) });
  }
  return { status: 'PASS', foreignKeyCheck: 'PASS', constraintDefinitions: 'PASS', indexCheck: 'PASS', triggerCheck: 'PASS',
    moneyLedgerSchema: 'PASS', executionControlSchema: 'PASS', foreignKeys, indexes, compiledStatements,
    quickCheck: 'ok', fullIntegrityCheck: 'UNAVAILABLE_D1_AUTHORIZER_USE_QUICK_CHECK_AND_EXPLICIT_INDEX_PROBES',
    foreignKeyViolations: violations, triggerReferences, queryPlans };
}

const timestamp = '2026-09-21T00:00:00.000Z';
const productSql = `INSERT INTO products(id,slug,status,revision,token,created_at,updated_at,payload,identities)
  VALUES('probe-product','probe-product','draft',1,'${'a'.repeat(64)}','${timestamp}','${timestamp}','{}','[]')`;
const proposalSql = `INSERT INTO execution_proposals(id,origin,proposal_type,capability,source_subsystem,source_record_id,environment,execution_mode,
  risk_level,reason_codes,evidence_refs,policy_version,algorithm_version,requested_at,expires_at,approval_requirement,rollback_requirement,evidence_fingerprint)
  VALUES('probe-proposal','TEST_FIXTURE','LOCAL_PROBE','READ_ONLY','LOCAL_PROBE','probe-product','LOCAL','SHADOW','READ_ONLY','[]','[]','fixture','fixture',0,1,'REQUIRED','NOT_POSSIBLE','fixture')`;
const moneyFixture = [productSql,
  `INSERT INTO affiliate_clicks(id,product_id,offer_id,provider,merchant_id,currency,created_at,attribution_reference,attribution_transport,origin,payload,platform)
    VALUES('probe-click','probe-product','probe-offer','accesstrade','fixture','VND','${timestamp}','probe-click','UNAVAILABLE','TEST_FIXTURE','{}','shopee')`,
  `INSERT INTO affiliate_conversions(provider,external_id,event_id,click_id,occurred_at,fingerprint,origin)
    VALUES('accesstrade','probe-conversion','probe-conversion-event','probe-click','${timestamp}','fixture','TEST_FIXTURE')`,
  `INSERT INTO affiliate_commission_events(provider,event_id,external_id,conversion_id,revision,state,amount_minor,currency,occurred_at,fingerprint,origin)
    VALUES('accesstrade','probe-commission-event','probe-commission','probe-conversion',1,'PENDING',100,'VND','${timestamp}','fixture','TEST_FIXTURE')`];

async function constraintProbes(database, snapshot) {
  const checks = [];
  const invalid = [
    ['not-null', [`INSERT INTO system_settings(id,updated_at,payload) VALUES(NULL,'${timestamp}','{}')`], /NOT NULL constraint failed/],
    ['check-status', [productSql.replace("'draft'", "'invalid'")], /CHECK constraint failed/],
    ['json-validity', [`INSERT INTO system_settings(id,updated_at,payload) VALUES('scheduler','${timestamp}','not-json')`], /CHECK constraint failed/],
    ['unique', [`INSERT INTO system_settings(id,updated_at,payload) VALUES('scheduler','${timestamp}','{}')`,
      `INSERT INTO system_settings(id,updated_at,payload) VALUES('scheduler','${timestamp}','{}')`], /UNIQUE constraint failed/],
    ['foreign-key', ["INSERT INTO execution_contexts(proposal_id,payload) VALUES('missing-proposal','{}')"], /FOREIGN KEY constraint failed/],
    ['execution-environment', [proposalSql, `INSERT INTO execution_jobs(id,proposal_id,proposal_fingerprint,environment,status,available_at,expires_at,dispatch_at)
      VALUES('probe-job','probe-proposal','fixture','PRODUCTION','PENDING',0,1,0)`], /CHECK constraint failed/],
    ['execution-mode', [proposalSql.replace("'SHADOW'", "'LIVE'")], /CHECK constraint failed/],
    ['execution-commit-guard', ["INSERT INTO execution_commit_guards(id,valid) VALUES('probe',0)"], /CHECK constraint failed/],
    ['money-amount', [...moneyFixture.slice(0, -1), moneyFixture.at(-1).replace("'PENDING',100", "'PENDING',-1")], /CHECK constraint failed/],
  ];
  for (const table of ['affiliate_money_events', 'affiliate_commission_events', 'affiliate_conversions', 'affiliate_clicks']) {
    for (const operation of ['UPDATE', 'DELETE']) {
      const column = table === 'affiliate_money_events' ? 'amount_minor' : table === 'affiliate_commission_events' ? 'revision' : table === 'affiliate_conversions' ? 'fingerprint' : 'merchant_id';
      invalid.push([`${table}-${operation.toLowerCase()}-immutable`, [...moneyFixture,
        operation === 'UPDATE' ? `UPDATE ${table} SET ${column}=${column}` : `DELETE FROM ${table}`], /IMMUTABLE_MONEY_EVIDENCE/]);
    }
  }
  for (const [name, statements, expected] of invalid) {
    await assert.rejects(() => database.batch(statements.map(statement => database.prepare(statement))), expected);
    assert.equal((await dataSummary(database, snapshot.schema)).businessRows, 0);
    checks.push({ name, status: 'PASS', expectedError: expected.source, batchRolledBack: true });
  }
  await database.batch([...moneyFixture, proposalSql, "INSERT INTO execution_contexts(proposal_id,payload) VALUES('probe-proposal','{}')"].map(statement => database.prepare(statement)));
  assert.equal((await rows(database, 'SELECT COUNT(*) AS count FROM affiliate_money_events'))[0].count, 3);
  assert.deepEqual(await rows(database, 'SELECT state,amount_minor FROM affiliate_commissions'), [{ state: 'PENDING', amount_minor: 100 }]);
  assert.equal((await rows(database, 'SELECT COUNT(*) AS count FROM execution_contexts'))[0].count, 1);
  const sourceInsert = contentId => database.prepare('INSERT INTO content_lifecycle_sources(origin,content_id,product_id,intent,token,entity) VALUES(?,?,?,?,?,?)')
    .bind('TEST_FIXTURE', contentId, 'probe-product', 'fixture', 'fixture', '{}');
  await database.batch(Array.from({ length: 15 }, (_, ordinal) => sourceInsert(`cap-source-${ordinal}`)));
  await sourceInsert('cap-source-15').run();
  await assert.rejects(() => sourceInsert('cap-source-16').run(), /CONTENT_PRODUCT_CAP/);
  await database.prepare("INSERT INTO content_lifecycle_sources(origin,content_id,product_id,intent,token,entity) VALUES('TEST_FIXTURE','cap-source-15','probe-product','fixture','fixture','{}') ON CONFLICT(origin,content_id) DO NOTHING").run();
  assert.equal((await rows(database, 'SELECT COUNT(*) AS count FROM content_lifecycle_sources'))[0].count, 16);
  const auditInsert = ordinal => database.prepare('INSERT INTO content_lifecycle_audit(id,origin,content_id,fingerprint,algorithm_version,created_at,execution_mode,payload) VALUES(?,?,?,?,?,?,?,?)')
    .bind(`cap-audit-${ordinal}`, 'TEST_FIXTURE', 'cap-source-0', `fingerprint-${ordinal}`, 'fixture', ordinal, 'SHADOW', '{"plan":{"productionAllowed":false}}');
  for (let offset = 0; offset < 255; offset += 64) {
    await database.batch(Array.from({ length: Math.min(64, 255 - offset) }, (_, ordinal) => auditInsert(offset + ordinal)));
  }
  await auditInsert(255).run();
  await assert.rejects(() => auditInsert(256).run(), /CONTENT_AUDIT_CAP/);
  assert.equal((await rows(database, 'SELECT COUNT(*) AS count FROM content_lifecycle_audit'))[0].count, 256);
  assert.equal((await rows(database, "SELECT audit_count FROM content_lifecycle_sources WHERE content_id='cap-source-0'"))[0].audit_count, 256);
  assert.deepEqual(await rows(database, 'PRAGMA foreign_key_check'), []);
  return { status: 'PASS', checks, positiveMoneyProjection: { status: 'PASS', moneyEvents: 3, commissionAmountMinor: 100 },
    repairedCapPolicies: { status: 'PASS', source15To16Allowed: true, source17Rejected: 'CONTENT_PRODUCT_CAP', duplicateSourceAtCapAllowed: true,
      audit255To256Allowed: true, audit257Rejected: 'CONTENT_AUDIT_CAP', sourceRows: 16, auditRows: 256, auditCounter: 256 },
    positiveExecutionContext: 'PASS', fixtureScope: 'SEPARATE_DISPOSABLE_LOCAL_DATABASE_ONLY',
    finalFixtureBusinessRows: (await dataSummary(database, snapshot.schema, false)).businessRows };
}

async function runRehearsals(sources) {
  for (const name of Object.keys(process.env)) {
    if (/CLOUDFLARE|^CF_|SHOPEE|ACCESS_TRADE|GEMINI|OPENAI|ANTHROPIC|MONGODB|(?:TOKEN|PASSWORD|SECRET|API_KEY)|^SANDEAL_|^NODE_OPTIONS$/i.test(name)) delete process.env[name];
  }
  Object.assign(process.env, { WRANGLER_SEND_METRICS: 'false', NEXT_TELEMETRY_DISABLED: '1', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false' });
  let externalNetworkAttempts = 0, databasesCreated = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, ...args) => {
    const address = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname)) { externalNetworkAttempts++; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); }
    return originalFetch(input, ...args);
  };
  try {
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    async function withDatabase(work) {
      const instance = new Miniflare(convertV4MiniflareOptions({ name: 'phase10-evidence-local', host: '127.0.0.1', port: 0,
        modules: true, script: 'export default {fetch() {return new Response("local-only");}}', compatibilityDate: '2026-09-08',
        d1Databases: ['DB'], d1Persist: false,
        outboundService: () => { externalNetworkAttempts++; throw new Error('WORKER_OUTBOUND_FORBIDDEN'); } }));
      databasesCreated++;
      try {
        const database = await instance.getD1Database('DB');
        const raw = await rows(database, 'SELECT type,name,tbl_name FROM sqlite_schema');
        assert.deepEqual(raw.filter(includedObject), [], 'BASELINE_NOT_EMPTY');
        assert.deepEqual(await ledger(database), [], 'BASELINE_LEDGER_PRESENT');
        assert.ok(!raw.some(row => row.name === 'd1_migrations'));
        return await work(database, { status: 'EMPTY', applicationObjects: 0, migrationLedgerPresent: false,
          excludedInfrastructure: raw.map(row => ({ type: row.type, name: row.name })).sort((left, right) => compareText(left.name, right.name)) });
      } finally { await instance.dispose(); }
    }
    const installs = [];
    let canonicalSchema;
    for (const id of ['A', 'B']) {
      console.log(`LOCAL_CLEAN_INSTALL_${id}=RUNNING`);
      installs.push(await withDatabase(async (database, baseline) => {
        const startedAt = new Date().toISOString();
        const steps = await apply(database, sources);
        const snapshot = await captureSchema(database);
        const checks = await structuralChecks(database, snapshot);
        const data = await dataSummary(database, snapshot.schema);
        if (canonicalSchema) assert.deepEqual(snapshot.schema, canonicalSchema, 'A_B_CANONICAL_SCHEMA_MISMATCH');
        else canonicalSchema = snapshot.schema;
        return { id, status: 'PASS', startedAt, finishedAt: new Date().toISOString(), baseline, sourceManifestSha256: digest(sources.manifest),
          steps, appliedMigrations: (await ledger(database)).map(row => row.name), schemaFingerprint: snapshot.sha256,
          canonicalBytes: snapshot.bytes, counts: snapshot.counts, data, checks };
      }));
    }
    assert.equal(installs[0].schemaFingerprint, installs[1].schemaFingerprint);
    const partialResumes = [];
    for (const through of [3, 6, 8, 9]) {
      console.log(`LOCAL_PARTIAL_RESUME_${String(through).padStart(4, '0')}=RUNNING`);
      partialResumes.push(await withDatabase(async (database, baseline) => {
        const prefixSteps = await apply(database, sources, through);
        const prefixSchema = await captureSchema(database);
        const before = { ledger: await ledger(database), fingerprint: prefixSchema.sha256,
          ...(through === 8 ? { canonicalSchema: prefixSchema.schema, counts: prefixSchema.counts,
            data: await dataSummary(database, prefixSchema.schema), foreignKeyViolations: await rows(database, 'PRAGMA foreign_key_check'),
            quickCheck: await rows(database, 'PRAGMA quick_check'), migration0009MetadataPresent: false, migration0010MetadataPresent: false,
            partial0009Objects: (await rows(database, 'SELECT type,name FROM sqlite_schema')).filter(object =>
              object.name.startsWith('content_') || ['automation_jobs_lifecycle', 'scheduled_tasks_lifecycle'].includes(object.name)) } : {}) };
        if (through === 8) {
          assert.equal(before.ledger.length, 8); assert.deepEqual(before.partial0009Objects, []);
          assert.equal(before.fingerprint, installs[0].steps[7].schemaFingerprint);
          assert.equal(before.fingerprint, installs[1].steps[7].schemaFingerprint);
          assert.deepEqual(before.foreignKeyViolations, []);
        }
        const resumeSteps = await apply(database, sources, through === 8 ? 9 : 10);
        if (through === 8) resumeSteps.push((await apply(database, sources, 10)).at(-1));
        assert.ok(resumeSteps.slice(0, through).every(step => step.action === 'ALREADY_APPLIED'));
        assert.ok(resumeSteps.slice(through).every(step => step.action === 'APPLIED'));
        const snapshot = await captureSchema(database);
        assert.equal(snapshot.sha256, installs[0].schemaFingerprint);
        const rerun = await apply(database, sources);
        assert.ok(rerun.every(step => step.action === 'ALREADY_APPLIED'));
        assert.equal((await captureSchema(database)).sha256, snapshot.sha256);
        return { through: names[through - 1], status: 'PASS', baseline, sourceManifestSha256: digest(sources.manifest), prefixSteps, before,
          resumeSteps, finalLedger: await ledger(database), schemaFingerprint: snapshot.sha256, counts: snapshot.counts,
          data: await dataSummary(database, snapshot.schema), foreignKeyViolations: await rows(database, 'PRAGMA foreign_key_check'),
          secondFullApply: 'ALL_ALREADY_APPLIED_SCHEMA_UNCHANGED' };
      }));
    }
    console.log('LOCAL_FAILED_MIGRATION_ATOMICITY=RUNNING');
    const failureAtomicity = await withDatabase(async database => {
      await apply(database, sources, 3);
      await database.prepare("INSERT INTO scheduled_tasks(id,job_type,payload,enabled,next_run_at,interval_ms,revision) VALUES('atomicity-fixture','CAPTURE_PRICE_HISTORY','{}',0,0,60000,1)").run();
      const probe = ['CREATE TABLE phase10_failure_probe(id TEXT PRIMARY KEY,valid INTEGER CHECK(valid=1))',
        "INSERT INTO phase10_failure_probe VALUES('fixture',1)", "INSERT INTO d1_migrations(name) VALUES('fixture-failed-migration')"];
      await database.batch(probe.map(statement => database.prepare(statement)));
      assert.equal((await rows(database, 'SELECT COUNT(*) AS count FROM phase10_failure_probe'))[0].count, 1);
      assert.ok((await ledger(database)).some(row => row.name === 'fixture-failed-migration'));
      await database.batch([database.prepare('DROP TABLE phase10_failure_probe'), database.prepare("DELETE FROM d1_migrations WHERE name='fixture-failed-migration'")]);
      const beforeSchema = await captureSchema(database);
      const before = { schemaFingerprint: beforeSchema.sha256, ledger: await ledger(database), data: await dataSummary(database, beforeSchema.schema, false),
        copiedTableFixture: await rows(database, "SELECT * FROM scheduled_tasks WHERE id='atomicity-fixture'") };
      const failingStatements = [...sources.scripts[3].statements, ...probe, "INSERT INTO phase10_failure_probe VALUES('must-fail',0)",
        `INSERT INTO d1_migrations(name) VALUES('${names[3]}')`];
      await assert.rejects(() => database.batch(failingStatements.map(statement => database.prepare(statement))), /CHECK constraint failed/);
      const afterSchema = await captureSchema(database);
      const after = { schemaFingerprint: afterSchema.sha256, ledger: await ledger(database), data: await dataSummary(database, afterSchema.schema, false),
        copiedTableFixture: await rows(database, "SELECT * FROM scheduled_tasks WHERE id='atomicity-fixture'") };
      assert.deepEqual(after, before, 'FAILED_BATCH_NOT_ATOMIC');
      assert.deepEqual(await rows(database, "SELECT name FROM sqlite_schema WHERE name='phase10_failure_probe'"), []);
      const retrySteps = await apply(database, sources, 10, false);
      const final = await captureSchema(database); assert.equal(final.sha256, installs[0].schemaFingerprint);
      assert.deepEqual(await rows(database, "SELECT * FROM scheduled_tasks WHERE id='atomicity-fixture'"), before.copiedTableFixture);
      assert.deepEqual(await rows(database, 'PRAGMA foreign_key_check'), []);
      return { status: 'PASS', sourceManifestSha256: digest(sources.manifest), failedMigration: digestFile(sources.scripts[3].file),
        exactMigrationStatementCount: sources.scripts[3].statementCount, failingBatchSha256: digest(failingStatements),
        injectedSql: [...probe, "INSERT INTO phase10_failure_probe VALUES('must-fail',0)"], expectedError: 'CHECK constraint failed',
        positiveControl: 'DDL_DATA_AND_LEDGER_BATCH_SUCCEEDS_WITHOUT_INJECTED_FAILURE', before, after,
        schemaRolledBack: true, dataRolledBack: true, ledgerRolledBack: true, priorCommittedPrefixPreserved: true,
        retrySteps, retrySchemaFingerprint: final.sha256, retryLedger: await ledger(database), copiedTableFixturePreserved: true,
        fixtureScope: 'ONE_SYNTHETIC_SCHEDULED_TASK_IN_SEPARATE_DISPOSABLE_LOCAL_DATABASE' };
    });
    console.log('LOCAL_CONSTRAINT_AND_MONEY_EXECUTION_PROBES=RUNNING');
    const constraints = await withDatabase(async database => {
      await apply(database, sources);
      const snapshot = await captureSchema(database); assert.equal(snapshot.sha256, installs[0].schemaFingerprint);
      return { ...await constraintProbes(database, snapshot), sourceManifestSha256: digest(sources.manifest), schemaFingerprint: snapshot.sha256 };
    });
    assert.equal(externalNetworkAttempts, 0);
    assert.deepEqual(loadMigrations().manifest, sources.manifest);
    return { installs, canonicalSchema, partialResumes, failureAtomicity, constraints,
      repeatability: 'PASS', isolation: { engine: 'DIRECT_MINIFLARE_WORKERD', persistence: false, remoteBindings: false,
        dotenvLoaded: false, wranglerConfigurationLoaded: false, authenticationAttempted: false, externalNetworkAttempts,
        databasesCreated, allDatabasesDisposed: true, workerDeployment: false, queueBindings: 0,
        effectCounterBasis: 'Only ephemeral local D1 bindings and fixed local quality commands; no production executor or account client.' } };
  } finally { globalThis.fetch = originalFetch; }
}

export function validateRehearsal(report, currentSources, currentHarness, head) {
  assert.equal(report.schema, 'phase10-d1-rehearsal-evidence-v3');
  assert.equal(report.outcome, 'PASS'); assert.equal(report.sourceHead, head);
  assert.deepEqual(report.migrationSources, currentSources); assert.deepEqual(report.harnessSources, currentHarness);
  assert.equal(report.sourceManifestSha256, digest(currentSources));
  assert.equal(report.migrationCount, 10); assert.equal(report.migrationSequenceValid, true);
  assert.equal(report.initialGitGate.head, head); assert.deepEqual(report.initialGitGate.unrelatedDirtyFiles, []);
  assert.ok(report.initialGitGate.stagedFiles.every(file => file === incidentFile));
  assert.equal(report.initialGitGate.indexClean, report.initialGitGate.stagedFiles.length === 0);
  assert.equal(report.initialGitGate.worktreeClean, report.initialGitGate.status === '');
  assert.deepEqual(report.initialGitGate.migrationSources, currentSources);
  assert.deepEqual(report.repairAudit, auditRepair(root, currentSources));
  assert.deepEqual(report.incidentEvidence, assertIncidentPreserved(root));
  assert.deepEqual(report.parserCompatibility, parserCompatibilityGuard(fs.readFileSync(path.join(root, currentSources[8].file), 'utf8')));
  assert.equal(report.authorizationEvidenceInvalidatedByRepair, true);
  assert.equal(report.method.version, METHOD_VERSION);
  assert.deepEqual(report.method.documentation, currentHarness.find(source => source.file === methodFile));
  assert.deepEqual(report.method.implementation, currentHarness.find(source => source.file === 'scripts/lib/d1-schema-canonical.mjs'));
  const fingerprint = digest(report.canonicalSchema); assert.equal(report.schemaFingerprint, fingerprint);
  assert.equal(report.canonicalSchema.methodVersion, METHOD_VERSION);
  assert.equal(report.sourceToFingerprintBinding, 'PASS');
  const allIndexes = report.canonicalSchema.tables.flatMap(table => table.indexes);
  const expectedCounts = { tables: report.canonicalSchema.tables.length, indexes: allIndexes.filter(index => index.origin === 'c').length,
    migrationLedgerTables: 1, tablesIncludingMigrationLedger: report.canonicalSchema.tables.length + 1,
    implicitIndexes: allIndexes.filter(index => index.origin !== 'c').length, allIndexes: allIndexes.length,
    triggers: report.canonicalSchema.triggers.length, views: report.canonicalSchema.views.length,
    checkConstraints: report.canonicalSchema.tables.reduce((sum, table) => sum + table.checks.length, 0) };
  const scripts = loadMigrations().scripts;
  function validateData(data, expectedTables, empty = true) {
    assert.deepEqual(data.perTable.map(item => item.table), expectedTables);
    assert.ok(data.perTable.every(item => Number.isSafeInteger(item.rows) && item.rows >= 0));
    const control = expectedTables.includes('affiliate_revenue_cursor');
    assert.deepEqual(data.controlRows, control ? [{ id: 'revenue-v1', last_sequence: 0, claim_key: null }] : []);
    assert.equal(data.controlRowCount, control ? 1 : 0);
    if (control) assert.equal(data.perTable.find(item => item.table === 'affiliate_revenue_cursor').rows, 1);
    assert.equal(data.businessRows, data.perTable.filter(item => item.table !== 'affiliate_revenue_cursor').reduce((sum, item) => sum + item.rows, 0));
    if (empty) assert.equal(data.businessRows, 0);
  }
  function validateSteps(steps, prefixLength, through = 10, empty = true) {
    assert.equal(steps.length, through);
    assert.deepEqual(steps.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })), currentSources.slice(0, through));
    for (const [position, step] of steps.entries()) {
      assert.equal(step.statementCount, scripts[position].statementCount);
      assert.equal(step.submittedStatementsSha256, scripts[position].submittedStatementsSha256);
      assert.equal(step.action, position < prefixLength ? 'ALREADY_APPLIED' : 'APPLIED');
      if (step.action === 'APPLIED') {
        assert.deepEqual(step.ledger.map(row => row.name), names.slice(0, position + 1));
        assert.deepEqual(step.foreignKeyViolations, []);
        assert.equal(step.counts.tables, step.data.perTable.length);
        validateData(step.data, step.data.perTable.map(item => item.table), empty);
      }
    }
  }
  assert.equal(report.repeatability, 'PASS'); assert.equal(report.installs.length, 2);
  assert.deepEqual(report.installs.map(install => install.id), ['A', 'B']);
  for (const install of report.installs) {
    assert.equal(install.status, 'PASS'); assert.equal(install.baseline.status, 'EMPTY'); assert.equal(install.baseline.applicationObjects, 0);
    assert.equal(install.baseline.migrationLedgerPresent, false); assert.equal(install.sourceManifestSha256, digest(currentSources));
    assert.equal(install.schemaFingerprint, fingerprint); assert.equal(install.canonicalBytes, Buffer.byteLength(canonicalJson(report.canonicalSchema)));
    assert.equal(install.data.businessRows, 0); assert.equal(install.checks.status, 'PASS');
    assert.deepEqual(install.counts, expectedCounts);
    validateData(install.data, report.canonicalSchema.tables.map(table => table.name));
    validateSteps(install.steps, 0);
    assert.equal(install.steps.at(-1).schemaFingerprint, fingerprint);
    for (const field of ['foreignKeyCheck', 'constraintDefinitions', 'indexCheck', 'triggerCheck', 'moneyLedgerSchema', 'executionControlSchema']) assert.equal(install.checks[field], 'PASS');
    assert.equal(install.checks.quickCheck, 'ok'); assert.equal(install.checks.compiledStatements, expectedCounts.tables * 3);
    assert.deepEqual(install.checks.foreignKeyViolations, []);
    assert.equal(install.checks.triggerReferences.length, expectedCounts.triggers);
    assert.deepEqual(install.appliedMigrations, names); assert.equal(install.steps.length, names.length);
    assert.deepEqual(install.steps.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })), currentSources);
    assert.ok(install.steps.every(step => step.action === 'APPLIED' && step.data.businessRows === 0 && step.foreignKeyViolations.length === 0));
  }
  assert.deepEqual(report.installs[0].counts, report.installs[1].counts);
  assert.deepEqual(report.partialResumes.map(resume => resume.through), [names[2], names[5], names[7], names[8]]);
  for (const resume of report.partialResumes) {
    assert.equal(resume.status, 'PASS'); assert.equal(resume.sourceManifestSha256, digest(currentSources));
    assert.equal(resume.schemaFingerprint, fingerprint); assert.equal(resume.data.businessRows, 0);
    assert.deepEqual(resume.finalLedger.map(row => row.name), names); assert.deepEqual(resume.foreignKeyViolations, []);
    const prefixLength = names.indexOf(resume.through) + 1;
    validateSteps(resume.prefixSteps, 0, prefixLength);
    validateSteps(resume.resumeSteps, prefixLength);
    validateData(resume.data, report.canonicalSchema.tables.map(table => table.name));
    assert.deepEqual(resume.counts, expectedCounts);
    assert.deepEqual(resume.before.ledger.map(row => row.name), names.slice(0, prefixLength));
    assert.equal(resume.before.fingerprint, report.installs[0].steps[prefixLength - 1].schemaFingerprint);
    assert.deepEqual(resume.resumeSteps.map(step => step.action), names.map(name => names.indexOf(name) < prefixLength ? 'ALREADY_APPLIED' : 'APPLIED'));
    assert.deepEqual(resume.resumeSteps.map(({ file, sha256, bytes }) => ({ file, sha256, bytes })), currentSources);
  }
  const partial = report.partialResumes.find(resume => resume.through === names[7]);
  assert.equal(partial.before.fingerprint, digest(partial.before.canonicalSchema));
  assert.equal(report.pre0009SchemaFingerprint, partial.before.fingerprint);
  assert.equal(partial.before.fingerprint, report.installs[1].steps[7].schemaFingerprint);
  assert.deepEqual(partial.before.ledger, report.installs[0].steps[7].ledger);
  assert.deepEqual(partial.before.counts, report.installs[0].steps[7].counts);
  assert.deepEqual(partial.before.data, report.installs[0].steps[7].data);
  assert.deepEqual(partial.before.foreignKeyViolations, []);
  assert.deepEqual(partial.before.quickCheck.map(row => Object.values(row)[0]), ['ok']);
  assert.equal(partial.before.migration0009MetadataPresent, false); assert.equal(partial.before.migration0010MetadataPresent, false);
  assert.deepEqual(partial.before.partial0009Objects, []);
  assert.equal(partial.resumeSteps[8].action, 'APPLIED'); assert.equal(partial.resumeSteps[9].action, 'APPLIED');
  assert.deepEqual(report.partialProductionBaselineModel, partialBaselineModel(report));
  const restoredHistoricalSchema = structuredClone(report.canonicalSchema);
  for (const repair of triggerRepairs) {
    const trigger = restoredHistoricalSchema.triggers.find(trigger => trigger.name === repair.name);
    assert.ok(trigger.sql.includes(normalizeSql(repairedExpression(repair))));
    trigger.sql = trigger.sql.replace(normalizeSql(repairedExpression(repair)), normalizeSql(legacyExpression(repair)));
  }
  assert.equal(digest(restoredHistoricalSchema), report.oldFingerprintComparison.oldFingerprint);
  assert.equal(report.oldFingerprintComparison.authority, 'HISTORICAL_ONLY_INVALIDATED_BY_0009_REPAIR');
  assert.equal(report.oldFingerprintComparison.newFingerprint, fingerprint);
  assert.equal(report.failureAtomicity.status, 'PASS'); assert.equal(report.failureAtomicity.sourceManifestSha256, digest(currentSources));
  assert.deepEqual(report.failureAtomicity.failedMigration, currentSources[3]);
  assert.equal(report.failureAtomicity.before.schemaFingerprint, report.installs[0].steps[2].schemaFingerprint);
  assert.deepEqual(report.failureAtomicity.before.ledger.map(row => row.name), names.slice(0, 3));
  validateSteps(report.failureAtomicity.retrySteps, 3, 10, false);
  assert.deepEqual(report.failureAtomicity.retryLedger.map(row => row.name), names);
  assert.deepEqual(report.failureAtomicity.before, report.failureAtomicity.after);
  assert.equal(report.failureAtomicity.retrySchemaFingerprint, fingerprint); assert.equal(report.failureAtomicity.copiedTableFixturePreserved, true);
  for (const field of ['schemaRolledBack', 'dataRolledBack', 'ledgerRolledBack', 'priorCommittedPrefixPreserved']) assert.equal(report.failureAtomicity[field], true);
  assert.equal(report.constraints.status, 'PASS'); assert.equal(report.constraints.sourceManifestSha256, digest(currentSources));
  assert.equal(report.constraints.schemaFingerprint, fingerprint); assert.ok(report.constraints.checks.length >= 17);
  assert.ok(report.constraints.checks.every(check => check.status === 'PASS' && check.batchRolledBack));
  assert.deepEqual(report.constraints.repairedCapPolicies, { status: 'PASS', source15To16Allowed: true, source17Rejected: 'CONTENT_PRODUCT_CAP',
    duplicateSourceAtCapAllowed: true, audit255To256Allowed: true, audit257Rejected: 'CONTENT_AUDIT_CAP', sourceRows: 16, auditRows: 256, auditCounter: 256 });
  assert.equal(report.phase5SideEffectAudit.status, 'UNCHANGED_BYTE_FOR_BYTE');
  assert.deepEqual(report.phase5SideEffectAudit.before, report.phase5SideEffectAudit.after);
  assert.deepEqual(report.productionEffects, effects); assert.equal(report.isolation.externalNetworkAttempts, 0);
  assert.equal(report.isolation.authenticationAttempted, false); assert.equal(report.isolation.allDatabasesDisposed, true);
  assert.equal(report.isolation.databasesCreated, 8); assert.equal(report.isolation.persistence, false);
  assert.equal(report.isolation.remoteBindings, false); assert.equal(report.isolation.queueBindings, 0);
  assert.equal(report.quality.status, 'PASS'); assert.equal(report.quality.harnessManifestSha256, digest(currentHarness));
  assert.deepEqual(report.quality.results.map(result => result.name), ['focused-tests', 'typescript', 'eslint', 'secret-scan', 'git-diff-check']);
  assert.ok(report.quality.results.every(result => result.exitCode === 0));
  const { evidenceBindingSha256, ...bound } = report;
  assert.equal(evidenceBindingSha256, digest(bound), 'EVIDENCE_BINDING_DIGEST_MISMATCH');
  return fingerprint;
}

function qualityChecks(harness) {
  const results = [];
  const commands = [
    ['focused-tests', process.execPath, ['scripts/phase-10-d1-evidence-tests.mjs']],
    ['typescript', process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '--incremental', 'false']],
    ['eslint', process.execPath, ['node_modules/eslint/bin/eslint.js', '.', '--format', 'json']],
    ['secret-scan', process.execPath, ['scripts/release-validation.cjs', 'secret-scan']],
    ['git-diff-check', 'git', ['diff', '--check']],
  ];
  for (const [name, binary, args] of commands) {
    console.log(`QUALITY_${name.toUpperCase()}=RUNNING`);
    const startedAt = new Date().toISOString();
    const result = spawnSync(binary, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    fs.writeFileSync(path.join(root, scratch, `${name}.log`), output);
    const record = { name, command: [binary === process.execPath ? 'node' : binary, ...args].join(' '), startedAt,
      finishedAt: new Date().toISOString(), exitCode: result.status ?? 1, outputSha256: sha256(output) };
    if (name === 'eslint' && result.status === 0) {
      const files = JSON.parse(result.stdout);
      record.errors = files.reduce((sum, file) => sum + file.errorCount, 0);
      record.warnings = files.reduce((sum, file) => sum + file.warningCount, 0);
      record.repairFileWarnings = files.filter(file => repairFiles.includes(path.relative(root, file.filePath).replaceAll('\\', '/'))).reduce((sum, file) => sum + file.warningCount, 0);
      assert.equal(record.repairFileWarnings, 0, 'NEW_LINT_WARNINGS');
    }
    if (name === 'focused-tests' && result.status === 0) {
      const summary = /(\d+) passed, (\d+) failed, (\d+) skipped/.exec(output); assert.ok(summary);
      record.passed = Number(summary[1]); record.failed = Number(summary[2]); record.skipped = Number(summary[3]);
      assert.ok(record.passed > 0); assert.equal(record.failed, 0); assert.equal(record.skipped, 0);
    }
    results.push(record); console.log(JSON.stringify(record));
    assert.equal(record.exitCode, 0, `QUALITY_FAILED_${name}`);
  }
  for (const file of repairFiles.filter(file => fs.existsSync(path.join(root, file)))) {
    assert.ok(!fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).some(line => /[\t ]+$/.test(line)), `UNTRACKED_WHITESPACE_${file}`);
  }
  assert.deepEqual(harnessManifest(), harness, 'HARNESS_DRIFT');
  return { status: 'PASS', harnessManifestSha256: digest(harness), results, untrackedRepairWhitespaceCheck: 'PASS' };
}

function verifyDurable() {
  const report = readJson(rehearsalFile), preauth = readJson(preauthFile);
  const fingerprint = validateRehearsal(report, loadMigrations().manifest, harnessManifest(), git('rev-parse', 'HEAD'));
  assert.deepEqual(phase5Files.map(digestFile), report.phase5SideEffectAudit.after);
  assert.equal(preauth.rehearsalReference.sha256, digestFile(rehearsalFile).sha256, 'PREAUTH_REHEARSAL_REFERENCE_DRIFT');
  assert.equal(preauth.rehearsalReference.bytes, digestFile(rehearsalFile).bytes);
  assert.equal(preauth.rehearsalReference.evidenceBindingSha256, report.evidenceBindingSha256);
  assert.equal(preauth.rehearsalReference.sourceManifestSha256, report.sourceManifestSha256);
  assert.deepEqual(preauth.migrationSources, report.migrationSources);
  assert.equal(preauth.sourceHead, report.sourceHead); assert.equal(preauth.methodVersion, METHOD_VERSION);
  assert.equal(preauth.schemaFingerprintA, fingerprint); assert.equal(preauth.schemaFingerprintB, fingerprint);
  assert.equal(preauth.migrationSourceHashesMatchRehearsal, true);
  assert.equal(preauth.readyForD1PartialBaselinePreauthAudit, 'YES');
  assert.equal(preauth.authorizationDecision, 'NO'); assert.equal(preauth.productionMigrationAuthorized, false);
  assert.equal(preauth.currentProductionIdentityVerified, false); assert.equal(preauth.productionIsEmpty, false);
  assert.equal(preauth.productionInspectedThisTask, false);
  assert.deepEqual(preauth.partialProductionBaselineModel, partialBaselineModel(report));
  assert.deepEqual(preauth.incidentEvidence, report.incidentEvidence);
  assert.deepEqual(preauth.productionEffects, effects);
  assert.ok(Object.values(preauth.localRequirements).every(value => value === 'PASS'));
  checkWorkspace(report.initialGitGate, report.migrationSources);
  console.log(`DURABLE_REHEARSAL_AND_PREAUTH_VERIFIED=PASS SCHEMA_FINGERPRINT=${fingerprint}`);
  return report;
}

async function repair() {
  const gate = readJson(`${scratch}/initial-gate.json`), sources = loadMigrations(), harness = harnessManifest();
  checkWorkspace(gate, sources.manifest);
  writeJson(preauthFile, { auditStatus: 'LOCAL_REVALIDATION_IN_PROGRESS', authorizationDecision: 'NO',
    productionMigrationAuthorized: false, readyForD1ProductionMigrationPreauthReaudit: 'NO', productionEffects: effects });
  writeJson(rehearsalFile, { outcome: 'IN_PROGRESS', sourceHead: gate.head, migrationSources: sources.manifest, productionEffects: effects });
  const results = await runRehearsals(sources);
  const historical = JSON.parse(execFileSync('git', ['show', `${incidentHead}:${rehearsalFile}`], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  const oldFingerprint = historical.schemaFingerprint;
  assert.equal(digest(historical.canonicalSchema), oldFingerprint);
  const newFingerprint = results.installs[0].schemaFingerprint;
  const report = { schema: 'phase10-d1-rehearsal-evidence-v3', outcome: 'PASS', observedAt: new Date().toISOString(),
    sourceHead: gate.head, branch: gate.branch, initialGitGate: gate, migrationCount: sources.manifest.length, migrationSequenceValid: true,
    migrationSources: sources.manifest, sourceManifestSha256: digest(sources.manifest), harnessSources: harness,
    harnessProvenance: 'EXACT_WORKING_TREE_BYTES_AT_SOURCE_HEAD_NOT_AN_IMPLIED_COMMIT',
    runtime: { node: process.version, miniflare: readJson('node_modules/miniflare/package.json').version,
      workerd: readJson('node_modules/workerd/package.json').version, compatibilityDate: '2026-09-08' },
    method: { version: METHOD_VERSION, documentation: digestFile(methodFile), implementation: digestFile('scripts/lib/d1-schema-canonical.mjs'),
      encoding: 'UTF-8_WITHOUT_BOM', newline: 'ONE_FINAL_LF', hashAlgorithm: 'SHA-256', serialization: 'RECURSIVELY_KEY_SORTED_COMPACT_JSON',
      representation: 'canonicalSchema field in this evidence; hash canonicalJson(field), not pretty-printed file bytes' },
    ...results, schemaFingerprint: newFingerprint, sourceToFingerprintBinding: 'PASS',
    authorizationEvidenceInvalidatedByRepair: true, repairAudit: auditRepair(root, sources.manifest), incidentEvidence: assertIncidentPreserved(root),
    parserCompatibility: parserCompatibilityGuard(fs.readFileSync(path.join(root, sources.manifest[8].file), 'utf8')),
    pre0009SchemaFingerprint: results.partialResumes.find(resume => resume.through === names[7]).before.fingerprint,
    oldFingerprintComparison: { oldFingerprint, newFingerprint, match: oldFingerprint === newFingerprint,
      changeReason: 'Only the two repaired trigger SQL bodies differ under the unchanged canonicalization method. Replacing them with their historical expressions reproduces the old canonical fingerprint exactly.',
      oldMethod: METHOD_VERSION, historicalGitReference: `${incidentHead}:${rehearsalFile}`, authority: 'HISTORICAL_ONLY_INVALIDATED_BY_0009_REPAIR',
      olderUndocumentedFingerprint: '765242eb594e24acd01c1e35ee5a9c13c9a31754b18d6a828f1a7729da2d3859' },
    phase5SideEffectAudit: { status: 'UNCHANGED_BYTE_FOR_BYTE', before: gate.phase5, after: phase5Files.map(digestFile), regenerationPerformed: false },
    recoveryLimitations: ['Per-file D1 batch only; ten migrations are not one atomic transaction.',
      'Table-copy/drop migrations are not automatically reversible; Worker rollback does not restore D1 schema/data.',
      'Empty-prefix resumes do not certify populated production upgrades or remote Wrangler transaction behavior.',
      'No production identity, baseline, backup, export/restore, Time Travel, permissions or change window verified.',
      'A fresh separately authorized production preflight and explicit human migration authorization are still mandatory.'],
    productionEffects: effects, checkpoint: { filesToCommit: changedFiles(), filesToIgnore: [`${scratch}/`, `${forensicDirectory}/`,
      '.test-tmp/isolated/0001_test.sql', '.test-tmp/bisect/0001_base.sql'], filesToReview: [] },
    quality: { status: 'PENDING' } };
  report.partialProductionBaselineModel = partialBaselineModel(report);
  writeJson(rehearsalFile, report);
  report.quality = qualityChecks(harness);
  checkWorkspace(gate, sources.manifest);
  report.phase5SideEffectAudit.after = phase5Files.map(digestFile);
  report.evidenceBindingSha256 = digest(report);
  validateRehearsal(report, sources.manifest, harness, gate.head);
  writeJson(rehearsalFile, report);
  const preauth = { schema: 'phase10-d1-partial-production-preauth-v3', observedAt: new Date().toISOString(), auditStatus: 'LOCAL_PARTIAL_BASELINE_EVIDENCE_READY',
    sourceHead: gate.head, branch: gate.branch, scope: 'LOCAL_ONLY_PREAUTH_EVIDENCE_REVALIDATION_NOT_MIGRATION_AUTHORIZATION',
    priorConclusion: { sha256: gate.priorEvidence.find(item => item.file === preauthFile).sha256, status: 'INVALIDATED_BY_0009_REPAIR_AND_NONEMPTY_PRODUCTION',
      reason: 'Production has exactly 0001..0008 applied, not an empty schema. Previous migration hashes and canonical fingerprint do not authorize repaired 0009.' },
    initialWorktreeClean: gate.worktreeClean, initialIndexClean: gate.indexClean, currentWorktreeClean: changedFiles().length === 0,
    currentIndexClean: git('diff', '--cached', '--name-only') === '',
    expectedDirtyFiles: changedFiles(), unrelatedDirtyFiles: [],
    rehearsalReference: { ...digestFile(rehearsalFile), evidenceBindingSha256: report.evidenceBindingSha256, sourceManifestSha256: report.sourceManifestSha256 },
    migrationSources: sources.manifest, migrationSourceHashesMatchRehearsal: true, methodVersion: METHOD_VERSION,
    schemaFingerprintA: results.installs[0].schemaFingerprint, schemaFingerprintB: results.installs[1].schemaFingerprint,
    localRequirements: Object.fromEntries(['durableMigrationHashes', 'hashesTiedToFreshRehearsal', 'fingerprintMethodDocumented',
      'fingerprintRepeatable', 'currentMigrationHashesEqualRehearsal', 'zeroBusinessSeed', 'partialResumesVerified', 'failureBehaviorVerified',
      'recoveryLimitationsDocumented', 'phase5EvidenceUnchanged', 'noUnrelatedDirtyChanges', 'qualityChecks'].map(name => [name, 'PASS'])),
    currentProductionIdentityVerified: false, productionIsEmpty: false, productionInspectedThisTask: false,
    partialProductionBaselineModel: report.partialProductionBaselineModel, pre0009SchemaFingerprint: report.pre0009SchemaFingerprint,
    incidentEvidence: report.incidentEvidence,
    requiredFutureReadOnlyEvidence: ['Exact account ID and D1 ID/name', 'Exact ordered migration history 0001..0008 with no unknown entries',
      '0009 and 0010 metadata absent', 'No partial 0009 tables, indexes, triggers or other schema effect',
      'Full d1-schema-canonical-v1 schema equal to expected pre-0009 fingerprint', 'Zero business rows and exact unchanged control row',
      'Repaired source hashes, HEAD and evidence bindings unchanged; clean reviewed checkpoint'],
    allowedFutureMigrationSequence: [names[8], names[9]], forbiddenFutureMigrationReplay: names.slice(0, 8),
    recoveryPlanStatus: 'LOCAL_LIMITATIONS_DOCUMENTED_PRODUCTION_RECOVERY_UNVERIFIED',
    productionGateBlockers: ['FINAL_CHECKPOINT_REQUIRES_HUMAN_REVIEW', 'CURRENT_PRODUCTION_IDENTITY_AND_EXACT_0001_TO_0008_BASELINE_NOT_REVALIDATED',
      'PRODUCTION_BACKUP_AND_RECOVERY_NOT_VERIFIED', 'REMOTE_APPLY_SEMANTICS_AND_CHANGE_WINDOW_REQUIRE_REVIEW', 'NO_HUMAN_MIGRATION_AUTHORIZATION'],
    abortConditions: ['Any source, method, harness, HEAD or evidence-reference drift', 'Wrong account/D1 identity, any unknown migration, nonzero business rows or unverified partial baseline',
      '0009/0010 metadata present, any partial 0009 object or pre-0009 fingerprint mismatch',
      'Any failed local quality, repeatability, integrity, resume or atomicity check', 'Any unresolved unrelated changes or missing recovery/approval'],
    readyForD1PartialBaselinePreauthAudit: 'YES', authorizationDecision: 'NO', productionMigrationAuthorized: false,
    productionEffects: effects, nextStep: 'STOP_FOR_HUMAN_REVIEW_NO_AUTHENTICATION_NO_PRODUCTION_WRITE_NO_DEPLOY_NO_COMMIT' };
  writeJson(preauthFile, preauth);
  verifyDurable();
  for (const [binary, args] of [[process.execPath, ['scripts/release-validation.cjs', 'secret-scan']], ['git', ['diff', '--check']]]) {
    execFileSync(binary, args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  }
  console.log(JSON.stringify({ PHASE10_D1_EVIDENCE_REPAIR: 'PASS', fingerprint: newFingerprint, counts: results.installs[0].counts,
    READY_FOR_D1_PARTIAL_BASELINE_PREAUTH_AUDIT: 'YES', PRODUCTION_MIGRATION_AUTHORIZED: false, ...effects }));
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  assert.ok(['capture-gate', 'repair', 'verify', 'replay'].includes(mode) && extra.length === 0, 'LOCAL_EVIDENCE_MODE_REQUIRED_NO_TARGET_OR_REMOTE_ARGUMENTS');
  if (mode === 'capture-gate') return captureGate();
  if (mode === 'verify') return verifyDurable();
  if (mode === 'repair') return repair();
  const report = verifyDurable();
  const replay = await runRehearsals(loadMigrations());
  assert.deepEqual(replay.canonicalSchema, report.canonicalSchema);
  assert.equal(replay.installs[0].schemaFingerprint, report.schemaFingerprint);
  assert.equal(replay.installs[1].schemaFingerprint, report.schemaFingerprint);
  assert.deepEqual(phase5Files.map(digestFile), report.phase5SideEffectAudit.after);
  writeJson(`${scratch}/independent-replay.json`, { status: 'PASS', observedAt: new Date().toISOString(),
    sourceHead: report.sourceHead, sourceManifestSha256: report.sourceManifestSha256, fingerprint: report.schemaFingerprint,
    partialResumes: replay.partialResumes.map(resume => ({ through: resume.through, status: resume.status })),
    failureAtomicity: replay.failureAtomicity.status, constraints: replay.constraints.status, isolation: replay.isolation });
  console.log('INDEPENDENT_LOCAL_REPLAY=PASS DURABLE_EVIDENCE_UNCHANGED=YES');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    if (process.argv[2] === 'repair') {
      writeJson(preauthFile, { auditStatus: 'LOCAL_REVALIDATION_FAILED', authorizationDecision: 'NO', productionMigrationAuthorized: false,
        readyForD1ProductionMigrationPreauthReaudit: 'NO', blocker: 'LOCAL_CHECK_FAILED_SEE_CONSOLE', productionEffects: effects });
      const report = readJson(rehearsalFile); report.outcome = 'FAIL'; report.sourceToFingerprintBinding = 'FAIL';
      delete report.evidenceBindingSha256; writeJson(rehearsalFile, report);
    }
    console.error(error); process.exitCode = 1;
  });
}
