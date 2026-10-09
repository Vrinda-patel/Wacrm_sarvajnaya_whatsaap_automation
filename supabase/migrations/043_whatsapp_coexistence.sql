-- ============================================================
-- Migration 043: WhatsApp Business App Coexistence
-- ============================================================
--
-- Adds fields to whatsapp_config to track numbers onboarded via
-- Meta Embedded Signup in coexistence mode (i.e. the number stays
-- on the WhatsApp Business App on the phone AND is connected to
-- Cloud API simultaneously).
--
-- NO existing columns are dropped or altered.  The new columns are
-- purely additive so the existing manual-config flow and all
-- downstream code continue to work unchanged.
--
-- New fields align exactly with what Meta's Coexistence API returns:
--   business_id           – Meta Business Portfolio ID
--   display_phone_number  – human-readable E.164 number
--   onboarding_mode       – how the row was created
--   onboarding_status     – overall lifecycle state
--   is_on_biz_app         – true when Meta confirms coexistence is active
--   platform_type         – Meta's platform classification for the number
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS business_id          TEXT,
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT,
  ADD COLUMN IF NOT EXISTS onboarding_mode      TEXT
    NOT NULL DEFAULT 'manual'
    CHECK (onboarding_mode IN (
      'manual',
      'embedded_signup_coexistence',
      'embedded_signup_standard'
    )),
  ADD COLUMN IF NOT EXISTS onboarding_status    TEXT
    NOT NULL DEFAULT 'pending'
    CHECK (onboarding_status IN (
      'pending',
      'completed',
      'failed',
      'cancelled'
    )),
  ADD COLUMN IF NOT EXISTS is_on_biz_app        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS platform_type        TEXT;

-- Backfill existing rows: they were set up manually and are now in
-- the "completed" manual onboarding state.
UPDATE whatsapp_config
  SET onboarding_status = 'completed'
  WHERE onboarding_status = 'pending'
    AND access_token IS NOT NULL
    AND access_token <> '';

COMMENT ON COLUMN whatsapp_config.business_id IS
  'Meta Business Portfolio ID returned by the Embedded Signup flow.';

COMMENT ON COLUMN whatsapp_config.display_phone_number IS
  'Human-readable E.164 number (e.g. +91 98765 43210) fetched from Meta after onboarding.';

COMMENT ON COLUMN whatsapp_config.onboarding_mode IS
  'How this config row was created: manual (form paste), embedded_signup_coexistence (Meta Embedded Signup + coexistence), or embedded_signup_standard.';

COMMENT ON COLUMN whatsapp_config.onboarding_status IS
  'Lifecycle state of the onboarding flow: pending | completed | failed | cancelled.';

COMMENT ON COLUMN whatsapp_config.is_on_biz_app IS
  'True when Meta confirmed this number is running in coexistence mode (Cloud API + WhatsApp Business App simultaneously).';

COMMENT ON COLUMN whatsapp_config.platform_type IS
  'Meta platform classification for this phone number (e.g. CLOUD_API, SMB). Populated after Embedded Signup.';
