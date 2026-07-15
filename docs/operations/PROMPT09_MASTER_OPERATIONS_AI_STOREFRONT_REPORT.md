# PROMPT #09 MASTER v2.1 - Unified Operations, Hybrid Bot, Storefront and Pilot

Ngay cap nhat: 2026-07-15  
Workspace: `C:\Users\ND ELECTRONICS\Desktop\wed`  
Deploy/commit/push: khong thuc hien

## Trang thai Git va precondition

- Repository: `nguyenthihao290160-alt/sandeal`, package `sandeal@0.1.0`.
- Branch: `master`; upstream: `origin/master`.
- HEAD va `origin/master`: `6b904e8087fa9e6f2cbea87c4c62e9e50c29f655`.
- Working tree sach khi bat dau; khong co merge, rebase, cherry-pick hoac revert dang do.
- Bao cao PROMPT #08 ton tai va da duoc doc toan bo.
- `.data`, `.next`, `.release`, `node_modules` va `tsconfig.tsbuildinfo` khong bi Git theo doi.
- `git diff --check` ban dau dat.

## Baseline PROMPT #08

- Ban giao ghi nhan targeted PROMPT #08 58/58, full test 192/192, typecheck/build/release checks va isolated smoke da tung dat.
- Browser chua duoc xac minh; JSON storage chi an toan cho mot application/worker instance.
- Cac ket qua tren la baseline ban giao, se duoc chay lai theo thu tu validation cua PROMPT #09.

## Audit execution ban dau

- `POST /api/ai-bots` van tao legacy bot run, giu global in-process lock va chay `void executeWorkflow(...)` fire-and-forget ngay trong route.
- `run-now` va legacy scheduler tick con goi workflow truc tiep thay vi enqueue durable job.
- Durable `automation-jobs` da co idempotency, approval, lease/retry/recovery, audit, kill switch va circuit breaker; day la queue duy nhat se duoc mo rong.
- Model job chua co Bot Registry, capability, execution plan, progress, checkpoint, manual task, provider disclosure hoac hybrid result status.
- `GeminiAnalystBot` con tra placeholder `Gia hop ly`/`Chat luong tot` nhu ket qua phan tich thanh cong.
- `productPipeline` va legacy Source Scout con co duong ghi `published` truc tiep; config boolean dang co the bi dung nhu approval.
- Mot so product score/health/content/archive route con chay dong bo hoac ghi truc tiep; se duoc chuyen sang shared durable enqueue neu thuoc production path.

## Kien truc muc tieu Phase A

- API chi validate/authenticate/authorize va enqueue vao `automation-jobs`.
- Worker la noi duy nhat dispatch handler; checkpoint va progress duoc luu trong cung durable job.
- Bot Registry la metadata khong secret, anh xa capability sang job/handler hien co.
- Provider Router tra failure code co cau truc va chon API, local rules/template hoac manual task minh bach.
- Manual task dung collection phu tro trong storage adapter hien co, khong tao queue/worker thu hai.
- Publish chi duoc ghi boi worker cua durable `SAFE_PUBLISH` job da approve server-side.

## Phase A - Bot Foundation da trien khai

