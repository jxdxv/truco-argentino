CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  creator_name TEXT NOT NULL,
  player_count INTEGER NOT NULL DEFAULT 1,
  target_points INTEGER NOT NULL DEFAULT 30,
  with_flor INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'waiting'
);
CREATE INDEX IF NOT EXISTS idx_rooms_waiting ON rooms(status, player_count, created_at);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_data TEXT,
  progress_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
