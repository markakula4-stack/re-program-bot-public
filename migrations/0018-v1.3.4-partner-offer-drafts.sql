-- RE Program Bot v1.3.4 — Partner Beta offer drafts.
-- Additive and idempotent. The canonical URL remains in partner_links;
-- this table only records which approved link a partner selected for an offer.

CREATE TABLE IF NOT EXISTS partner_offer_links (
  offer_code TEXT PRIMARY KEY,
  partner_link_id INTEGER NOT NULL,
  selected_by INTEGER NOT NULL,
  selected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_partner_offer_links_link
  ON partner_offer_links(partner_link_id, updated_at DESC);

-- A legacy v1.3.3 snapshot may receive its first SHA-256 during runtime
-- reconciliation. Once a hash exists, the snapshot is append-only.
CREATE TRIGGER IF NOT EXISTS trg_offer_versions_immutable_update
BEFORE UPDATE ON offer_versions
WHEN OLD.content_hash <> ''
BEGIN
  SELECT RAISE(ABORT, 'offer_versions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_offer_versions_immutable_delete
BEFORE DELETE ON offer_versions
WHEN EXISTS (
  SELECT 1
  FROM offer_owners
  WHERE offer_code = OLD.offer_code AND owner_kind = 'partner'
)
BEGIN
  SELECT RAISE(ABORT, 'offer_versions are immutable');
END;

INSERT OR IGNORE INTO re_schema_migrations (version)
VALUES ('1.3.4-partner-offer-drafts');