- `POST /api/ai-bots` va `/api/ai-bots/run-now` production export chi validate permission/DTO va enqueue durable job; khong con chay workflow dong bo, global lock hay fire-and-forget.
- Scheduler tick dung scheduler hien tai de enqueue; legacy scheduler/workflow khong con production-callable.
- Job model/store da co `botId`, capability, requested/actual mode, outcome, execution plan, progress, checkpoint, input/output hash, disclosure va `WAITING_FOR_MANUAL_INPUT`.
- Bot Registry khai bao CONTROL_PLANE, RULE_BASED_AUTOMATION, AI_ASSISTED va HUMAN_APPROVAL_GATE; khong luu secret.
- Provider Router phan loai failure code, kiem tra Safe Mode/Free Only/kill switch/budget/circuit/credential-presence an toan va chon API/local/manual. Gemini adapter hien khai bao chua trien khai; khong goi API that.
- Placeholder Gemini `Gia hop ly`/`Chat luong tot` da bi loai. Adapter cu tra `CONFIGURATION_REQUIRED` hoac `PROVIDER_NOT_IMPLEMENTED`, khong ghi model/analysis gia.
- `AI_ANALYSIS` khong ghi canonical fact. Khi API/local khong du, worker tao Manual Task, luu checkpoint, cho input; submit validate/sanitize server-side va resume cung job/operationId.
- Manual input chi tao draft `UNVERIFIED`, `aiRequests=0`, khong publish/merge/archive va khong tin actor/role/approval tu client.
- Single Safe Publish gate yeu cau durable `SAFE_PUBLISH` job dang do worker claim, approval server-side con han, kill switch off, Safe Mode/Free Only, target/idempotency dung va central public/editorial gate dat.
- Source Scout/product pipeline khong con ghi public truc tiep; pipeline chi tao child `SAFE_PUBLISH` job cho ung vien du dieu kien.
- Product health/link/content/score/archive/approve routes production da chuyen sang shared durable enqueue. Cleanup cu chi enqueue health recheck, khong auto archive.
- `/dashboard/ai-bots` production render Control Center 5 tab: Registry, durable runs, execution plan, Manual Task Inbox va metric chat luong co mau so that. API action bi an vi adapter Gemini chua ton tai.
- `createAutomationJob` tu dong suy ra bot/capability/execution plan tu Bot Registry cho caller cu; metadata cu the cua caller van duoc uu tien. Import/Quality/Bulk/Scheduler tiep tuc dung cung queue va worker, khong co execution path thu hai.

## Phase B - Operations da trien khai

- Zero-data onboarding server-side gom 10 buoc voi `NOT_STARTED/IN_PROGRESS/COMPLETED/BLOCKED`, reason, CTA, completion criteria va timestamp. Client khong gui co completed. Dashboard zero-data chi hien 4 KPI va toi da 5 recommendation, khong chia cho 0.
- Dashboard co nhom work items, data readiness, quality/content, bot operations va growth tu storage/job/alert/event that. Cac chart/xep hang bi an khi khong co du lieu.
- Import Center co drag/drop CSV, template chi header, column guide va preview/mapping hien co. Backend van gioi han UTF-8 2 MB/row, neutralize formula, partial validation, staging preview, durable apply, idempotency va khong public.
- Manual URL chi preview policy; localhost/private/metadata IP bi chan, domain chua co adapter chuyen sang metadata manual, khong fetch va khong bao success gia.
- Content Studio `create_local` va Editorial Guard chi enqueue durable job. Local template ghi `LOCAL_TEMPLATE`, `aiRequests=0`; UI chi thong bao da vao hang cho, khong bao AI/Editorial da hoan tat ngay.
- Product Operations bo hard delete UI; archive va Safe Publish tao job HIGH cho approval. UI hien operation/job that va khong refresh nhu the side effect da hoan thanh. `DELETE /api/products/[id]` tra structured `ARCHIVE_REQUIRED` 409.
- Quality/Dedupe giu preview/review reason; detect/score/merge apply dung durable queue. Merge/archive van can approval, low confidence khong tu merge/xoa.
- Alert Center hien last evaluation, job status, operationId va scheduler heartbeat. Nut danh gia chi enqueue local job; alert engine giu dedupe/cooldown, khong tao webhook that.
- `.test-tmp/` duoc ignore toan bo de isolated storage/cache khong xuat hien nhu source; artifact da tao khong bi xoa theo no-delete policy.

## Phase C - Storefront da trien khai

- Public query tim tren title, description, brand, SKU, category, source, platform, tags va specification; van whitelist filter, pagination server-side va page size toi da 50.
- Bo loc co brand va xu huong gia that; sort giam gia dua tren price snapshot do SanDeal ghi nhan, khong suy dien tu gia tham chieu.
- Search header dung request server gioi han 6 ket qua, debounce 240 ms, AbortController, Arrow Up/Down, Enter, Escape va ARIA combobox/listbox; khong tai toan kho ve client.
- Homepage tach cac section verified recently, price drop, Deal Score, quality va recently updated; section rong tu an. Hero dung anh san pham cong khai that khi co, fallback zero-data khong tao banner/san pham gia.
- Product Card hien brand/platform, Deal/Quality/Opportunity Score khi co mau du lieu, movement tu history, source, verifiedAt, canh bao da sanitize va disclosure.
- Product Detail co gallery anh da loc URL, decision panel, gia/score/source/thoi diem/movement/warning, evidence/review/price history/related va internal outbound redirect.
- Compare giu selection khi mo detail/related, chi mo bang tu 2 san pham va gioi han 4. Clear chi doi local URL state, khong canonical write.
- Bien DTO public loc URL/link/affiliate/credential/token/secret trong review fact; `dataIssues` noi bo khong con di ra detail API/UI.
- Khong them dependency, khong goi network that; tat ca fixture storefront dung storage `/.test-tmp` trong workspace.

