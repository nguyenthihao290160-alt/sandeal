CREATE TABLE decision_records (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  deal_fingerprint TEXT NOT NULL CHECK(length(deal_fingerprint)=64),
  policy_version TEXT NOT NULL,
  config_version TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('ALLOW','ALLOW_WITH_REVIEW','HOLD','BLOCK','QUARANTINE')),
  review_required INTEGER NOT NULL CHECK(review_required IN (0,1)),
  ai_status TEXT NOT NULL CHECK(ai_status IN ('DISABLED','AVOIDED','UNAVAILABLE','INVALID','VALID')),
  ai_failed INTEGER NOT NULL CHECK(ai_failed IN (0,1)),
  provider TEXT,
  platform TEXT,
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  created_at INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=16384),
  UNIQUE(origin,product_id,fingerprint)
);
-- statement-breakpoint
CREATE INDEX decision_product_latest ON decision_records(origin,product_id,created_at DESC,id);
-- statement-breakpoint
CREATE INDEX decision_current ON decision_records(origin,product_id,config_version,deal_fingerprint,created_at DESC,id);
-- statement-breakpoint
CREATE INDEX decision_priority ON decision_records(origin,score DESC,id);
-- statement-breakpoint
CREATE INDEX decision_review ON decision_records(origin,review_required,created_at DESC,id);
-- statement-breakpoint
CREATE INDEX decision_outcome ON decision_records(origin,outcome,created_at DESC,id);
-- statement-breakpoint
CREATE INDEX decision_ai_status ON decision_records(origin,ai_failed,created_at DESC,id);
-- statement-breakpoint
CREATE INDEX decision_provider ON decision_records(origin,provider,created_at DESC,id);
-- statement-breakpoint
CREATE INDEX decision_platform ON decision_records(origin,provider,platform,created_at DESC,id);
-- statement-breakpoint
CREATE INDEX decision_expiry ON decision_records(origin,valid_until,id);
-- statement-breakpoint
CREATE TABLE decision_ai_advice (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=64),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  state TEXT NOT NULL CHECK(state IN ('RESERVED','COMPLETE')),
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 2),
  created_at INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  payload TEXT CHECK(payload IS NULL OR (json_valid(payload) AND length(CAST(payload AS BLOB))<=8192))
);
-- statement-breakpoint
CREATE INDEX decision_ai_expiry ON decision_ai_advice(origin,valid_until,id);
-- statement-breakpoint
CREATE INDEX decision_ai_product ON decision_ai_advice(origin,product_id,created_at DESC,id);
-- statement-breakpoint
CREATE TABLE decision_ai_budget (
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  window INTEGER NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0 CHECK(calls BETWEEN 0 AND 10),
  PRIMARY KEY(origin,window)
);
-- statement-breakpoint
CREATE TABLE decision_ai_health (
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  provider_key TEXT NOT NULL CHECK(length(provider_key)<=100),
  failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 3),
  retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(origin,provider_key)
);
