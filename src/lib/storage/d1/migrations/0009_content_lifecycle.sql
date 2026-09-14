CREATE TABLE automation_jobs_lifecycle (
  id TEXT PRIMARY KEY NOT NULL,
  job_type TEXT NOT NULL CHECK(job_type IN ('CAPTURE_PRICE_HISTORY','AGGREGATE_GROWTH_METRICS','DEAL_EVALUATE','CONTENT_LIFECYCLE_EVALUATE')),
  idempotency_key TEXT UNIQUE NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
  payload_version INTEGER NOT NULL CHECK(payload_version=1),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=512),
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','RETRY_SCHEDULED','SUCCEEDED','FAILED','BLOCKED')),
  created_at TEXT NOT NULL CHECK(length(created_at)=24), available_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3), claim_token TEXT,
  lease_expires_at INTEGER NOT NULL DEFAULT 0, dispatch_pending INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_pending IN (0,1)),
  dispatch_at INTEGER NOT NULL, dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 5),
  last_error_code TEXT, result TEXT CHECK(result IS NULL OR (json_valid(result) AND length(CAST(result AS BLOB))<=512))
);
-- statement-breakpoint
INSERT INTO automation_jobs_lifecycle SELECT * FROM automation_jobs;
-- statement-breakpoint
DROP TABLE automation_jobs;
-- statement-breakpoint
ALTER TABLE automation_jobs_lifecycle RENAME TO automation_jobs;
-- statement-breakpoint
CREATE INDEX automation_jobs_dispatch_due ON automation_jobs(dispatch_pending,dispatch_at,id);
-- statement-breakpoint
CREATE TABLE content_lifecycle_sources (
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')), content_id TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id), intent TEXT NOT NULL, token TEXT NOT NULL,
  entity TEXT NOT NULL CHECK(json_valid(entity) AND length(CAST(entity AS BLOB))<=4096),
  plan TEXT CHECK(plan IS NULL OR (json_valid(plan) AND length(CAST(plan AS BLOB))<=8192)),
  baseline TEXT CHECK(baseline IS NULL OR (json_valid(baseline) AND length(CAST(baseline AS BLOB))<=16384)),
  relationship TEXT CHECK(relationship IS NULL OR (json_valid(relationship) AND length(CAST(relationship AS BLOB))<=2048)),
  attribution_count INTEGER NOT NULL DEFAULT 0 CHECK(attribution_count BETWEEN 0 AND 20000),
  audit_count INTEGER NOT NULL DEFAULT 0 CHECK(audit_count BETWEEN 0 AND 256),
  PRIMARY KEY(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_sources_product ON content_lifecycle_sources(product_id,origin,content_id);
-- statement-breakpoint
CREATE TRIGGER content_source_cap BEFORE INSERT ON content_lifecycle_sources WHEN NOT EXISTS(SELECT 1 FROM content_lifecycle_sources WHERE origin=NEW.origin AND content_id=NEW.content_id) BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM (SELECT content_id FROM content_lifecycle_sources WHERE product_id=NEW.product_id LIMIT 16))>=16 THEN RAISE(ABORT,'CONTENT_PRODUCT_CAP') END;
END;
-- statement-breakpoint
CREATE TABLE content_lifecycle_config (
  origin TEXT PRIMARY KEY NOT NULL, config_version TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '', pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1))
);
-- statement-breakpoint
CREATE TABLE content_lifecycle_work (
  origin TEXT NOT NULL, content_id TEXT NOT NULL, product_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)), due_at INTEGER NOT NULL DEFAULT 0, urgency INTEGER NOT NULL DEFAULT 1 CHECK(urgency IN (0,1)),
  coalesce_until INTEGER, evaluated_fingerprint TEXT, evaluated_config_version TEXT, material_fingerprint TEXT, cooldown_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(origin,content_id), FOREIGN KEY(origin,content_id) REFERENCES content_lifecycle_sources(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_work_due ON content_lifecycle_work(origin,pending,due_at,content_id);
-- statement-breakpoint
CREATE INDEX content_work_urgent ON content_lifecycle_work(origin,pending,urgency,due_at,content_id);
-- statement-breakpoint
CREATE INDEX content_work_product ON content_lifecycle_work(product_id,origin,content_id);
-- statement-breakpoint
CREATE TRIGGER content_source_created AFTER INSERT ON content_lifecycle_sources BEGIN
  INSERT INTO content_lifecycle_work(origin,content_id,product_id) VALUES(NEW.origin,NEW.content_id,NEW.product_id);
END;
-- statement-breakpoint
CREATE TRIGGER content_source_changed AFTER UPDATE OF token ON content_lifecycle_sources WHEN NEW.token<>OLD.token BEGIN
  UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE origin=NEW.origin AND content_id=NEW.content_id;
END;
-- statement-breakpoint
CREATE TRIGGER content_deal_invalidated AFTER UPDATE OF revision ON deal_work WHEN NEW.revision<>OLD.revision BEGIN
  UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0,urgency=0 WHERE product_id=NEW.product_id;
END;
-- statement-breakpoint
CREATE TRIGGER content_opportunity_created AFTER INSERT ON opportunity_evaluations BEGIN
  UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE product_id=NEW.product_id AND origin=NEW.origin;
END;
-- statement-breakpoint
CREATE TRIGGER content_opportunity_changed AFTER UPDATE OF fingerprint ON opportunity_evaluations WHEN NEW.fingerprint<>OLD.fingerprint BEGIN
  UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE product_id=NEW.product_id AND origin=NEW.origin;
END;
-- statement-breakpoint
CREATE TRIGGER content_policy_created AFTER INSERT ON decision_records BEGIN
  UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0,urgency=0 WHERE product_id=NEW.product_id AND origin=NEW.origin;
END;
-- statement-breakpoint
CREATE TABLE content_lifecycle_audit (
  id TEXT PRIMARY KEY NOT NULL, origin TEXT NOT NULL, content_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  algorithm_version TEXT NOT NULL, created_at INTEGER NOT NULL, execution_mode TEXT NOT NULL CHECK(execution_mode='SHADOW'),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=32768 AND json_extract(payload,'$.plan.productionAllowed')=0),
  UNIQUE(origin,content_id,fingerprint,algorithm_version), FOREIGN KEY(origin,content_id) REFERENCES content_lifecycle_sources(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_audit_time ON content_lifecycle_audit(origin,content_id,created_at,id);
-- statement-breakpoint
CREATE TRIGGER content_audit_immutable_update BEFORE UPDATE ON content_lifecycle_audit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIFECYCLE_AUDIT'); END;
-- statement-breakpoint
CREATE TRIGGER content_audit_immutable_delete BEFORE DELETE ON content_lifecycle_audit BEGIN SELECT RAISE(ABORT,'IMMUTABLE_LIFECYCLE_AUDIT'); END;
-- statement-breakpoint
CREATE TRIGGER content_audit_cap BEFORE INSERT ON content_lifecycle_audit WHEN NOT EXISTS(SELECT 1 FROM content_lifecycle_audit WHERE id=NEW.id) BEGIN
  SELECT CASE WHEN (SELECT audit_count FROM content_lifecycle_sources WHERE origin=NEW.origin AND content_id=NEW.content_id)>=256 THEN RAISE(ABORT,'CONTENT_AUDIT_CAP') END;
END;
-- statement-breakpoint
CREATE TRIGGER content_audit_count AFTER INSERT ON content_lifecycle_audit BEGIN
  UPDATE content_lifecycle_sources SET audit_count=audit_count+1 WHERE origin=NEW.origin AND content_id=NEW.content_id;
END;
-- statement-breakpoint
CREATE TABLE content_lifecycle (
  origin TEXT NOT NULL, content_id TEXT NOT NULL, evaluation_id TEXT NOT NULL REFERENCES content_lifecycle_audit(id),
  state TEXT NOT NULL CHECK(state IN ('CURRENT','STALE','REFRESH_CANDIDATE','REFRESH_QUEUED','REFRESH_REVIEW_REQUIRED','MERGE_CANDIDATE','SUPERSEDE_CANDIDATE','ARCHIVE_CANDIDATE','BLOCKED','UNKNOWN')),
  priority TEXT NOT NULL CHECK(priority IN ('P0','P1','P2','P3','NONE','BLOCKED')), urgency INTEGER NOT NULL CHECK(urgency BETWEEN 0 AND 5),
  action TEXT NOT NULL, provider TEXT, platform TEXT, material INTEGER NOT NULL CHECK(material IN (0,1)),
  high_value_stale INTEGER NOT NULL CHECK(high_value_stale IN (0,1)), low_confidence_stale INTEGER NOT NULL CHECK(low_confidence_stale IN (0,1)),
  created_at INTEGER NOT NULL, PRIMARY KEY(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_lifecycle_priority ON content_lifecycle(origin,priority,urgency,content_id);
-- statement-breakpoint
CREATE INDEX content_lifecycle_state ON content_lifecycle(origin,state,urgency,content_id);
-- statement-breakpoint
CREATE INDEX content_lifecycle_recent ON content_lifecycle(origin,material,created_at DESC,content_id);
-- statement-breakpoint
CREATE INDEX content_lifecycle_provider ON content_lifecycle(origin,provider,platform,urgency,content_id);
-- statement-breakpoint
CREATE INDEX content_lifecycle_high_value ON content_lifecycle(origin,high_value_stale,urgency,content_id);
-- statement-breakpoint
CREATE INDEX content_lifecycle_low_confidence ON content_lifecycle(origin,low_confidence_stale,urgency,content_id);
-- statement-breakpoint
CREATE INDEX content_lifecycle_sample ON content_lifecycle(origin,urgency,content_id);
-- statement-breakpoint
CREATE TABLE content_refresh_jobs (
  job_id TEXT PRIMARY KEY NOT NULL, origin TEXT NOT NULL, content_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  algorithm_version TEXT NOT NULL, config_version TEXT NOT NULL, revision INTEGER NOT NULL,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('SHADOW_RECORDED','STALE_JOB_NOOP','DUPLICATE_SAFE')),
  UNIQUE(origin,content_id,fingerprint,algorithm_version), FOREIGN KEY(origin,content_id) REFERENCES content_lifecycle_sources(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_refresh_content ON content_refresh_jobs(origin,content_id,job_id);
-- statement-breakpoint
CREATE TABLE content_attribution_inbox (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, content_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CLICK','CONVERSION','COMMISSION')), click_id TEXT, provider TEXT, external_id TEXT,
  pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)), disposition TEXT,
  FOREIGN KEY(origin,content_id) REFERENCES content_lifecycle_sources(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_attribution_due ON content_attribution_inbox(origin,pending,sequence);
-- statement-breakpoint
CREATE TRIGGER content_click_source AFTER INSERT ON affiliate_clicks BEGIN
  INSERT INTO content_attribution_inbox(event_key,origin,content_id,kind,click_id)
    SELECT 'click:'||NEW.id,NEW.origin,content_id,'CLICK',NEW.id FROM content_lifecycle_sources
    WHERE origin=NEW.origin AND product_id=NEW.product_id AND content_id=json_extract(NEW.payload,'$.contentEntityId') AND attribution_count<20000;
END;
-- statement-breakpoint
CREATE TRIGGER content_conversion_source AFTER INSERT ON affiliate_conversions BEGIN
  INSERT INTO content_attribution_inbox(event_key,origin,content_id,kind,provider,external_id)
    SELECT 'conversion:'||NEW.provider||':'||NEW.external_id,NEW.origin,source.content_id,'CONVERSION',NEW.provider,NEW.external_id
    FROM affiliate_clicks click JOIN content_lifecycle_sources source ON source.content_id=json_extract(click.payload,'$.contentEntityId') AND source.origin=click.origin
    WHERE click.id=NEW.click_id AND source.product_id=click.product_id AND source.origin=NEW.origin AND source.attribution_count<20000;
END;
-- statement-breakpoint
CREATE TRIGGER content_commission_source AFTER INSERT ON affiliate_commissions BEGIN
  INSERT INTO content_attribution_inbox(event_key,origin,content_id,kind,provider,external_id)
    SELECT 'commission:'||NEW.provider||':'||NEW.external_id,click.origin,source.content_id,'COMMISSION',NEW.provider,NEW.external_id
    FROM affiliate_conversions conversion JOIN affiliate_clicks click ON click.id=conversion.click_id
    JOIN content_lifecycle_sources source ON source.content_id=json_extract(click.payload,'$.contentEntityId') AND source.origin=click.origin
    WHERE conversion.provider=NEW.provider AND conversion.external_id=NEW.conversion_id AND source.product_id=click.product_id AND source.attribution_count<20000;
END;
-- statement-breakpoint
CREATE TRIGGER content_commission_revision AFTER UPDATE ON affiliate_commissions WHEN NEW.revision<>OLD.revision BEGIN
  UPDATE content_attribution_inbox SET pending=1,disposition=NULL WHERE event_key='commission:'||NEW.provider||':'||NEW.external_id;
END;
-- statement-breakpoint
CREATE TRIGGER content_attribution_queued AFTER INSERT ON content_attribution_inbox BEGIN
  UPDATE content_lifecycle_sources SET attribution_count=attribution_count+1 WHERE origin=NEW.origin AND content_id=NEW.content_id;
END;
-- statement-breakpoint
CREATE TABLE content_attribution (
  event_key TEXT PRIMARY KEY NOT NULL, origin TEXT NOT NULL, content_id TEXT NOT NULL, click_id TEXT NOT NULL REFERENCES affiliate_clicks(id),
  provider TEXT NOT NULL, platform TEXT NOT NULL, product_id TEXT NOT NULL, offer_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL, revision INTEGER NOT NULL, day INTEGER NOT NULL, currency TEXT NOT NULL,
  clicks INTEGER NOT NULL, conversions INTEGER NOT NULL, approved_minor INTEGER NOT NULL, paid_minor INTEGER NOT NULL,
  approved_count INTEGER NOT NULL, paid_count INTEGER NOT NULL, commission_events INTEGER NOT NULL, occurred_at INTEGER NOT NULL,
  FOREIGN KEY(origin,content_id) REFERENCES content_lifecycle_sources(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_attribution_chain ON content_attribution(origin,content_id,click_id,event_key);
-- statement-breakpoint
CREATE TABLE content_value_daily (
  origin TEXT NOT NULL, content_id TEXT NOT NULL, day INTEGER NOT NULL, currency TEXT NOT NULL,
  clicks INTEGER NOT NULL DEFAULT 0, conversions INTEGER NOT NULL DEFAULT 0, approved_minor INTEGER NOT NULL DEFAULT 0 CHECK(approved_minor BETWEEN 0 AND 9007199254740991),
  paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(paid_minor BETWEEN 0 AND 9007199254740991), approved_count INTEGER NOT NULL DEFAULT 0, paid_count INTEGER NOT NULL DEFAULT 0,
  commission_events INTEGER NOT NULL DEFAULT 0, source_events INTEGER NOT NULL DEFAULT 0, last_sequence INTEGER NOT NULL DEFAULT 0, last_event_at INTEGER NOT NULL,
  PRIMARY KEY(origin,content_id,day,currency)
);
-- statement-breakpoint
CREATE TRIGGER content_value_first AFTER INSERT ON content_attribution BEGIN
  INSERT INTO content_value_daily(origin,content_id,day,currency,clicks,conversions,approved_minor,paid_minor,approved_count,paid_count,commission_events,source_events,last_sequence,last_event_at)
    VALUES(NEW.origin,NEW.content_id,NEW.day,NEW.currency,NEW.clicks,NEW.conversions,NEW.approved_minor,NEW.paid_minor,NEW.approved_count,NEW.paid_count,NEW.commission_events,1,1,NEW.occurred_at)
    ON CONFLICT(origin,content_id,day,currency) DO UPDATE SET clicks=clicks+NEW.clicks,conversions=conversions+NEW.conversions,
    approved_minor=approved_minor+NEW.approved_minor,paid_minor=paid_minor+NEW.paid_minor,approved_count=approved_count+NEW.approved_count,
    paid_count=paid_count+NEW.paid_count,commission_events=commission_events+NEW.commission_events,source_events=source_events+1,last_sequence=last_sequence+1,last_event_at=max(last_event_at,NEW.occurred_at);
  UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE origin=NEW.origin AND content_id=NEW.content_id;
END;
-- statement-breakpoint
CREATE TRIGGER content_value_revision AFTER UPDATE ON content_attribution WHEN NEW.revision>OLD.revision BEGIN
  UPDATE content_value_daily SET approved_minor=approved_minor-OLD.approved_minor+NEW.approved_minor,paid_minor=paid_minor-OLD.paid_minor+NEW.paid_minor,
    approved_count=approved_count-OLD.approved_count+NEW.approved_count,paid_count=paid_count-OLD.paid_count+NEW.paid_count,last_sequence=last_sequence+1,
    last_event_at=max(last_event_at,NEW.occurred_at) WHERE origin=NEW.origin AND content_id=NEW.content_id AND day=NEW.day AND currency=NEW.currency;
  UPDATE content_lifecycle_work SET revision=revision+1,pending=1,due_at=0 WHERE origin=NEW.origin AND content_id=NEW.content_id;
END;
-- statement-breakpoint
CREATE TABLE content_value_snapshots (
  origin TEXT NOT NULL, content_id TEXT NOT NULL, fingerprint TEXT NOT NULL, business_value TEXT NOT NULL,
  conversions INTEGER NOT NULL, revenue_evidence INTEGER NOT NULL CHECK(revenue_evidence IN (0,1)),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), generated_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=8192), PRIMARY KEY(origin,content_id)
);
-- statement-breakpoint
CREATE INDEX content_value_class ON content_value_snapshots(origin,business_value,conversions DESC,content_id);
-- statement-breakpoint
CREATE INDEX content_value_revenue ON content_value_snapshots(origin,revenue_evidence,conversions DESC,content_id);
-- statement-breakpoint
CREATE INDEX content_value_conversions ON content_value_snapshots(origin,conversions DESC,content_id);
