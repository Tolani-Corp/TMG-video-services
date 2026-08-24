PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS tmg_requests (
  request_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  request_name TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT '',
  business_goal TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('standard','high','critical_review')),
  deliverables_json TEXT NOT NULL,
  output_format TEXT NOT NULL,
  target_duration TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN (
    'submitted','rights_pending','rights_verified','quarantined_uploaded',
    'ready_for_operator_review','rejected','closed'
  )),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processing_authority INTEGER NOT NULL DEFAULT 0 CHECK (processing_authority = 0),
  publication_authority INTEGER NOT NULL DEFAULT 0 CHECK (publication_authority = 0),
  commercial_authority INTEGER NOT NULL DEFAULT 0 CHECK (commercial_authority = 0)
);

CREATE TABLE IF NOT EXISTS tmg_source_assets (
  asset_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
  quarantine_object_key TEXT NOT NULL UNIQUE,
  rights_state TEXT NOT NULL DEFAULT 'pending' CHECK (rights_state IN ('pending','verified','rejected','revoked')),
  upload_state TEXT NOT NULL DEFAULT 'metadata_registered' CHECK (upload_state IN (
    'metadata_registered','quarantined_integrity_verified','rejected'
  )),
  processable INTEGER NOT NULL DEFAULT 0 CHECK (processable = 0),
  r2_version TEXT,
  r2_etag TEXT,
  uploaded_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id) REFERENCES tmg_requests(request_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tmg_rights_evidence (
  evidence_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN (
    'license','contract','release','ownership_attestation','synthetic_repo_owned'
  )),
  description TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
  expected_sha256 TEXT NOT NULL CHECK (length(expected_sha256) = 64),
  evidence_object_key TEXT NOT NULL UNIQUE,
  upload_state TEXT NOT NULL DEFAULT 'metadata_registered' CHECK (upload_state IN (
    'metadata_registered','integrity_verified','rejected'
  )),
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending','verified','rejected','revoked')),
  grants_internal_processing INTEGER NOT NULL DEFAULT 0 CHECK (grants_internal_processing IN (0,1)),
  grants_derivative_use INTEGER NOT NULL DEFAULT 0 CHECK (grants_derivative_use IN (0,1)),
  grants_external_provider_evaluation INTEGER NOT NULL DEFAULT 0 CHECK (grants_external_provider_evaluation IN (0,1)),
  submitted_by TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  verified_by TEXT,
  verified_at TEXT,
  rejected_reason TEXT,
  CHECK (verified_by IS NULL OR verified_by <> submitted_by),
  FOREIGN KEY (request_id) REFERENCES tmg_requests(request_id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES tmg_source_assets(asset_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tmg_jobs (
  job_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'blocked_processing_authority' CHECK (status IN (
    'blocked_rights','blocked_processing_authority','ready_for_operator_review','cancelled','closed'
  )),
  workflow_state TEXT NOT NULL DEFAULT 'not_started' CHECK (workflow_state IN ('not_started','blocked','cancelled')),
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processing_authority INTEGER NOT NULL DEFAULT 0 CHECK (processing_authority = 0),
  billable INTEGER NOT NULL DEFAULT 0 CHECK (billable = 0),
  FOREIGN KEY (request_id) REFERENCES tmg_requests(request_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tmg_outputs (
  output_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  output_kind TEXT NOT NULL,
  artifact_object_key TEXT,
  status TEXT NOT NULL DEFAULT 'not_generated' CHECK (status IN ('not_generated','review_only','revoked')),
  release_authority INTEGER NOT NULL DEFAULT 0 CHECK (release_authority = 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES tmg_jobs(job_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tmg_approvals (
  approval_id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('rights_evidence','request','job','output')),
  subject_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject','revoke')),
  authority_effect TEXT NOT NULL DEFAULT 'none_g0' CHECK (authority_effect = 'none_g0'),
  actor_email TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tmg_audit_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tmg_requests_created_by ON tmg_requests(created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmg_assets_request ON tmg_source_assets(request_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tmg_rights_asset ON tmg_rights_evidence(asset_id, submitted_at);
CREATE INDEX IF NOT EXISTS idx_tmg_rights_review ON tmg_rights_evidence(review_state, submitted_at);
CREATE INDEX IF NOT EXISTS idx_tmg_jobs_request ON tmg_jobs(request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmg_audit_subject ON tmg_audit_events(subject_type, subject_id, created_at);
