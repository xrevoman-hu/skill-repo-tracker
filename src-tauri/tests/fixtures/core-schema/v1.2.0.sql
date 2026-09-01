-- Fictional, sanitized compatibility fixture. Contains no user paths or credentials.
PRAGMA user_version = 0;
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings VALUES
  ('fixture_version', 'v1.2.0'),
  ('concurrency', '7'),
  ('retry_count', '3'),
  ('cleanup_keep', '42');
CREATE TABLE user_notes (
  scope TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(scope, entity_key)
);
INSERT INTO user_notes VALUES
  ('repository', 'github:fixture/repository', 'fictional compatibility note', '2026-01-01T00:00:00Z');
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref_name TEXT NOT NULL,
  repo_type TEXT NOT NULL,
  skills_count INTEGER NOT NULL DEFAULT 0,
  remote_sha TEXT NOT NULL DEFAULT 'unknown',
  last_backup_sha TEXT,
  last_checked TEXT,
  backup_status TEXT NOT NULL DEFAULT 'never-backed-up',
  check_status TEXT NOT NULL DEFAULT 'unknown',
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  backup_path TEXT,
  snapshot_time TEXT,
  source_type TEXT NOT NULL DEFAULT 'github',
  local_path TEXT,
  github_account_id TEXT,
  canonical_name TEXT,
  error TEXT,
  readme_search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO repositories VALUES (
  'github:fixture/repository:main', 'Fixture Repository', 'fixture', 'repository', 'main',
  'skill repo', 2, 'fixture-remote-sha', 'fixture-backup-sha', '2026-01-01T00:00:00Z',
  'backed-up-latest', 'success', 'https://github.com/fixture/repository', 'main',
  '/tmp/fictional-backup.zip', '2026-01-01T00:00:00Z', 'github', NULL, NULL,
  'fixture/repository', NULL, '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', repo_name TEXT NOT NULL, path TEXT NOT NULL,
  ref_name TEXT NOT NULL, local_version TEXT, remote_version TEXT NOT NULL, status TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, installed_hash TEXT,
  remote_hash TEXT, handled_remote_sha TEXT, handled_remote_hash TEXT,
  source_type TEXT NOT NULL DEFAULT 'github_repo', local_path TEXT, install_path TEXT,
  deleted_at TEXT, deleted_path TEXT, sync_targets_mode TEXT NOT NULL DEFAULT 'inherit',
  sync_targets TEXT, search_text TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE TABLE skill_sync_records (
  skill_id TEXT NOT NULL, target_id TEXT NOT NULL, target_path TEXT NOT NULL,
  skill_path TEXT NOT NULL, content_hash TEXT, synced_at TEXT NOT NULL,
  PRIMARY KEY(skill_id, target_id), FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE TABLE skill_update_conflicts (
  id TEXT PRIMARY KEY, skill_id TEXT NOT NULL, task_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', local_hash TEXT NOT NULL, installed_hash TEXT,
  remote_sha TEXT NOT NULL, remote_hash TEXT NOT NULL,
  verification_state TEXT NOT NULL DEFAULT 'pending', verified_local_hash TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT, resolved_at TEXT,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX skill_update_conflicts_one_active ON skill_update_conflicts(skill_id)
  WHERE status = 'pending';
CREATE TABLE plugins (
  id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, install_command TEXT NOT NULL,
  update_command TEXT, source_path TEXT NOT NULL, source_excerpt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'detected', detected_sha TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT, updated_at TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '',
  FOREIGN KEY(repo_id) REFERENCES repositories(id) ON DELETE CASCADE
);
CREATE TABLE plugin_skill_links (
  plugin_id TEXT NOT NULL, skill_id TEXT NOT NULL, PRIMARY KEY(plugin_id, skill_id),
  FOREIGN KEY(plugin_id) REFERENCES plugins(id) ON DELETE CASCADE,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
);
CREATE TABLE backup_jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, progress TEXT NOT NULL,
  status TEXT NOT NULL, summary TEXT NOT NULL, backup_dir TEXT,
  retryable INTEGER NOT NULL DEFAULT 0, retry_action TEXT, retry_payload TEXT, retry_reason TEXT,
  created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT
);
CREATE TABLE backup_job_items (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL, repo_id TEXT NOT NULL, repo_name TEXT NOT NULL,
  status TEXT NOT NULL, ref_name TEXT NOT NULL, resolved_sha TEXT, file_path TEXT,
  size_bytes INTEGER, sha256 TEXT, error TEXT,
  FOREIGN KEY(job_id) REFERENCES backup_jobs(id) ON DELETE CASCADE
);
CREATE TABLE task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
  line_no INTEGER NOT NULL, line TEXT NOT NULL
);
CREATE TABLE github_accounts (
  id TEXT PRIMARY KEY, login TEXT NOT NULL, display_name TEXT NOT NULL, avatar_url TEXT,
  token_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'saved_unverified',
  scopes TEXT NOT NULL DEFAULT '', last_verified TEXT, is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE github_repo_catalog (
  account_id TEXT NOT NULL, full_name TEXT NOT NULL, owner TEXT NOT NULL, repo TEXT NOT NULL,
  github_id INTEGER NOT NULL DEFAULT 0, html_url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', visibility TEXT NOT NULL DEFAULT 'public',
  private INTEGER NOT NULL DEFAULT 0, fork INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, default_branch TEXT NOT NULL DEFAULT 'main',
  language TEXT NOT NULL DEFAULT '', stargazers_count INTEGER NOT NULL DEFAULT 0,
  starred INTEGER NOT NULL DEFAULT 0, starred_at TEXT, permissions TEXT NOT NULL DEFAULT '',
  pushed_at TEXT, github_updated_at TEXT, readme_search_text TEXT NOT NULL DEFAULT '',
  last_refreshed TEXT NOT NULL, PRIMARY KEY(account_id, full_name),
  FOREIGN KEY(account_id) REFERENCES github_accounts(id) ON DELETE CASCADE
);
CREATE TABLE backup_manifests (
  id TEXT PRIMARY KEY, backup_dir TEXT NOT NULL, manifest_path TEXT NOT NULL,
  created_at TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL
);
CREATE TABLE schedules (
  kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL,
  interval_minutes INTEGER NOT NULL, updated_at TEXT NOT NULL
);

INSERT INTO github_accounts
  (id, login, display_name, token_key, status, scopes, last_verified, is_default, created_at, updated_at)
VALUES ('github:fixture-account', 'fixture-octopus', 'Fixture Octopus',
  'github-account:fixture-octopus', 'verified', 'repo', '2026-01-01T00:00:00Z', 1,
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
UPDATE repositories SET github_account_id = 'github:fixture-account';
INSERT INTO github_repo_catalog
  (account_id, full_name, owner, repo, html_url, description, default_branch, starred,
   permissions, last_refreshed)
VALUES ('github:fixture-account', 'fixture/repository', 'fixture', 'repository',
  'https://github.com/fixture/repository', 'fictional catalog row', 'main', 1,
  'push,pull', '2026-01-01T00:00:00Z');
INSERT INTO skills
  (id, repo_id, name, description, repo_name, path, ref_name, remote_version, status,
   installed, remote_hash, source_type, created_at, updated_at)
VALUES ('skill:fixture', 'github:fixture/repository:main', 'fixture-skill',
  'fictional skill row', 'Fixture Repository', 'skills/fixture', 'main', '1.0.0',
  'update-available', 1, 'fixture-remote-hash', 'github_repo',
  NULL, '2026-01-01T00:00:00Z');
INSERT INTO skill_sync_records VALUES
  ('skill:fixture', 'target:fixture', '/tmp/fictional-target', 'fixture-skill',
   'fixture-content-hash', '2026-01-01T00:00:00Z');
INSERT INTO skill_update_conflicts
  (id, skill_id, task_id, local_hash, installed_hash, remote_sha, remote_hash,
   verification_state, created_at, updated_at)
VALUES ('conflict:fixture', 'skill:fixture', 'task:fixture', 'fixture-local-hash',
  'fixture-installed-hash', 'fixture-remote-sha', 'fixture-remote-hash', 'pending',
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
INSERT INTO plugins
  (id, repo_id, name, description, kind, install_command, update_command, source_path,
   source_excerpt, status, detected_sha, created_at, updated_at)
VALUES ('plugin:fixture', 'github:fixture/repository:main', 'fixture-plugin',
  'fictional plugin row', 'cli', 'fictional install', 'fictional update', 'README.md',
  'fictional excerpt', 'detected', 'fixture-remote-sha', NULL,
  '2026-01-01T00:00:00Z');
INSERT INTO plugin_skill_links VALUES ('plugin:fixture', 'skill:fixture');
INSERT INTO backup_jobs
  (id, kind, target, progress, status, summary, backup_dir, retryable, retry_action,
   retry_payload, retry_reason, created_at, started_at, completed_at)
VALUES ('job:fixture', 'Backup repositories', 'Fixture Repository', '1 / 1', 'success',
  'fictional backup complete', '/tmp/fictional-backup', 1, 'backup_repositories', '{}',
  'fictional retry reason', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z',
  '2026-01-01T00:00:01Z');
INSERT INTO backup_job_items VALUES
  ('job-item:fixture', 'job:fixture', 'github:fixture/repository:main', 'Fixture Repository',
   'success', 'main', 'fixture-remote-sha', '/tmp/fictional-backup/repository.zip', 128,
   'fixture-sha256', NULL);
INSERT INTO task_logs(task_id, line_no, line) VALUES ('job:fixture', 1, 'fictional task log');
INSERT INTO backup_manifests VALUES
  ('backup:fixture', '/tmp/fictional-backup', '/tmp/fictional-backup/manifest.json',
   '2026-01-01T00:00:00Z', 'all', 'success', 'fictional manifest');
INSERT INTO schedules VALUES ('check', 1, 60, '2026-01-01T00:00:00Z');
