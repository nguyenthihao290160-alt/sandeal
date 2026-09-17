CREATE TABLE execution_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  proposal_type TEXT NOT NULL,
  capability TEXT NOT NULL,
  source_subsystem TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  target_entity_id TEXT,
  environment TEXT NOT NULL CHECK(environment IN ('LOCAL','TEST','PREVIEW','STAGING','PRODUCTION')),
  execution_mode TEXT NOT NULL CHECK(execution_mode IN ('SHADOW','DRY_RUN','REVIEW_REQUIRED','DISABLED')),
  risk_level TEXT NOT NULL CHECK(risk_level IN ('READ_ONLY','LOW','MEDIUM','HIGH','CRITICAL')),
  reason_codes TEXT NOT NULL CHECK(json_valid(reason_codes)),
  evidence_refs TEXT NOT NULL CHECK(json_valid(evidence_refs)),
  policy_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approval_requirement TEXT NOT NULL CHECK(approval_requirement IN ('NOT_REQUIRED','REQUIRED')),
  rollback_requirement TEXT NOT NULL CHECK(rollback_requirement IN ('NOT_REQUIRED','REQUIRED','NOT_POSSIBLE')),
  evidence_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPROVED','REJECTED','EXPIRED','SUPERSEDED','EXECUTED','FAILED'))
);
-- statement-breakpoint
CREATE INDEX execution_proposals_status ON execution_proposals(origin, status, requested_at DESC);
-- statement-breakpoint
CREATE INDEX execution_proposals_capability ON execution_proposals(origin, capability, requested_at DESC);
-- statement-breakpoint
CREATE INDEX execution_proposals_target ON execution_proposals(origin, target_entity_id, requested_at DESC);
-- statement-breakpoint
CREATE INDEX execution_proposals_fingerprint ON execution_proposals(origin, evidence_fingerprint);
-- statement-breakpoint

