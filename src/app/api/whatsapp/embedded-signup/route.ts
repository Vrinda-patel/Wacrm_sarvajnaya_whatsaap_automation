import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import {
  exchangeOAuthCodeForToken,
  getCoexistencePhoneDetails,
  subscribeWabaToApp,
} from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  explainMetaError,
  metaErrorPayload,
  type MetaConnectStep,
} from '@/lib/whatsapp/meta-error-explain'

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Server-side handler for the Meta Embedded Signup OAuth flow (coexistence mode).
 *
 * Flow:
 *   1. Receive the short-lived authorization `code` and session data
 *      from the frontend (which gets them from the Meta JS SDK — the
 *      browser never sees the App Secret).
 *   2. Exchange the code for a long-lived access token (server-side only).
 *   3. Fetch phone-number details including `is_on_biz_app` and `platform_type`.
 *   4. Subscribe the WABA to this app's webhook (idempotent).
 *   5. DO NOT call POST /{phone_number_id}/register — in coexistence mode
 *      the number is already registered on the WhatsApp Business App;
 *      calling /register would disrupt it.
 *   6. Encrypt the access token with AES-256-GCM (ENCRYPTION_KEY) and
 *      upsert into `whatsapp_config`.
 *   7. Return only non-sensitive metadata to the client.
 *
 * Security:
 *   - META_APP_SECRET is never sent to the browser.
 *   - The raw access token is never logged or returned in the response.
 *   - The stored token is AES-256-GCM encrypted at rest.
 */

// ---- Admin client ----------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

// ---- Helpers --------------------------------------------------------------------

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

function metaFailure(err: unknown, step: MetaConnectStep) {
  const explained = explainMetaError(err, step, {})
  console.error(`[embedded-signup] Meta ${step} failed:`, explained.metaMessage, {
    code: explained.code,
    subcode: explained.subcode,
    fbtrace_id: explained.fbtraceId,
  })
  return NextResponse.json(
    { error: explained.summary, meta: metaErrorPayload(explained) },
    { status: explained.httpStatus },
  )
}

// ---- Route handler --------------------------------------------------------------

export async function POST(request: Request) {
  try {
    // ---- Authentication --------------------------------------------------------
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // ---- Parse body ------------------------------------------------------------
    let body: {
      code?: string
      phone_number_id?: string
      waba_id?: string
      business_id?: string
      /** The event type from the Meta SDK popup message. */
      event_type?: string
    }

    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { code, phone_number_id, waba_id, business_id, event_type } = body

    if (!code) {
      return NextResponse.json(
        { error: 'authorization code is required' },
        { status: 400 },
      )
    }
    if (!phone_number_id) {
      return NextResponse.json(
        { error: 'phone_number_id is required' },
        { status: 400 },
      )
    }
    if (!waba_id) {
      return NextResponse.json(
        { error: 'waba_id is required' },
        { status: 400 },
      )
    }

    // Determine onboarding mode from the Meta SDK event type.
    // FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING → coexistence path.
    // FINISH                                  → standard path (but still
    //                                           skip /register here because
    //                                           this endpoint is only reached
    //                                           via the coexistence button).
    const isCoexistence =
      event_type === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING'
    const onboarding_mode = isCoexistence
      ? 'embedded_signup_coexistence'
      : 'embedded_signup_standard'

    // ---- Step 1: Exchange code for access token --------------------------------
    let accessToken: string
    try {
      const result = await exchangeOAuthCodeForToken({ code })
      accessToken = result.accessToken
    } catch (err) {
      return metaFailure(err, 'verify_number') // closest existing step label
    }

    // ---- Step 2: Fetch phone details (including coexistence state) -------------
    let phoneInfo: Awaited<ReturnType<typeof getCoexistencePhoneDetails>>
    try {
      phoneInfo = await getCoexistencePhoneDetails({ phoneNumberId: phone_number_id, accessToken })
    } catch (err) {
      return metaFailure(err, 'verify_number')
    }

    // ---- Step 3: Subscribe WABA to this app (idempotent) -----------------------
    // We always do this regardless of coexistence vs standard — it ensures
    // Meta sends webhooks to our endpoint.
    let subscribedAppsAt: string | null = null
    try {
      await subscribeWabaToApp({ wabaId: waba_id, accessToken })
      subscribedAppsAt = new Date().toISOString()
    } catch (err) {
      return metaFailure(err, 'subscribe_waba')
    }

    // ---- Step 4: Encrypt the access token at rest ------------------------------
    let encryptedAccessToken: string
    try {
      encryptedAccessToken = encrypt(accessToken)
    } catch (encErr) {
      const msg = encErr instanceof Error ? encErr.message : 'Unknown encryption error'
      console.error('[embedded-signup] Encryption failed:', msg)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt access token. Verify ENCRYPTION_KEY is a valid 64-character hex string.',
        },
        { status: 500 },
      )
    }

    // ---- Step 5: Upsert whatsapp_config ----------------------------------------
    //
    // Coexistence: registered_at is set to NOW() because the number is already
    // registered on the WhatsApp Business App — we must NOT call /register.
    // Setting registered_at = NOW() tells the rest of the app that webhooks
    // should be live without a PIN registration step.
    const now = new Date().toISOString()
    const row = {
      phone_number_id,
      waba_id,
      business_id: business_id ?? null,
      access_token: encryptedAccessToken,
      status: 'connected',
      connected_at: now,
      // Mark as registered so the app doesn't show "Not registered" banner.
      registered_at: now,
      subscribed_apps_at: subscribedAppsAt,
      last_registration_error: null,
      // Coexistence fields from migration 043
      display_phone_number: phoneInfo.display_phone_number ?? null,
      onboarding_mode,
      onboarding_status: 'completed',
      is_on_biz_app: phoneInfo.is_on_biz_app ?? isCoexistence,
      platform_type: phoneInfo.platform_type ?? null,
      updated_at: now,
    }

    // Check whether a config row already exists for this account.
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('id, phone_number_id')
      .eq('account_id', accountId)
      .maybeSingle()

    // Guard: reject if another account has already claimed this phone_number_id.
    const { data: claimed } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance.',
        },
        { status: 409 },
      )
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(row)
        .eq('account_id', accountId)

      if (updateError) {
        console.error('[embedded-signup] Error updating whatsapp_config:', updateError)
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: user.id, ...row })

      if (insertError) {
        console.error('[embedded-signup] Error inserting whatsapp_config:', insertError)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    // ---- Return only non-sensitive metadata ------------------------------------
    return NextResponse.json({
      success: true,
      onboarding_mode,
      is_on_biz_app: phoneInfo.is_on_biz_app ?? isCoexistence,
      platform_type: phoneInfo.platform_type ?? null,
      display_phone_number: phoneInfo.display_phone_number,
      waba_id,
      phone_number_id,
      // Never include: access_token, META_APP_SECRET, ENCRYPTION_KEY
    })
  } catch (error) {
    console.error('[embedded-signup] Unhandled error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
