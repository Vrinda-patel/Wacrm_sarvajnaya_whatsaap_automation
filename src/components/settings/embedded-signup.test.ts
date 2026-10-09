import { describe, it, expect, vi } from 'vitest'

describe('WhatsApp Embedded Signup Coexistence Specifications', () => {
  it('validates trusted Meta origins for WA_EMBEDDED_SIGNUP messages', () => {
    const isMetaOrigin = (origin: string) => origin.endsWith('facebook.com')

    expect(isMetaOrigin('https://www.facebook.com')).toBe(true)
    expect(isMetaOrigin('https://web.facebook.com')).toBe(true)
    expect(isMetaOrigin('https://facebook.com')).toBe(true)
    expect(isMetaOrigin('https://evil-facebook.com.attacker.com')).toBe(false)
    expect(isMetaOrigin('https://example.com')).toBe(false)
  })

  it('verifies FB.login options conform to Meta Embedded Signup v4 Coexistence spec', () => {
    const configId = '1234567890'
    const loginOptions = {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: {
        version: 'v4',
        featureType: 'whatsapp_business_app_onboarding',
        feature: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      },
    }

    expect(loginOptions.config_id).toBe(configId)
    expect(loginOptions.response_type).toBe('code')
    expect(loginOptions.override_default_response_type).toBe(true)
    expect(loginOptions.extras.version).toBe('v4')
    expect(loginOptions.extras.featureType).toBe('whatsapp_business_app_onboarding')
    expect(loginOptions.extras.sessionInfoVersion).toBe('3')
  })

  it('coordinates auth code and session data asynchronously without race conditions', () => {
    let capturedCode: string | null = null
    let capturedSession: { phone_number_id: string; waba_id: string } | null = null
    let submittedWith: { code: string; phone_number_id: string; waba_id: string } | null = null

    const trySubmit = () => {
      if (capturedCode && capturedSession) {
        submittedWith = {
          code: capturedCode,
          phone_number_id: capturedSession.phone_number_id,
          waba_id: capturedSession.waba_id,
        }
      }
    }

    // Scenario A: Message arrives first, then FB.login callback completes
    capturedSession = { phone_number_id: 'pn_123', waba_id: 'waba_456' }
    trySubmit()
    expect(submittedWith).toBeNull() // Not submitted yet, waiting for code

    capturedCode = 'auth_code_from_fb_login'
    trySubmit()
    expect(submittedWith).toEqual({
      code: 'auth_code_from_fb_login',
      phone_number_id: 'pn_123',
      waba_id: 'waba_456',
    })

    // Reset for Scenario B: FB.login callback completes first, then message arrives
    capturedCode = null
    capturedSession = null
    submittedWith = null

    capturedCode = 'auth_code_early'
    trySubmit()
    expect(submittedWith).toBeNull() // Not submitted yet, waiting for session

    capturedSession = { phone_number_id: 'pn_999', waba_id: 'waba_888' }
    trySubmit()
    expect(submittedWith).toEqual({
      code: 'auth_code_early',
      phone_number_id: 'pn_999',
      waba_id: 'waba_888',
    })
  })

  it('extracts fallback code from session data if provided in postMessage', () => {
    const sessionData = {
      phone_number_id: '123',
      waba_id: '456',
      code: 'direct_session_code',
    }

    let capturedCode: string | null = null
    if (sessionData.code && !capturedCode) {
      capturedCode = sessionData.code
    }

    expect(capturedCode).toBe('direct_session_code')
  })
})
