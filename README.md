This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Worker and Scheduler runtime safety

Production Worker and Scheduler processes fail closed before acquiring a runtime
role unless these five values are matching full Git SHAs:

- `SANDEAL_BUILD_MANIFEST_COMMIT`
- `SANDEAL_BUILD_COMMIT`
- `SANDEAL_RELEASE_ID`
- `GIT_COMMIT_SHA`
- `NEXT_PUBLIC_SANDEAL_RELEASE_ID`

For FileStorage job mutations, expensive scanning, serialization, temporary-file
writing, and backup preparation occur under the `automation-jobs` collection
lock without holding the Worker runtime-role fence. The fence is acquired only
for final authority validation and remains held through atomic replacement and
durable sync. A takeover before that boundary rejects the stale mutation and
removes its temporary file.

Slow or failed file transactions emit the payload-free
`file_storage_transaction_timing` diagnostic. It separates collection-lock wait,
preparation, runtime-authority wait/hold, and atomic-commit time. Run the focused
regression suite with:

```bash
npm run test:runtime-fence
```

## V6 Decision OS — Local Shadow Foundation

Phase 7 reuses the existing Affiliate Money Engine, Deal Intelligence Engine,
and Cloudflare D1/Queue lifecycle. Deterministic policy is authoritative; AI
advice cannot change deal scores, financial evidence, publication gates, or
affiliate routing. Action plans are inert internal markers, not executors.

```bash
npm run test:v6:decisions
node scripts/v6-phase7-validation.mjs tests
node scripts/v6-phase7-validation.mjs quality
```

These checks use local fixtures and ephemeral D1. No live AI account is needed.
The local Worker opt-in is `SANDEAL_DECISION_OS_ENABLED=true`, alongside the
existing local-only AutoPilot and Deal Intelligence flags. Execution mode is
always `SHADOW`; any other configured mode fails closed. The shipped Worker
keeps AI disabled and has no external action executor or notification transport.

See `docs/v6/phase-07-decision-os.md` for the policy, advisory-provider boundary,
bounded storage, verification evidence, and remaining production limitations.

## V6 Opportunity And Experiments — Local Shadow Only

Phase 7.5 ranks verified opportunities independently of DealScore using the
existing Money Engine, Decision OS and indexed D1 deal jobs. It never updates
public ranking, content, affiliate destinations, prices or traffic routing.

```bash
npm run test:v6:opportunities
node scripts/v6-phase7-validation.mjs tests phase7-5
node scripts/v6-phase7-validation.mjs quality phase7-5
```

The optional local Worker flag is `SANDEAL_OPPORTUNITY_ENABLED=true`, with the
existing local-only AutoPilot, Deal Intelligence and Decision OS prerequisites.
It is not enabled in shipped configuration. AI remains disabled; missing D1 or
Queue bindings fail closed. Experiment assignment and metric ingestion require
explicit test dependency injection and have no HTTP or storefront entry point.
`ACTIVE` is rejected by both the experiment state machine and D1 schema.

See `docs/v6/phase-07-5-opportunity-experiments.md` for score weights, evidence
limitations, bounded queries, local proof and the separate Phase 8 authorization
boundary. Legacy `Product.opportunityScore` remains a legacy display value, not
the V6 Opportunity Engine's authoritative score.
