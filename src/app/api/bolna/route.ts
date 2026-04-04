import { NextRequest, NextResponse } from 'next/server'

// Bolna AI call trigger endpoint — called from CRM UI to initiate outbound calls
export async function POST(req: NextRequest) {
  try {
    const { agentId, apiKey, phoneNumber } = await req.json()

    if (!agentId || !apiKey || !phoneNumber) {
      return NextResponse.json({ error: 'Missing agentId, apiKey, or phoneNumber' }, { status: 400 })
    }

    const cleanPhone = phoneNumber.replace(/\D/g, '').slice(-10)

    // Get the webhook URL for this deployment
    const host = req.headers.get('host') || 'localhost:3000'
    const protocol = host.includes('localhost') ? 'http' : 'https'
    const webhookUrl = `${protocol}://${host}/api/webhooks/bolna`

    const response = await fetch('https://api.bolna.dev/call', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        agent_id: agentId,
        recipient_phone_number: `+91${cleanPhone}`,
        webhook_url: webhookUrl,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return NextResponse.json({ error: `Bolna API error: ${err}` }, { status: response.status })
    }

    const data = await response.json()
    return NextResponse.json({ success: true, callId: data.call_id || data.id })
  } catch (error) {
    console.error('Bolna call trigger error:', error)
    return NextResponse.json({ error: String(error) }, { status: 500 })
  }
}
