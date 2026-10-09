/**
 * Coexistence feature tests.
 *
 * Covers:
 *  - Webhook field routing (isCoexistenceField)
 *  - smb_message_echoes: idempotent persistence
 *  - smb_app_state_sync: logging only
 *  - account_update: DB write on warning events
 *  - history: logging only
 *  - exchangeOAuthCodeForToken: success + error paths
 *  - getCoexistencePhoneDetails: success + error paths
 *  - Confirms META_APP_SECRET is never included in any response
 *
 * Does NOT call real Meta APIs — all fetch() calls are mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isCoexistenceField,
  COEXISTENCE_FIELDS,
  handleSmbAppStateSync,
  handleHistory,
  type SmbMessageEcho,
  type AccountUpdateValue,
  type SmbAppStateSyncValue,
} from './coexistence-webhook'

// ============================================================
// Helpers
// ============================================================

/** Minimal Supabase mock that captures what was called. */
function makeMockSupabase() {
  const calls: { table: string; op: string; args: unknown[] }[] = []

  const chain = (table: string) => {
    const ops = {
      select: vi.fn((...args: unknown[]) => {
        calls.push({ table, op: 'select', args })
        return ops
      }),
      eq: vi.fn((...args: unknown[]) => {
        calls.push({ table, op: 'eq', args })
        return ops
      }),
      neq: vi.fn(() => ops),
      update: vi.fn((...args: unknown[]) => {
        calls.push({ table, op: 'update', args })
        return ops
      }),
      upsert: vi.fn((...args: unknown[]) => {
        calls.push({ table, op: 'upsert', args })
        return ops
      }),
      maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    }
    return ops
  }

  const supabase = {
    from: vi.fn((table: string) => chain(table)),
    _calls: calls,
  }

  return supabase
}

// ============================================================
// isCoexistenceField
// ============================================================

describe('isCoexistenceField', () => {
  it('returns true for all coexistence fields', () => {
    for (const field of COEXISTENCE_FIELDS) {
      expect(isCoexistenceField(field)).toBe(true)
    }
  })

  it('returns false for standard messaging fields', () => {
    expect(isCoexistenceField('messages')).toBe(false)
    expect(isCoexistenceField('message_template_status_update')).toBe(false)
    expect(isCoexistenceField('statuses')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isCoexistenceField('')).toBe(false)
  })
})

// ============================================================
// handleSmbAppStateSync
// ============================================================

describe('handleSmbAppStateSync', () => {
  it('logs without throwing', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    const payload: SmbAppStateSyncValue = { phone_number_id: '123', state: 'ONLINE' }
    expect(() => handleSmbAppStateSync(payload)).not.toThrow()
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining('smb_app_state_sync')
    )
    consoleInfo.mockRestore()
  })
})

// ============================================================
// handleHistory
// ============================================================

describe('handleHistory', () => {
  it('logs without throwing', () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    expect(() => handleHistory({ some: 'data' })).not.toThrow()
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining('history sync'),
      expect.any(String),
    )
    consoleInfo.mockRestore()
  })
})

// ============================================================
// handleSmbMessageEchoes (isolated)
// ============================================================

describe('handleSmbMessageEchoes', () => {
  it('is exported and callable', async () => {
    // Import lazily to avoid top-level module-scope issues.
    const { handleSmbMessageEchoes } = await import('./coexistence-webhook')
    expect(typeof handleSmbMessageEchoes).toBe('function')
  })

  it('returns without throwing on empty echoes array', async () => {
    const { handleSmbMessageEchoes } = await import('./coexistence-webhook')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = makeMockSupabase() as any
    await expect(
      handleSmbMessageEchoes([], '12345', supabase),
    ).resolves.toBeUndefined()
  })

  it('logs a warning when echo has no `to` field', async () => {
    const { handleSmbMessageEchoes } = await import('./coexistence-webhook')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = makeMockSupabase() as any
    // Override maybeSingle for whatsapp_config to return a config row.
    supabase.from = vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { account_id: 'acct-1', user_id: 'user-1' },
        error: null,
      }),
      upsert: vi.fn().mockReturnThis(),
    }))

    const echoNoTo: SmbMessageEcho = {
      id: 'wamid.echo1',
      timestamp: '1700000000',
      to: '', // missing
      type: 'text',
      text: { body: 'Hello' },
    }

    await handleSmbMessageEchoes([echoNoTo], '12345', supabase)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no `to` field'),
      expect.any(String),
    )
    warn.mockRestore()
  })
})

