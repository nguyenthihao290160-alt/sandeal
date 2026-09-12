CREATE TABLE scheduled_tasks_deal (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 160),
  job_type TEXT NOT NULL CHECK(job_type IN ('CAPTURE_PRICE_HISTORY','AGGREGATE_GROWTH_METRICS','DEAL_EVALUATE')),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 512),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  next_run_at INTEGER NOT NULL CHECK(next_run_at >= 0),
  interval_ms INTEGER NOT NULL CHECK(interval_ms BETWEEN 60000 AND 2678400000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)
);
-- statement-breakpoint
INSERT INTO scheduled_tasks_deal SELECT * FROM scheduled_tasks;
-- statement-breakpoint
DROP TABLE scheduled_tasks;
-- statement-breakpoint
ALTER TABLE scheduled_tasks_deal RENAME TO scheduled_tasks;
-- statement-breakpoint
CREATE INDEX scheduled_tasks_due ON scheduled_tasks(enabled,next_run_at,id);
-- statement-breakpoint
CREATE TABLE automation_jobs_deal (
  id TEXT PRIMARY KEY NOT NULL,
  job_type TEXT NOT NULL CHECK(job_type IN ('CAPTURE_PRICE_HISTORY','AGGREGATE_GROWTH_METRICS','DEAL_EVALUATE')),
  idempotency_key TEXT UNIQUE NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 512),
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED','BLOCKED')),
  created_at TEXT NOT NULL CHECK(length(created_at) = 24),
  available_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
  claim_token TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0,
  dispatch_pending INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_pending IN (0,1)),
  dispatch_at INTEGER NOT NULL,
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 5),
  last_error_code TEXT,
  result TEXT CHECK(result IS NULL OR (json_valid(result) AND length(CAST(result AS BLOB)) <= 512))
);
-- statement-breakpoint
INSERT INTO automation_jobs_deal SELECT * FROM automation_jobs;
-- statement-breakpoint
DROP TABLE automation_jobs;
-- statement-breakpoint
ALTER TABLE automation_jobs_deal RENAME TO automation_jobs;
-- statement-breakpoint
CREATE INDEX automation_jobs_dispatch_due ON automation_jobs(dispatch_pending,dispatch_at,id);
-- statement-breakpoint
CREATE TABLE deal_work (
  product_id TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1),
  evaluated_revision INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL DEFAULT 0 CHECK(due_at >= 0)
);
-- statement-breakpoint
CREATE INDEX deal_work_due ON deal_work(due_at,product_id);
-- statement-breakpoint
CREATE TABLE deal_provider_products (
  provider TEXT NOT NULL CHECK(provider IN ('accesstrade','tiktok')),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY(provider,product_id)
);
-- statement-breakpoint
CREATE INDEX deal_provider_product_owner ON deal_provider_products(product_id,provider);
-- statement-breakpoint
CREATE TABLE deal_provider_refresh (
  provider TEXT PRIMARY KEY CHECK(provider IN ('accesstrade','tiktok')),
  revision INTEGER NOT NULL DEFAULT 1,
  cursor TEXT NOT NULL DEFAULT '',
  pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1))
);
-- statement-breakpoint
CREATE TABLE deal_evaluations (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  algorithm_version TEXT NOT NULL,
  provider TEXT,
  platform TEXT,
  priority TEXT NOT NULL CHECK(priority IN ('TOP','HIGH','NORMAL','LOW','REJECT')),
  recommendation TEXT NOT NULL CHECK(recommendation IN ('PUBLISH','REFRESH_FIRST','HOLD','REJECT')),
  monetization_state TEXT NOT NULL,
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  valid_until INTEGER NOT NULL,
  provider_versions TEXT NOT NULL CHECK(json_valid(provider_versions)),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  PRIMARY KEY(origin,product_id)
);
-- statement-breakpoint
CREATE INDEX deal_rank ON deal_evaluations(origin,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX deal_rank_provider ON deal_evaluations(origin,provider,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX deal_rank_platform ON deal_evaluations(origin,provider,platform,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX deal_rank_recommendation ON deal_evaluations(origin,recommendation,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX deal_rank_priority ON deal_evaluations(origin,priority,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX deal_rank_monetization ON deal_evaluations(origin,monetization_state,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX deal_rank_confidence ON deal_evaluations(origin,confidence,product_id);
-- statement-breakpoint
CREATE INDEX deal_stale ON deal_evaluations(origin,valid_until,product_id);
-- statement-breakpoint
INSERT INTO deal_work(product_id) SELECT id FROM products;
-- statement-breakpoint
INSERT INTO deal_provider_products(provider,product_id)
SELECT DISTINCT json_extract(offer.value,'$.monetization.provider'),products.id FROM products,json_each(products.payload,'$.offers') offer
WHERE json_extract(offer.value,'$.monetization.provider') IN ('accesstrade','tiktok');
-- statement-breakpoint
INSERT INTO deal_provider_refresh(provider) SELECT provider FROM affiliate_provider_observations;
-- statement-breakpoint
CREATE TRIGGER deal_product_created AFTER INSERT ON products BEGIN
  INSERT INTO deal_work(product_id) VALUES(NEW.id);
  INSERT INTO deal_provider_products(provider,product_id)
    SELECT DISTINCT json_extract(value,'$.monetization.provider'),NEW.id FROM json_each(NEW.payload,'$.offers')
    WHERE json_extract(value,'$.monetization.provider') IN ('accesstrade','tiktok');
END;
-- statement-breakpoint
CREATE TRIGGER deal_product_changed AFTER UPDATE OF payload ON products WHEN NEW.payload<>OLD.payload BEGIN
  UPDATE deal_work SET revision=revision+1,due_at=0 WHERE product_id=NEW.id;
  DELETE FROM deal_provider_products WHERE product_id=NEW.id;
  INSERT INTO deal_provider_products(provider,product_id)
    SELECT DISTINCT json_extract(value,'$.monetization.provider'),NEW.id FROM json_each(NEW.payload,'$.offers')
    WHERE json_extract(value,'$.monetization.provider') IN ('accesstrade','tiktok');
END;
-- statement-breakpoint
CREATE TRIGGER deal_price_created AFTER INSERT ON price_history BEGIN
  UPDATE deal_work SET revision=revision+1,due_at=0 WHERE product_id=NEW.product_id;
END;
-- statement-breakpoint
CREATE TRIGGER deal_price_changed AFTER UPDATE ON price_history BEGIN
  UPDATE deal_work SET revision=revision+1,due_at=0 WHERE product_id IN (NEW.product_id,OLD.product_id);
END;
-- statement-breakpoint
CREATE TRIGGER deal_price_removed AFTER DELETE ON price_history BEGIN
  UPDATE deal_work SET revision=revision+1,due_at=0 WHERE product_id=OLD.product_id;
END;
-- statement-breakpoint
CREATE TRIGGER deal_provider_created AFTER INSERT ON affiliate_provider_observations BEGIN
  INSERT INTO deal_provider_refresh(provider) VALUES(NEW.provider) ON CONFLICT(provider) DO UPDATE SET revision=revision+1,cursor='',pending=1;
END;
-- statement-breakpoint
CREATE TRIGGER deal_provider_changed AFTER UPDATE ON affiliate_provider_observations WHEN NEW.payload<>OLD.payload BEGIN
  INSERT INTO deal_provider_refresh(provider) VALUES(NEW.provider) ON CONFLICT(provider) DO UPDATE SET revision=revision+1,cursor='',pending=1;
END;
-- statement-breakpoint
CREATE TRIGGER deal_provider_removed AFTER DELETE ON affiliate_provider_observations BEGIN
  INSERT INTO deal_provider_refresh(provider) VALUES(OLD.provider) ON CONFLICT(provider) DO UPDATE SET revision=revision+1,cursor='',pending=1;
END;
-- statement-breakpoint
CREATE TRIGGER deal_revenue_created AFTER INSERT ON affiliate_revenue_snapshots WHEN NEW.scope='PRODUCT' BEGIN
  UPDATE deal_work SET revision=revision+1,due_at=0 WHERE product_id=NEW.scope_id;
END;
-- statement-breakpoint
CREATE TRIGGER deal_revenue_changed AFTER UPDATE ON affiliate_revenue_snapshots WHEN NEW.scope='PRODUCT' BEGIN
  UPDATE deal_work SET revision=revision+1,due_at=0 WHERE product_id=NEW.scope_id;
END;