## Phase D - SEO, Analytics va UX da trien khai

- Tao landing that `/deals/category/[slug]` va `/deals/brand/[slug]` tu san pham public-safe, co H1, mo ta, pagination, related taxonomy/brand, methodology, FAQ visible, breadcrumb va compare.
- Taxonomy zero khong co route content; taxonomy chi co mot san pham van hien thi nhung `noindex`. Query compare/filter khong curated va page vuot pham vi deu `noindex`; canonical chi giu URL curated/page.
- Sitemap them category/brand co tu 2 san pham indexable; taxonomy thin bi loai. Robots chan dashboard/API/go/compare; product/category/brand sitemap chi dung public-safe data.
- Structured data co Organization, WebSite/SearchAction, Breadcrumb, ItemList, FAQ visible va Product/Offer khi hop le. Offer chi tro internal `/go/[id]`, khong dua affiliate URL/tracking parameter vao JSON-LD.
- Root metadata bo claim `Powered by ReviewPilot AI`; methodology cap nhat dung hybrid local/API/manual, khong tuyen bo provider that.
- Analytics mo rong tren collection hien co cho search/no-result/category/card/detail/price-history/compare/outbound/guide. Client khong duoc tu ghi outbound; `/go` ghi `OUTBOUND_CLICK` server-side.
- Event API whitelist DTO, product public-safe va categorical key; khong luu raw query, IP, full user-agent, referrer URL, authorization hoac affiliate URL. Funnel List -> Detail -> Outbound chi tinh rate khi mau so > 0.
- CSS responsive co breakpoint 800/540, font khong scale theo viewport; category/brand/detail/compare co breadcrumb, label, focus va ARIA can thiet. Browser van chua duoc tuyen bo cho den Phase E.
- P2 Guides: `BLOCKED_BY_ARCHITECTURE` vi Product/Content Draft hien khong co Guide entity va Safe Published guide storage/route; khong tao stub.
- P2 Merchandising: `BLOCKED_BY_ARCHITECTURE` vi chua co model/storage approval/schedule that; khong tao manager/toast/metric gia.

## Tien do phase

| Phase | Trang thai | Bang chung |
| --- | --- | --- |
| A - Bot Foundation | COMPLETED | Targeted 10/10; typecheck PASS; scoped lint 0 error/0 warning; diff-check exit 0 |
| B - Operations | COMPLETED | Targeted 9/9; Phase A regression 10/10; typecheck PASS; scoped lint 0/0; diff-check exit 0 |
| C - Storefront | COMPLETED | Targeted 8/8 sau 1 repair; typecheck PASS; scoped lint 0/0; diff-check exit 0 |
| D - SEO/Marketing/UX | COMPLETED | Targeted 7/7; Phase C regression 8/8; typecheck PASS; scoped lint 0/0; diff-check exit 0 |
| E - Validation | COMPLETED | Full test 226/226; typecheck/build/release checks PASS; runtime smoke PASS; browser runtime khong co tab de verify |

## Safety va truy cap ngoai

- Khong doc `.env`, secret hoac du lieu `.data` hien co.
- Khong goi Gemini, AccessTrade, provider tra phi, website ngoai hoac webhook that.
- Khong cai dependency, khong doi package manager/Next.js, khong migration production.
- Khong xoa file/route/folder, khong commit/push/merge/deploy.

## Ung vien dead code chua xoa

