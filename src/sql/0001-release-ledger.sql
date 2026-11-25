CREATE TABLE IF NOT EXISTS release_artifacts (
  artifact_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  version TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  logical_task_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  prepared_by_instance_id TEXT NOT NULL,
  committed_by_instance_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  artifact_path TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  compensated_by_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_artifacts_active_logical_task
  ON release_artifacts (release_id, attempt_number, logical_task_id)
  WHERE status IN ('STAGED', 'PROMOTED');

CREATE TABLE IF NOT EXISTS release_candidate_locks (
  candidate_lock_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  version TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL,
  staged_module_count INTEGER NOT NULL,
  participating_instances TEXT NOT NULL,
  build_flags TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  compensated_by_key TEXT,
  failure_diagnostic TEXT,
  manifest_path TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- one row per module task execution: what step 1 prepared, and where (the key of every later join)
CREATE TABLE IF NOT EXISTS module_preparations (
  execution_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  logical_task_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  prepared_by_instance_id TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- the stall drill: the worker that froze (or died) inside its step, written before it froze
CREATE TABLE IF NOT EXISTS worker_stalls (
  execution_id TEXT PRIMARY KEY,
  logical_task_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL,
  stalled_instance_id TEXT NOT NULL,
  stalled_pid INTEGER NOT NULL,
  mode TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- the evidence: what the ledger's own steps did, and what the framework's audit log said about
-- the leases (mirrored by the LeaseEvidenceObserver), in one timeline
CREATE TABLE IF NOT EXISTS ledger_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id TEXT,
  attempt_number INTEGER,
  execution_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  fencing_token INTEGER,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  details TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
);
