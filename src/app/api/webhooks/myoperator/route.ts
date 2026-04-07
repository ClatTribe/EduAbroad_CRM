import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// MyOperator IVR Webhook — auto-creates leads from inbound/missed calls
// MyOperator sends POST to this URL when a call is received/missed/completed
// Configure in MyOperator dashboard → Integrations → Webhooks

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(async () => {
      // MyOperator sometimes sends form-encoded data
      const text = await req.text()
      const params = new URLSearchParams(text)
      const obj: Record<string, string> = {}
      params.forEach((v, k) => { obj[k] = v })
      return obj
    })

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceKey)

    // MyOperator webhook fields (varies by event type)
    // Supported: call_initiated, call_answered, call_completed, call_missed, voicemail
    const eventType = body.event || body.event_type || body.call_status || 'call'
    const callerPhone = body.caller_number || body.from || body.customer_number || body.phone || ''
    const agentPhone = body.agent_number || body.to || ''
    const callId = body.call_id || body.call_uuid || body.id || `mo-${Date.now()}`
    const callDuration = parseInt(body.duration || body.call_duration || '0')
    const callStatus = body.status || body.call_status || eventType
    const recording = body.recording_url || body.record_url || ''
    const agentName = body.agent_name || body.operator_name || ''
    const did = body.did || body.virtual_number || '' // DID/virtual number called

    // Only process inbound calls with a caller phone
    const cleanPhone = callerPhone.replace(/\D/g, '').slice(-10)
    if (!cleanPhone) {
      return NextResponse.json({ success: true, message: 'No phone number in payload' })
    }

    // Get user_id from settings (to assign lead to correct CRM user)
    const { data: settingsData } = await supabase
      .from('settings')
      .select('user_id')
      .limit(1)
    const userId = settingsData?.[0]?.user_id || ''

    if (!userId) {
      return NextResponse.json({ error: 'No CRM user configured' }, { status: 400 })
    }

    // Check if lead already exists
    const { data: existingLeads } = await supabase
      .from('leads')
      .select('id, conversations, call_transcripts')
      .like('phone', `%${cleanPhone}%`)
      .limit(1)

    const callLog = {
      type: 'system' as const,
      content: `[MyOperator IVR] ${callStatus} call — Duration: ${callDuration}s${agentName ? ` | Agent: ${agentName}` : ''}${recording ? ` | Recording: ${recording}` : ''}${did ? ` | DID: ${did}` : ''}`,
      channel: 'Call',
      timestamp: Date.now(),
    }

    if (existingLeads && existingLeads.length > 0) {
      // Lead exists — log the call in their conversation history
      const lead = existingLeads[0]
      const conversations = lead.conversations || []
      conversations.push(callLog)

      const callTranscripts = lead.call_transcripts || []
      callTranscripts.push({
        date: Date.now(),
        duration: Math.ceil(callDuration / 60),
        transcript: '',
        summary: `MyOperator IVR call — ${callStatus}`,
        source: 'myoperator',
        callId,
        recording,
        agentName,
      })

      await supabase
        .from('leads')
        .update({ conversations, call_transcripts: callTranscripts })
        .eq('id', lead.id)

      return NextResponse.json({ success: true, message: 'Call logged to existing lead', leadId: lead.id })
    }

    // New caller — create a lead
    // Only create for missed calls or completed calls (not just ringing)
    const shouldCreate = ['missed', 'no_answer', 'completed', 'call_missed', 'call_completed', 'voicemail'].some(
      s => callStatus.toLowerCase().includes(s)
    ) || callDuration > 0 || eventType === 'call_missed'

    if (!shouldCreate) {
      return NextResponse.json({ success: true, message: 'Call too brief — lead not created' })
    }

    const newLeadId = `myoperator-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const { error } = await supabase.from('leads').insert({
      id: newLeadId,
      name: `IVR Lead (${cleanPhone})`,
      phone: cleanPhone,
      email: '',
      source: 'IVR Call',
      stage: 'New Enquiry',
      created_at: Date.now(),
      lead_status: 'active',
      user_id: userId,
      utm_source: 'myoperator',
      utm_medium: 'ivr',
      notes: `Auto-created from MyOperator IVR. Call ID: ${callId}. Status: ${callStatus}. DID: ${did}`,
      conversations: [callLog],
      call_transcripts: [{
        date: Date.now(),
        duration: Math.ceil(callDuration / 60),
        transcript: '',
        summary: `Inbound IVR call — ${callStatus}`,
        source: 'myoperator',
        callId,
        recording,
        agentName,
      }],
    })

    if (error) {
      console.error('MyOperator lead creation error:', error)
      return NextResponse.json({ error: 'Failed to create lead' }, { status: 500 })
    }

    return NextResponse.json({ success: true, leadId: newLeadId, message: 'Lead created from IVR call' })
  } catch (error) {
    console.error('MyOperator webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}

// GET handler — for webhook verification if MyOperator requires it
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const challenge = url.searchParams.get('challenge') || url.searchParams.get('hub.challenge')
  if (challenge) return new NextResponse(challenge, { status: 200 })
  return NextResponse.json({ status: 'MyOperator webhook active', service: 'EduAbroad CRM' })
}
