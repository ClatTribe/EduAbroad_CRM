import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Portal webhook (app.goeduabroad.com) — bidirectional sync
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    const portalToken = process.env.PORTAL_WEBHOOK_TOKEN
    if (portalToken && authHeader !== `Bearer ${portalToken}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await req.json()
    const action = body.action || ''

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceKey)

    // Get user_id
    const { data: settingsData } = await supabase.from('settings').select('user_id').limit(1)
    const userId = settingsData?.[0]?.user_id || ''

    switch (action) {
      case 'student_registered': {
        // Student registered on the portal — create lead in CRM
        const { name, phone, email, city, portalUserId } = body.data || {}
        const cleanPhone = (phone || '').replace(/\D/g, '').slice(-10)

        // Duplicate check
        if (cleanPhone) {
          const { data: existing } = await supabase.from('leads').select('id').like('phone', `%${cleanPhone}%`).limit(1)
          if (existing && existing.length > 0) {
            // Update existing lead with portal user ID
            await supabase.from('leads').update({ portal_user_id: portalUserId || '' }).eq('id', existing[0].id)
            return NextResponse.json({ success: true, message: 'Updated existing lead', leadId: existing[0].id })
          }
        }

        const newLeadId = `portal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        await supabase.from('leads').insert({
          id: newLeadId,
          name: name || '',
          phone: cleanPhone,
          email: email || '',
          city: city || '',
          source: 'Portal',
          stage: 'New Enquiry',
          created_at: Date.now(),
          portal_user_id: portalUserId || '',
          lead_status: 'active',
          user_id: userId,
        })
        return NextResponse.json({ success: true, leadId: newLeadId })
      }

      case 'document_uploaded': {
        // Student uploaded a document on portal
        const { portalUserId, documentType, fileName } = body.data || {}
        if (portalUserId) {
          const { data: leads } = await supabase.from('leads').select('id, documents').eq('portal_user_id', portalUserId).limit(1)
          if (leads && leads.length > 0) {
            const documents = leads[0].documents || []
            const existingDoc = documents.findIndex((d: any) => d.documentType === documentType)
            if (existingDoc >= 0) {
              documents[existingDoc].status = 'Ready'
              documents[existingDoc].uploadedAt = Date.now()
            } else {
              documents.push({ documentType, status: 'Ready', uploadedAt: Date.now(), verifiedBy: '' })
            }
            await supabase.from('leads').update({ documents }).eq('id', leads[0].id)
          }
        }
        return NextResponse.json({ success: true })
      }

      case 'counselling_booked': {
        // Student booked a counselling session on portal
        const { portalUserId, scheduledAt, notes } = body.data || {}
        if (portalUserId) {
          const { data: leads } = await supabase.from('leads').select('id, conversations, stage').eq('portal_user_id', portalUserId).limit(1)
          if (leads && leads.length > 0) {
            const conversations = leads[0].conversations || []
            conversations.push({
              type: 'system',
              content: `[Portal] Counselling session booked for ${new Date(scheduledAt).toLocaleString()}${notes ? ` — ${notes}` : ''}`,
              channel: 'Portal',
              timestamp: Date.now(),
            })
            const updates: Record<string, any> = {
              conversations,
              follow_up_at: scheduledAt || Date.now(),
              follow_up_note: 'Counselling booked via portal',
            }
            if (leads[0].stage === 'New Enquiry' || leads[0].stage === 'Not Contacted') {
              updates.stage = 'Counselling Scheduled'
            }
            await supabase.from('leads').update(updates).eq('id', leads[0].id)
          }
        }
        return NextResponse.json({ success: true })
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
  } catch (error) {
    console.error('Portal webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
