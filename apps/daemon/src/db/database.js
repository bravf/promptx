import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

export const DATABASE_VERSION = 6

export function resolveDaemonPaths() {
  const homeDir = path.resolve(process.env.PROMPTX_HOME || path.join(os.homedir(), '.promptx'))
  const dataDir = path.resolve(process.env.PROMPTX_DATA_DIR || path.join(homeDir, 'data'))
  return {
    homeDir,
    dataDir,
    assetsDir: path.resolve(process.env.PROMPTX_UPLOADS_DIR || path.join(homeDir, 'uploads-v2')),
    databasePath: path.join(dataDir, 'promptx-v2.sqlite'),
  }
}

export function openDatabase(databasePath = resolveDaemonPaths().databasePath) {
  if (databasePath !== ':memory:') fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const db = new Database(databasePath)
  try {
    const version = db.pragma('user_version', { simple: true })
    const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()
    if (hasTables && version !== DATABASE_VERSION) {
      const error = new Error('数据库模型已更新，不支持旧数据。请停止服务后运行 pnpm data:reset，再重新启动。')
      error.code = 'DATABASE_VERSION_MISMATCH'
      throw error
    }
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    if (!hasTables) db.transaction(() => {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY, repository_root TEXT NOT NULL, path_key TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL, default_branch TEXT NOT NULL DEFAULT '',
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'archived')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT NOT NULL,
          archived_at TEXT, pinned_at TEXT
        );
        CREATE TABLE execution_environments (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('local', 'worktree')),
          cwd TEXT NOT NULL, repository_root TEXT NOT NULL, branch_name TEXT NOT NULL DEFAULT '',
          base_ref TEXT NOT NULL DEFAULT '', base_commit TEXT NOT NULL DEFAULT '', worktree_path TEXT, path_key TEXT NOT NULL,
          ownership TEXT NOT NULL CHECK(ownership IN ('promptx', 'external')),
          status TEXT NOT NULL CHECK(status IN ('ready', 'dirty', 'clean', 'missing', 'removed', 'unavailable')),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_managed_worktree_path ON execution_environments(path_key)
          WHERE kind = 'worktree' AND ownership = 'promptx';
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          environment_id TEXT NOT NULL UNIQUE REFERENCES execution_environments(id), title TEXT NOT NULL,
          lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active', 'archived')),
          timeline_epoch TEXT NOT NULL, timeline_next_seq INTEGER NOT NULL DEFAULT 1 CHECK(timeline_next_seq > 0),
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_active_at TEXT NOT NULL,
          archived_at TEXT, pinned_at TEXT
        );
        CREATE INDEX idx_projects_activity ON projects(lifecycle, pinned_at DESC, last_opened_at DESC);
        CREATE INDEX idx_tasks_project_activity ON tasks(project_id, archived_at, pinned_at DESC, last_active_at DESC);
        CREATE TABLE agent_sessions (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL, lifecycle TEXT NOT NULL,
          model_id TEXT NOT NULL DEFAULT '', mode_id TEXT NOT NULL DEFAULT '',
          config_json TEXT NOT NULL DEFAULT '{}', capabilities_json TEXT NOT NULL DEFAULT '{}',
          native_handle_json TEXT NOT NULL DEFAULT '{}', native_source_id TEXT,
          last_error TEXT NOT NULL DEFAULT '', requires_attention INTEGER NOT NULL DEFAULT 0,
          attention_reason TEXT, attention_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(provider_id, native_source_id), UNIQUE(id, task_id)
        );
        CREATE TABLE task_assets (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          file_name TEXT NOT NULL, mime_type TEXT NOT NULL, byte_size INTEGER NOT NULL,
          sha256 TEXT NOT NULL, storage_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
        );
        CREATE INDEX idx_task_assets_created ON task_assets(task_id, created_at DESC);
        CREATE TABLE agent_turns (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_session_id TEXT NOT NULL, client_message_id TEXT NOT NULL, native_turn_id TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'completed', 'failed', 'canceled')),
          error_message TEXT NOT NULL DEFAULT '', usage_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
          FOREIGN KEY(agent_session_id, task_id) REFERENCES agent_sessions(id, task_id) ON DELETE CASCADE,
          UNIQUE(task_id, client_message_id), UNIQUE(id, task_id)
        );
        CREATE UNIQUE INDEX idx_turns_one_active ON agent_turns(task_id) WHERE status IN ('queued', 'running');
        CREATE INDEX idx_turns_task_created ON agent_turns(task_id, created_at DESC);
        CREATE TABLE agent_timeline_rows (
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL CHECK(seq > 0), timestamp TEXT NOT NULL, turn_id TEXT,
          provider_message_id TEXT, item_type TEXT NOT NULL, item_json TEXT NOT NULL,
          FOREIGN KEY(turn_id, task_id) REFERENCES agent_turns(id, task_id), UNIQUE(task_id, seq)
        );
        CREATE TABLE agent_timeline_sync_state (
          task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
          provider_id TEXT NOT NULL, source_id TEXT NOT NULL, manifest_json TEXT NOT NULL DEFAULT '{}', synced_at TEXT NOT NULL
        );
      `)
      db.pragma(`user_version = ${DATABASE_VERSION}`)
    })()
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
