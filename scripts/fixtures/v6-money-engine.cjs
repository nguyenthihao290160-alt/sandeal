/* eslint-disable @typescript-eslint/no-require-imports */
const { fixture } = require('../lib/cloudflare-autopilot-test.cjs');
const { AccessTradeAffiliateProvider, AccessTradeTikTokAffiliateProvider } = require('../../src/lib/affiliate/accessTradeProviders.ts');
const { ShopeeAffiliateProvider } = require('../../src/lib/affiliate/shopeeAffiliateProvider.ts');
const { D1AffiliateStore } = require('../../src/lib/storage/d1/d1AffiliateStore.ts');
const { discoverNormalizedOffers } = require('../../src/lib/affiliate/money/offers.ts');
const { prepareMoneyRedirect } = require('../../src/lib/affiliate/money/redirect.ts');
const { syncMoneyEvidence } = require('../../src/lib/affiliate/money/providers.ts');
const { normalizeAccessTradeItem } = require('../../src/lib/integrations/accesstrade.ts');
const { createCloudflareSchedulerAdapter } = require('../../src/lib/platform/cloudflareAdapters.ts');
const { consumeDelivery } = require('../../src/lib/runtime/cloudflare/autopilot.ts');
const { delivery } = require('../lib/cloudflare-autopilot-test.cjs');

