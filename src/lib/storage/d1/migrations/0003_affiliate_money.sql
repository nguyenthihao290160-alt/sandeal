CREATE TABLE affiliate_provider_observations (
  provider TEXT PRIMARY KEY NOT NULL CHECK(provider IN ('accesstrade','tiktok')),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 4096)
);
-- statement-breakpoint
CREATE TABLE affiliate_clicks (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  offer_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('accesstrade','tiktok')),
  merchant_id TEXT NOT NULL,
  campaign_id TEXT,
  currency TEXT NOT NULL CHECK(currency IN ('VND','USD','EUR')),
  created_at TEXT NOT NULL,
  attribution_reference TEXT UNIQUE NOT NULL,
  attribution_transport TEXT NOT NULL CHECK(attribution_transport IN ('PROVIDER_SUB1','UNAVAILABLE')),
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB)) <= 4096)
);
-- statement-breakpoint
CREATE INDEX affiliate_clicks_product_time ON affiliate_clicks(product_id,created_at,id);
-- statement-breakpoint
CREATE TABLE affiliate_conversions (
  provider TEXT NOT NULL CHECK(provider IN ('accesstrade','tiktok')),
  external_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  click_id TEXT NOT NULL REFERENCES affiliate_clicks(id),
  occurred_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  PRIMARY KEY(provider,external_id),
  UNIQUE(provider,event_id)
);
-- statement-breakpoint
CREATE TABLE affiliate_commission_events (
  provider TEXT NOT NULL CHECK(provider IN ('accesstrade','tiktok')),
  event_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  conversion_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 100000),
  state TEXT NOT NULL CHECK(state IN ('UNKNOWN','ESTIMATED','PENDING','APPROVED','REJECTED','PAID')),
  amount_minor INTEGER CHECK(amount_minor BETWEEN 0 AND 1000000000000),
  currency TEXT NOT NULL CHECK(currency IN ('VND','USD','EUR')),
  occurred_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  PRIMARY KEY(provider,event_id),
  UNIQUE(provider,external_id,revision),
  FOREIGN KEY(provider,conversion_id) REFERENCES affiliate_conversions(provider,external_id),
  CHECK(amount_minor IS NOT NULL OR state='UNKNOWN')
);
-- statement-breakpoint
CREATE TABLE affiliate_commissions (
  provider TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  conversion_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('UNKNOWN','ESTIMATED','PENDING','APPROVED','REJECTED','PAID')),
  amount_minor INTEGER,
  currency TEXT NOT NULL,
  PRIMARY KEY(provider,external_id),
  FOREIGN KEY(provider,event_id) REFERENCES affiliate_commission_events(provider,event_id)
);
-- statement-breakpoint
CREATE TABLE affiliate_money_unmatched (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('CONVERSION','COMMISSION')),
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('UNMATCHED','QUARANTINED')),
  created_at TEXT NOT NULL
);
-- statement-breakpoint
CREATE TABLE affiliate_money_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  effect_key TEXT NOT NULL UNIQUE,
  product_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('accesstrade','tiktok')),
  merchant_id TEXT NOT NULL,
  campaign_id TEXT,
  day TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('VND','USD','EUR')),
  clicks INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  commission_state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(commission_state IN ('UNKNOWN','ESTIMATED','PENDING','APPROVED','REJECTED','PAID')),
  amount_minor INTEGER NOT NULL DEFAULT 0,
  unknown_amounts INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE'))
);
-- statement-breakpoint
CREATE TRIGGER affiliate_click_event AFTER INSERT ON affiliate_clicks BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,merchant_id,campaign_id,day,currency,clicks,origin)
    VALUES('click:'||NEW.id,NEW.product_id,NEW.provider,NEW.merchant_id,NEW.campaign_id,substr(NEW.created_at,1,10),NEW.currency,1,NEW.origin);
END;
-- statement-breakpoint
CREATE TRIGGER affiliate_conversion_event AFTER INSERT ON affiliate_conversions BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,merchant_id,campaign_id,day,currency,conversions,origin)
    SELECT 'conversion:'||NEW.provider||':'||NEW.external_id,product_id,provider,merchant_id,campaign_id,substr(NEW.occurred_at,1,10),currency,1,NEW.origin
    FROM affiliate_clicks WHERE id=NEW.click_id;
END;
-- statement-breakpoint
CREATE TRIGGER affiliate_commission_current AFTER INSERT ON affiliate_commission_events BEGIN
  INSERT INTO affiliate_commissions(provider,external_id,event_id,conversion_id,revision,state,amount_minor,currency)
    VALUES(NEW.provider,NEW.external_id,NEW.event_id,NEW.conversion_id,NEW.revision,NEW.state,NEW.amount_minor,NEW.currency)
    ON CONFLICT(provider,external_id) DO UPDATE SET event_id=excluded.event_id,revision=excluded.revision,state=excluded.state,amount_minor=excluded.amount_minor
    WHERE excluded.revision>affiliate_commissions.revision AND excluded.conversion_id=affiliate_commissions.conversion_id AND excluded.currency=affiliate_commissions.currency;
