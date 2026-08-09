/* eslint-disable @typescript-eslint/no-require-imports */
const process = require('node:process');

require('./register-typescript.cjs');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find(entry => entry.startsWith(prefix));
  return value ? value.slice(prefix.length).trim() : '';
}

function sanitizedAffiliateShape(value) {
  try {
    const url = new URL(value);
    const segments = url.pathname.split('/').filter(Boolean).map(segment => (
      segment.length > 32 || /^[A-Za-z0-9_-]{20,}$/.test(segment) ? ':redacted' : segment.slice(0, 80)
    ));
    return { host: url.hostname.toLowerCase(), path: `/${segments.join('/')}` };
  } catch {
    return undefined;
  }
}

async function main() {
  const { getRawPrimaryCredentialValue } = require('../src/lib/storage/tokenVault.ts');
  const {
    AccessTradeTikTokError,
    createAccessTradeTikTokAffiliateLink,
    searchAccessTradeTikTokProducts,
  } = require('../src/lib/integrations/accesstradeTikTokShop.ts');
  const credential = await getRawPrimaryCredentialValue('accesstrade');
  if (!credential) {
    console.log(JSON.stringify({
      tokenAvailable: false,
      requestStatus: 'NOT_RUN',
      productCount: 0,
      distinctShopCount: 0,
      productsWithTitle: 0,
      productsWithImage: 0,
      productsWithValidPrice: 0,
      productsWithProductUrl: 0,
      nextPageTokenPresent: false,
      samples: [],
    }, null, 2));
    console.log('LIVE_PROBE_CLASSIFICATION=NOT_RUN_NO_LOCAL_TOKEN');
    return;
  }
  const keyword = (argument('keyword') || 'tai nghe').slice(0, 160);
  const createLink = process.argv.includes('--create-link');
  try {
    const result = await searchAccessTradeTikTokProducts({
      titleKeywords: [keyword],
      sortStrategy: 'RECOMMENDED',
      limit: 10,
      maximumPages: 1,
      rawItemBudget: 10,
      acceptedItemBudget: 10,
      mode: 'probe',
    }, { credential, circuit: false });
    const products = result.items;
    let affiliateProbe;
    if (createLink && products[0]) {
      const link = await createAccessTradeTikTokAffiliateLink({
        productUrl: products[0].originalUrl,
        productId: products[0].id,
        tracking: { utmSource: 'sandeal', utmMedium: 'diagnostic', utmCampaign: 'live_probe' },
      }, { credential, circuit: false });
      affiliateProbe = { attempted: true, valid: true, ...sanitizedAffiliateShape(link.url) };
    }
    console.log(JSON.stringify({
      tokenAvailable: true,
      requestStatus: result.requests.at(-1)?.statusCode || 'SUCCESS',
      productCount: products.length,
      distinctShopCount: new Set(products.map(product => product.merchantIdentity)).size,
      productsWithTitle: products.filter(product => Boolean(product.name)).length,
      productsWithImage: products.filter(product => Boolean(product.imageUrl)).length,
      productsWithValidPrice: products.filter(product => Number(product.currentPrice) > 0).length,
      productsWithProductUrl: products.filter(product => Boolean(product.originalUrl)).length,
      nextPageTokenPresent: result.diagnostics.nextPageTokenPresent,
      samples: products.slice(0, 3).map(product => ({
        productId: product.id,
        title: product.name.slice(0, 160),
        shop: product.shopName || product.shopId || product.merchantIdentity,
      })),
      affiliateProbe: affiliateProbe || { attempted: false },
    }, null, 2));
    console.log('LIVE_PROBE_CLASSIFICATION=PASS');
  } catch (error) {
    console.log(JSON.stringify({
      tokenAvailable: true,
      requestStatus: error instanceof AccessTradeTikTokError ? error.resultType : 'FAILED',
      productCount: 0,
      distinctShopCount: 0,
      samples: [],
    }, null, 2));
    console.log('LIVE_PROBE_CLASSIFICATION=FAIL');
    process.exitCode = 1;
  }
}

main().catch(() => {
  console.log(JSON.stringify({ tokenAvailable: false, requestStatus: 'FAILED', productCount: 0, distinctShopCount: 0, samples: [] }, null, 2));
  console.log('LIVE_PROBE_CLASSIFICATION=FAIL');
  process.exitCode = 1;
});
