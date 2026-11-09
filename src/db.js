// Camada de banco de dados (SQLite embutido do Node.js — sem dependências nativas).
// Para produção em nuvem com várias instâncias, troque por PostgreSQL mantendo as mesmas tabelas.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'agenda.db');
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');
if (DB_PATH !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE,
  scale_model   TEXT NOT NULL,
  cycle_start   TEXT NOT NULL,              -- data âncora do ciclo (AAAA-MM-DD)
  shift_start   TEXT NOT NULL DEFAULT '08:00',
  daily_hours   REAL NOT NULL,              -- horas contratuais por dia de trabalho
  description   TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operador')),
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('treinamento','folga','plantao')),
  title         TEXT NOT NULL,
  date          TEXT NOT NULL,
  start_time    TEXT,
  end_time      TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'agendado' CHECK (status IN ('agendado','compareceu','nao_compareceu','cancelado')),
  validated_at  TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_user_date ON events(user_id, date);

-- Jornadas efetivamente trabalhadas (ponto). Base do controle de excesso de escala.
CREATE TABLE IF NOT EXISTS work_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date          TEXT NOT NULL,
  clock_in      TEXT NOT NULL,              -- HH:MM
  clock_out     TEXT NOT NULL,              -- HH:MM (se menor que entrada, atravessa a meia-noite)
  break_minutes INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_work_logs_user_date ON work_logs(user_id, date);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

function audit(userId, action, details) {
  db.prepare('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(userId ?? null, action, details ? JSON.stringify(details) : null);
}

module.exports = { db, audit, DB_PATH };
