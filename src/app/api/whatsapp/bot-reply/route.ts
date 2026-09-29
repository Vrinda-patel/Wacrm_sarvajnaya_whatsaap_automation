import { NextResponse } from 'next/server'
import { engineSendText } from '@/lib/automations/meta-send'

export async function POST(request: Request) {
  // Read the secret inside the handler so the current env value is always used
  const expected = (process.env.BOT_REPLY_SECRET ?? '').trim()
  const header = request.headers.get('authorization') ?? ''
  const provided = header.replace(/^Bearer\s+/i, '').trim()

  if (!expected || provided !== expected) {
    // TEMPORARY debug info, remove once it works. Never includes the secret itself.
    const reason = !expected
      ? 'server_secret_not_set'
      : !header
        ? 'no_authorization_header'
        : 'secret_mismatch'
    return NextResponse.json(
      {
        error: 'Unauthorized',
        reason,
        expected_length: expected.length,
        provided_length: provided.length,
      },
      { status: 401 }
    )
  }

  try {
    const body = await request.json()
    const { account_id, user_id, conversation_id, contact_id, text } = body

    if (!account_id || !user_id || !conversation_id || !contact_id || !text) {
      return NextResponse.json(
        { error: 'account_id, user_id, conversation_id, contact_id, and text are required' },
        { status: 400 }
      )
    }

    const result = await engineSendText({
      accountId: account_id,
      userId: user_id,
      conversationId: conversation_id,
      contactId: contact_id,
      text,
    })

    return NextResponse.json({ success: true, whatsapp_message_id: result.whatsapp_message_id })
  } catch (error) {
    console.error('[bot-reply] failed:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    )
  }
}