-- Product is the existing aggregate authority. Child tables are atomic projections.
-- statement-breakpoint
CREATE TABLE products (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK(length(id) BETWEEN 1 AND 160),
  slug TEXT UNIQUE CHECK(slug IS NULL OR length(slug) <= 160),
  status TEXT NOT NULL CHECK(status IN ('draft','needs_review','approved','published','archived')),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  token TEXT NOT NULL CHECK(length(token) = 64),
  created_at TEXT NOT NULL CHECK(length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 24),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 262144),
  identities TEXT NOT NULL CHECK(json_valid(identities) AND json_array_length(identities) <= 256)
);
-- statement-breakpoint
CREATE INDEX products_status_id ON products(status,id);
-- statement-breakpoint
CREATE TABLE product_identities (
  namespace TEXT NOT NULL CHECK(namespace IN ('SOURCE','CREATE','CANONICAL')),
  kind TEXT NOT NULL CHECK(kind IN ('source','url','alias')),
  identity_key TEXT NOT NULL CHECK(length(identity_key) BETWEEN 1 AND 4096),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_sequence INTEGER NOT NULL,
  PRIMARY KEY(namespace,identity_key,product_id)
);
-- statement-breakpoint
CREATE UNIQUE INDEX product_source_identity_unique ON product_identities(namespace,identity_key)
  WHERE namespace = 'SOURCE' AND kind = 'source';
-- statement-breakpoint
CREATE INDEX product_identity_lookup ON product_identities(namespace,identity_key,product_sequence);
-- statement-breakpoint
CREATE INDEX product_identity_owner ON product_identities(product_id);
-- statement-breakpoint
CREATE TABLE product_offers (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) BETWEEN 1 AND 240),
  source TEXT NOT NULL,
  merchant TEXT NOT NULL,
  price REAL CHECK(price IS NULL OR price >= 0),
  original_price REAL CHECK(original_price IS NULL OR original_price >= 0),
  affiliate_url TEXT NOT NULL CHECK(length(affiliate_url) <= 4096),
  health TEXT NOT NULL CHECK(health IN ('HEALTHY','DEGRADED','BROKEN','UNKNOWN')),
  observed_at TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  PRIMARY KEY(product_id,id)
);
-- statement-breakpoint
CREATE TRIGGER products_insert_projections AFTER INSERT ON products BEGIN
  INSERT INTO product_identities(namespace,kind,identity_key,product_id,product_sequence)
    SELECT json_extract(value,'$.namespace'),json_extract(value,'$.kind'),json_extract(value,'$.key'),NEW.id,NEW.sequence
    FROM json_each(NEW.identities);
  INSERT INTO product_offers(product_id,id,source,merchant,price,original_price,affiliate_url,health,observed_at,payload)
    SELECT NEW.id,json_extract(value,'$.id'),json_extract(value,'$.source'),json_extract(value,'$.merchant'),
      json_extract(value,'$.price'),json_extract(value,'$.originalPrice'),json_extract(value,'$.affiliateUrl'),
      json_extract(value,'$.health'),json_extract(value,'$.observedAt'),value FROM json_each(NEW.payload,'$.offers');
END;
-- statement-breakpoint
CREATE TRIGGER products_update_projections AFTER UPDATE OF payload,identities ON products BEGIN
  DELETE FROM product_identities WHERE product_id = OLD.id;
  INSERT INTO product_identities(namespace,kind,identity_key,product_id,product_sequence)
    SELECT json_extract(value,'$.namespace'),json_extract(value,'$.kind'),json_extract(value,'$.key'),NEW.id,NEW.sequence
    FROM json_each(NEW.identities);
  DELETE FROM product_offers WHERE product_id = OLD.id;
  INSERT INTO product_offers(product_id,id,source,merchant,price,original_price,affiliate_url,health,observed_at,payload)
    SELECT NEW.id,json_extract(value,'$.id'),json_extract(value,'$.source'),json_extract(value,'$.merchant'),
      json_extract(value,'$.price'),json_extract(value,'$.originalPrice'),json_extract(value,'$.affiliateUrl'),
      json_extract(value,'$.health'),json_extract(value,'$.observedAt'),value FROM json_each(NEW.payload,'$.offers');
END;
-- statement-breakpoint
CREATE TABLE price_history (
  id TEXT NOT NULL PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 160),
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL CHECK(length(captured_at) = 24),
  source_hash TEXT NOT NULL CHECK(length(source_hash) BETWEEN 1 AND 128),
  price REAL CHECK(price IS NULL OR price >= 0),
  sale_price REAL CHECK(sale_price IS NULL OR sale_price >= 0),
  operation_id TEXT NOT NULL CHECK(length(operation_id) <= 160),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 4096)
);
-- statement-breakpoint
CREATE INDEX price_history_product_time ON price_history(product_id,captured_at DESC,id DESC);
-- statement-breakpoint
CREATE TABLE system_settings (
  id TEXT NOT NULL PRIMARY KEY CHECK(id IN ('automation','scheduler')),
  updated_at TEXT NOT NULL CHECK(length(updated_at) = 24),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 65536)
);
-- statement-breakpoint
CREATE TABLE product_audits (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('duplicate','evidence','publication')),
  effect_key TEXT CHECK(effect_key IS NULL OR length(effect_key) BETWEEN 1 AND 240),
  product_id TEXT NOT NULL,
  captured_at TEXT NOT NULL CHECK(length(captured_at) = 24),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 16384),
  UNIQUE(kind,effect_key)
);