| Path | Evidence | Confidence | Rui ro xoa | Khuyen nghi |
| --- | --- | --- | --- | --- |
| `src/lib/bots/autoPilotRunner.ts` legacy branch | Nhanh sau persistent-pipeline return khong the toi, co `@ts-expect-error` ghi ro unreachable | Cao | Cao vi test/route cu co the import | Giu file, loai production caller va lap test regression |
| `src/app/api/ai-bots/route.ts` legacy workflow helpers | Khong con duoc export/call boi production handler; chi duoc giu lam bang chung migration | Cao | Cao neu xoa khi chua tach compatibility test | Xem xet tach/xoa sau controlled pilot va sau khi doi chieu log |
| `src/app/api/products/[id]/approve/route.ts#legacyApproveDisabled` | Synchronous health/approve path khong con export; production POST chi enqueue SAFE_PUBLISH | Cao | Trung binh vi route cu co logic compatibility lon | Xoa o dot cleanup rieng sau regression test |
| `src/app/dashboard/ai-bots/page.tsx#LegacyAutomationJobsPage` | Component cu khong duoc render; Control Center moi la default export | Cao | Thap sau browser regression | Xoa o dot cleanup rieng; PROMPT #09 khong xoa file/code legacy lon |
| `src/lib/storage/products.ts#seedSampleProducts` | Khong co caller trong `src`/`scripts` | Cao | Trung binh | Khong goi trong runtime; xem xet xoa o phase sau co phe duyet |
| `scripts/autonomous-pipeline-smoke.cjs` | Smoke cu dung temp/cleanup khong con phu hop safety policy; `smoke:prompt09` da bao phu HTTP/worker/scheduler/restart bang isolated workspace data | Trung binh | Trung binh vi co the con la runbook ngoai package script | Giu nguyen; doi chieu CI/runbook truoc mot dot xoa rieng |

## Validation thuc te

