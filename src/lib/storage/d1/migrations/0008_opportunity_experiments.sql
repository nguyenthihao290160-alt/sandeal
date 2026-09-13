CREATE TABLE opportunity_evaluations (
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  id TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  config_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  provider TEXT,
  platform TEXT,
  priority TEXT NOT NULL CHECK(priority IN ('P0','P1','P2','P3','BLOCKED')),
  rankable INTEGER NOT NULL CHECK(rankable IN (0,1)),
  score REAL NOT NULL CHECK(score BETWEEN 0 AND 100),
  confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
  new_opportunity INTEGER NOT NULL CHECK(new_opportunity IN (0,1)),
  low_confidence INTEGER NOT NULL CHECK(low_confidence IN (0,1)),
  content_candidate INTEGER NOT NULL CHECK(content_candidate IN (0,1)),
  experiment_candidate INTEGER NOT NULL CHECK(experiment_candidate IN (0,1)),
  refresh_candidate INTEGER NOT NULL CHECK(refresh_candidate IN (0,1)),
  review_required INTEGER NOT NULL CHECK(review_required IN (0,1)),
  valid_until INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=16384 AND json_extract(payload,'$.executionMode')='SHADOW'),
  PRIMARY KEY(origin,product_id)
);
-- statement-breakpoint
CREATE INDEX opportunity_rank ON opportunity_evaluations(origin,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_available ON opportunity_evaluations(origin,rankable,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_provider ON opportunity_evaluations(origin,rankable,provider,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_platform ON opportunity_evaluations(origin,rankable,provider,platform,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_priority ON opportunity_evaluations(origin,priority,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_new ON opportunity_evaluations(origin,rankable,new_opportunity,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_confidence ON opportunity_evaluations(origin,rankable,low_confidence,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_content ON opportunity_evaluations(origin,rankable,content_candidate,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_experiment ON opportunity_evaluations(origin,rankable,experiment_candidate,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_refresh ON opportunity_evaluations(origin,rankable,refresh_candidate,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_review ON opportunity_evaluations(origin,rankable,review_required,score DESC,product_id);
-- statement-breakpoint
CREATE INDEX opportunity_stale ON opportunity_evaluations(origin,valid_until,product_id);
-- statement-breakpoint
CREATE TABLE experiments (
  id TEXT PRIMARY KEY NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  product_id TEXT NOT NULL REFERENCES products(id),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  opportunity_id TEXT NOT NULL,
  experiment_type TEXT NOT NULL CHECK(experiment_type IN ('TITLE_VARIANT','CTA_VARIANT','DEAL_BADGE_VARIANT','CARD_LAYOUT_VARIANT','SORT_PRIORITY_VARIANT','CONTENT_ANGLE_VARIANT')),
  version INTEGER NOT NULL CHECK(version>=1),
  state TEXT NOT NULL CHECK(state IN ('DRAFT','ELIGIBLE','SHADOW','READY_FOR_REVIEW','PAUSED','COMPLETED','REJECTED')),
  execution_mode TEXT NOT NULL CHECK(execution_mode='SHADOW'),
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  assignment_count INTEGER NOT NULL DEFAULT 0 CHECK(assignment_count BETWEEN 0 AND 10000),
  metric_count INTEGER NOT NULL DEFAULT 0 CHECK(metric_count BETWEEN 0 AND 20000),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=8192),
  UNIQUE(origin,product_id,experiment_type,version)
);
-- statement-breakpoint
CREATE INDEX experiments_state ON experiments(origin,state,expires_at,id);
-- statement-breakpoint
CREATE INDEX experiments_retention ON experiments(origin,retain_until,id);
-- statement-breakpoint
CREATE INDEX experiments_product ON experiments(origin,product_id,id);
-- statement-breakpoint
CREATE UNIQUE INDEX experiments_exclusion ON experiments(origin,product_id) WHERE state IN ('SHADOW','READY_FOR_REVIEW');
-- statement-breakpoint
CREATE TRIGGER experiment_definition_immutable BEFORE UPDATE OF payload,fingerprint,product_id,starts_at,expires_at,retain_until,origin,execution_mode,experiment_type,version ON experiments
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPERIMENT_DEFINITION'); END;
-- statement-breakpoint
CREATE TABLE experiment_variants (
  experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  weight INTEGER NOT NULL CHECK(weight BETWEEN 1 AND 10000),
  subjects INTEGER NOT NULL DEFAULT 0 CHECK(subjects BETWEEN 0 AND 10000),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK(clicks BETWEEN 0 AND 10000),
  conversions INTEGER NOT NULL DEFAULT 0 CHECK(conversions BETWEEN 0 AND 10000),
  PRIMARY KEY(experiment_id,id)
);
-- statement-breakpoint
CREATE TRIGGER experiment_variant_immutable BEFORE UPDATE OF experiment_id,id,weight ON experiment_variants
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPERIMENT_VARIANT'); END;
-- statement-breakpoint
CREATE TABLE experiment_assignments (
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  subject_key TEXT NOT NULL CHECK(length(subject_key)=64),
  variant_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  retain_until INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin='TEST_FIXTURE'),
  click_id TEXT,
  PRIMARY KEY(experiment_id,subject_key),
  UNIQUE(experiment_id,click_id),
  FOREIGN KEY(experiment_id,variant_id) REFERENCES experiment_variants(experiment_id,id)
);
-- statement-breakpoint
CREATE INDEX experiment_assignment_retention ON experiment_assignments(retain_until,experiment_id,subject_key);
-- statement-breakpoint
CREATE TRIGGER experiment_assignment_immutable BEFORE UPDATE ON experiment_assignments BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPERIMENT_ASSIGNMENT'); END;
-- statement-breakpoint
CREATE TRIGGER experiment_assignment_count AFTER INSERT ON experiment_assignments BEGIN
  UPDATE experiments SET assignment_count=assignment_count+1 WHERE id=NEW.experiment_id;
  UPDATE experiment_variants SET subjects=subjects+1 WHERE experiment_id=NEW.experiment_id AND id=NEW.variant_id;
END;
-- statement-breakpoint
CREATE TABLE experiment_metric_events (
  experiment_id TEXT NOT NULL REFERENCES experiments(id),
  event_key TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  metric TEXT NOT NULL CHECK(metric IN ('CLICK','CONVERSION')),
  origin TEXT NOT NULL CHECK(origin='TEST_FIXTURE'),
  retain_until INTEGER NOT NULL,
  PRIMARY KEY(experiment_id,event_key),
  UNIQUE(experiment_id,subject_key,metric),
  FOREIGN KEY(experiment_id,subject_key) REFERENCES experiment_assignments(experiment_id,subject_key)
);
-- statement-breakpoint
CREATE INDEX experiment_metric_retention ON experiment_metric_events(retain_until,experiment_id,event_key);
-- statement-breakpoint
CREATE TRIGGER experiment_metric_immutable BEFORE UPDATE ON experiment_metric_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EXPERIMENT_METRIC'); END;
-- statement-breakpoint
CREATE TRIGGER experiment_metric_count AFTER INSERT ON experiment_metric_events BEGIN
  UPDATE experiments SET metric_count=metric_count+1 WHERE id=NEW.experiment_id;
  UPDATE experiment_variants SET clicks=clicks+CASE WHEN NEW.metric='CLICK' THEN 1 ELSE 0 END,
    conversions=conversions+CASE WHEN NEW.metric='CONVERSION' THEN 1 ELSE 0 END WHERE experiment_id=NEW.experiment_id AND id=NEW.variant_id;
END;
-- statement-breakpoint
CREATE TRIGGER opportunity_decision_changed AFTER INSERT ON decision_records WHEN EXISTS(
  SELECT 1 FROM opportunity_evaluations WHERE origin=NEW.origin AND product_id=NEW.product_id AND decision_id<>NEW.id
) BEGIN
  UPDATE deal_work SET due_at=0 WHERE product_id=NEW.product_id;
END;
