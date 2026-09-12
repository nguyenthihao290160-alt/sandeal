/* eslint-disable @typescript-eslint/no-require-imports */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {moneyFixture}=require('./fixtures/v6-money-engine.cjs');
const {normalizeAffiliateOffer,discoverNormalizedOffers,persistNormalizedOffers}=require('../src/lib/affiliate/money/offers.ts');
const {selectMoneyRoute}=require('../src/lib/affiliate/money/router.ts');
const {syncMoneyEvidence,resolveMoneyDestination}=require('../src/lib/affiliate/money/providers.ts');
const {prepareMoneyRedirect}=require('../src/lib/affiliate/money/redirect.ts');
const {D1AffiliateStore}=require('../src/lib/storage/d1/d1AffiliateStore.ts');
const {MoneyError,MONEY_LIMITS}=require('../src/lib/affiliate/money/types.ts');
const {consumeDelivery}=require('../src/lib/runtime/cloudflare/autopilot.ts');
const {cloudflareFetch}=require('../src/lib/runtime/cloudflare/http.ts');
const {ShopeeAffiliateProvider}=require('../src/lib/affiliate/shopeeAffiliateProvider.ts');
const {recordEvidence}=require('./v6-run-state.cjs');
let passed=0,failed=0;
async function test(name,work){try{await moneyFixture(work);passed++;console.log(`PASS ${name}`);}catch(error){failed++;console.error(`FAIL ${name}`,error);}}
async function main(){
  await test('one canonical product holds normalized AccessTrade and TikTok offers with unknown commissions',async context=>{
    const product=await context.seed(); const offers=product.offers.filter(offer=>offer.monetization).map(offer=>offer.monetization);
    assert.equal(offers.length,2);assert.equal(new Set(offers.map(offer=>offer.productId)).size,1);
    assert.deepEqual(offers.map(offer=>offer.provider).sort(),['accesstrade','tiktok']);
    for(const offer of offers){assert.equal(offer.commissionRate,null);assert.equal(offer.commissionAmountEstimate,null);assert.equal('sourcePayload' in offer,false);}
    for(const offer of product.offers.filter(offer=>offer.monetization)){assert.equal(offer.confidence,1);assert.equal(offer.monetization.sourceConfidence,100);}
    await context.seed();assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM products').first()).count,1);
    assert.equal((await context.adapter.domain.getProduct(context.product.id)).value.offers.filter(offer=>offer.monetization).length,2);
  });
  await test('deterministic money router ranks safe candidates without fabricated performance',async context=>{
    const product=await context.seed(),health=await context.money.providers(),now=Date.now();
    const first=selectMoneyRoute(product,health,['merchant.example'],now);
    const reversed=selectMoneyRoute({...product,offers:[...product.offers].reverse()},health.reverse(),['merchant.example'],now);
    assert.equal(first.reason,'SELECTED_HIGH_CONFIDENCE');assert.equal(first.selected.id,reversed.selected.id);
    assert.equal(first.candidates.length,2);assert.deepEqual(first.candidates.map(candidate=>candidate.reasons),[[],[]]);
    assert.equal(JSON.stringify(first).includes('conversionRate'),false);
  });
  const rejectionCases=[
    ['expired offer',offer=>{offer.validUntil=new Date(Date.now()-1000).toISOString();},'REJECTED_EXPIRED'],
    ['future offer',offer=>{offer.validFrom=new Date(Date.now()+60000).toISOString();},'REJECTED_NOT_STARTED'],
    ['stale offer',offer=>{offer.lastVerifiedAt=new Date(Date.now()-86400001).toISOString();},'REJECTED_STALE'],
    ['missing merchant',offer=>{offer.merchant.id='';},'REJECTED_MERCHANT_IDENTITY'],
    ['invalid URL',offer=>{offer.destination.url='javascript:alert(1)';},'REJECTED_UNSAFE_DESTINATION'],
    ['private URL',offer=>{offer.destination.url='https://127.0.0.1/';},'REJECTED_UNSAFE_DESTINATION'],
    ['unknown provider',offer=>{offer.provider='unknown';},'REJECTED_PROVIDER_DISABLED'],
    ['Shopee offer',offer=>{offer.provider='shopee';},'REJECTED_PROVIDER_DISABLED'],
    ['required attribution',offer=>{offer.destination.attributionRequired=true;},'REJECTED_ATTRIBUTION_UNAVAILABLE'],
    ['unavailable inventory',offer=>{offer.availability='UNKNOWN';},'REJECTED_UNAVAILABLE'],
  ];
  for(const [name,mutate,reason] of rejectionCases)await test(`router rejects ${name} even with a large nominal commission`,async context=>{
    const product=await context.seed();product.offers=product.offers.filter(offer=>offer.monetization).slice(0,1);
    const offer=product.offers[0].monetization;offer.commissionAmountEstimate=999999999;mutate(offer);
    const result=selectMoneyRoute(product,await context.money.providers(),['merchant.example']);
    assert.equal(result.selected,null);assert.equal(result.reason,'NO_MONETIZABLE_OFFER');assert.equal(result.candidates[0].reasons.includes(reason),true);
  });
  await test('unpublished products and disabled or stale providers never monetize',async context=>{
    const product=await context.seed(),observations=await context.money.providers();
    assert.equal(selectMoneyRoute({...product,status:'draft'},observations,['merchant.example']).selected,null);
    assert.equal(selectMoneyRoute(product,observations.map(row=>({...row,health:{...row.health,enabled:false}})),['merchant.example']).selected,null);
    assert.equal(selectMoneyRoute(product,observations.map(row=>({...row,health:{...row.health,checkedAt:'2020-01-01T00:00:00.000Z'}})),['merchant.example']).selected,null);
  });
  await test('request destination injection is rejected before clicks',async context=>{
    await context.seed();const product=await context.adapter.domain.getProduct(context.product.id);
    for(const query of ['url=https://evil.example','next=//evil.example','context=DEAL&context=PRODUCT','context=invalid']){
      await assert.rejects(()=>prepareMoneyRedirect(new Request(`https://sandeal.test/go/${product.value.id}?${query}`),product,context.money,['merchant.example']));
    }
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_clicks').first()).count,0);
  });
  await test('click records omit personal data and replay exactly once',async context=>{
    await context.seed();const result=await context.click(),product=await context.adapter.domain.getProduct(context.product.id);
    assert.equal(new URL(result.target).hostname,'merchant.example');assert.equal(result.click.attribution.reference,result.click.id);
    assert.equal((await context.money.recordClick(result.click,product.version.token)).created,false);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_clicks').first()).count,1);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_money_events').first()).count,1);
    assert.deepEqual(Object.keys(result.click).sort(),['attribution','campaignId','context','createdAt','currency','destinationHash','id','merchantId','offerId','origin','platform','productId','provider']);
    await assert.rejects(()=>context.money.recordClick({...result.click,context:'PRODUCT'},product.version.token),error=>error.code==='CLICK_IDEMPOTENCY_CONFLICT');
  });
  await test('publication change before click commit rejects without attribution writes',async context=>{
    await context.seed();const result=await context.click(),stored=await context.adapter.domain.getProduct(context.product.id);
    await context.adapter.domain.replaceProduct({...stored.value,status:'draft'},stored.version);
    await assert.rejects(()=>context.money.recordClick({...result.click,id:'click-another',attribution:{...result.click.attribution,reference:'click-another'}},stored.version.token),error=>error.code==='PRODUCT_CHANGED_BEFORE_CLICK');
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_clicks').first()).count,1);
  });
  await test('TikTok uses existing tracking resolver with a generated click reference',async context=>{
    const product=await context.seed();product.offers=product.offers.filter(offer=>offer.monetization?.provider==='tiktok');
    const record=await context.adapter.domain.getProduct(context.product.id);await context.adapter.domain.replaceProduct({...record.value,offers:product.offers},record.version);
    const result=await context.click([context.tiktok]);assert.equal(result.click.attribution.transport,'PROVIDER_SUB1');
    assert.equal(new URL(result.target).searchParams.get('sub1'),result.click.id);assert.equal(context.calls.resolution,1);
  });
  await test('duplicate conversion and commission evidence produces one durable effect each',async context=>{
    await context.seed();const {click}=await context.click(),evidence=await context.evidence(click);
    assert.equal(evidence.converted.outcomes[0].status,'APPLIED');assert.equal(evidence.commissioned.outcomes[0].status,'APPLIED');
    for(let replay=0;replay<3;replay++){
      assert.equal((await context.money.ingestConversion(click.provider,evidence.conversionValue,context.origin)).status,'DUPLICATE');
      assert.equal((await context.money.ingestCommission(click.provider,evidence.commissionValue,context.origin)).status,'DUPLICATE');
    }
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_conversions').first()).count,1);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_commission_events').first()).count,1);
    const first=await context.snapshot();assert.equal(first.result,'SUCCEEDED');assert.equal((await context.revenue())[0].amountsMinor.PENDING,25000);
    assert.equal(await consumeDelivery(first.message,context.env,{moneyTestOnly:true}),'DUPLICATE_SAFE');
    await context.snapshot('second-snapshot');assert.equal((await context.revenue())[0].amountsMinor.PENDING,25000);
  });
  await test('concurrent duplicate evidence and concurrent snapshots cannot duplicate money',async context=>{
    await context.seed();const {click}=await context.click(),conversion=context.conversion(click),commission=context.commission();
    const provider=context.evidenceProvider(click.provider);await context.money.observeProvider({health:await provider.healthCheck(),capabilities:provider.getCapabilities(),origin:context.origin});
    const converted=await Promise.all([context.money.ingestConversion(click.provider,conversion,context.origin),context.money.ingestConversion(click.provider,conversion,context.origin)]);
    assert.deepEqual(converted.map(row=>row.status).sort(),['APPLIED','DUPLICATE']);
    const commissioned=await Promise.all([context.money.ingestCommission(click.provider,commission,context.origin),context.money.ingestCommission(click.provider,commission,context.origin)]);
    assert.deepEqual(commissioned.map(row=>row.status).sort(),['APPLIED','DUPLICATE']);
    const snapshots=await Promise.allSettled([context.money.refreshSnapshots(),context.money.refreshSnapshots()]);
    assert.equal(snapshots.some(row=>row.status==='fulfilled'),true);
    for(const row of snapshots)if(row.status==='rejected')assert.equal(row.reason.code,'REVENUE_SNAPSHOT_RETRY');
    await context.money.refreshSnapshots();assert.equal((await context.revenue())[0].amountsMinor.PENDING,25000);
  });
  await test('commission lifecycle separates estimates, pending, approved and paid without summing transitions',async context=>{
    await context.seed();const {click}=await context.click(),evidence=await context.evidence(click,context.conversion(click),context.commission({state:'ESTIMATED'}));
    await context.snapshot();assert.equal((await context.revenue())[0].amountsMinor.ESTIMATED,25000);assert.equal((await context.revenue())[0].amountsMinor.PAID,0);
    for(const [index,state] of ['PENDING','APPROVED','PAID'].entries()){
      const next={...evidence.commissionValue,eventId:`transition-${state}`,revision:index+2,state};
      assert.equal((await context.money.ingestCommission(click.provider,next,context.origin)).status,'APPLIED');
      await context.snapshot(`snapshot-${state}`);
      const amounts=(await context.revenue())[0].amountsMinor;
      assert.equal(amounts[state],25000);assert.equal(Object.values(amounts).reduce((sum,value)=>sum+value,0),25000);
    }
    const invalid={...evidence.commissionValue,eventId:'paid-downgrade',revision:5,state:'PENDING'};
    assert.equal((await context.money.ingestCommission(click.provider,invalid,context.origin)).status,'QUARANTINED');
    assert.equal((await context.revenue())[0].amountsMinor.PAID,25000);
  });
  await test('unknown commission amount stays explicitly unknown and currency cannot mix',async context=>{
    await context.seed();const {click}=await context.click();await context.evidence(click,context.conversion(click),context.commission({state:'UNKNOWN',amountMinor:null}));
    await context.snapshot();const row=(await context.revenue())[0];assert.equal(row.unknownAmounts,1);assert.equal(row.currency,'VND');assert.deepEqual(Object.values(row.amountsMinor),[0,0,0,0,0,0]);
    assert.equal((await context.money.ingestCommission(click.provider,context.commission({eventId:'different-currency',revision:2,currency:'USD'}),context.origin)).status,'QUARANTINED');
  });
  await test('unmatched conversion and commission evidence never creates revenue',async context=>{
    await context.seed();const provider=context.evidenceProvider('accesstrade');await context.money.observeProvider({health:await provider.healthCheck(),capabilities:provider.getCapabilities(),origin:context.origin});
    assert.equal((await context.money.ingestConversion('accesstrade',context.conversion({id:'missing-click'}),context.origin)).status,'UNMATCHED');
    assert.equal((await context.money.ingestCommission('accesstrade',context.commission(),context.origin)).status,'UNMATCHED');
    await context.snapshot();assert.deepEqual(await context.revenue(),[]);assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_money_unmatched').first()).count,2);
  });
  await test('malformed monetary evidence and conflicting event IDs quarantine',async context=>{
    await context.seed();const {click}=await context.click(),evidence=await context.evidence(click);
    for(const changes of [{amountMinor:1.1},{amountMinor:-1},{amountMinor:Number.MAX_SAFE_INTEGER},{currency:'FAKE'},{state:'PAYOUT'},{secret:'local-test-value'}]){
      assert.equal((await context.money.ingestCommission(click.provider,{...evidence.commissionValue,...changes},context.origin)).status,'QUARANTINED');
    }
    assert.equal((await context.money.ingestCommission(click.provider,{...evidence.commissionValue,amountMinor:999},context.origin)).status,'QUARANTINED');
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_commission_events').first()).count,1);
  });
  await test('production-default money paths reject fixture evidence and hide fixture snapshots',async context=>{
    await context.seed();const {click}=await context.click(),evidence=await context.evidence(click);await context.snapshot();
    const production=new D1AffiliateStore(context.db);
    await assert.rejects(()=>production.ingestConversion(click.provider,evidence.conversionValue,context.origin),error=>error.code==='UNVERIFIED_EVIDENCE_ORIGIN');
    assert.deepEqual(await production.providers(),[]);
    assert.deepEqual(await production.revenue({scope:'PRODUCT',scopeId:context.product.id,currency:'VND',from:context.day,to:context.day}),[]);
    const response=await cloudflareFetch(new Request(`https://sandeal.test/go/${context.product.id}`),{...context.env,SANDEAL_MONEY_ENGINE_ENABLED:'true',AFFILIATE_REDIRECT_HOSTS:'merchant.example'});
    assert.equal(response.status,422);assert.equal(response.headers.get('location'),null);
  });
  await test('Shopee missing credentials and pending access make zero discovery resolution or evidence calls',async context=>{
    const original=global.fetch;global.fetch=async()=>{context.calls.shopee++;throw new Error('SHOPEE_NETWORK_FORBIDDEN');};
    try{
      for(const [environment,state] of [[{},'DISABLED_NO_CREDENTIALS'],[{SHOPEE_AFFILIATE_ENABLED:'true'},'PENDING_EXTERNAL_ACCESS']]){
        const provider=new ShopeeAffiliateProvider(environment);assert.equal((await provider.healthCheck()).state,state);
        assert.deepEqual(provider.getCapabilities(),{discovery:false,trackingLink:false,conversionEvidence:false,commissionEvidence:false,clickReference:'UNAVAILABLE'});
        for(const operation of ['discoverProducts','createTrackingLink','syncTransactions','syncCommissions'])assert.equal((await provider[operation]({})).ok,false);
        await assert.rejects(()=>discoverNormalizedOffers(provider,context.adapter.domain,{limit:1}));
        await assert.rejects(()=>syncMoneyEvidence(provider,context.money,'CONVERSION',{limit:1}));
        await assert.rejects(()=>syncMoneyEvidence(provider,context.money,'COMMISSION',{limit:1}));
      }
    }finally{global.fetch=original;}
    assert.equal(context.calls.shopee,0);
    for(const table of ['affiliate_clicks','affiliate_conversions','affiliate_commission_events','affiliate_revenue_snapshots'])assert.equal((await context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count,0);
  });
  await test('current AccessTrade and TikTok conversion sync remains explicitly unsupported',async context=>{
    for(const provider of context.providers){assert.equal(provider.getCapabilities().conversionEvidence,false);assert.equal(provider.getCapabilities().commissionEvidence,false);
      await assert.rejects(()=>syncMoneyEvidence(provider,context.money,'CONVERSION',{limit:1}),error=>error.code==='PROVIDER_SYNC_NOT_SUPPORTED');}
    assert.equal(context.calls.conversion,0);assert.equal(context.calls.commission,0);
  });
  await test('provider retryable final and malformed outcomes fail explicitly',async context=>{
    const provider=context.evidenceProvider('accesstrade');
    for(const retryable of [true,false]){
      provider.syncTransactions=async()=>({ok:false,provider:provider.id,error:{reason:'PROVIDER_ERROR',retryable}});
      await assert.rejects(()=>syncMoneyEvidence(provider,context.money,'CONVERSION',{limit:1},context.origin),error=>error instanceof MoneyError && error.classification===(retryable?'RETRYABLE':'FINAL'));
    }
    provider.syncTransactions=async()=>({ok:true,provider:provider.id,data:{records:{malformed:true}}});
    await assert.rejects(()=>syncMoneyEvidence(provider,context.money,'CONVERSION',{limit:1},context.origin),error=>error.code==='MALFORMED_PROVIDER_RESPONSE');
    await assert.rejects(()=>syncMoneyEvidence(provider,context.money,'CONVERSION',{limit:21},context.origin));
  });
  await test('D1 outage cannot acknowledge a click or fabricate commission success',async context=>{
    const unavailable=new D1AffiliateStore({prepare(){throw new Error('synthetic-private-driver-detail');}},true);
    await assert.rejects(()=>unavailable.providers(),error=>error.code==='D1_MONEY_UNAVAILABLE'&&!error.message.includes('private'));
    await assert.rejects(()=>unavailable.ingestCommission('accesstrade',context.commission(),context.origin),error=>error.classification==='RETRYABLE');
  });
  await test('snapshot crash during commit rolls back counters cursor and job success',async context=>{
    await context.seed();const {click}=await context.click();await context.evidence(click);
    await context.db.prepare("CREATE TRIGGER fail_money_completion BEFORE UPDATE OF status ON automation_jobs WHEN NEW.status='SUCCEEDED' BEGIN SELECT RAISE(ABORT,'fixture-abort'); END").run();
    const first=await context.snapshot();assert.equal(first.result,'RETRYABLE');assert.deepEqual(await context.revenue(),[]);
    assert.equal((await context.db.prepare('SELECT last_sequence FROM affiliate_revenue_cursor').first()).last_sequence,0);
    await context.db.prepare('DROP TRIGGER fail_money_completion').run();
    assert.equal(await consumeDelivery(first.message,context.env,{now:()=>Date.now()+60000,moneyTestOnly:true}),'SUCCEEDED');
    assert.equal((await context.revenue())[0].amountsMinor.PENDING,25000);
  });
  await test('postcommit crash and expired claim takeover preserve a single revenue effect',async context=>{
    await context.seed();const {click}=await context.click();await context.evidence(click);
    const job=(await context.store.createJob({type:'AGGREGATE_GROWTH_METRICS',payload:{productId:'revenue-all'},idempotencyKey:'crash-money'},Date.now())).job;
    const first=context.message(job);
    await assert.rejects(()=>consumeDelivery(first,context.env,{moneyTestOnly:true,afterCommit:async()=>{throw new Error('FIXTURE_POST_COMMIT');}}),/FIXTURE_POST_COMMIT/);
    assert.equal(first.ackCount,0);assert.equal(await consumeDelivery(first,context.env,{moneyTestOnly:true}),'DUPLICATE_SAFE');
    const next=(await context.store.createJob({type:'AGGREGATE_GROWTH_METRICS',payload:{productId:'revenue-all'},idempotencyKey:'takeover-money'},Date.now())).job;
    const now=Date.now(),stale=await context.store.claim(next,now),current=await context.store.claim(next,now+60001);
    await assert.rejects(()=>context.store.commitRevenueSnapshot(stale,now+60002,true));
    await context.store.commitRevenueSnapshot(current,now+60002,true);assert.equal((await context.revenue())[0].amountsMinor.PENDING,25000);
  });
  await test('revenue by product provider merchant campaign is indexed and bounded',async context=>{
    await context.seed();const {click}=await context.click();await context.evidence(click);await context.snapshot();
    for(const [scope,id] of [['PRODUCT',click.productId],['PROVIDER',click.provider],['PLATFORM',`${click.provider}:${click.platform}`],['MERCHANT',click.merchantId],['CAMPAIGN',`${click.provider}:${click.campaignId}`]]){
      const rows=await context.revenue(scope,id);assert.equal(rows.length,1);assert.equal(rows[0].clicks,1);assert.equal(rows[0].conversions,1);assert.equal(rows[0].amountsMinor.PENDING,25000);assert.equal(rows[0].amountsMinor.PAID,0);
    }
    for(const sql of ["EXPLAIN QUERY PLAN SELECT * FROM affiliate_money_events WHERE sequence>0 ORDER BY sequence LIMIT 10",
      "EXPLAIN QUERY PLAN SELECT * FROM affiliate_revenue_snapshots WHERE origin='TEST_FIXTURE' AND scope='PLATFORM' AND scope_id='accesstrade:shopee' AND day>='2026-01-01' AND day<='2026-01-31' AND currency='VND' ORDER BY day LIMIT 31",
      "EXPLAIN QUERY PLAN SELECT * FROM affiliate_revenue_snapshots WHERE origin='TEST_FIXTURE' AND scope='PRODUCT' AND scope_id='local-audio' AND day>='2026-01-01' AND day<='2026-01-31' AND currency='VND' ORDER BY day LIMIT 31"]){
      const plan=JSON.stringify((await context.db.prepare(sql).all()).results);assert.match(plan,/SEARCH/);assert.doesNotMatch(plan,/SCAN affiliate_/);
    }
    await assert.rejects(()=>context.money.revenue({scope:'PRODUCT',scopeId:click.productId,currency:'VND',from:'2026-01-01',to:'2026-12-31'}));
  });
  await test('bounded snapshot backlog advances incrementally without dropping a state transition',async context=>{
    await context.seed();for(let count=0;count<25;count++)await context.click();
    const prepared=await context.money.snapshotStatements();assert.equal(prepared.eventsProcessed,10);assert.equal(prepared.statements.length,56);
    const first=await context.snapshot();const stored=await context.store.get(first.job.id);assert.equal(stored.result.revenueEvents,MONEY_LIMITS.snapshotEvents);
    assert.equal((await context.revenue())[0].clicks,10);await context.snapshot('page-two');await context.snapshot('page-three');assert.equal((await context.revenue())[0].clicks,25);
    await context.snapshot('page-empty');assert.equal((await context.revenue())[0].clicks,25);
  });
  await test('state transition split at page boundary is deferred as an atomic pair',async context=>{
    await context.seed();const {click}=await context.click(),evidence=await context.evidence(click);await context.snapshot();
    for(let count=0;count<9;count++)await context.click();
    const transition={...evidence.commissionValue,eventId:'boundary-approval',revision:2,state:'APPROVED'};
    assert.equal((await context.money.ingestCommission(click.provider,transition,context.origin)).status,'APPLIED');
    const page=await context.snapshot('boundary-page');assert.equal((await context.store.get(page.job.id)).result.revenueEvents,9);
    assert.equal((await context.revenue())[0].amountsMinor.PENDING,25000);assert.equal((await context.revenue())[0].amountsMinor.APPROVED,0);
    const next=await context.snapshot('boundary-next');assert.equal((await context.store.get(next.job.id)).result.revenueEvents,2);
    assert.equal((await context.revenue())[0].amountsMinor.PENDING,0);assert.equal((await context.revenue())[0].amountsMinor.APPROVED,25000);
  });
  await test('evidence and event ledger rows are immutable',async context=>{
    await context.seed();const {click}=await context.click();await context.evidence(click);
    for(const table of ['affiliate_clicks','affiliate_conversions','affiliate_commission_events','affiliate_money_events'])await assert.rejects(()=>context.db.prepare(`DELETE FROM ${table}`).run());
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_money_events').first()).count,3);
  });
  await test('complete fixture money flow uses Cron Queue D1 and duplicate-safe attribution',async context=>{
    await context.seed();const {click,decision,target}=await context.click();assert.equal(decision.reason,'SELECTED_HIGH_CONFIDENCE');assert.equal(new URL(target).hostname,'merchant.example');
    const evidence=await context.evidence(click);assert.equal((await context.money.ingestConversion(click.provider,evidence.conversionValue,context.origin)).status,'DUPLICATE');
    assert.equal((await context.money.ingestCommission(click.provider,evidence.commissionValue,context.origin)).status,'DUPLICATE');
    const result=await context.scheduledSnapshot();assert.equal(result.result,'SUCCEEDED');assert.equal(context.sent.length,1);
    assert.equal(await consumeDelivery(result.message,context.env,{moneyTestOnly:true}),'DUPLICATE_SAFE');
    const row=(await context.revenue())[0];assert.equal(row.conversions,1);assert.equal(row.amountsMinor.PENDING,25000);assert.equal(row.amountsMinor.PAID,0);
    const proof={MONEY_ROUTER:'PASS',NORMALIZED_OFFERS:'PASS',AFFILIATE_REDIRECT:'PASS',CLICK_ATTRIBUTION:'PASS',CONVERSION_ATTRIBUTION:'PASS',COMMISSION_LEDGER:'PASS',REVENUE_SNAPSHOT:'PASS',
      DUPLICATE_CONVERSION_EFFECT:0,DUPLICATE_COMMISSION_EFFECT:0,DUPLICATE_REVENUE_EFFECT:0,SHOPEE_LIVE_CALLS:context.calls.shopee,FILE_STORAGE_CALLS:0,PM2_REQUIRED:'NO',VPS_REQUIRED:'NO',LONG_RUNNING_PROCESS_REQUIRED:'NO',ORIGIN:context.origin,REAL_MONEY_TRANSACTION_CREATED:'NO'};
    recordEvidence('phase5-local-money-proof',proof);console.log(JSON.stringify(proof));
  });
  await test('compiled money runtime excludes FileStorage and filesystem settings',async context=>{
    const meta=JSON.parse(fs.readFileSync(context.runtime.built.file.replace('worker.mjs','metafile.json'),'utf8'));
    assert.equal(Object.keys(meta.inputs).some(name=>/fileStorageAdapter|legacySettingsStore|mongoStorageAdapter|automation-worker|automation-scheduler/.test(name)),false);
    const imports=Object.values(meta.outputs).flatMap(row=>row.imports.map(item=>item.path));assert.deepEqual([...new Set(imports)].sort(),['node:async_hooks','node:crypto']);
  });
  await test('normalization rejects missing merchant malformed amounts and cross-product identity',async context=>{
    const source=await context.accesstrade.discoverProducts({limit:1});const item=source.data.products[0];
    for(const value of [{...item,sourcePayload:{...item.sourcePayload,merchantDomain:''}},
      {...item,price:'25000'},{...item,productUrl:'https://other.example/product'},
      {...item,sourcePayload:{...item.sourcePayload,commissionAmount:NaN}}]){
      assert.throws(()=>normalizeAffiliateOffer(context.product,value,context.origin,true));
    }
    assert.throws(()=>normalizeAffiliateOffer(context.product,item,context.origin,false),error=>error.code==='UNVERIFIED_EVIDENCE_ORIGIN');
  });
  await test('allowed tracking host cannot carry an unsafe nested redirect target',async context=>{
    const product=await context.seed();product.offers=product.offers.filter(offer=>offer.monetization).slice(0,1);
    product.offers[0].monetization.destination.url='https://merchant.example/redirect?url=https://evil.example/';
    assert.equal(selectMoneyRoute(product,await context.money.providers(),['merchant.example']).selected,null);
    const provider={...context.evidenceProvider('tiktok'),healthCheck:()=>context.tiktok.healthCheck(),getCapabilities:()=>context.tiktok.getCapabilities(),
      createTrackingLink:async()=>({ok:true,provider:'tiktok',data:{url:'https://merchant.example/redirect?url=http://127.0.0.1',source:'provider_api'}})};
    await assert.rejects(()=>resolveMoneyDestination(provider,{...product.offers[0].monetization,provider:'tiktok'},'click-test',['merchant.example']),error=>error.code==='UNSAFE_RESOLVED_DESTINATION');
  });
  await test('Cloudflare HTTP money redirect persists attribution and exposes no money data',async context=>{
    await context.seed();const env={...context.env,SANDEAL_MONEY_ENGINE_ENABLED:'true',AFFILIATE_REDIRECT_HOSTS:'merchant.example'};
    const result=await cloudflareFetch(new Request(`https://sandeal.test/go/${context.product.id}`),env,{moneyTestOnly:true});
    assert.equal(result.status,302);assert.equal(new URL(result.headers.get('location')).hostname,'merchant.example');
    assert.equal(result.headers.get('cache-control'),'no-store');assert.equal(await result.text(),'');
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_clicks').first()).count,1);
    const privateResult=await cloudflareFetch(new Request('https://sandeal.test/api/admin/affiliate/revenue'),env);
    assert.equal(privateResult.status,503);assert.equal(JSON.stringify(await privateResult.json()).includes('amountsMinor'),false);
  });
  await test('full money domain flow records zero FileStorage and filesystem settings calls',async context=>{
    await context.seed();
    const fileAdapter=require('../src/lib/storage/fileStorageAdapter.ts').fileStorageAdapter;
    const originals=new Map(),descriptors=new Map();let fileCalls=0,filesystemCalls=0;
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fileAdapter))){
      if(typeof descriptor.value!=='function'&&!descriptor.get)continue;descriptors.set(key,descriptor);
      Object.defineProperty(fileAdapter,key,{configurable:true,get(){fileCalls++;throw new Error('FILE_STORAGE_FORBIDDEN');}});
    }
    for(const key of ['readFile','writeFile','mkdir','rename','open','stat','access','readdir','unlink','rm']){originals.set(key,fs.promises[key]);fs.promises[key]=async()=>{filesystemCalls++;throw new Error('FILESYSTEM_FORBIDDEN');};}
    try{const {click}=await context.click();await context.evidence(click);await context.snapshot();assert.equal((await context.revenue())[0].amountsMinor.PENDING,25000);}
    finally{for(const [key,original] of originals)fs.promises[key]=original;for(const [key,descriptor] of descriptors)Object.defineProperty(fileAdapter,key,descriptor);}
    assert.equal(fileCalls,0);assert.equal(filesystemCalls,0);
  });
  await test('disabled evidence provider stops before any provider request',async context=>{
    let calls=0;const provider=context.evidenceProvider('accesstrade');
    provider.healthCheck=async()=>({provider:'accesstrade',ready:false,enabled:false,state:'DISABLED',checkedAt:new Date().toISOString()});
    provider.syncTransactions=async()=>{calls++;throw new Error('FORBIDDEN');};
    await assert.rejects(()=>syncMoneyEvidence(provider,context.money,'CONVERSION',{limit:1},context.origin),error=>error.code==='PROVIDER_DISABLED');
    assert.equal(calls,0);
  });
  await test('AccessTrade-sourced Shopee keeps authoritative provenance with direct Shopee disabled',async context=>{
    const fixture=await context.seedShopee(),offer=fixture.product.offers[0].monetization;
    assert.equal(offer.provider,'accesstrade');assert.equal(offer.platform,'shopee');
    assert.deepEqual(offer.sourceEvidence,{provider:'accesstrade',endpoint:'datafeed',externalItemId:'fixture-shopee-item',platformBasis:'MERCHANT_DOMAIN',affiliateEndpoint:'datafeed',affiliateField:'aff_link'});
    assert.equal(offer.merchant.domain,'shopee.vn');assert.equal(offer.merchant.externalId,'fixture-shop');assert.equal(offer.campaign.id,'fixture-shopee-campaign');
    assert.equal((await context.shopee.healthCheck()).state,'DISABLED_NO_CREDENTIALS');
    const route=selectMoneyRoute(fixture.product,await context.money.providers(),fixture.allowedHosts);
    assert.equal(route.reason,'SELECTED_ACCESSTRADE_SHOPEE');assert.equal(route.selected.id,offer.id);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM products').first()).count,1);
  });
  await test('two AccessTrade campaigns coexist without duplicating canonical product identity',async context=>{
    const fixture=await context.seedShopee(),firstId=fixture.product.offers[0].id;
    fixture.adapter.item.affiliateUrlCampaignId='fixture-second-campaign';
    await discoverNormalizedOffers(fixture.provider,context.adapter.domain,{limit:2,origin:context.origin,testOnly:true});
    const product=(await context.adapter.domain.getProduct(context.product.id)).value;
    assert.equal(product.offers.length,2);assert.equal(new Set(product.offers.map(offer=>offer.id)).size,2);
    assert.equal(product.offers.some(offer=>offer.id===firstId),true);
    assert.deepEqual(product.offers.map(offer=>offer.monetization.campaign.id).sort(),['fixture-second-campaign','fixture-shopee-campaign']);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM products').first()).count,1);
  });
  await test('refresh upgrades pre-platform offers by exact identity without retaining duplicate offers',async context=>{
    const product=await context.seed(),projection=product.offers.find(offer=>offer.monetization),modern=projection.monetization,legacy=structuredClone(projection);
    legacy.id='legacy-offer';legacy.monetization.id='legacy-offer';delete legacy.monetization.sourceEvidence;delete legacy.monetization.platform;
    const stored=await context.adapter.domain.getProduct(product.id);
    assert.equal((await context.adapter.domain.replaceProduct({...product,offers:product.offers.map(offer=>offer.id===modern.id?legacy:offer)},stored.version)).status,'APPLIED');
    await persistNormalizedOffers(context.adapter.domain,product.id,[modern]);
    const refreshed=(await context.adapter.domain.getProduct(product.id)).value;
    assert.equal(refreshed.offers.length,3);assert.equal(refreshed.offers.filter(offer=>offer.monetization).length,2);assert.equal(refreshed.offers.some(offer=>offer.id==='legacy-offer'),false);
    assert.equal(refreshed.offers.find(offer=>offer.id===modern.id).confidence,1);
  });
  const provenanceFailures=[
    ['missing campaign',source=>{delete source.affiliateUrlCampaignId;},'MISSING_CAMPAIGN_IDENTITY'],
    ['missing endpoint evidence',source=>{delete source.sourceEndpoint;},'MISSING_OR_INVALID_SOURCE_EVIDENCE'],
    ['missing affiliate field evidence',source=>{delete source.affiliateUrlSourceField;},'MISSING_OR_INVALID_SOURCE_EVIDENCE'],
    ['false direct Shopee provider',source=>{source.provider='shopee';},'PROVIDER_PROVENANCE_MISMATCH'],
    ['false direct Shopee link provider',source=>{source.affiliateUrlProvider='shopee';},'PROVIDER_PROVENANCE_MISMATCH'],
    ['mismatched platform',source=>{source.platform='tiktok_shop';},'PROVIDER_PLATFORM_MISMATCH'],
  ];
  for(const [name,mutate,code] of provenanceFailures)await test(`AccessTrade Shopee rejects ${name} without money effects`,async context=>{
    const fixture=await context.seedShopee();mutate(fixture.adapter.item);
    await assert.rejects(()=>discoverNormalizedOffers(fixture.provider,context.adapter.domain,{limit:2,origin:context.origin,testOnly:true}),error=>error.code===code);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_clicks').first()).count,0);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_commission_events').first()).count,0);
  });
  await test('router fails closed for weak confidence campaign and provenance mutation',async context=>{
    const fixture=await context.seedShopee();
    for(const [mutate,reason] of [
      [offer=>{offer.sourceConfidence=0;},'REJECTED_SOURCE_CONFIDENCE'],
      [offer=>{offer.sourceConfidence=101;},'REJECTED_SOURCE_CONFIDENCE'],
      [offer=>{offer.sourceConfidence=NaN;},'REJECTED_SOURCE_CONFIDENCE'],
      [offer=>{offer.campaign=null;},'REJECTED_MISSING_IDENTITY'],
      [offer=>{offer.sourceEvidence.provider='shopee';},'REJECTED_SOURCE_PROVENANCE'],
    ]){
      const product=structuredClone(fixture.product);mutate(product.offers[0].monetization);
      const route=selectMoneyRoute(product,await context.money.providers(),fixture.allowedHosts);
      assert.equal(route.selected,null);assert.equal(route.candidates[0].reasons.includes(reason),true);
    }
    fixture.adapter.item.verifiedSource=false;
    const normalized=await discoverNormalizedOffers(fixture.provider,context.adapter.domain,{limit:2,origin:context.origin,testOnly:true});
    assert.equal(normalized.offers[0].sourceConfidence,0);assert.equal(normalized.offers[0].monetizationStatus,'UNAVAILABLE');
    assert.equal(selectMoneyRoute((await context.adapter.domain.getProduct(context.product.id)).value,await context.money.providers(),fixture.allowedHosts).selected,null);
  });
  await test('AccessTrade-first preference never overrides safety and preserves TikTok fallback',async context=>{
    const product=await context.seed(),observations=await context.money.providers();
    const tiktok=product.offers.find(offer=>offer.monetization?.provider==='tiktok');tiktok.monetization.commissionAmountEstimate=999999;
    assert.equal(selectMoneyRoute(product,observations,['merchant.example']).selected.provider,'accesstrade');
    const accessTrade=product.offers.find(offer=>offer.monetization?.provider==='accesstrade');accessTrade.monetization.validUntil=new Date(Date.now()-1000).toISOString();
    const fallback=selectMoneyRoute(product,observations,['merchant.example']);assert.equal(fallback.selected.provider,'tiktok');assert.equal(fallback.reason,'SELECTED_ONLY_ELIGIBLE_PROVIDER');
  });
  await test('provider and platform click mismatch fails before any committed effect',async context=>{
    const fixture=await context.seedShopee();
    const redirect=await prepareMoneyRedirect(new Request(`https://sandeal.test/go/${context.product.id}`),await context.adapter.domain.getProduct(context.product.id),context.money,fixture.allowedHosts);
    const stored=await context.adapter.domain.getProduct(context.product.id);
    await assert.rejects(()=>context.money.recordClick({...redirect.click,id:'forged-click',provider:'tiktok',attribution:{reference:'forged-click',transport:'UNAVAILABLE'}},stored.version.token),error=>error.code==='CLICK_PROVENANCE_MISMATCH');
    await assert.rejects(()=>context.money.recordClick({...redirect.click,id:'forged-platform',platform:'lazada',attribution:{reference:'forged-platform',transport:'UNAVAILABLE'}},stored.version.token),error=>error.code==='PRODUCT_CHANGED_BEFORE_CLICK');
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM affiliate_clicks').first()).count,1);
  });
  await test('actual AccessTrade normalizer preserves only explicit availability and never invents commission evidence',async context=>{
    const fixture=await context.seedShopee(),{normalizeAccessTradeItem}=require('../src/lib/integrations/accesstrade.ts');
    assert.equal(fixture.adapter.item.verifiedSource,true);assert.equal(fixture.adapter.item.affiliateUrl,fixture.raw.aff_link);
    assert.equal(fixture.product.offers[0].monetization.commissionRate,null);assert.equal(fixture.product.offers[0].monetization.commissionAmountEstimate,null);
    for(const [available,expected] of [[undefined,'UNKNOWN'],['true','UNKNOWN'],[false,'UNAVAILABLE']]){
      Object.assign(fixture.adapter.item,normalizeAccessTradeItem({...fixture.raw,available}));
      const result=await discoverNormalizedOffers(fixture.provider,context.adapter.domain,{limit:2,origin:context.origin,testOnly:true});
      assert.equal(result.offers[0].availability,expected);assert.equal(selectMoneyRoute((await context.adapter.domain.getProduct(context.product.id)).value,await context.money.providers(),fixture.allowedHosts).selected,null);
    }
  });
  await test('complete AccessTrade Shopee Cron Queue D1 proof has no duplicate money or direct API calls',async context=>{
    const fixture=await context.seedShopee();let directCalls=0;const originalFetch=global.fetch;
    global.fetch=async()=>{directCalls++;throw new Error('DIRECT_SHOPEE_FORBIDDEN');};
    try{for(const provider of [context.shopee,new ShopeeAffiliateProvider({SHOPEE_AFFILIATE_ENABLED:'true'})]){
      for(const method of ['discoverProducts','getOffers','getProduct','getPromotions','createTrackingLink','syncTransactions','syncCommissions'])assert.equal((await provider[method]()).ok,false);
    }}finally{global.fetch=originalFetch;}
    assert.equal(directCalls,0);
    const env={...context.env,SANDEAL_MONEY_ENGINE_ENABLED:'true',AFFILIATE_REDIRECT_HOSTS:fixture.allowedHosts.join(',')};
    const response=await cloudflareFetch(new Request(`https://sandeal.test/go/${context.product.id}`),env,{moneyTestOnly:true});
    assert.equal(response.status,302);assert.equal(new URL(response.headers.get('location')).hostname,'go.isclix.com');
    assert.equal(new URL(response.headers.get('location')).searchParams.get('url'),fixture.canonicalUrl);
    const click=JSON.parse((await context.db.prepare('SELECT payload FROM affiliate_clicks LIMIT 1').first()).payload);
    assert.equal(click.provider,'accesstrade');assert.equal(click.platform,'shopee');assert.equal(click.origin,'TEST_FIXTURE');
    const evidence=await context.evidence(click);assert.equal(evidence.converted.outcomes[0].status,'APPLIED');assert.equal(evidence.commissioned.outcomes[0].status,'APPLIED');
    assert.equal((await context.money.ingestConversion('accesstrade',evidence.conversionValue,context.origin)).status,'DUPLICATE');
    assert.equal((await context.money.ingestCommission('accesstrade',evidence.commissionValue,context.origin)).status,'DUPLICATE');
    const run=await context.scheduledSnapshot();assert.equal(run.result,'SUCCEEDED');assert.equal(context.sent.length,1);
    const before=await context.revenue('PLATFORM','accesstrade:shopee');
    assert.equal(before.length,1);assert.equal(before[0].clicks,1);assert.equal(before[0].conversions,1);
    assert.deepEqual(before[0].amountsMinor,{UNKNOWN:0,ESTIMATED:0,PENDING:25000,APPROVED:0,REJECTED:0,PAID:0});
    assert.equal(await consumeDelivery(run.message,context.env,{moneyTestOnly:true}),'DUPLICATE_SAFE');
    await context.snapshot('second-shopee-snapshot');assert.deepEqual(await context.revenue('PLATFORM','accesstrade:shopee'),before);
    assert.deepEqual(await context.revenue('PROVIDER','shopee'),[]);
    assert.equal((await context.db.prepare("SELECT COUNT(*) AS count FROM affiliate_conversions WHERE provider='accesstrade'").first()).count,1);
    assert.equal((await context.db.prepare("SELECT COUNT(*) AS count FROM affiliate_commission_events WHERE provider='accesstrade'").first()).count,1);
    assert.equal((await context.db.prepare("SELECT COUNT(*) AS count FROM affiliate_money_events WHERE provider='accesstrade' AND platform='shopee'").first()).count,3);
    const proof={MONEY_ROUTER:'PASS',NORMALIZED_OFFERS:'PASS',ACCESS_TRADE_SHOPEE_NORMALIZATION:'PASS',ACCESS_TRADE_SHOPEE_MONETIZATION:'PASS',AFFILIATE_REDIRECT:'PASS',CLICK_ATTRIBUTION:'PASS',CONVERSION_ATTRIBUTION:'PASS',COMMISSION_LEDGER:'PASS',REVENUE_SNAPSHOT:'PASS',
      PROVIDER:'accesstrade',PLATFORM:'shopee',DUPLICATE_CONVERSION_EFFECT:0,DUPLICATE_COMMISSION_EFFECT:0,DUPLICATE_REVENUE_EFFECT:0,DIRECT_SHOPEE_API_CALLS:directCalls,FILE_STORAGE_CALLS:0,PM2_REQUIRED:'NO',VPS_REQUIRED:'NO',LONG_RUNNING_PROCESS_REQUIRED:'NO',ORIGIN:context.origin,REAL_MONEY_TRANSACTION_CREATED:'NO'};
    recordEvidence('phase5-accesstrade-shopee-proof',proof);console.log(JSON.stringify(proof));
  });
  await test('additive schema upgrade preserves pending jobs claims and task revisions',async()=>{
    const {openLocalD1}=require('./lib/local-d1.cjs');const {D1JobStore}=require('../src/lib/storage/d1/d1JobStore.ts');
    const runtime=await openLocalD1({testOnly:true});
    try{
      async function apply(name){const sql=fs.readFileSync(`src/lib/storage/d1/migrations/${name}`,'utf8').split('-- statement-breakpoint').map(value=>value.trim()).filter(value=>value&&!/^--[^\n]*$/.test(value));await runtime.db.batch(sql.map(value=>runtime.db.prepare(value)));}
      await apply('0001_product_storage.sql');await apply('0002_event_jobs.sql');
      const jobs=new D1JobStore(runtime.db),now=Date.now();
      await jobs.createTask({id:'preserved-task',type:'CAPTURE_PRICE_HISTORY',payload:{productId:'existing-product'},nextRunAt:now,intervalMs:60000,enabled:true});
      const job=(await jobs.createJob({type:'CAPTURE_PRICE_HISTORY',payload:{productId:'existing-product'},idempotencyKey:'existing-job'},now)).job;
      await jobs.claim(job,now);
      const beforeJob=await jobs.get(job.id),beforeTasks=(await runtime.db.prepare('SELECT * FROM scheduled_tasks').all()).results;
      await apply('0003_affiliate_money.sql');await apply('0004_money_snapshot_jobs.sql');await apply('0005_money_platform.sql');
      assert.deepEqual(await jobs.get(job.id),beforeJob);assert.deepEqual((await runtime.db.prepare('SELECT * FROM scheduled_tasks').all()).results,beforeTasks);
      assert.equal((await jobs.createJob({type:'AGGREGATE_GROWTH_METRICS',payload:{productId:'revenue-all'},idempotencyKey:'new-money-job'},now)).created,true);
    }finally{await runtime.dispose();}
  });
  await test('platform schema upgrade preserves existing money evidence balances and unknown history',async context=>{
    const {openLocalD1}=require('./lib/local-d1.cjs');const runtime=await openLocalD1({testOnly:true});
    try{
      async function apply(name){const sql=fs.readFileSync(`src/lib/storage/d1/migrations/${name}`,'utf8').split('-- statement-breakpoint').map(value=>value.trim()).filter(value=>value&&!/^--[^\n]*$/.test(value));await runtime.db.batch(sql.map(value=>runtime.db.prepare(value)));}
      for(const name of ['0001_product_storage.sql','0002_event_jobs.sql','0003_affiliate_money.sql','0004_money_snapshot_jobs.sql'])await apply(name);
      const row=await context.db.prepare('SELECT * FROM products LIMIT 1').first(),columns=['id','slug','status','revision','token','created_at','updated_at','payload','identities'];
      await runtime.db.prepare(`INSERT INTO products(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(column=>row[column])).run();
      const payload=JSON.stringify({id:'legacy-money-click',origin:'TEST_FIXTURE'});
      await runtime.db.prepare("INSERT INTO affiliate_clicks(id,product_id,offer_id,provider,merchant_id,campaign_id,currency,created_at,attribution_reference,attribution_transport,origin,payload) VALUES('legacy-money-click',?,'legacy-offer','accesstrade','legacy-merchant','legacy-campaign','VND',?,'legacy-money-click','UNAVAILABLE','TEST_FIXTURE',?)").bind(context.product.id,new Date().toISOString(),payload).run();
      await runtime.db.prepare("INSERT INTO affiliate_revenue_snapshots(origin,scope,scope_id,day,currency,clicks,last_sequence) VALUES('TEST_FIXTURE','PROVIDER','accesstrade',?,'VND',1,1)").bind(context.day).run();
      await runtime.db.prepare("UPDATE affiliate_revenue_cursor SET last_sequence=1 WHERE id='revenue-v1'").run();
      const before=(await runtime.db.prepare('SELECT * FROM affiliate_revenue_snapshots').all()).results;
      await apply('0005_money_platform.sql');
      assert.deepEqual((await runtime.db.prepare('SELECT * FROM affiliate_revenue_snapshots').all()).results,before);
      assert.deepEqual(await runtime.db.prepare('SELECT payload,platform FROM affiliate_clicks LIMIT 1').first(),{payload,platform:'unknown'});
      assert.equal((await runtime.db.prepare('SELECT platform FROM affiliate_money_events LIMIT 1').first()).platform,'unknown');
      assert.equal((await runtime.db.prepare('SELECT last_sequence FROM affiliate_revenue_cursor').first()).last_sequence,1);
      assert.equal((await runtime.db.prepare("SELECT COUNT(*) AS count FROM affiliate_revenue_snapshots WHERE scope='PLATFORM'").first()).count,0);
      await assert.rejects(()=>runtime.db.prepare('DELETE FROM affiliate_clicks').run());
    }finally{await runtime.dispose();}
  });
}
main().catch(error=>{failed++;console.error('FAIL setup',error);}).finally(()=>{console.log(`V6 money engine: ${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;});
