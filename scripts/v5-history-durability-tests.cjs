/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const allowedTempRoot = path.resolve(repositoryRoot, '.test-tmp');
const suiteRoot = path.join(
  allowedTempRoot,
  `v5-history-durability-${process.pid}-${Date.now()}`,
);
if (path.dirname(path.resolve(suiteRoot)) !== allowedTempRoot) {
  throw new Error('V5_HISTORY_UNSAFE_TEST_ROOT');
}
fs.mkdirSync(suiteRoot, { recursive: true });

const releaseId = '5'.repeat(40);
process.env.NODE_ENV = 'test';
process.env.SANDEAL_STORAGE_DRIVER = 'file';
process.env.SANDEAL_AUTOMATION_JOB_ARCHIVE_ENABLED = 'true';
process.env.SANDEAL_BUILD_MANIFEST_COMMIT = releaseId;
process.env.SANDEAL_BUILD_COMMIT = releaseId;
process.env.SANDEAL_RELEASE_ID = releaseId;
process.env.GIT_COMMIT_SHA = releaseId;
process.env.NEXT_PUBLIC_SANDEAL_RELEASE_ID = releaseId;
process.env.ALLOW_PAID_AI = 'false';
require('./register-typescript.cjs');

let passed = 0;
let failed = 0;

