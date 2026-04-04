import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Bolna AI Voice Agent webhook — receives call completion data
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceKey)

    const callId = body.call_id || body.id || ''
    const phone = body.recipient_phone_number || body.phone || ''
    const status = body.status || 'completed'
    const transcript = body.transcript || ''
    const summary = body.summary || ''
    const duration = body.duration || 0
    const extractedData = body.extracted_data || body.extraction || {}

    const cleanPhone = phone.replace(/\D/g, '').slice(-10)

    if (cleanPhone) {
      // Find the lead by phone number
      const { data: leads } = await supabase
        .from('leads')
        .select('id, call_transcripts, bolna_calls, conversations')
        .like('phone', `%${cleanPhone}%`)
        .limit(1)

      if (leads && leads.length > 0) {
        const lead = leads[0]

        // Add to bolna_calls
        const bolnaCalls = lead.bolna_calls || []
        bolnaCalls.push({
          callId,
          agentId: body.agent_id || '',
          phone: cleanPhone,
          status,
          duration,
          transcript,
          summary,
          extractedData,
          timestamp: Date.now(),
        })

        // Add to call_transcripts
        const callTranscripts = lead.call_transcripts || []
        callTranscripts.push({
          date: Date.now(),
          duration: Math.ceil(duration / 60), // convert to minutes
          transcript,
          summary,
          emotions: extractedData.emotions ? [extractedData.emotions] : [],
          objections: extractedData.objections ? [extractedData.objections] : [],
          extractedFields: extractedData,
          source: 'bolna',
        })

        // Add to conversations
        const conversations = lead.conversations || []
        conversations.push({
          type: 'system',
          content: `[Bolna AI Call] Duration: ${Math.ceil(duration / 60)}min | Summary: ${summary || 'Call completed'}`,
          channel: 'Call',
          timestamp: Date.now(),
        })

        // Update lead with extracted fields if available
        const updates: Record<string, any> = {
          bolna_calls: bolnaCalls,
          call_transcripts: callTranscripts,
          conversations,
        }

        // Auto-update lead fields from extracted data
        if (extractedData.destination_country) updates.destination_countries = [extractedData.destination_country]
        if (extractedData.budget) updates.budget = extractedData.budget
        if (extractedData.intake) updates.target_intake = extractedData.intake
        if (extractedData.degree) updates.intended_degree = extractedData.degree

        await supabase.from('leads').update(updates).eq('id', lead.id)
      }
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Bolna webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
