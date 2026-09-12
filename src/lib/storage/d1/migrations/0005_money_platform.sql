ALTER TABLE affiliate_clicks ADD COLUMN platform TEXT NOT NULL DEFAULT 'unknown'
  CHECK(platform IN ('shopee','tiktok_shop','lazada','website','other','unknown') AND (platform<>'shopee' OR provider='accesstrade'));
-- statement-breakpoint
ALTER TABLE affiliate_money_events ADD COLUMN platform TEXT NOT NULL DEFAULT 'unknown'
  CHECK(platform IN ('shopee','tiktok_shop','lazada','website','other','unknown') AND (platform<>'shopee' OR provider='accesstrade'));
-- statement-breakpoint
DROP TRIGGER affiliate_click_event;
-- statement-breakpoint
CREATE TRIGGER affiliate_click_event AFTER INSERT ON affiliate_clicks BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,platform,merchant_id,campaign_id,day,currency,clicks,origin)
    VALUES('click:'||NEW.id,NEW.product_id,NEW.provider,NEW.platform,NEW.merchant_id,NEW.campaign_id,substr(NEW.created_at,1,10),NEW.currency,1,NEW.origin);
END;
-- statement-breakpoint
DROP TRIGGER affiliate_conversion_event;
-- statement-breakpoint
CREATE TRIGGER affiliate_conversion_event AFTER INSERT ON affiliate_conversions BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,platform,merchant_id,campaign_id,day,currency,conversions,origin)
    SELECT 'conversion:'||NEW.provider||':'||NEW.external_id,product_id,provider,platform,merchant_id,campaign_id,substr(NEW.occurred_at,1,10),currency,1,NEW.origin
    FROM affiliate_clicks WHERE id=NEW.click_id;
END;
-- statement-breakpoint
DROP TRIGGER affiliate_commission_first;
-- statement-breakpoint
CREATE TRIGGER affiliate_commission_first AFTER INSERT ON affiliate_commissions BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,platform,merchant_id,campaign_id,day,currency,commission_state,amount_minor,unknown_amounts,origin)
    SELECT 'commission:'||NEW.provider||':'||NEW.external_id||':'||NEW.revision||':new',click.product_id,NEW.provider,click.platform,click.merchant_id,click.campaign_id,
      substr(conversion.occurred_at,1,10),NEW.currency,NEW.state,coalesce(NEW.amount_minor,0),NEW.amount_minor IS NULL,click.origin
    FROM affiliate_conversions conversion JOIN affiliate_clicks click ON click.id=conversion.click_id
    WHERE conversion.provider=NEW.provider AND conversion.external_id=NEW.conversion_id;
END;
-- statement-breakpoint
DROP TRIGGER affiliate_commission_change;
-- statement-breakpoint
CREATE TRIGGER affiliate_commission_change AFTER UPDATE ON affiliate_commissions BEGIN
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,platform,merchant_id,campaign_id,day,currency,commission_state,amount_minor,unknown_amounts,origin)
    SELECT 'commission:'||NEW.provider||':'||NEW.external_id||':'||NEW.revision||':old',click.product_id,NEW.provider,click.platform,click.merchant_id,click.campaign_id,
      substr(conversion.occurred_at,1,10),OLD.currency,OLD.state,-coalesce(OLD.amount_minor,0),-(OLD.amount_minor IS NULL),click.origin
    FROM affiliate_conversions conversion JOIN affiliate_clicks click ON click.id=conversion.click_id
    WHERE conversion.provider=NEW.provider AND conversion.external_id=NEW.conversion_id;
  INSERT INTO affiliate_money_events(effect_key,product_id,provider,platform,merchant_id,campaign_id,day,currency,commission_state,amount_minor,unknown_amounts,origin)
    SELECT 'commission:'||NEW.provider||':'||NEW.external_id||':'||NEW.revision||':new',click.product_id,NEW.provider,click.platform,click.merchant_id,click.campaign_id,
      substr(conversion.occurred_at,1,10),NEW.currency,NEW.state,coalesce(NEW.amount_minor,0),NEW.amount_minor IS NULL,click.origin
    FROM affiliate_conversions conversion JOIN affiliate_clicks click ON click.id=conversion.click_id
    WHERE conversion.provider=NEW.provider AND conversion.external_id=NEW.conversion_id;
END;
-- statement-breakpoint
ALTER TABLE affiliate_revenue_snapshots RENAME TO affiliate_revenue_snapshots_previous;
-- statement-breakpoint
CREATE TABLE affiliate_revenue_snapshots (
  origin TEXT NOT NULL CHECK(origin IN ('AUTHENTICATED_PROVIDER_API','TEST_FIXTURE')),
  scope TEXT NOT NULL CHECK(scope IN ('PROVIDER','PLATFORM','MERCHANT','CAMPAIGN','PRODUCT')),
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
-- statement-breakpoint
INSERT INTO affiliate_revenue_snapshots SELECT * FROM affiliate_revenue_snapshots_previous;
-- statement-breakpoint
DROP TABLE affiliate_revenue_snapshots_previous;