async function test(name, work) {
  try {
    await work();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL ${name}\n${error && error.stack ? error.stack : error}\n`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function iso(value) {
  return new Date(value).toISOString();
}

function historyShard(id) {
  return (Number.parseInt(sha256(id).slice(0, 2), 16) % 128)
      .toString(16)
      .padStart(2, '0');
}

function findIdForShard(prefix, shard, used = new Set()) {
  for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
    const id = `${prefix}-${attempt}`;
    if (!used.has(id) && historyShard(id) === shard) {
      used.add(id);
      return id;
    }
  }
  throw new Error('V5_HISTORY_TEST_SHARD_ID_EXHAUSTED');
}

function terminalJob(id, nowMs = Date.now(), status = 'FAILED', overrides = {}) {
  const createdAt = iso(nowMs - 60_000);
  const completedAt = iso(nowMs - 30_000);
  return {
    schemaVersion: 1,
    policyVersion: 'v5-history-fixture',
    handlerVersion: 'v5-history-fixture',
    id,
    correlationId: `v5-correlation-${id}`.slice(0, 200),
    type: 'HEALTH_CHECK',
    status,
    payload: { fixture: 'v5-history-durability', id },
    result: { fixture: true },
    priority: 50,
    idempotencyKey: `v5-history-key-${id}`.slice(0, 200),
    operationId: `v5-history-operation-${id}`.slice(0, 200),
    requestedBy: 'v5-history-durability-test',
    approvalStatus: 'NOT_REQUIRED',
    riskLevel: 'LOW',
    dryRun: false,
    attemptCount: 1,
    maxAttempts: 1,
    queuedAt: createdAt,
    scheduledAt: createdAt,
    startedAt: iso(nowMs - 50_000),
    completedAt,
    cancelledAt: status === 'CANCELLED' ? completedAt : undefined,
    createdAt,
    updatedAt: completedAt,
    ...overrides,
  };
}

function directorySnapshot(root) {
  if (!fs.existsSync(root)) return {};
  return Object.fromEntries(fs.readdirSync(root, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => {
        const target = path.join(root, entry.name);
        return [entry.name, entry.isFile()
          ? { bytes: fs.statSync(target).size, hash: sha256(fs.readFileSync(target)) }
          : { directory: true }];
      }));
}

function rawCollectionPath(root, collection) {
  if (!/^[a-z0-9-]{1,160}$/.test(collection)) {
    throw new Error('V5_HISTORY_TEST_COLLECTION_INVALID');
  }
  const target = path.resolve(root, `${collection}.json`);
  if (path.dirname(target) !== path.resolve(root)) {
    throw new Error('V5_HISTORY_TEST_COLLECTION_PATH_INVALID');
  }
  return target;
}

function writeRawCollection(root, collection, items) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(rawCollectionPath(root, collection), JSON.stringify(items), 'utf8');
}

function errorCode(error) {
  if (error && typeof error === 'object' && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : String(error);
}

async function rejectsCode(work, expected) {
  await assert.rejects(work, error => {
    assert.match(errorCode(error), expected);
    return true;
  });
}

async function withTimeout(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function spawnNode(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForFiles(files, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (!files.every(file => fs.existsSync(file))) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('V5_HISTORY_TEST_CHILD_READY_TIMEOUT');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function main() {
  const adapter = require('../src/lib/storage/adapter.ts');
  const fileStorage = require('../src/lib/storage/fileStorageAdapter.ts');
  const history = require('../src/lib/automation/jobHistoryArchive.ts');
  const maintenance = require('../src/lib/automation/jobHistoryMaintenance.ts');
  const productionSkew = require('./fixtures/v5-history-production-skew.json');

  async function scenario(name) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('V5_HISTORY_SCENARIO_NAME_INVALID');
    const root = path.resolve(suiteRoot, name);
    if (path.dirname(root) !== path.resolve(suiteRoot)) {
      throw new Error('V5_HISTORY_UNSAFE_SCENARIO_ROOT');
    }
    fs.mkdirSync(root, { recursive: true });
    process.env.SANDEAL_DATA_DIR = root;
    history.setAutomationJobHistoryTestHookForTests(undefined);
    fileStorage.setFileStorageTransactionTestHookForTests(undefined);
    return root;
  }

  function makeHistoryRecord(job, archivedAt = job.completedAt || job.updatedAt) {
    const jobFingerprint = history.automationJobHistoryFingerprint(job);
    return {
      schemaVersion: 1,
      id: sha256(`automation-job-history-record\u0000${job.id}\u0000${jobFingerprint}`),
      jobId: job.id,
      jobFingerprint,
      archivedAt,
      job: structuredClone(job),
    };
  }

  function findIdempotencyKeyForCollection(prefix, collection) {
    for (let attempt = 0; attempt < 1_000_000; attempt += 1) {
      const key = `${prefix}-${attempt}`;
      const digest = sha256(`automation-job-idempotency\u0000HEALTH_CHECK\u0000${key}`);
      if (history.automationJobHistoryIdempotencyCollection(digest) === collection) return key;
    }
    throw new Error('V5_HISTORY_TEST_INDEX_KEY_EXHAUSTED');
  }

  function seedAuthoritativeRecords(root, records, options = {}) {
    const bySegment = new Map();
    for (const record of records) {
      const collection = history.automationJobHistorySegmentCollection(record.jobId);
      const group = bySegment.get(collection) || [];
      group.push(record);
      bySegment.set(collection, group);
    }
    for (const [collection, group] of bySegment) writeRawCollection(root, collection, group);
    if (options.indexes) {
      const byIndex = new Map();
      for (const record of records) {
        const index = history.makeAutomationJobHistoryIdempotencyRecord(record);
        const collection = history.automationJobHistoryIdempotencyCollection(index.keyDigest);
        const group = byIndex.get(collection) || [];
        group.push(index);
        byIndex.set(collection, group);
      }
      for (const [collection, group] of byIndex) writeRawCollection(root, collection, group);
    }
    return bySegment;
  }

  function exactManifest(entries, updatedAt, manifestGeneration = 1) {
    const segments = [...entries].sort((left, right) => left.collection.localeCompare(right.collection));
    const totals = history.automationJobHistoryManifestTotals(segments);
    return {
      schemaVersion: 1,
      id: 'automation-job-history-manifest',
      shardCount: 128,
      segmentMaximumItems: 1_024,
      segmentMaximumBytes: 16 * 1024 * 1024,
      archivedVersions: totals.archivedVersions,
      statusCounts: totals.statusCounts,
      segments,
      manifestGeneration,
      updatedAt,
    };
  }

  function manifestEntry(collection, records) {
    return {
      collection,
      itemCount: records.length,
      contentFingerprint: history.automationJobHistorySegmentFingerprint(records),
      statusCounts: history.automationJobHistoryStatusCounts(records),
    };
  }

  async function assertStrictPass(expectedArchivedVersions) {
    const report = await maintenance.verifyV5HistoryInvariants();
    assert.equal(report.result, 'PASS', JSON.stringify(report));
    assert.equal(report.recoveryClass, 'GREEN');
    if (expectedArchivedVersions !== undefined) {
      assert.equal(report.summary.archivedVersions, expectedArchivedVersions);
    }
    assert.ok(report.invariants.every(item => item.result === 'PASS'));
    return report;
  }

  async function crashAndRecover(name, phase, restartInChild = false) {
    const root = await scenario(name);
    const shard = '2a';
    const id = findIdForShard(`${name}-job`, shard);
    const job = terminalJob(id, Date.now());
    let fired = false;
    history.setAutomationJobHistoryTestHookForTests(input => {
      if (!fired && input.phase === phase) {
        fired = true;
        throw new Error(`V5_HISTORY_FAULT_${phase}`);
      }
    });
    try {
      await rejectsCode(
          () => history.archiveAutomationJobHistory(job),
          new RegExp(`V5_HISTORY_FAULT_${phase}`),
      );
    } finally {
      history.setAutomationJobHistoryTestHookForTests(undefined);
    }
    assert.equal(fired, true);
    const intentsBefore = await history.readAutomationJobHistoryPublicationIntents();
    assert.equal(intentsBefore.length, 1);
    if (restartInChild) {
      const outcomes = await runHistoryWorkers(root, [[job]], `${name}-restart`);
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].result, 'PASS');
    } else {
      const recovered = await history.archiveAutomationJobHistory(job, { nowMs: Date.now() + 1_000 });
      assert.equal(recovered.record.jobId, job.id);
    }
    await history.assertAutomationJobHistoryBatchArchived(
        [job],
        { requireAllTerminalIdempotencyIndex: true },
    );
    assert.equal((await history.readAutomationJobHistoryPublicationIntents()).length, 0);
    await assertStrictPass(1);
    return root;
  }

  async function runHistoryWorkers(dataRoot, jobGroups, label) {
    const parent = path.dirname(path.resolve(dataRoot));
    if (path.dirname(path.resolve(dataRoot)) !== parent || !path.resolve(dataRoot).startsWith(`${parent}${path.sep}`)) {
      throw new Error('V5_HISTORY_CHILD_DATA_ROOT_INVALID');
    }
    const startPath = path.join(parent, `${label}-start`);
    const readyPaths = [];
    const children = jobGroups.map((jobs, index) => {
      const inputPath = path.join(parent, `${label}-input-${index}.json`);
      const readyPath = path.join(parent, `${label}-ready-${index}`);
      readyPaths.push(readyPath);
      fs.writeFileSync(inputPath, JSON.stringify({ jobs, nowMs: Date.now() + index }), 'utf8');
      return spawnNode(
          path.join(repositoryRoot, 'scripts', 'v5-history-cross-process-worker.cjs'),
          ['--input', inputPath, '--ready', readyPath, '--start', startPath],
          {
            NODE_ENV: 'test',
            SANDEAL_STORAGE_DRIVER: 'file',
            SANDEAL_DATA_DIR: dataRoot,
            ALLOW_PAID_AI: 'false',
          },
      );
    });
    await waitForFiles(readyPaths);
    fs.writeFileSync(startPath, 'start\n', { flag: 'wx' });
    const results = await withTimeout(Promise.all(children), 60_000, 'V5_HISTORY_CHILD_EXIT_TIMEOUT');
    return results.map(result => {
      assert.equal(result.signal, null, result.stderr);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      const jsonLine = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      const parsed = JSON.parse(jsonLine);
      assert.equal(parsed.result, 'PASS');
      return parsed;
    });
  }

  await test('01 same-shard concurrent archive converges', async () => {
    await scenario('01-same-shard');
    const used = new Set();
    const jobs = [
      terminalJob(findIdForShard('same-shard-a', '11', used)),
      terminalJob(findIdForShard('same-shard-b', '11', used)),
    ];
    await Promise.all(jobs.map(job => history.archiveAutomationJobHistory(job)));
    assert.equal((await history.readAutomationJobHistorySegment(
        history.automationJobHistorySegmentCollection(jobs[0].id),
    )).itemCount, 2);
    await assertStrictPass(2);
  });

  await test('02 different-shard concurrent archive converges', async () => {
    await scenario('02-different-shard');
    const jobs = [
      terminalJob(findIdForShard('different-shard-a', '03')),
      terminalJob(findIdForShard('different-shard-b', '67')),
    ];
    await Promise.all(jobs.map(job => history.archiveAutomationJobHistory(job)));
    const manifest = await history.readAutomationJobHistoryManifest();
    assert.equal(manifest.segments.length, 2);
    assert.equal(manifest.archivedVersions, 2);
    await assertStrictPass(2);
  });

  await test('03 stale writer cannot publish after a newer same-shard generation', async () => {
    await scenario('03-stale-writer');
    const used = new Set();
    const first = terminalJob(findIdForShard('stale-first', '35', used));
    const second = terminalJob(findIdForShard('stale-second', '35', used));
    await history.archiveAutomationJobHistory(first);
    const staleSnapshot = await history.readAutomationJobHistorySegment(
        history.automationJobHistorySegmentCollection(first.id),
    );
    await history.archiveAutomationJobHistory(second);
    await rejectsCode(
        () => history.withAutomationJobHistoryCoordinator(handle => (
          history.replaceAutomationJobHistoryManifestCoordinated(
              [staleSnapshot],
              Date.now(),
              handle,
          )
        )),
        /AUTOMATION_JOB_HISTORY_MANIFEST_STALE_WRITER/,
    );
    await assertStrictPass(2);

    const backupRoot = await scenario('03-primary-only-segment');
    const backupUsed = new Set();
    const retained = terminalJob(findIdForShard('backup-retained', '36', backupUsed));
    const replacement = terminalJob(findIdForShard('backup-replacement', '36', backupUsed));
    await history.archiveAutomationJobHistory(retained);
    const segmentCollection = history.automationJobHistorySegmentCollection(retained.id);
    const segmentPrimary = rawCollectionPath(backupRoot, segmentCollection);
    assert.equal(fs.existsSync(`${segmentPrimary}.bak`), false);
    fs.renameSync(segmentPrimary, `${segmentPrimary}.bak`);
    await rejectsCode(
        () => history.archiveAutomationJobHistory(replacement),
        /AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CONFLICT/,
    );
    const primaryOnly = await history.readAutomationJobHistorySegment(segmentCollection);
    assert.deepEqual(primaryOnly.records.map(record => record.jobId), [replacement.id]);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(`${segmentPrimary}.bak`, 'utf8')).map(record => record.jobId),
        [retained.id],
    );
    const unsafe = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(unsafe.safeToApply, false);
    assert.ok(unsafe.blockers.includes('AUTOMATION_JOB_HISTORY_MANIFEST_GENERATION_CONFLICT'));
  });

  await test('04 crash before segment commit is recoverable', async () => {
    await crashAndRecover('04-before-segment', 'BEFORE_SEGMENT_COMMIT');
  });

  await test('05 crash immediately after segment commit is recoverable', async () => {
    await crashAndRecover('05-after-segment', 'AFTER_SEGMENT_COMMIT');
  });

  await test('06 crash before index commit is recoverable', async () => {
    await crashAndRecover('06-before-index', 'BEFORE_INDEX_COMMIT');
  });

  await test('07 crash immediately after index commit is recoverable', async () => {
    await crashAndRecover('07-after-index', 'AFTER_INDEX_COMMIT');
  });

  await test('08 crash before manifest publication is recoverable', async () => {
    await crashAndRecover('08-before-manifest', 'BEFORE_MANIFEST_COMMIT');
  });

  await test('09 crash immediately after manifest publication is recoverable', async () => {
    await crashAndRecover('09-after-manifest', 'AFTER_MANIFEST_COMMIT');
  });

  await test('10 fresh-process restart recovers every durable boundary', async () => {
    const boundaries = [
      'BEFORE_SEGMENT_COMMIT',
      'AFTER_SEGMENT_COMMIT',
      'BEFORE_INDEX_COMMIT',
      'AFTER_INDEX_COMMIT',
      'BEFORE_MANIFEST_COMMIT',
      'AFTER_MANIFEST_COMMIT',
    ];
    for (let index = 0; index < boundaries.length; index += 1) {
      await crashAndRecover(
          `10-restart-${String(index).padStart(2, '0')}`,
          boundaries[index],
          true,
      );
    }
  });

  await test('11 missing manifest entry is rebuilt from current segment truth', async () => {
    await scenario('11-missing-manifest-entry');
    const job = terminalJob(findIdForShard('missing-manifest-entry', '41'));
    await history.archiveAutomationJobHistory(job);
    const observed = await history.readAutomationJobHistoryManifest();
    await adapter.writeCollection(history.AUTOMATION_JOB_HISTORY_MANIFEST_NAME, [
      exactManifest([], iso(Date.now()), observed.manifestGeneration + 1),
    ]);
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.segmentsMismatched, 1);
    assert.equal(plan.safeToApply, true);
    const applied = await maintenance.applyAutomationJobHistoryRepair({
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    assert.equal(applied.result, 'APPLIED');
    assert.equal((await history.getArchivedAutomationJob(job.id)).id, job.id);
    await assertStrictPass(1);
  });

  await test('12 production-skew fixture advances four stale entries without rolling back current records', async () => {
    const root = await scenario('12-production-skew');
    assert.equal(productionSkew.shardCount, 128);
    assert.equal(productionSkew.authoritativeSource, 'CURRENT_VALID_SEGMENTS');
    assert.equal(productionSkew.cases.length, 4);
    assert.equal(productionSkew.exactShards.itemCountPerShard, 1);
    assert.equal(productionSkew.exactShards.status, 'FAILED');
    assert.equal(productionSkew.exactShards.shards.length, 124);
    const staleShardNames = new Set(productionSkew.cases.map(item => item.shard));
    const exactShardNames = new Set(productionSkew.exactShards.shards);
    assert.equal(staleShardNames.size, 4);
    assert.equal(exactShardNames.size, 124);
    for (const shard of staleShardNames) assert.equal(exactShardNames.has(shard), false);
    assert.equal(new Set([...staleShardNames, ...exactShardNames]).size, 128);
    const nowMs = Date.now();
    const used = new Set();
    const allRecords = [];
    const currentByCollection = new Map();
    const staleEntries = [];
    const backupHashes = new Map();
    for (const item of productionSkew.cases) {
      const jobs = [];
      for (let index = 0; index < item.manifest.statusCounts.SUCCEEDED; index += 1) {
        jobs.push(terminalJob(
            findIdForShard(`prod-${item.shard}-s-${index}`, item.shard, used),
            nowMs - index,
            'SUCCEEDED',
        ));
      }
      const failedCount = item.currentItemCount - jobs.length;
      for (let index = 0; index < failedCount; index += 1) {
        jobs.push(terminalJob(
            findIdForShard(`prod-${item.shard}-f-${index}`, item.shard, used),
            nowMs - jobs.length - index,
            'FAILED',
        ));
      }
      const records = jobs.map(job => makeHistoryRecord(job, iso(nowMs)));
      const collection = `${history.AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}${item.shard}`;
      assert.equal(records.length, item.currentItemCount);
      assert.equal(history.automationJobHistoryStatusCounts(records).FAILED,
          item.manifest.statusCounts.FAILED + item.legitimateFailedRecordsAhead);
      currentByCollection.set(collection, records);
      allRecords.push(...records);
      const staleRecords = records.slice(0, item.manifest.itemCount);
      assert.deepEqual(
          history.automationJobHistoryStatusCounts(staleRecords),
          item.manifest.statusCounts,
      );
      staleEntries.push(manifestEntry(collection, staleRecords));
      writeRawCollection(root, collection, records);
      const primary = rawCollectionPath(root, collection);
      if (item.backupItemCounts.bak !== null) {
        const backup = `${primary}.bak`;
        fs.writeFileSync(backup, JSON.stringify(
            records.slice(0, item.backupItemCounts.bak),
        ), 'utf8');
        backupHashes.set(backup, sha256(fs.readFileSync(backup)));
      }
      if (item.backupItemCounts.bak2 !== null) {
        const backup = `${primary}.bak.2`;
        fs.writeFileSync(backup, JSON.stringify(
            records.slice(0, item.backupItemCounts.bak2),
        ), 'utf8');
        backupHashes.set(backup, sha256(fs.readFileSync(backup)));
      }
    }
    for (const [index, shard] of productionSkew.exactShards.shards.entries()) {
      const job = terminalJob(
          findIdForShard(`prod-${shard}-exact`, shard, used),
          nowMs - 1_000_000 - index,
          productionSkew.exactShards.status,
      );
      const records = [makeHistoryRecord(job, iso(nowMs))];
      const collection = `${history.AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}${shard}`;
      assert.equal(records.length, productionSkew.exactShards.itemCountPerShard);
      currentByCollection.set(collection, records);
      allRecords.push(...records);
      staleEntries.push(manifestEntry(collection, records));
      writeRawCollection(root, collection, records);
    }
    assert.equal(currentByCollection.size, productionSkew.expected.segmentsTotal);
    assert.equal(staleEntries.length, productionSkew.expected.segmentsTotal);
    assert.equal(
        allRecords.length,
        productionSkew.expected.authoritativeCurrent.archivedVersions,
    );
    assert.equal(
        seedAuthoritativeRecords(root, allRecords, { indexes: true }).size,
        productionSkew.expected.segmentsTotal,
    );
    const staleManifest = exactManifest(staleEntries, iso(nowMs), 9);
    assert.equal(
        staleManifest.archivedVersions,
        productionSkew.expected.manifestBeforeRepair.archivedVersions,
    );
    assert.deepEqual(
        staleManifest.statusCounts,
        productionSkew.expected.manifestBeforeRepair.statusCounts,
    );
    writeRawCollection(
        root,
        history.AUTOMATION_JOB_HISTORY_MANIFEST_NAME,
        [staleManifest],
    );
    const currentHashes = Object.fromEntries([...currentByCollection].map(([collection]) => [
      collection,
      sha256(fs.readFileSync(rawCollectionPath(root, collection))),
    ]));
    const firstPlan = await maintenance.planAutomationJobHistoryRepair();
    const secondPlan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(firstPlan.sourceFingerprint, secondPlan.sourceFingerprint);
    assert.equal(firstPlan.planFingerprint, secondPlan.planFingerprint);
    assert.equal(firstPlan.segmentsTotal, productionSkew.expected.segmentsTotal);
    assert.equal(firstPlan.segmentsPresent, productionSkew.expected.segmentsTotal);
    assert.equal(
        firstPlan.segmentsMatching,
        productionSkew.expected.segmentsMatchingBeforeRepair,
    );
    assert.equal(
        firstPlan.segmentsMismatched,
        productionSkew.expected.segmentsMismatchedBeforeRepair,
    );
    assert.equal(firstPlan.invalidSegments, 0);
    assert.equal(firstPlan.missingIndexRecords, 0);
    assert.equal(firstPlan.conflictingIndexRecords, 0);
    assert.equal(
        firstPlan.archivedVersions,
        productionSkew.expected.authoritativeCurrent.archivedVersions,
    );
    assert.deepEqual(
        firstPlan.statusTotals,
        productionSkew.expected.authoritativeCurrent.statusCounts,
    );
    assert.equal(firstPlan.safeToApply, true);
    const applied = await maintenance.applyAutomationJobHistoryRepair({
      expectedSourceFingerprint: firstPlan.sourceFingerprint,
      expectedPlanFingerprint: firstPlan.planFingerprint,
      nowMs: nowMs + 1_000,
    });
    assert.equal(applied.result, 'APPLIED');
    assert.equal(applied.manifestRebuilt, true);
    for (const [collection, records] of currentByCollection) {
      assert.equal(sha256(fs.readFileSync(rawCollectionPath(root, collection))), currentHashes[collection]);
      assert.equal((await history.readAutomationJobHistorySegment(collection)).itemCount, records.length);
    }
    for (const [backup, fingerprint] of backupHashes) {
      assert.equal(sha256(fs.readFileSync(backup)), fingerprint);
    }
    const repairedManifest = await history.readAutomationJobHistoryManifest();
    assert.equal(repairedManifest.segments.length, productionSkew.expected.segmentsTotal);
    assert.equal(
        repairedManifest.archivedVersions,
        productionSkew.expected.authoritativeCurrent.archivedVersions,
    );
    assert.deepEqual(
        repairedManifest.statusCounts,
        productionSkew.expected.authoritativeCurrent.statusCounts,
    );
    await assertStrictPass(productionSkew.expected.authoritativeCurrent.archivedVersions);
  });

  await test('13 missing idempotency record is deterministically reconstructed', async () => {
    const root = await scenario('13-missing-index');
    const job = terminalJob(findIdForShard('missing-index', '22'));
    const archived = await history.archiveAutomationJobHistory(job);
    const index = history.makeAutomationJobHistoryIdempotencyRecord(archived.record);
    const collection = history.automationJobHistoryIdempotencyCollection(index.keyDigest);
    const indexPrimary = rawCollectionPath(root, collection);
    assert.equal(fs.existsSync(`${indexPrimary}.bak`), false);
    fs.renameSync(indexPrimary, `${indexPrimary}.bak`);
    const second = terminalJob(findIdForShard('missing-index-new', '23'), Date.now() + 1_000, 'FAILED', {
      idempotencyKey: findIdempotencyKeyForCollection('v5-primary-only-index', collection),
    });
    const secondArchived = await history.archiveAutomationJobHistory(second);
    const secondIndex = history.makeAutomationJobHistoryIdempotencyRecord(secondArchived.record);
    const primaryOnly = await history.readAutomationJobHistoryIdempotencyIndex(collection);
    assert.deepEqual(primaryOnly.records.map(item => item.id), [secondIndex.id]);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(`${indexPrimary}.bak`, 'utf8')).map(item => item.id),
        [index.id],
    );
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.missingIndexRecords, 1);
    assert.equal(plan.safeToApply, true);
    const applied = await maintenance.applyAutomationJobHistoryRepair({
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    assert.equal(applied.indexRecordsCreated, 1);
    await assertStrictPass(2);
  });

  await test('14 exact matching idempotency record remains a no-op', async () => {
    await scenario('14-matching-index');
    const job = terminalJob(findIdForShard('matching-index', '23'));
    await history.archiveAutomationJobHistory(job);
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.matchingIndexRecords, 1);
    assert.equal(plan.missingIndexRecords, 0);
    assert.equal(plan.conflictingIndexRecords, 0);
    assert.equal(plan.noOp, true);
    await assertStrictPass(1);
  });

  await test('15 conflicting idempotency evidence fails closed', async () => {
    const root = await scenario('15-conflicting-index');
    const ghost = terminalJob(findIdForShard('orphan-index', '24'));
    const ghostRecord = makeHistoryRecord(ghost);
    const orphan = history.makeAutomationJobHistoryIdempotencyRecord(ghostRecord);
    writeRawCollection(
        root,
        history.automationJobHistoryIdempotencyCollection(orphan.keyDigest),
        [orphan],
    );
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.conflictingIndexRecords, 1);
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.recoveryClass, 'RED');
    const verifier = await maintenance.verifyV5HistoryInvariants();
    assert.equal(verifier.result, 'FAIL');
    await rejectsCode(
        () => maintenance.applyAutomationJobHistoryRepair({
          expectedSourceFingerprint: plan.sourceFingerprint,
          expectedPlanFingerprint: plan.planFingerprint,
        }),
        /HISTORY_REPAIR_UNSAFE_TO_APPLY/,
    );
  });

  await test('16 malformed current history record remains detectable', async () => {
    const root = await scenario('16-malformed-record');
    writeRawCollection(root, `${history.AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}00`, [{
      schemaVersion: 1,
      id: 'malformed',
      jobId: 'malformed',
    }]);
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.invalidSegments, 1);
    assert.equal(plan.safeToApply, false);
    assert.equal((await maintenance.verifyV5HistoryInvariants()).result, 'FAIL');
  });

  await test('17 invalid non-terminal history status remains detectable', async () => {
    const root = await scenario('17-invalid-status');
    const job = terminalJob(findIdForShard('invalid-status', '01'));
    const record = makeHistoryRecord(job);
    record.job.status = 'RUNNING';
    writeRawCollection(
        root,
        history.automationJobHistorySegmentCollection(job.id),
        [record],
    );
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.invalidSegments, 1);
    assert.equal(plan.recoveryClass, 'RED');
    assert.equal((await maintenance.verifyV5HistoryInvariants()).result, 'FAIL');
  });

  await test('18 oversized history shard fails the bounded invariant', async () => {
    const root = await scenario('18-oversized-shard');
    writeRawCollection(
        root,
        `${history.AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}02`,
        Array.from({ length: 1_025 }, (_, index) => ({ id: `oversized-${index}` })),
    );
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.invalidSegments, 1);
    assert.equal(plan.safeToApply, false);
    assert.equal((await maintenance.verifyV5HistoryInvariants()).result, 'FAIL');
  });

  await test('19 official repair dry-run makes zero writes', async () => {
    const root = await scenario('19-dry-run-zero-write');
    const job = terminalJob(findIdForShard('dry-run', '05'));
    seedAuthoritativeRecords(root, [makeHistoryRecord(job)]);
    const before = directorySnapshot(root);
    const result = await withTimeout(spawnNode(
        path.join(repositoryRoot, 'scripts', 'repair-automation-job-history.cjs'),
        ['--data-dir', root],
        { NODE_ENV: 'test', SANDEAL_STORAGE_DRIVER: 'file', ALLOW_PAID_AI: 'false' },
    ), 60_000, 'V5_HISTORY_REPAIR_DRY_RUN_TIMEOUT');
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /^HISTORY_REPAIR_DRY_RUN\r?$/m);
    assert.match(result.stdout, /^SEGMENTS_TOTAL=128\r?$/m);
    assert.match(result.stdout, /^SAFE_TO_APPLY=YES\r?$/m);
    assert.deepEqual(directorySnapshot(root), before);
  });

  await test('20 repair apply requires guards and converges only derived data', async () => {
    const root = await scenario('20-guarded-apply');
    const job = terminalJob(findIdForShard('guarded-apply', '06'));
    const record = makeHistoryRecord(job);
    seedAuthoritativeRecords(root, [record]);
    const repairScript = path.join(
        repositoryRoot,
        'scripts',
        'repair-automation-job-history.cjs',
    );
    const repairEnvironment = {
      NODE_ENV: 'test',
      SANDEAL_STORAGE_DRIVER: 'file',
      ALLOW_PAID_AI: 'false',
    };
    const beforeMissingGuard = directorySnapshot(root);
    const missingGuard = await withTimeout(
        spawnNode(repairScript, ['--apply', '--data-dir', root], repairEnvironment),
        60_000,
        'V5_HISTORY_REPAIR_MISSING_GUARD_TIMEOUT',
    );
    assert.equal(missingGuard.code, 1, `${missingGuard.stdout}\n${missingGuard.stderr}`);
    assert.equal(missingGuard.stdout, '');
    assert.deepEqual(JSON.parse(missingGuard.stderr.trim()), {
      schemaVersion: 1,
      program: 'SANDEAL_V5_2_ZERO_TOUCH',
      result: 'ERROR',
      errorCode: 'HISTORY_REPAIR_APPLY_FINGERPRINTS_REQUIRED',
    });
    assert.deepEqual(directorySnapshot(root), beforeMissingGuard);
    const sourceHash = sha256(fs.readFileSync(rawCollectionPath(
        root,
        history.automationJobHistorySegmentCollection(job.id),
    )));
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.missingIndexRecords, 1);
    assert.equal(plan.segmentsMismatched, 1);
    const applied = await withTimeout(spawnNode(repairScript, [
      '--apply',
      '--data-dir', root,
      '--source-fingerprint', plan.sourceFingerprint,
      '--plan-fingerprint', plan.planFingerprint,
    ], repairEnvironment), 60_000, 'V5_HISTORY_REPAIR_GUARDED_APPLY_TIMEOUT');
    assert.equal(applied.code, 0, `${applied.stdout}\n${applied.stderr}`);
    assert.equal(applied.stderr, '');
    assert.match(applied.stdout, /^HISTORY_REPAIR_APPLY\r?$/m);
    assert.match(applied.stdout, /^RESULT=APPLIED\r?$/m);
    assert.match(applied.stdout, /^INDEX_RECORDS_CREATED=1\r?$/m);
    assert.match(applied.stdout, /^MANIFEST_REBUILT=YES\r?$/m);
    assert.match(applied.stdout, /^STRICT_VERIFIER=PASS\r?$/m);
    assert.equal(applied.stdout.trim().split(/\r?\n/).at(-1), 'PASS');
    assert.equal(sha256(fs.readFileSync(rawCollectionPath(
        root,
        history.automationJobHistorySegmentCollection(job.id),
    ))), sourceHash);
    await assertStrictPass(1);
  });

  await test('21 repair apply aborts when authoritative source fingerprint changes', async () => {
    const root = await scenario('21-source-changed');
    const used = new Set();
    const first = terminalJob(findIdForShard('source-first', '07', used));
    const second = terminalJob(findIdForShard('source-second', '07', used));
    const firstRecord = makeHistoryRecord(first);
    const secondRecord = makeHistoryRecord(second);
    seedAuthoritativeRecords(root, [firstRecord]);
    const plan = await maintenance.planAutomationJobHistoryRepair();
    writeRawCollection(
        root,
        history.automationJobHistorySegmentCollection(first.id),
        [firstRecord, secondRecord],
    );
    await rejectsCode(
        () => maintenance.applyAutomationJobHistoryRepair({
          expectedSourceFingerprint: plan.sourceFingerprint,
          expectedPlanFingerprint: plan.planFingerprint,
        }),
        /HISTORY_REPAIR_SOURCE_FINGERPRINT_CHANGED/,
    );
    assert.equal((await history.readAutomationJobHistorySegment(
        history.automationJobHistorySegmentCollection(first.id),
    )).itemCount, 2);
  });

  await test('22 second successful repair apply is NO_OP', async () => {
    const root = await scenario('22-second-apply');
    const job = terminalJob(findIdForShard('second-apply', '08'));
    seedAuthoritativeRecords(root, [makeHistoryRecord(job)]);
    const repairScript = path.join(
        repositoryRoot,
        'scripts',
        'repair-automation-job-history.cjs',
    );
    const repairEnvironment = {
      NODE_ENV: 'test',
      SANDEAL_STORAGE_DRIVER: 'file',
      ALLOW_PAID_AI: 'false',
    };
    const firstPlan = await maintenance.planAutomationJobHistoryRepair();
    const first = await withTimeout(spawnNode(repairScript, [
      '--apply',
      '--data-dir', root,
      '--source-fingerprint', firstPlan.sourceFingerprint,
      '--plan-fingerprint', firstPlan.planFingerprint,
    ], repairEnvironment), 60_000, 'V5_HISTORY_REPAIR_FIRST_APPLY_TIMEOUT');
    assert.equal(first.code, 0, `${first.stdout}\n${first.stderr}`);
    assert.match(first.stdout, /^RESULT=APPLIED\r?$/m);
    assert.equal(first.stdout.trim().split(/\r?\n/).at(-1), 'PASS');
    const secondPlan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(secondPlan.noOp, true);
    const second = await withTimeout(spawnNode(repairScript, [
      '--apply',
      '--data-dir', root,
      '--source-fingerprint', secondPlan.sourceFingerprint,
      '--plan-fingerprint', secondPlan.planFingerprint,
    ], repairEnvironment), 60_000, 'V5_HISTORY_REPAIR_SECOND_APPLY_TIMEOUT');
    assert.equal(second.code, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(second.stderr, '');
    assert.match(second.stdout, /^HISTORY_REPAIR_APPLY\r?$/m);
    assert.match(second.stdout, /^RESULT=NO_OP\r?$/m);
    assert.match(second.stdout, /^INDEX_RECORDS_CREATED=0\r?$/m);
    assert.match(second.stdout, /^MANIFEST_REBUILT=NO\r?$/m);
    assert.match(second.stdout, /^STRICT_VERIFIER=PASS\r?$/m);
    assert.equal(second.stdout.trim().split(/\r?\n/).at(-1), 'NO_OP');
  });

  await test('23 strict shared verifier passes after official repair', async () => {
    const root = await scenario('23-strict-after-repair');
    const job = terminalJob(findIdForShard('strict-repair', '09'));
    seedAuthoritativeRecords(root, [makeHistoryRecord(job)]);
    const plan = await maintenance.planAutomationJobHistoryRepair();
    await maintenance.applyAutomationJobHistoryRepair({
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    const direct = await assertStrictPass(1);
    const command = await withTimeout(spawnNode(
        path.join(repositoryRoot, 'scripts', 'verify-v5-invariants.cjs'),
        ['history', '--data-dir', root],
        { NODE_ENV: 'test', SANDEAL_STORAGE_DRIVER: 'file', ALLOW_PAID_AI: 'false' },
    ), 60_000, 'V5_HISTORY_VERIFIER_TIMEOUT');
    assert.equal(command.code, 0, `${command.stdout}\n${command.stderr}`);
    const structured = JSON.parse(command.stdout);
    assert.equal(structured.result, 'PASS');
    assert.equal(structured.sourceFingerprint, direct.sourceFingerprint);
  });

  await test('24 persistent corruption stays RED and cannot be repaired by guessing', async () => {
    const root = await scenario('24-persistent-corruption');
    writeRawCollection(root, `${history.AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}0a`, [{
      schemaVersion: 99,
      opaque: 'persistent-invalid-fixture',
    }]);
    const first = await maintenance.planAutomationJobHistoryRepair();
    const second = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(first.planFingerprint, second.planFingerprint);
    assert.equal(first.recoveryClass, 'RED');
    assert.equal(first.safeToApply, false);
    await rejectsCode(
        () => maintenance.applyAutomationJobHistoryRepair({
          expectedSourceFingerprint: first.sourceFingerprint,
          expectedPlanFingerprint: first.planFingerprint,
        }),
        /HISTORY_REPAIR_UNSAFE_TO_APPLY/,
    );
    assert.equal((await maintenance.verifyV5HistoryInvariants()).result, 'FAIL');
  });

  await test('25 coordinated publication is deferred, never false-RED, then converges', async () => {
    await scenario('25-coordinated-publication');
    const job = terminalJob(findIdForShard('coordinated-publication', '0b'));
    let enteredResolve;
    let releaseResolve;
    let held = false;
    const entered = new Promise(resolve => { enteredResolve = resolve; });
    const release = new Promise(resolve => { releaseResolve = resolve; });
    history.setAutomationJobHistoryTestHookForTests(async input => {
      if (!held && input.phase === 'BEFORE_INDEX_COMMIT') {
        held = true;
        enteredResolve();
        await release;
      }
    });
    const archive = history.archiveAutomationJobHistory(job);
    try {
      await withTimeout(entered, 20_000, 'V5_HISTORY_COORDINATED_BARRIER_TIMEOUT');
      const during = await maintenance.verifyV5HistoryInvariants();
      assert.equal(during.recoveryClass, 'AMBER');
      assert.equal(during.result, 'DEFERRED');
      assert.ok(during.invariants.every(item => item.result !== 'FAIL'));
    } finally {
      releaseResolve();
      history.setAutomationJobHistoryTestHookForTests(undefined);
    }
    await withTimeout(archive, 20_000, 'V5_HISTORY_COORDINATED_ARCHIVE_TIMEOUT');
    await assertStrictPass(1);
  });

  await test('26 cross-process FileStorage coordinator serializes same-shard writers', async () => {
    const parent = await scenario('26-cross-process');
    const dataRoot = path.join(parent, 'data');
    fs.mkdirSync(dataRoot, { recursive: true });
    process.env.SANDEAL_DATA_DIR = dataRoot;
    const used = new Set();
    const jobs = [
      terminalJob(findIdForShard('cross-process-a', '5d', used)),
      terminalJob(findIdForShard('cross-process-b', '5d', used)),
    ];
    const outcomes = await runHistoryWorkers(
        dataRoot,
        jobs.map(job => [job]),
        'cross-process',
    );
    assert.equal(outcomes.length, 2);
    assert.equal(outcomes.reduce((sum, item) => sum + item.archived, 0), 2);
    const segment = await history.readAutomationJobHistorySegment(
        history.automationJobHistorySegmentCollection(jobs[0].id),
    );
    assert.equal(segment.itemCount, 2);
    assert.deepEqual(new Set(segment.records.map(record => record.jobId)), new Set(jobs.map(job => job.id)));
    await assertStrictPass(2);
  });

  await test('27 missing manifest primary ignores stale backup and rebuilds every current shard', async () => {
    const root = await scenario('27-missing-manifest-primary');
    const jobs = [
      terminalJob(findIdForShard('missing-primary-a', '31')),
      terminalJob(findIdForShard('missing-primary-b', '72')),
    ];
    const records = jobs.map(job => makeHistoryRecord(job));
    const bySegment = seedAuthoritativeRecords(root, records, { indexes: true });
    const firstCollection = history.automationJobHistorySegmentCollection(jobs[0].id);
    const staleBackup = exactManifest(
        [manifestEntry(firstCollection, bySegment.get(firstCollection))],
        iso(Date.now() - 60_000),
        41,
    );
    const manifestPrimary = rawCollectionPath(root, history.AUTOMATION_JOB_HISTORY_MANIFEST_NAME);
    fs.writeFileSync(`${manifestPrimary}.bak`, JSON.stringify([staleBackup]), 'utf8');
    assert.equal(fs.existsSync(manifestPrimary), false);

    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.segmentsPresent, 2);
    assert.equal(plan.segmentsMatching, 126);
    assert.equal(plan.segmentsMismatched, 2);
    assert.equal(plan.archivedVersions, 2);
    assert.equal(plan.statusTotals.FAILED, 2);
    assert.equal(plan.safeToApply, true);
    assert.equal(plan.recoveryClass, 'GREEN');

    const applied = await maintenance.applyAutomationJobHistoryRepair({
      expectedSourceFingerprint: plan.sourceFingerprint,
      expectedPlanFingerprint: plan.planFingerprint,
    });
    assert.equal(applied.result, 'APPLIED');
    const rebuilt = await history.readAutomationJobHistoryManifest();
    assert.equal(rebuilt.segments.length, 2);
    assert.deepEqual(
        rebuilt.segments.map(item => item.collection),
        jobs.map(job => history.automationJobHistorySegmentCollection(job.id)).sort(),
    );
    assert.equal(rebuilt.archivedVersions, 2);
    assert.equal(rebuilt.statusCounts.FAILED, 2);
    await assertStrictPass(2);
  });

  await test('28 unknown history job type and malformed index jobType stay RED', async () => {
    const historyRoot = await scenario('28-unknown-history-job-type');
    const unknownJob = terminalJob(
        findIdForShard('unknown-history-job-type', '4a'),
        Date.now(),
        'FAILED',
        { type: 'V5_UNKNOWN_JOB_TYPE' },
    );
    seedAuthoritativeRecords(historyRoot, [makeHistoryRecord(unknownJob)]);
    const historyPlan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(historyPlan.invalidSegments, 1);
    assert.equal(historyPlan.safeToApply, false);
    assert.equal(historyPlan.recoveryClass, 'RED');
    assert.equal((await maintenance.verifyV5HistoryInvariants()).result, 'FAIL');

    const indexRoot = await scenario('28-malformed-index-job-type');
    const validJob = terminalJob(findIdForShard('malformed-index-job-type', '4b'));
    const validRecord = makeHistoryRecord(validJob);
    seedAuthoritativeRecords(indexRoot, [validRecord]);
    const malformedIndex = {
      ...history.makeAutomationJobHistoryIdempotencyRecord(validRecord),
      jobType: 'V5_UNKNOWN_JOB_TYPE',
    };
    writeRawCollection(
        indexRoot,
        history.automationJobHistoryIdempotencyCollection(malformedIndex.keyDigest),
        [malformedIndex],
    );
    const indexPlan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(indexPlan.conflictingIndexRecords, 1);
    assert.equal(indexPlan.safeToApply, false);
    assert.equal(indexPlan.recoveryClass, 'RED');
    assert.equal((await maintenance.verifyV5HistoryInvariants()).result, 'FAIL');
  });

  await test('29 unreadable manifest primary stays RED even with a valid backup', async () => {
    const root = await scenario('29-unreadable-manifest-primary');
    const job = terminalJob(findIdForShard('unreadable-manifest-primary', '4c'));
    const record = makeHistoryRecord(job);
    seedAuthoritativeRecords(root, [record], { indexes: true });
    const collection = history.automationJobHistorySegmentCollection(job.id);
    const manifestPrimary = rawCollectionPath(root, history.AUTOMATION_JOB_HISTORY_MANIFEST_NAME);
    fs.writeFileSync(
        `${manifestPrimary}.bak`,
        JSON.stringify([exactManifest([manifestEntry(collection, [record])], iso(Date.now()), 7)]),
        'utf8',
    );
    fs.writeFileSync(manifestPrimary, '{"incomplete":', 'utf8');

    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.manifestStructuralValid, false);
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.recoveryClass, 'RED');
    assert.ok(plan.blockers.includes('BOUNDED_COLLECTION_INVALID_JSON'));
    assert.equal((await maintenance.verifyV5HistoryInvariants()).result, 'FAIL');
    await rejectsCode(
        () => maintenance.applyAutomationJobHistoryRepair({
          expectedSourceFingerprint: plan.sourceFingerprint,
          expectedPlanFingerprint: plan.planFingerprint,
        }),
        /HISTORY_REPAIR_UNSAFE_TO_APPLY/,
    );
  });

  await test('30 pending publication plus durable corruption stays RED', async () => {
    const root = await scenario('30-pending-intent-plus-corruption');
    const job = terminalJob(findIdForShard('pending-intent-corruption', '0c'));
    let fired = false;
    history.setAutomationJobHistoryTestHookForTests(input => {
      if (!fired && input.phase === 'BEFORE_INDEX_COMMIT') {
        fired = true;
        throw new Error('V5_HISTORY_PENDING_INTENT_FAULT');
      }
    });
    try {
      await rejectsCode(
          () => history.archiveAutomationJobHistory(job),
          /V5_HISTORY_PENDING_INTENT_FAULT/,
      );
    } finally {
      history.setAutomationJobHistoryTestHookForTests(undefined);
    }
    assert.equal(fired, true);
    assert.equal((await history.readAutomationJobHistoryPublicationIntents()).length, 1);
    writeRawCollection(root, `${history.AUTOMATION_JOB_HISTORY_SEGMENT_PREFIX}0d`, [{
      schemaVersion: 99,
      opaque: 'corruption-with-pending-publication',
    }]);

    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.pendingPublicationIntents, 1);
    assert.equal(plan.invalidSegments, 1);
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.recoveryClass, 'RED');
    const verifier = await maintenance.verifyV5HistoryInvariants();
    assert.equal(verifier.result, 'FAIL');
    assert.equal(verifier.recoveryClass, 'RED');
    await rejectsCode(
        () => maintenance.applyAutomationJobHistoryRepair({
          expectedSourceFingerprint: plan.sourceFingerprint,
          expectedPlanFingerprint: plan.planFingerprint,
        }),
        /HISTORY_REPAIR_UNSAFE_TO_APPLY/,
    );
  });

  await test('31 normal publication rebuilds a missing manifest from all current primary shards', async () => {
    const root = await scenario('31-normal-publication-missing-manifest');
    const existingJobs = [
      terminalJob(findIdForShard('normal-rebuild-existing-a', '14')),
      terminalJob(findIdForShard('normal-rebuild-existing-b', '6e')),
    ];
    const existingRecords = existingJobs.map(job => makeHistoryRecord(job));
    const bySegment = seedAuthoritativeRecords(root, existingRecords, { indexes: true });
    const firstCollection = history.automationJobHistorySegmentCollection(existingJobs[0].id);
    const staleBackup = exactManifest(
        [manifestEntry(firstCollection, bySegment.get(firstCollection))],
        iso(Date.now() - 60_000),
        41,
    );
    const manifestPrimary = rawCollectionPath(root, history.AUTOMATION_JOB_HISTORY_MANIFEST_NAME);
    const manifestBackup = `${manifestPrimary}.bak`;
    fs.writeFileSync(manifestBackup, JSON.stringify([staleBackup]), 'utf8');
    const staleBackupHash = sha256(fs.readFileSync(manifestBackup));
    assert.equal(fs.existsSync(manifestPrimary), false);

    const newJob = terminalJob(findIdForShard('normal-rebuild-new', '3d'));
    await history.archiveAutomationJobHistory(newJob);

    const manifest = await history.readAutomationJobHistoryManifest();
    const expectedCollections = [...existingJobs, newJob]
        .map(job => history.automationJobHistorySegmentCollection(job.id))
        .sort();
    assert.deepEqual(manifest.segments.map(item => item.collection), expectedCollections);
    assert.equal(manifest.archivedVersions, 3);
    assert.equal(manifest.statusCounts.FAILED, 3);
    assert.equal(manifest.manifestGeneration, 1);
    assert.equal(sha256(fs.readFileSync(manifestBackup)), staleBackupHash);
    assert.equal(JSON.parse(fs.readFileSync(manifestBackup, 'utf8'))[0].manifestGeneration, 41);
    await assertStrictPass(3);
  });

  await test('32 idempotency lookup resolves the exact archived version for an older key', async () => {
    await scenario('32-exact-version-lookup');
    const nowMs = Date.now();
    const jobId = findIdForShard('versioned-job-id', '25');
    const older = terminalJob(jobId, nowMs - 120_000, 'SUCCEEDED', {
      idempotencyKey: 'v5-history-versioned-key-older',
      operationId: 'v5-history-versioned-operation-older',
      result: { fixture: true, version: 'older' },
    });
    const newer = terminalJob(jobId, nowMs, 'SUCCEEDED', {
      idempotencyKey: 'v5-history-versioned-key-newer',
      operationId: 'v5-history-versioned-operation-newer',
      result: { fixture: true, version: 'newer' },
    });
    await history.archiveAutomationJobHistory(older, { nowMs: nowMs - 90_000 });
    await history.archiveAutomationJobHistory(newer, { nowMs });

    const latest = await history.getArchivedAutomationJob(jobId);
    assert.equal(
        history.automationJobHistoryFingerprint(latest),
        history.automationJobHistoryFingerprint(newer),
    );
    const resolvedOlder = await history.getArchivedSuccessfulAutomationJob(
        older.type,
        older.idempotencyKey,
        nowMs + 1_000,
    );
    assert.equal(
        history.automationJobHistoryFingerprint(resolvedOlder),
        history.automationJobHistoryFingerprint(older),
    );
    assert.equal(resolvedOlder.result.version, 'older');
    assert.notEqual(
        history.automationJobHistoryFingerprint(resolvedOlder),
        history.automationJobHistoryFingerprint(newer),
    );
    await assertStrictPass(2);
  });

  await test('33 conflicting and duplicate exact index evidence fails closed', async () => {
    const conflictRoot = await scenario('33-index-field-conflict');
    const conflictJob = terminalJob(
        findIdForShard('index-field-conflict', '26'),
        Date.now(),
        'SUCCEEDED',
    );
    const archived = await history.archiveAutomationJobHistory(conflictJob);
    const expectedIndex = history.makeAutomationJobHistoryIdempotencyRecord(archived.record);
    const conflictingIndex = {
      ...expectedIndex,
      // Deliberately outside retention: readers must validate exact durable
      // evidence before applying semantic retention filters.
      completedAt: iso(Date.parse(expectedIndex.completedAt) - 40 * 24 * 60 * 60_000),
      archivedAt: iso(Date.parse(expectedIndex.archivedAt) + 1_000),
    };
    writeRawCollection(
        conflictRoot,
        history.automationJobHistoryIdempotencyCollection(expectedIndex.keyDigest),
        [conflictingIndex],
    );
    await rejectsCode(
        () => history.getArchivedSuccessfulAutomationJob(
            conflictJob.type,
            conflictJob.idempotencyKey,
            Date.now() + 2_000,
        ),
        /AUTOMATION_JOB_HISTORY_INDEX_CONFLICT/,
    );
    const conflictPlan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(conflictPlan.conflictingIndexRecords, 1);
    assert.equal(conflictPlan.safeToApply, false);
    assert.equal(conflictPlan.recoveryClass, 'RED');

    const duplicateRoot = await scenario('33-duplicate-index-id');
    const duplicateJob = terminalJob(
        findIdForShard('duplicate-index-id', '27'),
        Date.now(),
        'SUCCEEDED',
    );
    const duplicateArchived = await history.archiveAutomationJobHistory(duplicateJob);
    const duplicateIndex = history.makeAutomationJobHistoryIdempotencyRecord(
        duplicateArchived.record,
    );
    writeRawCollection(
        duplicateRoot,
        history.automationJobHistoryIdempotencyCollection(duplicateIndex.keyDigest),
        [duplicateIndex, duplicateIndex],
    );
    await rejectsCode(
        () => history.getArchivedSuccessfulAutomationJob(
            duplicateJob.type,
            duplicateJob.idempotencyKey,
            Date.now() + 2_000,
        ),
        /AUTOMATION_JOB_HISTORY_INDEX_DUPLICATE_RECORD/,
    );
    const duplicatePlan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(duplicatePlan.conflictingIndexRecords, 1);
    assert.equal(duplicatePlan.safeToApply, false);
    assert.equal(duplicatePlan.recoveryClass, 'RED');
  });

  await test('34 malformed completedAt is classified RED before repair apply', async () => {
    const root = await scenario('34-malformed-completed-at');
    const job = terminalJob(findIdForShard('malformed-completed-at', '28'));
    const malformedRecord = makeHistoryRecord(job);
    malformedRecord.job.completedAt = 'not-a-valid-timestamp';
    writeRawCollection(
        root,
        history.automationJobHistorySegmentCollection(job.id),
        [malformedRecord],
    );
    const plan = await maintenance.planAutomationJobHistoryRepair();
    assert.equal(plan.invalidSegments, 1);
    assert.equal(plan.safeToApply, false);
    assert.equal(plan.recoveryClass, 'RED');
    const verifier = await maintenance.verifyV5HistoryInvariants();
    assert.equal(verifier.result, 'FAIL');
    assert.equal(verifier.recoveryClass, 'RED');
  });

  process.stdout.write(`V5 history durability: ${passed} passed, ${failed} failed\n`);
  if (failed) {
    process.stderr.write(`V5 history durability artifacts retained at ${suiteRoot}\n`);
    process.exitCode = 1;
    return;
  }
  const resolvedSuiteRoot = path.resolve(suiteRoot);
  if (path.dirname(resolvedSuiteRoot) !== allowedTempRoot) {
    throw new Error('V5_HISTORY_UNSAFE_TEST_CLEANUP');
  }
  fs.rmSync(resolvedSuiteRoot, { recursive: true, force: true });
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
});
