CREATE TABLE scheduled_tasks_money (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) BETWEEN 1 AND 160),
  job_type TEXT NOT NULL CHECK(job_type IN ('CAPTURE_PRICE_HISTORY','AGGREGATE_GROWTH_METRICS')),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 512),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  next_run_at INTEGER NOT NULL CHECK(next_run_at >= 0),
  interval_ms INTEGER NOT NULL CHECK(interval_ms BETWEEN 60000 AND 2678400000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision >= 1)
);
-- statement-breakpoint
INSERT INTO scheduled_tasks_money SELECT * FROM scheduled_tasks;
-- statement-breakpoint
DROP TABLE scheduled_tasks;
-- statement-breakpoint
ALTER TABLE scheduled_tasks_money RENAME TO scheduled_tasks;
-- statement-breakpoint
CREATE INDEX scheduled_tasks_due ON scheduled_tasks(enabled,next_run_at,id);
-- statement-breakpoint
CREATE TABLE automation_jobs_money (
  id TEXT PRIMARY KEY NOT NULL,
  job_type TEXT NOT NULL CHECK(job_type IN ('CAPTURE_PRICE_HISTORY','AGGREGATE_GROWTH_METRICS')),
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
INSERT INTO automation_jobs_money SELECT * FROM automation_jobs;
-- statement-breakpoint
DROP TABLE automation_jobs;
-- statement-breakpoint
ALTER TABLE automation_jobs_money RENAME TO automation_jobs;
-- statement-breakpoint
CREATE INDEX automation_jobs_dispatch_due ON automation_jobs(dispatch_pending,dispatch_at,id);
