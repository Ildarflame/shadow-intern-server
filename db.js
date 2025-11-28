const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "shadow.db");
const db = new Database(dbPath);

db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_key TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  limit_total INTEGER NOT NULL DEFAULT 500,
  usage INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_request_at INTEGER
);

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  license_id INTEGER NOT NULL,
  endpoint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (license_id) REFERENCES licenses(id)
);
`);

const defaultLicenses = [
  { key: "shadow-demo-key", active: 1, limit: 1000 },
  { key: "shadow-test-key", active: 1, limit: 100 },
  { key: "shadow-disabled-key", active: 0, limit: 0 }
];

const insertLicenseStmt = db.prepare(`
  INSERT OR IGNORE INTO licenses (
    license_key,
    active,
    limit_total,
    usage,
    created_at,
    updated_at,
    last_request_at
  ) VALUES (?, ?, ?, 0, ?, ?, NULL)
`);

const now = Date.now();
for (const license of defaultLicenses) {
  insertLicenseStmt.run(
    license.key,
    license.active,
    license.limit,
    now,
    now
  );
}

module.exports = db;

