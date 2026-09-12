/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
require('./register-typescript.cjs');
const { dealFixture, history, verifiedPublicOffers, DAY } = require('./fixtures/v6-deal-intelligence.cjs');
const { evaluateDeal } = require('../src/lib/deal-intelligence/evaluate.ts');
const { DEAL_CONFIG, boundedScore, unitConfidence, validateDealConfig } = require('../src/lib/deal-intelligence/config.ts');
const { D1DealStore } = require('../src/lib/storage/d1/d1DealStore.ts');
const { D1JobStore } = require('../src/lib/storage/d1/d1JobStore.ts');
const { createCloudflareSchedulerAdapter } = require('../src/lib/platform/cloudflareAdapters.ts');
const { consumeDelivery } = require('../src/lib/runtime/cloudflare/autopilot.ts');
const { cloudflareFetch } = require('../src/lib/runtime/cloudflare/http.ts');
let passed = 0, failed = 0;
async function test(name, work) {
  try { await work(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
const integration = (name, work) => test(name, () => dealFixture(work));
function firstOffer(input) { input.product.offers = input.product.offers.filter(offer => offer.monetization?.provider === 'accesstrade'); return input.product.offers[0]; }
function safeRanges(result) {
  for (const value of [result.dealScore,result.priceQualityScore,result.freshnessScore,result.offerQualityScore,result.monetizationScore,result.evidenceQualityScore])
    assert.equal(Number.isFinite(value) && value >= 0 && value <= 100, true);
  assert.equal(result.confidence >= 0 && result.confidence <= 1, true);
  assert.equal(result.discountConfidence >= 0 && result.discountConfidence <= 1, true);
}
async function main() {
  await dealFixture(async context => {
    const base = context.input;
    await test('A strong observed deal has exact scores and recommendation without revenue', () => {
      const result = evaluateDeal(base); safeRanges(result);
      assert.equal(result.historicalMedian,1600000); assert.equal(result.historicalLow,1200000); assert.equal(result.historicalSampleCount,10);
      assert.equal(result.discountPercent,25); assert.equal(result.discountConfidence,1); assert.equal(result.priceQualityScore,100);
      assert.equal(result.dealScore,97.75); assert.equal(result.confidence,1); assert.equal(result.priority,'TOP'); assert.equal(result.publishRecommendation,'PUBLISH');
      assert.equal(result.revenueEvidenceScore,undefined); assert.equal(result.revenueEvidence,undefined); assert.equal(result.monetizationState,'MONETIZATION_PATH_AVAILABLE');
      assert.equal(result.reasonCodes.includes('SAFE_MONETIZATION_PATH'),true); assert.equal(result.riskCodes.length,0);
    });
    await test('B list-price-only 50 percent is not a verified 50 percent discount', () => {
      const input = structuredClone(base); input.product.price=2000000; input.product.salePrice=1000000;
      for (const offer of input.product.offers) { offer.price=1000000; if(offer.monetization)offer.monetization.price=1000000; }
      input.history=history(input.product,input.now,[1000000,...Array(9).fill(1050000)]);
      const result=evaluateDeal(input);
      assert.equal(result.nominalDiscountPercent,50); assert.equal(result.discountPercent,100/21); assert.equal(result.priceQualityScore,59.52);
      assert.equal(result.riskCodes.includes('UNVERIFIED_LIST_DISCOUNT'),true); assert.equal(result.reasonCodes.includes('DISCOUNT_VERIFIED'),false);
      assert.equal(result.dealScore<85,true);
    });
    await test('D single observation keeps history quality unknown and confidence low', () => {
      const input=structuredClone(base);input.history=input.history.slice(0,1);const result=evaluateDeal(input);
      assert.equal(result.historicalMedian,undefined);assert.equal(result.discountPercent,undefined);assert.equal(result.priceQualityScore,0);
      assert.equal(result.confidence,0.4);assert.equal(result.confidenceBand,'LOW');assert.equal(result.publishRecommendation,'HOLD');
    });
    await test('same inputs converge exactly and permutation preserves fingerprint', () => {
      const first=evaluateDeal(base),second=evaluateDeal(structuredClone(base)); assert.deepEqual(second,first);
      const input=structuredClone(base);input.history.reverse();input.product.offers.reverse();input.providers.reverse();assert.deepEqual(evaluateDeal(input),first);
      assert.deepEqual(evaluateDeal({...base,now:base.now+1}),first);
    });
    const invalidPrices=[['zero',0],['negative',-1],['NaN',NaN],['Infinity',Infinity],['negative infinity',-Infinity],['string','1200000']];
    for(const [name,value] of invalidPrices)await test(`invalid current ${name} fails closed`,()=>{
      const input=structuredClone(base);input.product.salePrice=value;const result=evaluateDeal(input);safeRanges(result);
      assert.equal(result.currentPrice,undefined);assert.equal(result.priority,'REJECT');assert.notEqual(result.publishRecommendation,'PUBLISH');assert.equal(result.priceQualityScore,0);
    });
    for(const [name,mutate,reason] of [
      ['wrong product currency',input=>{input.product.currency='USD';},'INVALID_CURRENT_PRICE_OR_CURRENCY'],
      ['wrong offer currency',input=>{firstOffer(input).monetization.currency='USD';},'OFFER_PRICE_OR_CURRENCY_MISMATCH'],
      ['wrong offer price',input=>{firstOffer(input).monetization.price=1000;},'OFFER_PRICE_OR_CURRENCY_MISMATCH'],
      ['unknown provider',input=>{firstOffer(input).monetization.provider='unknown';},'REJECTED_PROVIDER_DISABLED'],
      ['direct Shopee',input=>{firstOffer(input).monetization.provider='shopee';},'REJECTED_PROVIDER_DISABLED'],
      ['disabled provider',input=>{firstOffer(input);input.providers.forEach(row=>{row.health.enabled=false;});},'REJECTED_PROVIDER_DISABLED'],
      ['unsafe destination',input=>{firstOffer(input).monetization.destination.url='https://127.0.0.1/private';},'REJECTED_UNSAFE_DESTINATION'],
      ['missing merchant',input=>{firstOffer(input).monetization.merchant.id='';},'REJECTED_MERCHANT_IDENTITY'],
      ['required campaign missing',input=>{const offer=firstOffer(input).monetization;offer.campaignRequired=true;offer.campaign=null;},'REJECTED_MISSING_IDENTITY'],
      ['expired offer',input=>{firstOffer(input).monetization.validUntil=new Date(input.now-1).toISOString();},'REJECTED_EXPIRED'],
      ['invalid expiry',input=>{firstOffer(input).monetization.validUntil='not-a-time';},'INVALID_OFFER_VALIDITY'],
      ['future start',input=>{firstOffer(input).monetization.validFrom=new Date(input.now+10000).toISOString();},'REJECTED_NOT_STARTED'],
      ['future offer',input=>{firstOffer(input).monetization.lastVerifiedAt=new Date(input.now+10000).toISOString();},'REJECTED_STALE'],
      ['future provider',input=>{firstOffer(input);input.providers.forEach(row=>{row.health.checkedAt=new Date(input.now+10000).toISOString();});},'REJECTED_PROVIDER_STALE'],
      ['ProductOffer percent confidence',input=>{firstOffer(input).confidence=100;},'CONFIDENCE_SCALE_MISMATCH'],
      ['money fractional confidence',input=>{firstOffer(input).monetization.sourceConfidence=1;},'REJECTED_SOURCE_CONFIDENCE'],
      ['money over-range confidence',input=>{firstOffer(input).monetization.sourceConfidence=101;},'REJECTED_SOURCE_CONFIDENCE'],
      ['publication denial',input=>{input.product.publicBlocked=true;},'PUBLICATION_GATE_DENIED'],
      ['draft publication',input=>{input.product.status='draft';},'PUBLICATION_GATE_DENIED'],
      ['public offer unhealthy',input=>{firstOffer(input).health='BROKEN';},'PUBLIC_OFFER_GATE_DENIED'],
    ])await test(`${name} cannot override safety`,()=>{
      const input=structuredClone(base);mutate(input);const result=evaluateDeal(input);safeRanges(result);
      assert.equal(result.riskCodes.includes(reason),true);assert.equal(result.selectedOfferId,undefined);assert.equal(result.monetizationScore,0);
      assert.equal(result.priority,'REJECT');assert.notEqual(result.publishRecommendation,'PUBLISH');assert.equal(result.priceQualityScore,name==='wrong product currency'?0:100);
    });
    await test('C stale affiliate path preserves price quality but blocks publishing',()=>{
      const input=structuredClone(base);const offer=firstOffer(input).monetization;offer.destination.verifiedAt=new Date(input.now-2*DAY).toISOString();offer.lastVerifiedAt=offer.destination.verifiedAt;
      const result=evaluateDeal(input);assert.equal(result.priceQualityScore,100);assert.equal(result.offerFreshness,'STALE');assert.equal(result.destinationFreshness,'STALE');
      assert.equal(result.monetizationScore,0);assert.equal(result.publishRecommendation,'REFRESH_FIRST');assert.equal(result.priority,'REJECT');
    });
    await test('no safe monetization path is explicit and unscored',()=>{
      const result=evaluateDeal({...base,product:{...base.product,offers:[]}});assert.equal(result.monetizationState,'NO_MONETIZATION_PATH');assert.equal(result.monetizationScore,0);assert.equal(result.priority,'REJECT');
    });
    await test('stale observed price never recommends publishing',()=>{
      const input=structuredClone(base);input.history.forEach(row=>{row.capturedAt=new Date(Date.parse(row.capturedAt)-4*DAY).toISOString();});const result=evaluateDeal(input);
      assert.equal(result.priceFreshness,'STALE');assert.equal(result.freshnessScore,0);assert.equal(result.publishRecommendation,'REFRESH_FIRST');assert.equal(result.priority,'LOW');
    });
    await test('missing price history does not use nominal discount as verified evidence',()=>{
      const result=evaluateDeal({...base,history:[]});assert.equal(result.historicalSampleCount,0);assert.equal(result.historicalMedian,undefined);assert.equal(result.historicalLow,undefined);
      assert.equal(result.discountPercent,undefined);assert.equal(result.discountConfidence,0);assert.equal(result.priceQualityScore,0);assert.equal(result.priceFreshness,'UNKNOWN');assert.notEqual(result.publishRecommendation,'PUBLISH');
    });
    for(const [name,mutate] of [
      ['bad price',row=>{row.price=NaN;}],['currency mismatch',row=>{row.currency='USD';}],['future observation',row=>{row.capturedAt=new Date(base.now+DAY).toISOString();}],
      ['invalid timestamp',row=>{row.capturedAt='2026-02-30T00:00:00.000Z';}],['wrong product',row=>{row.productId='another-product';}],['unavailable sample',row=>{row.availability='unavailable';}],
    ])await test(`historical ${name} cannot strengthen confidence`,()=>{
      const input=structuredClone(base);mutate(input.history[2]);const result=evaluateDeal(input);
      assert.equal(result.invalidSamples,1);assert.equal(result.riskCodes.includes('INVALID_HISTORICAL_SAMPLE'),true);assert.equal(result.confidence<evaluateDeal(base).confidence,true);safeRanges(result);
    });
    await test('duplicate timestamps do not increase sample count',()=>{
      const input=structuredClone(base);input.history.push({...input.history[1],id:'duplicate-observation'});const result=evaluateDeal(input);
      assert.equal(result.historicalSampleCount,10);assert.equal(result.confidence,1);assert.equal(result.reasonCodes.includes('DUPLICATE_TIMESTAMP_COLLAPSED'),true);
    });
    await test('conflicting timestamp is excluded rather than arbitrarily chosen',()=>{
      const input=structuredClone(base);input.history.push({...input.history[1],id:'conflicting-observation',price:2000000});const result=evaluateDeal(input);
      assert.equal(result.historicalSampleCount,9);assert.equal(result.invalidSamples,2);assert.equal(result.riskCodes.includes('CONFLICTING_PRICE_TIMESTAMP'),true);
    });
    await test('extreme outlier cannot inflate robust reference',()=>{
      const input=structuredClone(base);input.history[2].price=10000000000;const result=evaluateDeal(input);
      assert.equal(result.referencePrice,1600000);assert.equal(result.historicalMaximum,1600000);assert.equal(result.historicalSampleCount,9);assert.equal(result.riskCodes.includes('HISTORICAL_OUTLIER_EXCLUDED'),true);
    });
    await test('missing and below-current list prices confer no fabricated discount points',()=>{
      const input=structuredClone(base);delete input.product.price;const unknown=evaluateDeal(input);assert.equal(unknown.nominalDiscountPercent,undefined);assert.equal(unknown.priceQualityScore,100);
      input.product.price=1000000;const below=evaluateDeal(input);assert.equal(below.nominalDiscountPercent,0);assert.equal(below.priceQualityScore,100);assert.equal(below.riskCodes.includes('LIST_PRICE_BELOW_CURRENT'),true);
    });
    await test('high price score and low confidence remain separately representable',()=>{
      const input=structuredClone(base);input.history=input.history.slice(0,2);const result=evaluateDeal(input);
      assert.equal(result.priceQualityScore>70,true);assert.equal(result.confidence<0.5,true);assert.notEqual(result.publishRecommendation,'PUBLISH');
    });
    await test('higher verified discount never decreases price quality',()=>{
      let previous=-1;
      for(const price of [1700000,1600000,1500000,1400000,1300000,1200000]){
        const input=structuredClone(base);input.product.salePrice=price;input.history[0].price=price;
        const result=evaluateDeal(input);assert.equal(result.priceQualityScore>=previous,true);previous=result.priceQualityScore;safeRanges(result);
      }
      assert.equal(previous,100);
    });
    await test('freshness cannot improve with age',()=>{
      const results=[0,DAY+1,3*DAY+1].map(age=>evaluateDeal({...base,now:base.now+age}));
      assert.deepEqual(results.map(result=>result.freshnessScore),[100,50,0]);assert.deepEqual(results.map(result=>result.priceFreshness),['FRESH','AGING','STALE']);
    });
    await test('more verified history increases confidence without revenue feedback',()=>{
      const values=[1,2,4,7,10].map(count=>evaluateDeal({...base,history:base.history.slice(0,count)}).confidence);
      for(let index=1;index<values.length;index++)assert.equal(values[index]>=values[index-1],true);assert.equal(values.at(-1),1);
    });
    await test('approved and paid are distinct and revenue bonus is capped',()=>{
      const row={day:new Date(base.now).toISOString().slice(0,10),scope:'PRODUCT',scopeId:base.product.id,currency:'VND',clicks:2,conversions:1,unknownAmounts:0,asOfSequence:5,
        amountsMinor:{UNKNOWN:0,ESTIMATED:0,PENDING:25000,APPROVED:0,REJECTED:0,PAID:0}};
      const pending=evaluateDeal({...base,revenue:[row]});assert.equal(pending.revenueEvidence.paidMinor,0);assert.equal(pending.revenueEvidenceScore,50);
      row.amountsMinor.PENDING=0;row.amountsMinor.APPROVED=25000;const approved=evaluateDeal({...base,revenue:[row]});
      assert.equal(approved.revenueEvidence.paidMinor,0);assert.equal(approved.revenueEvidence.approvedMinor,25000);assert.equal(approved.monetizationState,'VERIFIED_REVENUE_EVIDENCE');
      assert.equal(approved.dealScore-evaluateDeal(base).dealScore<=3,true);assert.equal(approved.dealScore,100);
    });
    await test('malformed revenue never becomes a positive score',()=>{
      const result=evaluateDeal({...base,revenue:[{day:'future',scope:'PRODUCT',scopeId:base.product.id,currency:'VND',amountsMinor:{PAID:Infinity}}]});
      assert.equal(result.revenueEvidence,undefined);assert.equal(result.revenueEvidenceScore,undefined);assert.equal(result.riskCodes.includes('INVALID_REVENUE_EVIDENCE'),true);
    });
    await test('production evaluator does not accept test-fixture provider/offer evidence',()=>{
      const result=evaluateDeal({...base,testOnly:false});assert.equal(result.monetizationScore,0);assert.equal(result.selectedOfferId,undefined);assert.equal(result.priority,'REJECT');
    });
    await test('evidence and algorithm changes produce new fingerprints',()=>{
      const first=evaluateDeal(base);const input=structuredClone(base);input.history[1].price+=1000;assert.notEqual(evaluateDeal(input).evidenceFingerprint,first.evidenceFingerprint);
      const config=structuredClone(DEAL_CONFIG);config.algorithmVersion='deal-intelligence-v2';assert.notEqual(evaluateDeal(base,config).evidenceFingerprint,first.evidenceFingerprint);
    });
    await test('score clamp and confidence boundaries reject nonfinite/mismatched values',()=>{
      assert.equal(boundedScore(-1),0);assert.equal(boundedScore(101),100);assert.equal(unitConfidence(0),0);assert.equal(unitConfidence(1),1);
      for(const value of [NaN,Infinity,-Infinity])assert.throws(()=>boundedScore(value),/INVALID_DEAL_SCORE/);
      for(const value of [NaN,Infinity,-1,1.01,100])assert.throws(()=>unitConfidence(value),/INVALID_DEAL_CONFIDENCE/);
    });
    for(const [name,mutate] of [
      ['weights',config=>{config.weights.price=41;}],['NaN weight',config=>{config.weights.price=NaN;}],['unbounded history',config=>{config.limits.samples=100000;}],
      ['negative penalty',config=>{config.penalties.STALE_PRICE=-1;}],['confidence mismatch',config=>{config.confidence.high=80;}],['wrong windows',config=>{config.windows.shortDays=31;}],
    ])await test(`config ${name} is rejected`,()=>{const config=structuredClone(DEAL_CONFIG);mutate(config);assert.throws(()=>validateDealConfig(config),/INVALID_DEAL_CONFIG/);});
  });
  await integration('E AccessTrade-sourced Shopee is valid independently of direct Shopee',async context=>{
    const source=await context.seedShopee();const input={...context.input,product:{...source.product,price:1600000,offers:verifiedPublicOffers(source.product.offers)},allowedHosts:source.allowedHosts};
    input.providers=await context.money.providers();const result=evaluateDeal(input);
    assert.equal(result.provider,'accesstrade');assert.equal(result.platform,'shopee');assert.equal(result.priority,'TOP');assert.equal(result.publishRecommendation,'PUBLISH');
    assert.equal(result.reasonCodes.includes('ACCESSTRADE_SHOPEE_VALID'),true);assert.equal((await context.shopee.healthCheck()).state,'DISABLED_NO_CREDENTIALS');assert.equal(context.calls.shopee,0);
  });
  await integration('F persisted duplicate evaluations create zero extra effects',async context=>{
    await context.persist();const first=await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    const second=await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now+1);
    assert.equal(first.effect,1);assert.equal(second.effect,0);assert.deepEqual(second.evaluation,first.evaluation);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM deal_evaluations').first()).count,1);
  });
  await integration('evaluation does not mutate product history or money ledger',async context=>{
    await context.persist();const tables=['products','price_history','affiliate_clicks','affiliate_conversions','affiliate_commissions','affiliate_money_events','affiliate_revenue_snapshots'];
    const before=await Promise.all(tables.map(table=>context.db.prepare(`SELECT * FROM ${table}`).all()));
    await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    const after=await Promise.all(tables.map(table=>context.db.prepare(`SELECT * FROM ${table}`).all()));assert.deepEqual(after.map(result=>result.results),before.map(result=>result.results));
  });
  await integration('indexed rankings return bounded origin-isolated results',async context=>{
    await context.persist();await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    assert.equal((await context.store.rank({kind:'TOP'},1,context.now)).data.length,1);
    assert.equal((await context.store.rank({kind:'PROVIDER',provider:'accesstrade'},1,context.now)).data.length,1);
    assert.equal((await context.store.rank({kind:'RECOMMENDATION',recommendation:'PUBLISH'},1,context.now)).data.length,1);
    assert.equal((await new D1DealStore(context.db).rank({kind:'TOP'},1,context.now)).data.length,0);
    for(const filter of [{kind:'TOP'},{kind:'PROVIDER',provider:'accesstrade'},{kind:'PROVIDER',provider:'accesstrade',platform:'shopee'},
      {kind:'RECOMMENDATION',recommendation:'REFRESH_FIRST'},{kind:'PRIORITY',priority:'TOP'},{kind:'WEAK_CONFIDENCE'},{kind:'NO_SAFE_PATH'},{kind:'STALE'}]){
      const query=context.store.rankingQuery(filter,10);const plan=await context.db.prepare('EXPLAIN QUERY PLAN '+query.sql).bind(...query.values).all();
      assert.equal(plan.results.some(row=>String(row.detail).includes('SEARCH deal_evaluations USING INDEX')),true);
      assert.equal(plan.results.some(row=>/SCAN deal_evaluations|TEMP B-TREE/.test(row.detail)),false);
    }
    await assert.rejects(()=>context.store.rank({kind:'TOP'},51,context.now),/DEAL_RANKING_BOUND/);
  });
  await integration('stale evaluations are hidden from live rankings',async context=>{
    await context.persist();const result=await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);const after=Date.parse(result.evaluation.validUntil);
    assert.equal(await context.store.latest(context.product.id,after),null);assert.equal((await context.store.rank({kind:'TOP'},5,after)).data.length,0);
    assert.equal((await context.store.rank({kind:'STALE'},5,after)).data.length,1);
  });
  await integration('atomic product changes invalidate recommendations before reevaluation',async context=>{
    await context.persist();await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    const record=await context.adapter.domain.getProduct(context.product.id);await context.adapter.domain.replaceProduct({...record.value,publicBlocked:true},record.version);
    assert.equal(await context.store.latest(context.product.id,context.now),null);const result=await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    assert.equal(result.evaluation.priority,'REJECT');assert.equal(result.effect,1);
  });
  await integration('provider changes invalidate immediately and fanout is bounded',async context=>{
    await context.persist();await context.store.expandProviderChanges();await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    const provider=(await context.money.providers())[0];await context.money.observeProvider({...provider,health:{...provider.health,enabled:false}});
    assert.equal(await context.store.latest(context.product.id,context.now),null);await context.store.expandProviderChanges();
    assert.equal((await context.db.prepare('SELECT due_at FROM deal_work WHERE product_id=?').bind(context.product.id).first()).due_at,0);
  });
  await integration('concurrent evidence change rolls back evaluation and terminal job effect',async context=>{
    await context.persist();const prepared=await context.store.prepare(context.product.id,context.input.allowedHosts,context.now);
    await context.db.prepare('UPDATE price_history SET price=price+1 WHERE id=?').bind(context.input.history[1].id).run();
    await assert.rejects(()=>context.store.commit(prepared,context.now),/D1_DEAL_COMMIT_RETRY/);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM deal_evaluations').first()).count,0);
  });
  await integration('Cron dispatch and Queue duplicate delivery converge',async context=>{
    await context.persist();const scheduler=createCloudflareSchedulerAdapter(context.env);await scheduler.tick(context.now);await scheduler.tick(context.now);
    const messages=context.sent.filter(message=>message.jobType==='DEAL_EVALUATE');assert.equal(messages.length,1);
    const {delivery}=require('./lib/cloudflare-autopilot-test.cjs');const first=delivery(messages[0]);
    assert.equal(await consumeDelivery(first,context.env,{moneyTestOnly:true,now:()=>context.now}),'SUCCEEDED');assert.equal(first.ackCount,1);
    const duplicate=delivery(messages[0]);assert.equal(await consumeDelivery(duplicate,context.env,{moneyTestOnly:true,now:()=>context.now}),'DUPLICATE_SAFE');assert.equal(duplicate.ackCount,1);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM deal_evaluations').first()).count,1);
  });
  await integration('missing Queue and disabled feature fail closed',async context=>{
    await context.persist();assert.throws(()=>createCloudflareSchedulerAdapter({...context.env,JOB_QUEUE:undefined}),/QUEUE_BINDING_UNAVAILABLE/);
    const job=await context.job({type:'DEAL_EVALUATE',idempotencyKey:'deal-missing-queue'});
    assert.equal(await consumeDelivery(context.message(job),{...context.env,JOB_QUEUE:undefined},{now:()=>context.now,moneyTestOnly:true}),'RETRYABLE');
    const disabled=await context.job({type:'DEAL_EVALUATE',idempotencyKey:'deal-disabled'});
    assert.equal(await consumeDelivery(context.message(disabled),{...context.env,SANDEAL_DEAL_INTELLIGENCE_ENABLED:'false'},{now:()=>context.now,moneyTestOnly:true}),'TERMINAL');
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM deal_evaluations').first()).count,0);
  });
  await integration('late Queue claims and lost acknowledgments cannot duplicate evaluations',async context=>{
    await context.persist();const input={type:'DEAL_EVALUATE',idempotencyKey:'deal-lease-proof',payload:{productId:context.product.id}};
    const jobs=new D1JobStore(context.db),job=await jobs.createJob(input,context.now);const claimed=await jobs.claim(job.job,context.now);
    const prepared=await context.store.prepare(context.product.id,context.input.allowedHosts,context.now);
    await context.db.prepare('UPDATE automation_jobs SET lease_expires_at=? WHERE id=?').bind(context.now-1,claimed.id).run();
    await assert.rejects(()=>context.store.commit(prepared,context.now,claimed),/D1_DEAL_COMMIT_RETRY/);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM deal_evaluations').first()).count,0);
    const fresh=(await jobs.createJob({...input,idempotencyKey:'deal-lost-ack'},context.now)).job;
    await assert.rejects(()=>consumeDelivery(context.message(fresh),context.env,{moneyTestOnly:true,now:()=>context.now,afterCommit(){throw new Error('explicit-local-lost-ack');}}),/explicit-local-lost-ack/);
    assert.equal(await consumeDelivery(context.message(fresh),context.env,{moneyTestOnly:true,now:()=>context.now}),'DUPLICATE_SAFE');
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM deal_evaluations').first()).count,1);
  });
  await integration('price capture event schedules only affected product evaluation',async context=>{
    await context.persist();await context.store.expandProviderChanges();await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    const row={...context.input.history[0],id:'changed-price-event',price:1100000,capturedAt:new Date(context.now).toISOString(),sourceHash:'explicit-new-price'};
    await context.adapter.domain.appendPriceSnapshot(row,{forceCheckpoint:false,checkpointHours:24});
    assert.equal(await context.store.latest(context.product.id,context.now),null);assert.equal(await context.store.materializeDue(context.now),1);
    const jobs=(await context.db.prepare("SELECT payload FROM automation_jobs WHERE job_type='DEAL_EVALUATE'").all()).results;
    assert.deepEqual(jobs.map(job=>JSON.parse(job.payload).productId),[context.product.id]);
  });
  await integration('verified ledger snapshot change triggers bounded reevaluation',async context=>{
    await context.persist();await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    const click=await context.click();await context.evidence(click.click);await context.snapshot('deal-revenue-pending');
    assert.equal(await context.store.latest(context.product.id,context.now),null);
    const result=await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);
    assert.equal(result.evaluation.revenueEvidence.conversions,1);assert.equal(result.evaluation.revenueEvidence.paidMinor,0);
    assert.equal(result.evaluation.revenueEvidence.approvedMinor,0);assert.equal(result.evaluation.revenueEvidenceScore,50);
  });
  await integration('history due work provider fanout and revenue reads use indexed bounded queries',async context=>{
    await context.persist();
    const queries=[
      ['SELECT payload FROM price_history WHERE product_id=? AND captured_at>=? ORDER BY captured_at DESC,id DESC LIMIT ?',[context.product.id,'2026-01-01T00:00:00.000Z',181],'price_history_product_time'],
      ['SELECT product_id,revision,due_at FROM deal_work WHERE due_at<=? ORDER BY due_at,product_id LIMIT ?',[context.now,10],'deal_work_due'],
      ['SELECT product_id FROM deal_provider_products WHERE provider=? AND product_id>? ORDER BY product_id LIMIT ?',['accesstrade','',10],'sqlite_autoindex_deal_provider_products'],
      ['SELECT * FROM affiliate_revenue_snapshots WHERE origin=? AND scope=? AND scope_id=? AND day>=? AND day<=? AND currency=? ORDER BY day LIMIT ?',
        ['TEST_FIXTURE','PRODUCT',context.product.id,'2026-09-01','2026-09-30','VND',31],'sqlite_autoindex_affiliate_revenue_snapshots'],
    ];
    for(const [sql,values,index] of queries){const plan=(await context.db.prepare('EXPLAIN QUERY PLAN '+sql).bind(...values).all()).results;
      assert.equal(plan.some(row=>String(row.detail).includes(index)),true,JSON.stringify(plan));assert.equal(plan.some(row=>/SCAN |TEMP B-TREE/.test(row.detail)),false,JSON.stringify(plan));}
  });
  await integration('due work and provider updates never fan out across an unlimited catalogue',async context=>{
    const {cloudflareProduct}=require('./fixtures/v6-cloudflare-product.cjs');
    for(let index=0;index<25;index++){
      const product=cloudflareProduct(`deal-bound-${String(index).padStart(2,'0')}`);product.offers=[structuredClone(context.product.offers.find(offer=>offer.monetization?.provider==='accesstrade'))];
      const result=await context.adapter.domain.createProduct(product);assert.equal(result.status,'APPLIED');
    }
    await context.db.prepare('UPDATE deal_work SET due_at=?,evaluated_revision=revision').bind(context.now+DAY).run();
    await context.store.expandProviderChanges();
    const first=(await context.db.prepare('SELECT COUNT(*) AS count FROM deal_work WHERE due_at=0').first()).count;
    assert.equal(first,11);assert.equal(await context.store.materializeDue(context.now),10);
    assert.equal((await context.db.prepare("SELECT COUNT(*) AS count FROM automation_jobs WHERE job_type='DEAL_EVALUATE'").first()).count,10);
    assert.equal((await context.db.prepare("SELECT pending FROM deal_provider_refresh WHERE provider='accesstrade'").first()).pending,1);
  });
  await integration('additive Phase 6 migration preserves Phase 5 jobs tasks and balances',async context=>{
    const {openLocalD1}=require('./lib/local-d1.cjs');const runtime=await openLocalD1({testOnly:true});
    try{
      const files=fs.readdirSync('src/lib/storage/d1/migrations').filter(name=>/^000[1-5]_.*\.sql$/.test(name)).sort();
      async function apply(name){const statements=fs.readFileSync('src/lib/storage/d1/migrations/'+name,'utf8').split('-- statement-breakpoint').map(value=>value.trim()).filter(value=>value&&!/^--[^\n]*$/.test(value));await runtime.db.batch(statements.map(sql=>runtime.db.prepare(sql)));}
      for(const file of files)await apply(file);
      const jobs=new D1JobStore(runtime.db);
      await jobs.createTask({id:'phase5-preserved-task',type:'AGGREGATE_GROWTH_METRICS',payload:{productId:'revenue-all'},enabled:true,nextRunAt:context.now,intervalMs:60000});
      const job=(await jobs.createJob({type:'AGGREGATE_GROWTH_METRICS',payload:{productId:'revenue-all'},idempotencyKey:'phase5-preserved-job'},context.now)).job;await jobs.claim(job,context.now);
      await runtime.db.prepare("INSERT INTO affiliate_revenue_snapshots(origin,scope,scope_id,day,currency,clicks,last_sequence) VALUES('TEST_FIXTURE','PRODUCT','explicit-old-fixture','2026-09-12','VND',2,2)").run();
      const before=await jobs.get(job.id),tasks=(await runtime.db.prepare('SELECT * FROM scheduled_tasks').all()).results,balances=(await runtime.db.prepare('SELECT * FROM affiliate_revenue_snapshots').all()).results;
      await apply('0006_deal_intelligence.sql');assert.deepEqual(await jobs.get(job.id),before);assert.deepEqual((await runtime.db.prepare('SELECT * FROM scheduled_tasks').all()).results,tasks);
      assert.deepEqual((await runtime.db.prepare('SELECT * FROM affiliate_revenue_snapshots').all()).results,balances);
      assert.equal((await jobs.createJob({type:'DEAL_EVALUATE',payload:{productId:'explicit-fixture'},idempotencyKey:'new-deal-job'},context.now)).created,true);
    }finally{await runtime.dispose();}
  });
  await test('D1 outage is sanitized and never uses fallback storage',async()=>{
    const db={prepare(){throw new Error('sensitive driver detail');}};const store=new D1DealStore(db);
    await assert.rejects(()=>store.prepare('product',['merchant.example'],Date.now()),error=>error.code==='D1_DEAL_UNAVAILABLE'&&error.message==='D1_DEAL_UNAVAILABLE');
    assert.throws(()=>createCloudflareSchedulerAdapter({SANDEAL_RUNTIME:'cloudflare',SANDEAL_LOCAL_ONLY:'true',SANDEAL_PRODUCTION:'false',SANDEAL_AUTOPILOT_ENABLED:'true',SANDEAL_DEAL_INTELLIGENCE_ENABLED:'true',JOB_QUEUE:{send(){}}}));
  });
  await integration('admin intelligence read is protected and never public or writable',async context=>{
    await context.persist();const env={...context.env,BASIC_AUTH_USER:'local-test-admin',BASIC_AUTH_PASSWORD:'local-test-password'};
    const headers={authorization:'Basic '+Buffer.from('local-test-admin:local-test-password').toString('base64')};
    assert.equal((await cloudflareFetch(new Request('https://sandeal.test/api/admin/deals'),env)).status,401);
    const response=await cloudflareFetch(new Request('https://sandeal.test/api/admin/deals',{headers}),env);assert.equal(response.status,200);assert.deepEqual((await response.json()).data,[]);
    assert.equal((await cloudflareFetch(new Request('https://sandeal.test/api/admin/deals?limit=100',{headers}),env)).status,400);
    assert.equal((await cloudflareFetch(new Request('https://sandeal.test/api/public/deals'),env)).status,501);
    assert.equal((await context.db.prepare('SELECT COUNT(*) AS count FROM deal_evaluations').first()).count,0);
  });
  await integration('supported path performs zero filesystem and FileStorage calls',async context=>{
    await context.persist();const {fileStorageAdapter:adapter}=require('../src/lib/storage/fileStorageAdapter.ts');
    const descriptors=new Map();
    const originals=new Map(),fileCalls={count:0},settingsCalls={count:0};
    for(const method of ['readFile','writeFile','mkdir','rename','open','stat','access','readdir','unlink','rm']){originals.set(method,fs.promises[method]);fs.promises[method]=async()=>{settingsCalls.count++;throw new Error('FILESYSTEM_FORBIDDEN');};}
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(adapter))){
      if(typeof descriptor.value!=='function'&&!descriptor.get)continue;descriptors.set(key,descriptor);
      Object.defineProperty(adapter,key,{configurable:true,get(){fileCalls.count++;throw new Error('FILE_STORAGE_FORBIDDEN');}});
    }
    try{
      await createCloudflareSchedulerAdapter(context.env).tick(context.now);
      const {delivery}=require('./lib/cloudflare-autopilot-test.cjs');
      assert.equal(await consumeDelivery(delivery(context.sent[0]),context.env,{now:()=>context.now,moneyTestOnly:true}),'SUCCEEDED');
      await context.store.evaluate(context.product.id,context.input.allowedHosts,context.now);await context.store.rank({kind:'TOP'},10,context.now);
    }
    finally{for(const [method,original] of originals)fs.promises[method]=original;for(const [key,descriptor] of descriptors)Object.defineProperty(adapter,key,descriptor);}
    assert.equal(fileCalls.count,0);assert.equal(settingsCalls.count,0);assert.equal(context.runtime.built.fileStorageModules,0);assert.equal(context.runtime.built.filesystemSettingsModules,0);
  });
  await test('test sources have no skipped focused cases or production fixture branches',()=>{
    const source=fs.readFileSync(__filename,'utf8');const forbidden=new RegExp('\\.'+'(?:skip|only)\\s*\\(|\\b(?:f'+'it|fdescribe)\\s*\\(');
    assert.equal(forbidden.test(source),false);
    for(const name of ['config.ts','evaluate.ts','priceEvidence.ts']){
      const content=fs.readFileSync('src/lib/deal-intelligence/'+name,'utf8');assert.equal(/Math\.random|fetch\(|setInterval|while\s*\(\s*true/.test(content),false);
      assert.equal(content.includes('1600000'),false);
    }
  });
}
main().catch(error=>{failed++;console.error('FAIL setup',error);}).finally(()=>{console.log(`V6 deal intelligence: ${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;});
