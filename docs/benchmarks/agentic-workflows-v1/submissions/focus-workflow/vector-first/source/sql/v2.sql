CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  concurrency INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_jobs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  dependencies TEXT NOT NULL,
  max_attempts INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  legacy_id TEXT REFERENCES jobs(id),
  position INTEGER NOT NULL,
  UNIQUE(workflow_id, key)
);
CREATE TABLE IF NOT EXISTS attempts (
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
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
  contents TEXT NOT NULL,
  workflow_id TEXT NOT NULL REFERENCES workflows(id)
);
CREATE INDEX IF NOT EXISTS workflow_jobs_parent ON workflow_jobs(workflow_id, position);