const TEST_ORIGIN = 'TEST_FIXTURE';
async function moneyFixture(work) {
  await fixture(async context => {
    const calls = { discovery:0, resolution:0, conversion:0, commission:0, shopee:0 };
    const time = new Date(context.now).toISOString();
    function source(provider) {
      const item = { id:`${provider}-offer`,name:'Explicit development fixture',canonicalProductUrl:context.product.originalUrl,
        originalUrl:context.product.originalUrl,affiliateUrl:`https://merchant.example/products/${context.product.id}?affiliate=${provider}-test`,
        price:1500000,salePrice:1200000,merchantDomain:'merchant.example',platform:provider === 'tiktok' ? 'tiktok_shop' : 'other',available:true,verifiedSource:true,
        affiliateUrlSource:'provider_api',affiliateUrlStatus:'available',affiliateUrlFetchedAt:time,fetchedAt:time,
        affiliateUrlCampaignId:`${provider}-campaign`,source:provider === 'tiktok' ? 'accesstrade_tiktok_shop' : 'accesstrade' };
      return { item,id:provider,async isConfigured(){return true;},async healthCheck(){return {status:'ready',ready:true,configured:true,credentialsPresent:true,checkedAt:time};},
        async discover(){calls.discovery++;return {items:[item],requests:1};},normalize(value){return value;},classifyError(){return 'degraded';} };
    }
    const accesstrade = new AccessTradeAffiliateProvider(source('accesstrade'));
    const tiktok = new AccessTradeTikTokAffiliateProvider(source('tiktok'),async input => {
      calls.resolution++;
      return {url:`https://merchant.example/products/${context.product.id}?affiliate=tiktok-test&sub1=${input.tracking.sub1}`,fetchedAt:new Date().toISOString()};
    });
    const shopee = new ShopeeAffiliateProvider({});
    const money = new D1AffiliateStore(context.db,true);
    const providers = [accesstrade,tiktok];
    async function seed() {
      for (const provider of providers) {
        await money.observeProvider({health:await provider.healthCheck(),capabilities:provider.getCapabilities(),origin:TEST_ORIGIN});
        await discoverNormalizedOffers(provider,context.adapter.domain,{limit:2,origin:TEST_ORIGIN,testOnly:true});
      }
      return (await context.adapter.domain.getProduct(context.product.id)).value;
    }
    async function click(providerResolvers = []) {
      return prepareMoneyRedirect(new Request(`https://sandeal.test/go/${context.product.id}`),await context.adapter.domain.getProduct(context.product.id),money,['merchant.example'],providerResolvers);
    }
    async function seedShopee() {
      const canonicalUrl='https://shopee.vn/test-only-money-fixture';
      const previous=await context.adapter.domain.getProduct(context.product.id);
      const updated=await context.adapter.domain.replaceProduct({...previous.value,originalUrl:canonicalUrl,offers:[]},previous.version);
      if(updated.status!=='APPLIED')throw new Error('FIXTURE_PRODUCT_UPDATE_FAILED');
      const adapter=source('accesstrade');
      const raw={__sandealEndpoint:'datafeed',__sandealFetchedAt:time,product_id:'fixture-shopee-item',name:'Test-only wireless headphones',
        url:canonicalUrl,aff_link:`https://go.isclix.com/deep_link/fixture?url=${encodeURIComponent(canonicalUrl)}`,
        image:'https://images.example/test-only-headphones.jpg',price:1500000,discount:1200000,available:true,
        domain:'shopee.vn',shop_id:'fixture-shop',campaign_id:'fixture-shopee-campaign'};
      Object.assign(adapter.item,normalizeAccessTradeItem(raw));
      const provider=new AccessTradeAffiliateProvider(adapter);
      await money.observeProvider({health:await provider.healthCheck(),capabilities:provider.getCapabilities(),origin:TEST_ORIGIN});
      await discoverNormalizedOffers(provider,context.adapter.domain,{limit:2,origin:TEST_ORIGIN,testOnly:true});
      return {provider,adapter,raw,product:(await context.adapter.domain.getProduct(context.product.id)).value,
        allowedHosts:['shopee.vn','go.isclix.com'],canonicalUrl};
    }
    function evidenceProvider(providerId, conversions = [], commissions = []) {
      const original = providers.find(provider => provider.id === providerId);
      return {id:providerId,contractVersion:original.contractVersion,healthCheck:()=>original.healthCheck(),
        getCapabilities:()=>({...original.getCapabilities(),conversionEvidence:true,commissionEvidence:true}),
        async syncTransactions(){calls.conversion++;return {ok:true,provider:providerId,data:{records:conversions,requestCount:1}};},
        async syncCommissions(){calls.commission++;return {ok:true,provider:providerId,data:{records:commissions,requestCount:1}};} };
    }
    function conversion(clickValue, overrides={}) {return {eventId:'fixture-conversion-event',externalId:'fixture-order',attributionReference:clickValue.id,occurredAt:new Date().toISOString(),...overrides};}
    function commission(overrides={}) {return {eventId:'fixture-commission-event',externalId:'fixture-commission',conversionExternalId:'fixture-order',revision:1,state:'PENDING',amountMinor:25000,currency:'VND',occurredAt:new Date().toISOString(),...overrides};}
    async function evidence(clickValue, conversionValue=conversion(clickValue), commissionValue=commission()) {
      const provider = evidenceProvider(clickValue.provider,[conversionValue],[commissionValue]);
      const converted = await syncMoneyEvidence(provider,money,'CONVERSION',{limit:20},TEST_ORIGIN);
      const commissioned = await syncMoneyEvidence(provider,money,'COMMISSION',{limit:20},TEST_ORIGIN);
      return {provider,converted,commissioned,conversionValue,commissionValue};
    }
    async function snapshot(key='revenue-fixture') {
      const job = (await context.store.createJob({type:'AGGREGATE_GROWTH_METRICS',payload:{productId:'revenue-all'},idempotencyKey:key},Date.now())).job;
      const message = context.message(job);
      const result = await consumeDelivery(message,context.env,{moneyTestOnly:true});
      return {job,message,result};
    }
    async function scheduledSnapshot() {
      const now=Date.now();
      await context.store.createTask({id:'money-snapshot',type:'AGGREGATE_GROWTH_METRICS',payload:{productId:'revenue-all'},enabled:true,nextRunAt:now,intervalMs:300000});
      const scheduler=createCloudflareSchedulerAdapter(context.env);
      await scheduler.tick(now); await scheduler.tick(now);
      const message=delivery(context.sent[0]);
      const result=await consumeDelivery(message,context.env,{moneyTestOnly:true});
      return {message,result};
    }
    const day=new Date().toISOString().slice(0,10);
    function revenue(scope='PRODUCT',scopeId=context.product.id,currency='VND') {return money.revenue({scope,scopeId,currency,from:day,to:day});}
    await work({...context,calls,money,providers,accesstrade,tiktok,shopee,seed,seedShopee,click,evidenceProvider,conversion,commission,evidence,snapshot,scheduledSnapshot,revenue,day,origin:TEST_ORIGIN});
  });
}
module.exports={moneyFixture};
