import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Google Ads Lead Form webhook — receives lead form submissions
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    // Validate webhook key
    const webhookKey = process.env.GOOGLE_ADS_WEBHOOK_KEY
    if (webhookKey && body.google_key !== webhookKey) {
      return NextResponse.json({ error: 'Invalid webhook key' }, { status: 401 })
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(supabaseUrl, serviceKey)

    // Extract lead data from Google Ads payload
    const leadId = body.lead_id || ''
    const userColumns = body.user_column_data || []

    // Map Google Ads fields to our fields
    const fieldMap: Record<string, string> = {}
    for (const col of userColumns) {
      const key = (col.column_id || '').toLowerCase()
      fieldMap[key] = col.string_value || ''
    }

    const name = fieldMap['full_name'] || fieldMap['name'] || fieldMap['first_name'] || ''
    const phone = fieldMap['phone_number'] || fieldMap['phone'] || ''
    const email = fieldMap['email'] || ''
    const city = fieldMap['city'] || ''

    if (!name && !phone && !email) {
      return NextResponse.json({ error: 'No lead data found' }, { status: 400 })
    }

    // Check for duplicates
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

    // Get the first user's settings for user_id
    const { data: settingsData } = await supabase.from('settings').select('user_id').limit(1)
    const userId = settingsData?.[0]?.user_id || ''

    if (!userId) {
      return NextResponse.json({ error: 'No CRM user configured' }, { status: 400 })
    }

    // Create lead
    const newLeadId = `ga-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const { error } = await supabase.from('leads').insert({
      id: newLeadId,
      name,
      phone: cleanPhone,
      email,
      city,
      source: 'Google Ads',
      stage: 'New Enquiry',
      created_at: Date.now(),
      utm_source: 'google',
      utm_medium: 'cpc',
      utm_campaign: body.campaign_name || fieldMap['campaign'] || '',
      google_click_id: body.gcl_id || fieldMap['gclid'] || leadId,
      notes: `Auto-imported from Google Ads Lead Form. Lead ID: ${leadId}`,
      lead_status: 'active',
      user_id: userId,
    })

    if (error) {
      console.error('Google Ads lead creation error:', error)
      return NextResponse.json({ error: 'Failed to create lead' }, { status: 500 })
    }

    return NextResponse.json({ success: true, leadId: newLeadId })
  } catch (error) {
    console.error('Google Ads webhook error:', error)
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 })
  }
}
