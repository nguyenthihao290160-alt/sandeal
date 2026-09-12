/* eslint-disable @typescript-eslint/no-require-imports */
// Local event server only. No deployment/authentication command is accepted.
require('./register-typescript.cjs');
const { openWorker } = require('./lib/cloudflare-local.cjs');
const { cloudflareProduct } = require('./fixtures/v6-cloudflare-product.cjs');
const { createD1StorageAdapter } = require('../src/lib/storage/d1/d1StorageAdapter.ts');
async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--fixture') || process.argv.length > 3) throw new Error('LOCAL_ONLY_ARGUMENTS_REQUIRED');
  const runtime = await openWorker({ assets: true, port: 8787 });
  if (process.argv.includes('--fixture')) {
    const adapter = createD1StorageAdapter(runtime.db);
    await adapter.domain.createProduct(cloudflareProduct());
    console.log('SOURCE_TYPE=PRODUCTION_SHAPED_FIXTURE SOURCE_IS_AUTHORITATIVE=NO');
  }
  console.log('SANDEAL_RUNTIME=cloudflare REMOTE=false PRODUCTION=false URL=http://127.0.0.1:8787');
  // Ephemeral development data disappears when this explicitly started dev server closes.
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { runtime.dispose().then(() => process.exit(0)); });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
