import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Meta (Facebook/Instagram) Lead Form webhook
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceKey)

    // Meta sends leadgen webhook data
    const entry = body.entry?.[0]
    const changes = entry?.changes?.[0]
    const leadgenData = changes?.value || body

    const metaLeadId = leadgenData.leadgen_id || leadgenData.lead_id || body.lead_id || ''
    const formId = leadgenData.form_id || ''
    const pageId = leadgenData.page_id || ''

    // Field data from lead form
    const fieldData = leadgenData.field_data || body.field_data || []
    const fieldMap: Record<string, string> = {}
    for (const field of fieldData) {
      fieldMap[(field.name || '').toLowerCase()] = (field.values?.[0] || field.value || '')
    }

    const name = fieldMap['full_name'] || fieldMap['name'] || `${fieldMap['first_name'] || ''} ${fieldMap['last_name'] || ''}`.trim()
    const phone = fieldMap['phone_number'] || fieldMap['phone'] || ''
    const email = fieldMap['email'] || ''
    const city = fieldMap['city'] || ''

    if (!name && !phone && !email) {
      return NextResponse.json({ error: 'No lead data found' }, { status: 400 })
    }

    // Duplicate check
    const cleanPhone = phone.replace(/\D/g, '').slice(-10)
    if (cleanPhone) {
      const { data: existing } = await supabase
        .from('leads')
        .select('id')
        .like('phone', `%${cleanPhone}%`)
        .limit(1)

      if (existing && existing.length > 0) {
        return NextResponse.json({ success: true, message: 'Duplicate lead', leadId: existing[0].id })
      }
    }

    // Get user_id
    const { data: settingsData } = await supabase.from('settings').select('user_id').limit(1)
    const userId = settingsData?.[0]?.user_id || ''

    if (!userId) {
      return NextResponse.json({ error: 'No CRM user configured' }, { status: 400 })
    }

    // Create lead
    const newLeadId = `meta-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const { error } = await supabase.from('leads').insert({
      id: newLeadId,
      name,
      phone: cleanPhone,
      email,
      city,
      source: 'Meta Ads',
      stage: 'New Enquiry',
      created_at: Date.now(),
      utm_source: 'facebook',
      utm_medium: 'paid',
      utm_campaign: fieldMap['campaign_name'] || '',
      meta_lead_id: metaLeadId,
      notes: `Auto-imported from Meta Lead Form. Form: ${formId}, Page: ${pageId}`,
      lead_status: 'active',
      user_id: userId,
    })

    if (error) {
      console.error('Meta lead creation error:', error)
      return NextResponse.json({ error: 'Failed to create lead' }, { status: 500 })
    }

    return NextResponse.json({ success: true, leadId: newLeadId })
  } catch (error) {
    console.error('Meta webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}

// Meta webhook verification (GET request for hub.challenge)
export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const mode = url.searchParams.get('hub.mode')
  const token = url.searchParams.get('hub.verify_token')
  const challenge = url.searchParams.get('hub.challenge')

  const verifyToken = process.env.META_VERIFY_TOKEN || 'eduabroad-verify'

  if (mode === 'subscribe' && token === verifyToken) {
    return new NextResponse(challenge, { status: 200 })
  }

  return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
}
