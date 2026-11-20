-- Siteverify redemption is eventually consistent. Enforce single use within
-- this application in the same transaction as the receipt and its audit event.
-- Never persist the token itself, the submitter's IP, or form content here.
CREATE TABLE intake_token_redemptions (
  token_hash TEXT PRIMARY KEY NOT NULL
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  consumed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > consumed_at)
) STRICT;
CREATE INDEX idx_intake_token_expiry ON intake_token_redemptions(expires_at);
CREATE INDEX idx_inquiries_type ON inquiries(inquiry_type, created_at DESC);
