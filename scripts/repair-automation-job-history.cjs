/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');

const SHA256 = /^[a-f0-9]{64}$/;

function safeErrorCode(error) {
  const explicit = error && typeof error === 'object' && typeof error.code === 'string'
    ? error.code
    : error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{1,95}$/.test(explicit)
    ? explicit
    : 'HISTORY_REPAIR_FAILED';
}

function parseArguments(argv) {
  let apply = false;
  let dataDir;
  let sourceFingerprint;
  let planFingerprint;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--apply') {
      if (apply) throw new Error('HISTORY_REPAIR_ARGUMENT_DUPLICATE');
      apply = true;
      continue;
    }
    if (['--data-dir', '--source-fingerprint', '--plan-fingerprint'].includes(item)) {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error('HISTORY_REPAIR_ARGUMENT_VALUE_REQUIRED');
      }
      const value = argv[index + 1];
      if (item === '--data-dir') {
        if (dataDir !== undefined) throw new Error('HISTORY_REPAIR_ARGUMENT_DUPLICATE');
        dataDir = value;
      } else if (item === '--source-fingerprint') {
        if (sourceFingerprint !== undefined) throw new Error('HISTORY_REPAIR_ARGUMENT_DUPLICATE');
        sourceFingerprint = value;
      } else {
        if (planFingerprint !== undefined) throw new Error('HISTORY_REPAIR_ARGUMENT_DUPLICATE');
        planFingerprint = value;
      }
      index += 1;
      continue;
    }
    throw new Error('HISTORY_REPAIR_ARGUMENT_UNKNOWN');
  }
  if (apply) {
    if (!SHA256.test(sourceFingerprint || '') || !SHA256.test(planFingerprint || '')) {
      throw new Error('HISTORY_REPAIR_APPLY_FINGERPRINTS_REQUIRED');
    }
  } else if (sourceFingerprint !== undefined || planFingerprint !== undefined) {
    throw new Error('HISTORY_REPAIR_DRY_RUN_FINGERPRINT_FORBIDDEN');
  }
  return { apply, dataDir, sourceFingerprint, planFingerprint };
}

function printDryRun(plan) {
  const lines = [
    'HISTORY_REPAIR_DRY_RUN',
    `SEGMENTS_TOTAL=${plan.segmentsTotal}`,
    `SEGMENTS_MATCHING=${plan.segmentsMatching}`,
    `SEGMENTS_MISMATCHED=${plan.segmentsMismatched}`,
    `MISSING_INDEX_RECORDS=${plan.missingIndexRecords}`,
    `CONFLICTING_INDEX_RECORDS=${plan.conflictingIndexRecords}`,
    `INVALID_SEGMENTS=${plan.invalidSegments}`,
    `RECOVERY_CLASS=${plan.recoveryClass}`,
    `AUTO_MAINTENANCE_ELIGIBLE=${plan.automaticMaintenanceEligible ? 'YES' : 'NO'}`,
    `MISMATCH_SUMMARY_JSON=${JSON.stringify(plan.mismatchSummary)}`,
    `SOURCE_FINGERPRINT=${plan.sourceFingerprint}`,
    `PLAN_FINGERPRINT=${plan.planFingerprint}`,
    `SAFE_TO_APPLY=${plan.safeToApply ? 'YES' : 'NO'}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printApply(result) {
  const lines = [
    'HISTORY_REPAIR_APPLY',
    `RESULT=${result.result}`,
    `SOURCE_FINGERPRINT=${result.sourceFingerprint}`,
    `PLAN_FINGERPRINT=${result.planFingerprint}`,
    `INDEX_RECORDS_CREATED=${result.indexRecordsCreated}`,
    `MANIFEST_REBUILT=${result.manifestRebuilt ? 'YES' : 'NO'}`,
    `INTENTS_COMPLETED=${result.intentsCompleted}`,
    `STRICT_VERIFIER=${result.verifierResult}`,
  ];
  if (result.result === 'NO_OP') lines.push('NO_OP');
  else if (result.verifierResult === 'PASS') lines.push('PASS');
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.dataDir !== undefined) {
    if (!options.dataDir.trim()) throw new Error('HISTORY_REPAIR_DATA_DIR_INVALID');
    process.env.SANDEAL_DATA_DIR = path.resolve(options.dataDir);
  }
  require('./register-typescript.cjs');
  const {
    applyAutomationJobHistoryRepair,
    planAutomationJobHistoryRepair,
  } = require('../src/lib/automation/jobHistoryMaintenance.ts');
  if (!options.apply) {
    const plan = await planAutomationJobHistoryRepair();
    printDryRun(plan);
    if (!plan.safeToApply) process.exitCode = 2;
    return;
  }
  const result = await applyAutomationJobHistoryRepair({
    expectedSourceFingerprint: options.sourceFingerprint,
    expectedPlanFingerprint: options.planFingerprint,
  });
  printApply(result);
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify({
    schemaVersion: 1,
    program: 'SANDEAL_V5_2_ZERO_TOUCH',
    result: 'ERROR',
    errorCode: safeErrorCode(error),
  })}\n`);
  process.exitCode = 1;
});