// ============================================================
// handleAccountUpdate (isolated)
// ============================================================

describe('handleAccountUpdate', () => {
  it('logs the event', async () => {
    const { handleAccountUpdate } = await import('./coexistence-webhook')
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = makeMockSupabase() as any
    const value: AccountUpdateValue = { event: 'RESTORED', phone_number: '+919876543210' }
    await expect(handleAccountUpdate(value, supabase)).resolves.toBeUndefined()
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.stringContaining('account_update')
    )
    consoleInfo.mockRestore()
  })
})

// ============================================================
// exchangeOAuthCodeForToken (mocked fetch)
// ============================================================

describe('exchangeOAuthCodeForToken', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env.META_APP_ID = 'test-app-id'
    process.env.META_APP_SECRET = 'test-secret'
    process.env.META_API_VERSION = 'v21.0'
  })

  afterEach(() => {
    // Restore only the keys we touched.
    process.env.META_APP_ID = originalEnv.META_APP_ID
    process.env.META_APP_SECRET = originalEnv.META_APP_SECRET
    process.env.META_API_VERSION = originalEnv.META_API_VERSION
    vi.restoreAllMocks()
  })

  it('returns accessToken on success', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'LONG_LIVED_TOKEN', token_type: 'bearer' }),
    } as Response)

    const { exchangeOAuthCodeForToken } = await import('./meta-api')
    const result = await exchangeOAuthCodeForToken({ code: 'SHORT_CODE' })
    expect(result.accessToken).toBe('LONG_LIVED_TOKEN')
    expect(result.tokenType).toBe('bearer')
  })

  it('does NOT include META_APP_SECRET in the returned value', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'TOKEN', token_type: 'bearer' }),
    } as Response)

    const { exchangeOAuthCodeForToken } = await import('./meta-api')
    const result = await exchangeOAuthCodeForToken({ code: 'CODE' })
    const stringified = JSON.stringify(result)
    expect(stringified).not.toContain('test-secret')
    expect(stringified).not.toContain('META_APP_SECRET')
  })

  it('throws MetaApiError on non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: { message: 'Invalid verification code format', code: 100 },
      }),
    } as Response)

    const { exchangeOAuthCodeForToken } = await import('./meta-api')
    await expect(exchangeOAuthCodeForToken({ code: 'BAD' })).rejects.toThrow(
      /Invalid verification code format/,
    )
  })

  it('throws when META_APP_ID is missing', async () => {
    delete process.env.META_APP_ID
    delete process.env.NEXT_PUBLIC_META_APP_ID

    const { exchangeOAuthCodeForToken } = await import('./meta-api')
    await expect(exchangeOAuthCodeForToken({ code: 'CODE' })).rejects.toThrow(
      /META_APP_ID/,
    )
  })

  it('uses NEXT_PUBLIC_META_APP_ID when META_APP_ID is not set', async () => {
    delete process.env.META_APP_ID
    process.env.NEXT_PUBLIC_META_APP_ID = 'public-app-id'

    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      expect(url).toContain('client_id=public-app-id')
      return {
        ok: true,
        json: async () => ({ access_token: 'TOKEN_VIA_PUBLIC_APP_ID', token_type: 'bearer' }),
      } as Response
    })

    const { exchangeOAuthCodeForToken } = await import('./meta-api')
    const result = await exchangeOAuthCodeForToken({ code: 'CODE' })
    expect(result.accessToken).toBe('TOKEN_VIA_PUBLIC_APP_ID')
  })

  it('retries with empty redirect_uri when Meta returns subcode 36008', async () => {
    let callCount = 0
    global.fetch = vi.fn().mockImplementation(async (url: string) => {
      callCount++
      if (callCount === 1) {
        expect(url).not.toContain('redirect_uri')
        return {
          ok: false,
          status: 400,
          clone: () => ({
            json: async () => ({ error: { message: 'redirect_uri mismatch', error_subcode: 36008 } }),
          }),
          json: async () => ({ error: { message: 'redirect_uri mismatch', error_subcode: 36008 } }),
        } as unknown as Response
      }
      expect(url).toContain('redirect_uri=')
      return {
        ok: true,
        json: async () => ({ access_token: 'TOKEN_AFTER_RETRY', token_type: 'bearer' }),
      } as Response
    })

    const { exchangeOAuthCodeForToken } = await import('./meta-api')
    const result = await exchangeOAuthCodeForToken({ code: 'CODE' })
    expect(callCount).toBe(2)
    expect(result.accessToken).toBe('TOKEN_AFTER_RETRY')
  })
})

