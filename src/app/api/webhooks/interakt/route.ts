import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Interakt WhatsApp webhook — receives incoming messages and delivery status updates
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceKey)

    // Interakt sends different event types
    const eventType = body.type || body.event_type

    if (eventType === 'message_received' || body.data?.message) {
      // Incoming message from a student
      const phone = body.data?.customer?.phone_number || body.data?.from || ''
      const message = body.data?.message?.text || body.data?.message?.body || ''
      const cleanPhone = phone.replace(/\D/g, '').slice(-10)

      if (cleanPhone && message) {
        // Find the lead by phone number
        const { data: leads } = await supabase
          .from('leads')
          .select('id, conversations')
          .like('phone', `%${cleanPhone}%`)
          .limit(1)

        if (leads && leads.length > 0) {
          const lead = leads[0]
          const conversations = lead.conversations || []
          conversations.push({
            type: 'incoming',
            content: message,
            channel: 'WhatsApp',
            timestamp: Date.now(),
          })

          await supabase
            .from('leads')
            .update({ conversations })
            .eq('id', lead.id)
        }
      }
    }

    // Delivery status updates (sent, delivered, read, failed)
    if (body.data?.status) {
      console.log('Interakt delivery status:', body.data.status, body.data?.message_id)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Interakt webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
