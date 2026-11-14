CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  concurrency INTEGER NOT NULL CHECK(concurrency BETWEEN 1 AND 3),
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_legacy INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS workflow_jobs (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  key TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  max_attempts INTEGER NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE(workflow_id, key)
);
CREATE INDEX IF NOT EXISTS workflow_jobs_workflow ON workflow_jobs(workflow_id, position);
CREATE TABLE IF NOT EXISTS attempts (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  number INTEGER NOT NULL,
  status TEXT NOT NULL,
  pid INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  PRIMARY KEY(job_id, number)
);
CREATE TABLE IF NOT EXISTS events (
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  job_key TEXT,
  attempt INTEGER,
  PRIMARY KEY(workflow_id, seq)
);
CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id)
);