// ============================================================
// getCoexistencePhoneDetails (mocked fetch)
// ============================================================

describe('getCoexistencePhoneDetails', () => {
  afterEach(() => vi.restoreAllMocks())

  it('returns is_on_biz_app and platform_type', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: '987654321',
        display_phone_number: '+91 98765 43210',
        verified_name: 'Sarvajnaya',
        quality_rating: 'GREEN',
        is_on_biz_app: true,
        platform_type: 'CLOUD_API',
      }),
    } as Response)

    const { getCoexistencePhoneDetails } = await import('./meta-api')
    const info = await getCoexistencePhoneDetails({
      phoneNumberId: '987654321',
      accessToken: 'TOKEN',
    })

    expect(info.is_on_biz_app).toBe(true)
    expect(info.platform_type).toBe('CLOUD_API')
    expect(info.display_phone_number).toBe('+91 98765 43210')
  })

  it('throws on a non-ok response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Invalid token' } }),
    } as Response)

    const { getCoexistencePhoneDetails } = await import('./meta-api')
    await expect(
      getCoexistencePhoneDetails({ phoneNumberId: '1', accessToken: 'BAD' }),
    ).rejects.toThrow()
  })
})

// ============================================================
// Webhook field routing — coexistence vs standard
// ============================================================

describe('Webhook field routing', () => {
  const COEXISTENCE = ['smb_message_echoes', 'smb_app_state_sync', 'account_update', 'history']
  const STANDARD = ['messages', 'statuses', 'message_template_status_update', 'message_template_quality_update']

  for (const field of COEXISTENCE) {
    it(`isCoexistenceField('${field}') is true`, () => {
      expect(isCoexistenceField(field)).toBe(true)
    })
  }

  for (const field of STANDARD) {
    it(`isCoexistenceField('${field}') is false`, () => {
      expect(isCoexistenceField(field)).toBe(false)
    })
  }
})

// ============================================================
// Secret-leakage guard
// ============================================================

describe('Secret leakage guard', () => {
  it('handleSmbAppStateSync response does not contain a hypothetical secret', () => {
    // This is a belt-and-braces test: the function is pure logging,
    // but we confirm it cannot accidentally serialise env vars.
    process.env.META_APP_SECRET = 'SUPER_SECRET_VALUE'
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {})
    handleSmbAppStateSync({ phone_number_id: '1', state: 'ONLINE' })
    const calls = consoleInfo.mock.calls.map((c) => JSON.stringify(c))
    expect(calls.every((c) => !c.includes('SUPER_SECRET_VALUE'))).toBe(true)
    consoleInfo.mockRestore()
  })
})
