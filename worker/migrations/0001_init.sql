CREATE TABLE listings (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  condition TEXT,
  quantity INTEGER,
  ebay_price REAL NOT NULL,
  is_lot INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  ebay_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  held_by TEXT,
  seen_at TEXT NOT NULL
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  customer TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  items TEXT NOT NULL,
  asking_total REAL NOT NULL,
  offer_amount REAL NOT NULL,
  counter_amount REAL,
  invoice TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  ip TEXT
);
CREATE INDEX offers_created ON offers (created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
