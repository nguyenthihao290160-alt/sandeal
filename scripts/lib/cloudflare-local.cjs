/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const path = require('node:path');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');
const { root } = require('../v6-run-state.cjs');
const { buildWorker } = require('../v6-cloudflare-build.cjs');
async function openWorker({ bindings = {}, database = true, assets = false, queue = false, port = 0 } = {}) {
  const built = await buildWorker();
  const routing = JSON.parse(fs.readFileSync(path.join(root, 'config/cloudflare/wrangler.runtime.local.jsonc'), 'utf8')).assets;
  const options = { name: 'sandeal-local-proof', host: '127.0.0.1', port, modules: true, scriptPath: built.file,
    compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
    bindings: { SANDEAL_RUNTIME: 'cloudflare', SANDEAL_LOCAL_ONLY: 'true', SANDEAL_PRODUCTION: 'false', SHOPEE_AFFILIATE_ENABLED: 'false', ...bindings },
    ...(database ? { d1Databases: ['DB'] } : {}),
    ...(assets ? { assets: { directory: path.join(root, 'cloudflare/site/out'), binding: 'ASSETS', run_worker_first: routing.run_worker_first,
      routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: '404-page' } } } : {}),
    ...(queue ? { queueProducers: { JOB_QUEUE: 'sandeal-local-jobs' }, queueConsumers: { 'sandeal-local-jobs': { maxBatchSize: 10, maxBatchTimeout: 1, maxRetries: 3 } } } : {}),
  };
  const mf = new Miniflare(convertV4MiniflareOptions(options));
  try {
    await mf.ready;
    const db = database ? (await mf.getBindings()).DB : null;
    if (db) {
      for (const name of fs.readdirSync(path.join(root, 'src/lib/storage/d1/migrations')).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort()) {
        const statements = fs.readFileSync(path.join(root, 'src/lib/storage/d1/migrations', name), 'utf8')
          .split('-- statement-breakpoint').map(sql => sql.trim()).filter(sql => sql && !/^--[^\n]*$/.test(sql));
        await db.batch(statements.map(sql => db.prepare(sql)));
      }
    }
    return { mf, db, built, fetch: (pathname, init) => mf.dispatchFetch(`http://localhost${pathname}`, init), dispose: () => mf.dispose() };
  } catch (error) { await mf.dispose(); throw error; }
}
module.exports = { openWorker };
