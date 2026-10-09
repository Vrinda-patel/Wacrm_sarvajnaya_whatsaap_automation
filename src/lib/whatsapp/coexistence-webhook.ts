/**
 * Coexistence webhook event handlers.
 *
 * When a WhatsApp number runs in coexistence mode (Cloud API +
 * WhatsApp Business App), Meta delivers additional webhook fields
 * alongside the standard `messages` / `statuses` fields:
 *
 *   smb_message_echoes  – outbound messages sent from the mobile WA Business App
 *   smb_app_state_sync  – state sync between the mobile app and Cloud API
 *   account_update      – phone-number or WABA status changes
 *   history             – historical message sync on first connection
 *
 * All handlers are idempotent — duplicate deliveries (Meta retries
 * on a slow ack) are silently ignored. None of them touch the
 * existing `messages`, `statuses`, or `conversations` flow — they
 * are strictly additive.
 *
 * Imported and called from /api/whatsapp/webhook/route.ts inside
 * the processWebhook loop, after the existing template-lifecycle
 * and message-status branches.
 */

import { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Type definitions — Meta coexistence event shapes
// ============================================================

/**
 * A single echo of a message sent from the WhatsApp Business App
 * on the operator's mobile device.
 */
export interface SmbMessageEcho {
  /** Meta message id (wamid). */
  id: string
  /** Unix timestamp string. */
  timestamp: string
  /** Recipient phone number (the customer). */
  to: string
  /** Message type: text, image, document, audio, video, etc. */
  type: string
  text?: { body: string }
  image?: { id: string; mime_type: string; caption?: string }
  video?: { id: string; mime_type: string; caption?: string }
  document?: { id: string; mime_type: string; filename?: string; caption?: string }
  audio?: { id: string; mime_type: string }
  /** Present when the agent replied to a specific customer message. */
  context?: { id: string }
}

/** Meta `account_update` change value. */
export interface AccountUpdateValue {
  phone_number?: string
  event?: string
  reason?: string
  /** e.g. "FLAGGED", "BANNED", "RESTORED" */
  restriction_info?: unknown[]
}

/** Meta `smb_app_state_sync` change value. */
export interface SmbAppStateSyncValue {
  phone_number_id?: string
  state?: string
}

// ============================================================
// smb_message_echoes — outbound messages from the mobile app
// ============================================================

/**
 * Persist echoed outbound messages sent from the WhatsApp Business App.
 *
 * These are messages the operator typed on their phone — not through
 * the CRM.  We record them in the `messages` table so the CRM inbox
 * shows a complete two-sided conversation history.
 *
 * Idempotent: uses the same (conversation_id, message_id) unique index
 * that guards inbound messages (migration 037) — a duplicate echo lands
 * as ON CONFLICT DO NOTHING and is logged + skipped.
 */
export async function handleSmbMessageEchoes(
  echoes: SmbMessageEcho[],
  phoneNumberId: string,
  supabase: SupabaseClient,
): Promise<void> {
  for (const echo of echoes) {
    try {
      // Find the config row — needed for account_id to look up the
      // conversation for this outbound recipient.
      const { data: configRow } = await supabase
        .from('whatsapp_config')
        .select('account_id, user_id')
        .eq('phone_number_id', phoneNumberId)
        .maybeSingle()

      if (!configRow) {
        console.warn(
          `[coexistence] smb_message_echo: no config for phone_number_id ${phoneNumberId} — skipping`,
        )
        continue
      }

      const { account_id: accountId, user_id: configUserId } = configRow

      // Normalise the recipient phone number so we can look up the contact.
      const recipientPhone = echo.to?.replace(/\D/g, '') ?? null
      if (!recipientPhone) {
        console.warn('[coexistence] smb_message_echo: echo has no `to` field — skipping', echo.id)
        continue
      }

      // Find the contact by phone number, scoped to this account.
      const { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone', recipientPhone)
        .maybeSingle()

      if (!contact) {
        // Contact doesn't exist yet — we skip rather than auto-create so
        // we don't pollute the contacts list with every echo from the
        // mobile app.  The contact will be created on their next inbound.
        console.info(
          `[coexistence] smb_message_echo: contact not found for ${recipientPhone} — skipping`,
        )
        continue
      }

      // Find or skip the conversation.
      const { data: conversation } = await supabase
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .maybeSingle()

      if (!conversation) {
        // No conversation yet — skip; the contact hasn't written to us yet.
        continue
      }

      // Map the echo type to an allowed content_type value.
      const ALLOWED = new Set([
        'text', 'image', 'document', 'audio', 'video',
        'location', 'template', 'interactive',
      ])
      const contentType = ALLOWED.has(echo.type)
        ? echo.type
        : echo.type === 'sticker'
          ? 'image'
          : 'text'

      const contentText =
        echo.text?.body ??
        echo.image?.caption ??
        echo.video?.caption ??
        echo.document?.caption ??
        null

      // Idempotent insert — (conversation_id, message_id) unique index (migration 037).
      const { data: inserted, error: insertErr } = await supabase
        .from('messages')
        .upsert(
          {
            conversation_id: conversation.id,
            // 'agent' because the sender is a human staff member on their phone.
            sender_type: 'agent',
            // Record which user "sent" this so FK constraints are satisfied.
            // We use config_user_id as the closest proxy — the mobile app
            // echo doesn't carry a user identity.
            user_id: configUserId,
            content_type: contentType,
            content_text: contentText,
            message_id: echo.id,
            status: 'sent',
            created_at: new Date(parseInt(echo.timestamp) * 1000).toISOString(),
          },
          { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
        )
        .select('id')

      if (insertErr) {
        console.error('[coexistence] smb_message_echo insert failed:', insertErr.message)
        continue
      }

      if (!inserted || inserted.length === 0) {
        // Duplicate — already stored from a previous delivery.
        console.info('[coexistence] smb_message_echo duplicate ignored:', echo.id)
        continue
      }

      console.info('[coexistence] smb_message_echo stored:', echo.id)
    } catch (err) {
      // Best-effort — never throw so the outer webhook loop keeps processing.
      console.error('[coexistence] smb_message_echo unhandled error:', err)
    }
  }
}

// ============================================================
// smb_app_state_sync
// ============================================================

/**
 * Log state sync events from the WhatsApp Business App.
 *
 * These inform the Cloud API when the mobile app goes online/offline
 * or re-syncs.  Currently we only log them; no DB writes are needed.
 * Future: could update a `last_smb_sync_at` column.
 */
export function handleSmbAppStateSync(value: SmbAppStateSyncValue): void {
  console.info(
    `[coexistence] smb_app_state_sync phone_number_id=${value.phone_number_id ?? 'unknown'} state=${value.state ?? 'unknown'}`,
  )
}

// ============================================================
// account_update
// ============================================================

/**
 * Handle account-level status updates (FLAGGED, BANNED, RESTORED, etc.).
 *
 * Logs the event and — when the update contains a known restriction event —
 * writes a warning to the `whatsapp_config` row so the Settings UI can
 * surface it.  Non-destructive: never overwrites the status that Embedded
 * Signup set.
 */
export async function handleAccountUpdate(
  value: AccountUpdateValue,
  supabase: SupabaseClient,
): Promise<void> {
  const { phone_number: phoneNum, event, reason } = value
  console.info(`[coexistence] account_update event=${event ?? 'unknown'} reason=${reason ?? 'none'}`)

  // Known events that should surface an actionable warning in the UI.
  const warningEvents = ['FLAGGED', 'BANNED', 'ACCOUNT_UPDATE']
  if (event && warningEvents.includes(event.toUpperCase()) && phoneNum) {
    // Normalise the phone number to match what we store.
    const normalised = phoneNum.replace(/\D/g, '')
    const { error } = await supabase
      .from('whatsapp_config')
      .update({
        last_registration_error: `Meta account_update: ${event}${reason ? ` — ${reason}` : ''}`,
        updated_at: new Date().toISOString(),
      })
      .eq('phone_number_id', normalised)

    if (error) {
      console.error('[coexistence] account_update DB write failed:', error.message)
    }
  }
}

// ============================================================
// history
// ============================================================

/**
 * Log history-sync notifications.
 *
 * Meta sends these when the first historical batch of messages has been
 * transferred.  We don't currently re-import historical messages; just log
 * the event so operators can verify coexistence completed its initial sync.
 */
export function handleHistory(value: unknown): void {
  console.info('[coexistence] history sync notification received', JSON.stringify(value))
}

// ============================================================
// Field routing helper
// ============================================================

/** change.field values that belong to the coexistence handlers above. */
export const COEXISTENCE_FIELDS = new Set([
  'smb_message_echoes',
  'smb_app_state_sync',
  'account_update',
  'history',
])

export function isCoexistenceField(field: string): boolean {
  return COEXISTENCE_FIELDS.has(field)
}
