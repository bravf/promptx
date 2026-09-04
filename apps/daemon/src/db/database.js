import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export function resolveDaemonPaths() {
  const homeDir = path.resolve(process.env.PROMPTX_HOME || path.join(os.homedir(), '.promptx'))
  const dataDir = path.resolve(process.env.PROMPTX_DATA_DIR || path.join(homeDir, 'data'))
  const assetsDir = path.resolve(process.env.PROMPTX_UPLOADS_DIR || path.join(homeDir, 'uploads-v2'))
  return {
    homeDir,
    dataDir,
    assetsDir,
    databasePath: path.join(dataDir, 'promptx-v2.sqlite'),
  }
}

export function openDatabase(databasePath = resolveDaemonPaths().databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const db = new Database(databasePath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      path_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_sort
      ON workspaces(sort_order ASC, last_opened_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_assets (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_assets_workspace_created
      ON workspace_assets(workspace_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      title TEXT NOT NULL,
      lifecycle TEXT NOT NULL,
      model_id TEXT NOT NULL DEFAULT '',
      mode_id TEXT NOT NULL DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      native_handle_json TEXT NOT NULL DEFAULT '{}',
      timeline_epoch TEXT NOT NULL,
      timeline_next_seq INTEGER NOT NULL DEFAULT 1,
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_sessions_workspace_activity
      ON agent_sessions(workspace_id, archived_at, last_active_at DESC);

    CREATE TABLE IF NOT EXISTS agent_turns (
      id TEXT PRIMARY KEY,
      agent_session_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      native_turn_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error_message TEXT NOT NULL DEFAULT '',
      usage_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
      UNIQUE(agent_session_id, client_message_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_turns_one_active
      ON agent_turns(agent_session_id)
      WHERE status IN ('queued', 'running');

    CREATE INDEX IF NOT EXISTS idx_agent_turns_session_created
      ON agent_turns(agent_session_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS agent_timeline_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      turn_id TEXT,
      provider_message_id TEXT,
      item_type TEXT NOT NULL,
      item_json TEXT NOT NULL,
      FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE SET NULL,
      UNIQUE(agent_session_id, seq)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_timeline_session_seq
      ON agent_timeline_rows(agent_session_id, seq);

    CREATE TABLE IF NOT EXISTS agent_timeline_sync_state (
      agent_session_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      manifest_json TEXT NOT NULL DEFAULT '{}',
      synced_at TEXT NOT NULL,
      FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
    );
  `)
  // Keep the v2 database usable after adding attention state to existing local data.
  ensureColumn(db, 'agent_sessions', 'requires_attention', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'agent_sessions', 'attention_reason', 'TEXT')
  ensureColumn(db, 'agent_sessions', 'attention_at', 'TEXT')
  return db
}