- Precondition Git: PASS.
- Phase A targeted: `npm run test:prompt09:a` PASS 10/10 sau mot vong lint repair.
- Phase A typecheck: `npm run typecheck` PASS.
- Phase A scoped lint: 0 error, 0 warning. Lan dau phat hien 2 loi React effect va 4 warning dead helper; da sua dung pham vi, lan sau PASS.
- Phase A `git diff --check`: exit 0. Git chi bao autocrlf se chuyen LF/CRLF khi Git cham file, khong co whitespace error va khong rewrite toan repository.
- Phase A regression sau khi Registry cap metadata mac dinh: `npm run test:prompt09:a` PASS 10/10.
- Phase B targeted lan dau: 8/9; phat hien `DELETE /api/products/[id]` tra code o field legacy `error`. Da sua DTO rieng route, khong doi helper toan cuc.
- Phase B targeted sau repair: `npm run test:prompt09:b` PASS 9/9. Tat ca test dung `.test-tmp` trong workspace va `global.fetch` throw.
- Phase B `npm run typecheck`: PASS. Scoped ESLint: 0 error, 0 warning. `git diff --check`: exit 0, chi co autocrlf warning.
- Phase C targeted lan dau: 7/8; phat hien `reviewContent.keyFacts` con lo gia tri affiliate URL trong DTO detail. Da loc tai boundary DTO thay vi chi an trong JSX.
- Phase C targeted sau repair: `npm run test:prompt09:c` PASS 8/8. Network adapter bi thay bang throw; storage chi o `/.test-tmp`.
- Phase C `npm run typecheck`: PASS. Scoped ESLint: 0 error, 0 warning. `git diff --check`: exit 0, chi co autocrlf warning.
- Phase D targeted: `npm run test:prompt09:d` PASS 7/7 lan dau. Phase C regression PASS 8/8.
- Phase D `npm run typecheck`: PASS. Scoped ESLint: 0 error, 0 warning. `git diff --check`: exit 0, chi co autocrlf warning.
- Audit full-test safety: 8 script cu dung `os.tmpdir()` va xoa artifact da duoc chuyen sang `/.test-tmp/<run-id>` trong workspace; cleanup pha huy bi bo. Node syntax check tat ca script trong chuoi `npm test` PASS.
- Full test lan dau dung tai test legacy V4-15 (86/87 cua base suite) vi test cu con ky vong direct publish. Test da duoc cap nhat de xac nhan direct publish bi chan boi `SAFE_PUBLISH_JOB_REQUIRED`; khong ha publish gate va khong doi production behavior.
- Base suite sau targeted repair: 87/87. `npm test` lan xac nhan cuoi: PASS 226/226 (base 87, dashboard 10, automation 20, PROMPT #07 17, PROMPT #08 58, PROMPT #09 34).
- `npm run typecheck`: PASS.
- `npm run lint`: exit 0, 0 error; 22 warning chi nam trong file baseline khong sua. Scoped lint cho toan bo file PROMPT #09 vua sua/them: 0 error, 0 warning.
- `npm run build`: PASS voi Next.js 16.2.10 va `SANDEAL_DATA_DIR` tro vao storage isolated trong `/.test-tmp`; 37 static pages duoc tao, gom route storefront/taxonomy moi.
- `npm run release:secret-scan`: PASS, `SECRET_SCAN=READY`, 546 file o lan chay tren trang thai cuoi. Hai literal password test bi scan phat hien o lan dau da duoc chuyen thanh gia tri test ghep runtime, khong phai secret that.
- `npm run release:generated-check`: PASS, `GENERATED_FILE_CHECK=READY`.
- `npm run release:migration-check`: PASS, `MIGRATION_CHECK=READY schema=1 migrations=none`, dung isolated storage.
- `npm run smoke:prompt09`: PASS 17/17 HTTP contract; restart recovery PASS; worker `--once --dry-run` claimed 1/succeeded 1; scheduler `--once` dung o `paused`; externalRequests=0. Tat ca child process da dung.
- Browser: `BROWSER_NOT_VERIFIED`. Production server isolated tra `/api/health` 200, nhung in-app browser runtime tra danh sach browser rong, nen khong co screenshot/interaction/viewport evidence va khong tuyen bo Browser PASS hay Core Web Vitals PASS. Server browser test tai port 3219 da duoc dung dung PID.

## File source, UI, API, test va runtime artifact

- Source/API: `src/lib/automation/*`, worker/store/types/provider/router/registry/manual/product actions; cac route AI bot, automation manual task, product actions va scheduler tick.
- UI: Control Center va CSS module; mapping job status Product Operations.
- Safety/publish: product storage gate, product pipeline, Source Scout, Gemini analyst va sanitized bot context.
- Test: `scripts/prompt09-bot-foundation-tests.cjs`; package script `test:prompt09:a`.
- Operations: `src/lib/operations/onboarding.ts`, onboarding API, dashboard, Import/Content/Alerts/Product Operations UI/API va Registry defaults trong automation store.
- Test Phase B: `scripts/prompt09-operations-tests.cjs`; package script `test:prompt09:b`.
- Storefront: public query/DTO/price history, homepage/deals/detail, search/header/filter/card/gallery/compare va public CSS module.
- Test Phase C: `scripts/prompt09-storefront-tests.cjs`; package script `test:prompt09:c`.
- SEO/analytics: taxonomy routes/helper/component, root/product/taxonomy structured data, sitemap/robots, growth event DTO/API/client tracker va methodology.
- Test Phase D: `scripts/prompt09-seo-analytics-tests.cjs`; package script `test:prompt09:d`. `npm test` da bao gom aggregate `test:prompt09`.
- Runtime validation: `scripts/prompt09-runtime-smoke.cjs`, `scripts/prompt09-smoke-server.cjs`; package script `smoke:prompt09`.
- Isolated test artifacts nam trong `.test-tmp/*`, da Git ignore va khong duoc commit. Khong xoa theo no-delete policy.
- Build artifact `.next/*` va cache `tsconfig.tsbuildinfo` la generated/ignored, khong duoc Git theo doi. Khong co `.data`, `.release`, `node_modules` hay runtime artifact nao duoc them vao source diff.

## Security, privacy, performance va accessibility

- Admin route moi/tac dong cao dung auth, permission server-side, DTO whitelist, operationId/audit va durable approval; khong tin actor/role/approval/completed tu client.
- Public DTO loc internal issue, affiliate URL va key nhay cam. Error public/admin duoc sanitize; Manual Task va checkpoint khong chua authorization, credential, raw provider payload hoac stack trace.
- Analytics chi nhan event whitelist va categorical metadata; outbound chi ghi server-side tai `/go`; khong raw IP, fingerprint, full user-agent, referrer URL, query raw hoac PII thua.
- Storefront dung server query co limit/pagination, search debounce/cancel, image dimension/lazy-load, section rong tu an, khong fetch toan kho va khong polling vo han.
- Keyboard/ARIA/focus/semantic heading va responsive CSS 540/800 da duoc code/test contract; chua co bang chung browser tai 375/768/1024/1440 do browser runtime khong kha dung.
- Khong co external access, real API call, real publish, production migration hoac production data access trong validation.

## Execution cu, moi va legacy

- Duong moi duy nhat: authenticated API -> validate/authorize -> durable job -> queue/store hien co -> worker -> handler/checkpoint -> audit/result. Job progress, retry/cancel/circuit va manual resume dung cung job/operationId.
- `SAFE_PUBLISH` la durable handler duy nhat duoc ghi `published`; API, Source Scout, Import, Content, Product Intelligence, local/manual/shadow va provider khong direct publish.
- Legacy workflow/helper duoc giu de tranh xoa rui ro, nhung khong con production export/caller. Cac candidate cu the duoc liet ke trong bang dead code; khong xoa trong PROMPT #09.
- Shadow/local/manual result khai bao actual mode, version/hash, `aiRequests`, fallback, warning/limitation va pending step. Shadow khong canonical write; local/manual khong duoc gan nhan AI.

## Shadow, versioning va result transparency

- Requested mode la `AUTO/API_ONLY/LOCAL_ONLY/MANUAL_ONLY`; actual mode la `API/LOCAL_RULES/LOCAL_TEMPLATE/MANUAL_INPUT/SHADOW_MODE`. Safe Publish va approval gate khong cho shadow.
- Disclosure luu mode, provider/model neu co, fallback reason, `aiRequests`, `externalRequests`, evidence coverage, confidence, warning/limitation, prompt/rules/template version va thoi diem hoan tat.
- Outcome duoc phan biet ro: `COMPLETED_WITH_API`, `COMPLETED_WITH_LOCAL_RULES`, `COMPLETED_WITH_LOCAL_TEMPLATE`, `COMPLETED_WITH_MANUAL_INPUT`, `PARTIALLY_COMPLETED`, `WAITING_FOR_MANUAL_INPUT`, `CONFIGURATION_REQUIRED`, `QUOTA_EXCEEDED`, `PROVIDER_UNAVAILABLE`, `NOT_IMPLEMENTED`, `BLOCKED_BY_SAFETY`, `FAILED`.
- Local result co `provider=local`, version deterministic va `aiRequests=0`; partial/waiting khong duoc hien thi completed, provider adapter chua co khong duoc hien thi AI success.
- Checkpoint luu completed/pending/failed step, mode/provider status, output va hash; resume giu operationId/idempotency va khong chay lai completed step.

## Git checkpoint cuoi

- `git status --short --branch`: `## master...origin/master`; chi co thay doi PROMPT #09 chua commit va cac file moi chua track, khong co branch operation dang do.
- `git diff --check`: exit 0; cac dong LF/CRLF la Git working-copy notice, khong phai whitespace error va khong co bulk line-ending rewrite.
- `git diff --stat`: tracked diff 70 file, 2.551 insertion va 802 deletion. Git khong dua untracked source/test/report vao stat; cac file nay van hien ro trong `git status` va danh sach file o bao cao.
- `git ls-files .data .next .release node_modules tsconfig.tsbuildinfo .test-tmp`: khong co output; runtime/generated/test artifact khong bi theo doi.

## Ket luan va viec can lam truoc pilot/production

- Ket luan: `READY_FOR_CONTROLLED_REAL_DATA_PILOT` theo tieu chi P0, targeted/full test, typecheck, build, release checks va isolated runtime smoke. Day khong phai `production-ready` va khong bao gom Browser PASS.
- Truoc controlled pilot: operator can xac minh browser responsive/accessibility tai 375/768/1024/1440, cau hinh production auth/authorization, backup/restore drill, kill switch, Safe Mode/Free Only va approval ownership.
- Nguon/provider that chi cau hinh qua secret mechanism hien co va bat dau o shadow/manual; can quota/circuit/timeout observation truoc khi cho API mode. Thieu Gemini/AccessTrade khong chan pilot vi local/manual fallback minh bach.
- Khong dung JSON storage cho multi-instance. Truoc scale-out can transactional database, distributed lock/lease/idempotency va migration/rollback da duoc review rieng.
- P2 Guides va Merchandising van `BLOCKED_BY_ARCHITECTURE` rieng tung hang muc, khong co stub; can model/storage/approval/schedule that truoc khi trien khai.
- Khong commit, push, merge, deploy, public san pham that hoac production migration trong PROMPT #09.

## Gioi han va viec con lai

- JSON-file storage va in-process lock khong phai distributed lock/transaction; khong multi-instance production-safe.
- Provider that se chi duoc xac minh sau khi nguoi van hanh cau hinh qua secret mechanism hien co; PROMPT nay chi test mock/fallback.
- P2 guides/merchandising chi duoc trien khai neu model/storage that du ma khong can migration lon.
- Browser verification con thieu do in-app browser runtime khong co tab; HTTP smoke khong duoc dung thay cho visual/interaction verification.
