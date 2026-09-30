const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'journal.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  firm TEXT NOT NULL DEFAULT 'Other',
  kind TEXT NOT NULL DEFAULT '',
  connection_id TEXT,
  tv_env TEXT,
  tv_account_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS accounts_user ON accounts(user_id);
CREATE TABLE IF NOT EXISTS connections(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  method TEXT NOT NULL,              -- 'oauth' | 'apikey'
  env TEXT NOT NULL,                 -- 'demo' (prop/sim) | 'live'
  label TEXT NOT NULL DEFAULT '',
  enc_creds TEXT,                    -- API-key logins only, encrypted
  enc_token TEXT,                    -- encrypted access token
  token_expires INTEGER,
  status TEXT NOT NULL DEFAULT 'ok', -- 'ok' | 'error' | 'reconnect'
  last_sync_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trades(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  entry_ts INTEGER,
  root TEXT,
  side TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_user_ts ON trades(user_id, entry_ts);
CREATE TABLE IF NOT EXISTS legs(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  external_id TEXT NOT NULL,
  source TEXT NOT NULL,
  symbol TEXT, root TEXT, side TEXT,
  qty REAL, entry REAL, exit REAL, gross REAL, fees REAL,
  entry_ts INTEGER, exit_ts INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS legs_ext ON legs(user_id, external_id);
CREATE INDEX IF NOT EXISTS legs_trade ON legs(trade_id);
CREATE INDEX IF NOT EXISTS legs_acct_ts ON legs(user_id, account_id, entry_ts);
CREATE TABLE IF NOT EXISTS ignored_legs(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  PRIMARY KEY(user_id, external_id)
);
CREATE TABLE IF NOT EXISTS oauth_states(
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  env TEXT NOT NULL,
  label TEXT,
  expires_at INTEGER NOT NULL
);
`);

const q = {
  // users & sessions
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser: db.prepare('INSERT INTO users(id,email,pass_hash,created_at) VALUES(?,?,?,?)'),
  insertSession: db.prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)'),
  getSession: db.prepare('SELECT s.user_id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),

  // settings
  getSettings: db.prepare('SELECT data FROM settings WHERE user_id = ?'),
  putSettings: db.prepare('INSERT INTO settings(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data'),

  // accounts
  accountsForUser: db.prepare('SELECT * FROM accounts WHERE user_id = ? ORDER BY created_at'),
  accountById: db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?'),
  accountByTv: db.prepare('SELECT * FROM accounts WHERE user_id = ? AND tv_env = ? AND tv_account_id = ?'),
  insertAccount: db.prepare('INSERT INTO accounts(id,user_id,name,firm,kind,connection_id,tv_env,tv_account_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)'),
  updateAccount: db.prepare('UPDATE accounts SET name = ?, firm = ?, kind = ? WHERE id = ? AND user_id = ?'),
  relinkAccount: db.prepare('UPDATE accounts SET connection_id = ? WHERE id = ?'),
  deleteAccount: db.prepare('DELETE FROM accounts WHERE id = ? AND user_id = ?'),
  unlinkConnectionAccounts: db.prepare('UPDATE accounts SET connection_id = NULL WHERE connection_id = ?'),

  // connections
  connectionsForUser: db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at'),
  connectionById: db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?'),
  activeConnections: db.prepare("SELECT * FROM connections WHERE status IN ('ok','error')"),
  insertConnection: db.prepare('INSERT INTO connections(id,user_id,method,env,label,enc_creds,enc_token,token_expires,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)'),
  saveToken: db.prepare('UPDATE connections SET enc_token = ?, token_expires = ? WHERE id = ?'),
  setConnStatus: db.prepare('UPDATE connections SET status = ?, last_error = ? WHERE id = ?'),
  markSynced: db.prepare("UPDATE connections SET status = 'ok', last_error = NULL, last_sync_at = ? WHERE id = ?"),
  deleteConnection: db.prepare('DELETE FROM connections WHERE id = ? AND user_id = ?'),

  // oauth state
  insertState: db.prepare('INSERT INTO oauth_states(state,user_id,env,label,expires_at) VALUES(?,?,?,?,?)'),
  takeState: db.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING *'),
  purgeStates: db.prepare('DELETE FROM oauth_states WHERE expires_at < ?'),

  // trades
  tradesForUser: db.prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY entry_ts, date'),
  tradeById: db.prepare('SELECT * FROM trades WHERE id = ? AND user_id = ?'),
  insertTrade: db.prepare('INSERT INTO trades(id,user_id,date,entry_ts,root,side,source,data,updated_at) VALUES(?,?,?,?,?,?,?,?,?)'),
  updateTrade: db.prepare('UPDATE trades SET date = ?, entry_ts = ?, root = ?, side = ?, source = ?, data = ?, updated_at = ? WHERE id = ?'),
  deleteTrade: db.prepare('DELETE FROM trades WHERE id = ? AND user_id = ?'),
  tradesNear: db.prepare('SELECT * FROM trades WHERE user_id = ? AND root = ? AND side = ? AND entry_ts BETWEEN ? AND ?'),

  // legs
  legsForUser: db.prepare('SELECT * FROM legs WHERE user_id = ? ORDER BY entry_ts'),
  legsForTrade: db.prepare('SELECT * FROM legs WHERE trade_id = ? ORDER BY entry_ts, id'),
  legByExt: db.prepare('SELECT * FROM legs WHERE user_id = ? AND external_id = ?'),
  dupLegs: db.prepare('SELECT * FROM legs WHERE user_id = ? AND account_id IS ? AND side = ? AND entry_ts BETWEEN ? AND ?'),
  insertLeg: db.prepare(`INSERT INTO legs(id,user_id,trade_id,account_id,external_id,source,symbol,root,side,qty,entry,exit,gross,fees,entry_ts,exit_ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
  updateLeg: db.prepare('UPDATE legs SET account_id = ?, qty = ?, entry = ?, exit = ?, gross = ?, fees = ?, entry_ts = ?, exit_ts = ? WHERE id = ?'),
  ignoreLeg: db.prepare('INSERT OR IGNORE INTO ignored_legs(user_id,external_id) VALUES(?,?)'),
  isIgnored: db.prepare('SELECT 1 FROM ignored_legs WHERE user_id = ? AND external_id = ?'),
};

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, q, tx, DATA_DIR };