CREATE TABLE execution_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES execution_proposals(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK(environment IN ('LOCAL','TEST','PREVIEW','STAGING','PRODUCTION')),
  capability TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  approver_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','EXPIRED','REVOKED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
-- statement-breakpoint
CREATE INDEX execution_approvals_proposal ON execution_approvals(proposal_id);
-- statement-breakpoint
CREATE INDEX execution_approvals_status ON execution_approvals(status);
-- statement-breakpoint

CREATE TABLE execution_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES execution_proposals(id) ON DELETE CASCADE,
  execution_mode TEXT NOT NULL,
  preflight_result TEXT NOT NULL,
  would_execute INTEGER NOT NULL CHECK(would_execute IN (0,1)),
  blocked_effects INTEGER NOT NULL CHECK(blocked_effects IN (0,1)),
  risk_level TEXT NOT NULL,
  approval_state TEXT NOT NULL,
  rollback_available INTEGER NOT NULL CHECK(rollback_available IN (0,1)),
  fingerprint TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
-- statement-breakpoint
CREATE INDEX execution_receipts_proposal ON execution_receipts(proposal_id);
-- statement-breakpoint

CREATE TABLE execution_side_effects (
  id TEXT PRIMARY KEY NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES execution_receipts(id) ON DELETE CASCADE,
  effect_type TEXT NOT NULL,
  target TEXT NOT NULL,
  risk TEXT NOT NULL,
  reversible INTEGER NOT NULL CHECK(reversible IN (0,1)),
  requires_approval INTEGER NOT NULL CHECK(requires_approval IN (0,1)),
  production_mutation INTEGER NOT NULL CHECK(production_mutation IN (0,1)),
  external_call INTEGER NOT NULL CHECK(external_call IN (0,1)),
  dry_run_only INTEGER NOT NULL CHECK(dry_run_only IN (0,1)),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
-- statement-breakpoint
CREATE INDEX execution_side_effects_receipt ON execution_side_effects(receipt_id);
-- statement-breakpoint

CREATE TABLE execution_audit (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
-- statement-breakpoint
CREATE INDEX execution_audit_proposal ON execution_audit(proposal_id, timestamp DESC);
-- statement-breakpoint

CREATE TABLE rollback_plans (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL REFERENCES execution_proposals(id) ON DELETE CASCADE,
  original_state_evidence TEXT NOT NULL CHECK(json_valid(original_state_evidence)),
  target_state TEXT NOT NULL CHECK(json_valid(target_state)),
  reversal_steps TEXT NOT NULL CHECK(json_valid(reversal_steps)),
  preconditions TEXT NOT NULL CHECK(json_valid(preconditions)),
  limitations TEXT NOT NULL CHECK(json_valid(limitations))
);
-- statement-breakpoint

CREATE TABLE release_bundles (
  id TEXT PRIMARY KEY NOT NULL,
  environment TEXT NOT NULL,
  risk TEXT NOT NULL,
  preflight_state TEXT NOT NULL,
  rollback_coverage TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
-- statement-breakpoint
CREATE INDEX release_bundles_env ON release_bundles(environment, risk);
-- statement-breakpoint

CREATE TABLE release_bundle_proposals (
  bundle_id TEXT NOT NULL REFERENCES release_bundles(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL REFERENCES execution_proposals(id) ON DELETE CASCADE,
  PRIMARY KEY (bundle_id, proposal_id)
);
-- statement-breakpoint
ALTER TABLE execution_proposals ADD COLUMN semantic_key TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
ALTER TABLE execution_proposals ADD COLUMN proposal_fingerprint TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
ALTER TABLE execution_proposals ADD COLUMN payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload));
-- statement-breakpoint
CREATE UNIQUE INDEX execution_proposals_semantic ON execution_proposals(origin, semantic_key) WHERE semantic_key <> '';
-- statement-breakpoint
ALTER TABLE execution_approvals ADD COLUMN proposal_fingerprint TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
CREATE UNIQUE INDEX execution_approval_active ON execution_approvals(proposal_id) WHERE status='APPROVED';
-- statement-breakpoint
CREATE INDEX execution_approval_valid ON execution_approvals(proposal_id, proposal_fingerprint, environment, capability, risk_level, status, expires_at, id);
-- statement-breakpoint
CREATE INDEX execution_approval_recent ON execution_approvals(proposal_id, created_at DESC, id DESC);
-- statement-breakpoint
CREATE UNIQUE INDEX execution_receipt_semantic ON execution_receipts(proposal_id, fingerprint);
-- statement-breakpoint
ALTER TABLE execution_receipts ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_json));
-- statement-breakpoint
ALTER TABLE rollback_plans ADD COLUMN receipt_id TEXT REFERENCES execution_receipts(id);
-- statement-breakpoint
ALTER TABLE rollback_plans ADD COLUMN payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload));
-- statement-breakpoint
CREATE UNIQUE INDEX execution_rollback_receipt ON rollback_plans(receipt_id);
-- statement-breakpoint
CREATE UNIQUE INDEX execution_effect_once ON execution_side_effects(receipt_id, effect_type, target);
-- statement-breakpoint
CREATE TABLE execution_controls (
  id TEXT PRIMARY KEY NOT NULL CHECK(id='global'),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','INACTIVE','UNKNOWN')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
-- statement-breakpoint
CREATE TABLE execution_contexts (
  proposal_id TEXT PRIMARY KEY NOT NULL REFERENCES execution_proposals(id),
  payload TEXT NOT NULL CHECK(json_valid(payload))
);
-- statement-breakpoint
CREATE TABLE execution_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  proposal_id TEXT NOT NULL UNIQUE REFERENCES execution_proposals(id),
  proposal_fingerprint TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('LOCAL','TEST')),
  status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','SUCCEEDED','BLOCKED')),
  available_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claim_token TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation >= 0),
  lease_until INTEGER NOT NULL DEFAULT 0,
  dispatch_at INTEGER NOT NULL,
  dispatch_count INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_count BETWEEN 0 AND 5),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  receipt_id TEXT REFERENCES execution_receipts(id)
);
-- statement-breakpoint
CREATE INDEX execution_jobs_due ON execution_jobs(environment, status, available_at, id);
-- statement-breakpoint
CREATE INDEX execution_jobs_lease ON execution_jobs(environment, status, lease_until, id);
-- statement-breakpoint
CREATE INDEX execution_jobs_dispatch ON execution_jobs(environment, status, dispatch_at, id);
-- statement-breakpoint
CREATE TABLE execution_commit_guards (id TEXT PRIMARY KEY NOT NULL, valid INTEGER NOT NULL CHECK(valid=1));
-- statement-breakpoint
ALTER TABLE release_bundles ADD COLUMN semantic_key TEXT NOT NULL DEFAULT '';
-- statement-breakpoint
CREATE UNIQUE INDEX execution_bundle_semantic ON release_bundles(environment, semantic_key) WHERE semantic_key <> '';
-- statement-breakpoint
ALTER TABLE release_bundle_proposals ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
-- statement-breakpoint
CREATE INDEX execution_bundle_order ON release_bundle_proposals(bundle_id, ordinal, proposal_id);
