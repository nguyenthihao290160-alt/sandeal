/* eslint-disable @typescript-eslint/no-require-imports */
const path = require('node:path');

require('./register-typescript.cjs');

const { getAllProducts } = require(path.join(process.cwd(), 'src/lib/storage/products.ts'));
const { createAutomationJob } = require(path.join(process.cwd(), 'src/lib/automation/store.ts'));

const apply = process.argv.includes('--apply');
const confirmed = process.argv.includes('--confirm-enqueue');
const operationArgument = process.argv.find(value => value.startsWith('--operation-id='));
const operationId = operationArgument ? operationArgument.slice('--operation-id='.length).trim() : '';
const limitArgument = process.argv.find(value => value.startsWith('--limit='));
const limit = Math.max(1, Math.min(100, Number(limitArgument?.slice('--limit='.length)) || 100));

async function main() {
  const products = (await getAllProducts()).sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit);
  const summary = {
    mode: apply ? 'enqueue' : 'dry-run',
    recordsFound: products.length,
    limit,
    operationId: operationId || null,
    productIds: products.map(product => product.id),
    alreadyProcessed: operationId ? products.filter(product => product.lastReprocessOperationId === operationId).length : 0,
    hardDeletes: 0,
    auditCollection: 'product-reprocess-audit',
  };
  if (!apply) {
    console.log(JSON.stringify({ ...summary, writePerformed: false }, null, 2));
    return;
  }
  if (!confirmed || !/^[a-zA-Z0-9._:-]{8,120}$/.test(operationId)) {
    throw new Error('APPLY_REQUIRES_CONFIRM_ENQUEUE_AND_VALID_OPERATION_ID');
  }
  const created = await createAutomationJob({
    type: 'RECHECK_PRODUCT_HEALTH',
    payload: {
      productIds: products.map(product => product.id),
      limit: products.length || 1,
      healthTarget: 'all',
      trigger: 'operator_reprocess',
      noDelete: true,
    },
    idempotencyKey: `product-reprocess:${operationId}`.slice(0, 160),
    operationId,
    requestedBy: 'operator-reprocess-cli',
    riskLevel: 'MEDIUM',
    dryRun: false,
    maxAttempts: 3,
  });
  console.log(JSON.stringify({
    ...summary,
    writePerformed: created.created,
    jobId: created.job.id,
    jobStatus: created.job.status,
    enqueueCode: created.code,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'REPROCESS_ENQUEUE_FAILED');
  process.exitCode = 1;
});