END;
-- statement-breakpoint
CREATE TRIGGER affiliate_commission_first AFTER INSERT ON affiliate_commissions BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,merchant_id,campaign_id,day,currency,commission_state,amount_minor,unknown_amounts,origin)
    SELECT 'commission:'||NEW.provider||':'||NEW.external_id||':'||NEW.revision||':new',click.product_id,NEW.provider,click.merchant_id,click.campaign_id,
      substr(conversion.occurred_at,1,10),NEW.currency,NEW.state,coalesce(NEW.amount_minor,0),NEW.amount_minor IS NULL,click.origin
    FROM affiliate_conversions conversion JOIN affiliate_clicks click ON click.id=conversion.click_id
    WHERE conversion.provider=NEW.provider AND conversion.external_id=NEW.conversion_id;
END;
-- statement-breakpoint
CREATE TRIGGER affiliate_commission_change AFTER UPDATE ON affiliate_commissions BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,merchant_id,campaign_id,day,currency,commission_state,amount_minor,unknown_amounts,origin)
    SELECT 'commission:'||NEW.provider||':'||NEW.external_id||':'||NEW.revision||':old',click.product_id,NEW.provider,click.merchant_id,click.campaign_id,
      substr(conversion.occurred_at,1,10),OLD.currency,OLD.state,-coalesce(OLD.amount_minor,0),-(OLD.amount_minor IS NULL),click.origin
    FROM affiliate_conversions conversion JOIN affiliate_clicks click ON click.id=conversion.click_id
    WHERE conversion.provider=NEW.provider AND conversion.external_id=NEW.conversion_id;
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,merchant_id,campaign_id,day,currency,commission_state,amount_minor,unknown_amounts,origin)
    SELECT 'commission:'||NEW.provider||':'||NEW.external_id||':'||NEW.revision||':new',click.product_id,NEW.provider,click.merchant_id,click.campaign_id,
      substr(conversion.occurred_at,1,10),NEW.currency,NEW.state,coalesce(NEW.amount_minor,0),NEW.amount_minor IS NULL,click.origin
    FROM affiliate_conversions conversion JOIN affiliate_clicks click ON click.id=conversion.click_id
    WHERE conversion.provider=NEW.provider AND conversion.external_id=NEW.conversion_id;
END;
-- statement-breakpoint
CREATE TRIGGER affiliate_commission_events_immutable_update BEFORE UPDATE ON affiliate_commission_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TRIGGER affiliate_commission_events_immutable_delete BEFORE DELETE ON affiliate_commission_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TRIGGER affiliate_conversions_immutable_update BEFORE UPDATE ON affiliate_conversions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TRIGGER affiliate_conversions_immutable_delete BEFORE DELETE ON affiliate_conversions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TRIGGER affiliate_clicks_immutable_update BEFORE UPDATE ON affiliate_clicks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TRIGGER affiliate_clicks_immutable_delete BEFORE DELETE ON affiliate_clicks BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TRIGGER affiliate_money_events_immutable_update BEFORE UPDATE ON affiliate_money_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TRIGGER affiliate_money_events_immutable_delete BEFORE DELETE ON affiliate_money_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_MONEY_EVIDENCE'); END;
-- statement-breakpoint
CREATE TABLE affiliate_revenue_cursor (
  id TEXT PRIMARY KEY CHECK(id='revenue-v1'),
  last_sequence INTEGER NOT NULL DEFAULT 0,
  claim_key TEXT
);
-- statement-breakpoint
INSERT INTO affiliate_revenue_cursor(id) VALUES('revenue-v1');
-- statement-breakpoint
CREATE TABLE affiliate_revenue_snapshots (
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  scope TEXT NOT NULL CHECK(scope IN ('PROVIDER','MERCHANT','CAMPAIGN','PRODUCT')),
  scope_id TEXT NOT NULL,
  day TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('VND','USD','EUR')),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK(clicks>=0),
  conversions INTEGER NOT NULL DEFAULT 0 CHECK(conversions>=0),
  unknown_minor INTEGER NOT NULL DEFAULT 0 CHECK(unknown_minor BETWEEN 0 AND 9007199254740991),
  estimated_minor INTEGER NOT NULL DEFAULT 0 CHECK(estimated_minor BETWEEN 0 AND 9007199254740991),
  pending_minor INTEGER NOT NULL DEFAULT 0 CHECK(pending_minor BETWEEN 0 AND 9007199254740991),
  approved_minor INTEGER NOT NULL DEFAULT 0 CHECK(approved_minor BETWEEN 0 AND 9007199254740991),
  rejected_minor INTEGER NOT NULL DEFAULT 0 CHECK(rejected_minor BETWEEN 0 AND 9007199254740991),
  paid_minor INTEGER NOT NULL DEFAULT 0 CHECK(paid_minor BETWEEN 0 AND 9007199254740991),
  unknown_amounts INTEGER NOT NULL DEFAULT 0 CHECK(unknown_amounts>=0),
  last_sequence INTEGER NOT NULL,
  PRIMARY KEY(origin,scope,scope_id,day,currency)
);
