import { Lead } from './types'

// ─── Interakt WhatsApp API ───
// Replaces UltraMsg. Uses HTTP Basic Auth with API key.
export async function sendInteraktMessage(
  apiKey: string,
  rawPhone: string,
  message: string,
  templateName?: string,
  templateParams?: Record<string, string>
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const phone = rawPhone.replace(/\D/g, '').slice(-10)
    const countryCode = '91'
    const fullPhone = countryCode + phone

    // Session message (within 24hr window) or template message
    if (templateName) {
      // Template message (business-initiated, outside 24hr window)
      const response = await fetch('https://api.interakt.ai/v1/public/message/', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(apiKey + ':')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          countryCode: '+91',
          phoneNumber: phone,
          callbackData: 'eduabroad-crm',
          type: 'Template',
          template: {
            name: templateName,
            languageCode: 'en',
            bodyValues: templateParams ? Object.values(templateParams) : [],
          },
        }),
      })
      const data = await response.json()
      if (data.result) return { success: true, messageId: data.id }
      return { success: false, error: data.message || 'Template send failed' }
    } else {
      // Session message (free-form text within 24hr reply window)
      const response = await fetch('https://api.interakt.ai/v1/public/message/', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${btoa(apiKey + ':')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          countryCode: '+91',
          phoneNumber: phone,
          callbackData: 'eduabroad-crm',
          type: 'Text',
          data: { message },
        }),
      })
      const data = await response.json()
      if (data.result) return { success: true, messageId: data.id }
      return { success: false, error: data.message || 'Message send failed' }
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ─── Bolna AI Voice Agent ───
// Trigger outbound AI voice calls for lead qualification & follow-ups
export async function triggerBolnaCall(
  agentId: string,
  apiKey: string,
  phoneNumber: string,
  webhookUrl: string
): Promise<{ success: boolean; callId?: string; error?: string }> {
  try {
    const cleanPhone = phoneNumber.replace(/\D/g, '').slice(-10)
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
      return { success: false, error: `Bolna API error: ${err}` }
    }

    const data = await response.json()
    return { success: true, callId: data.call_id || data.id }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ─── Meta Conversions API (CAPI) ───
// Send events to Meta for remarketing optimization
export async function sendMetaConversionEvent(
  pixelId: string,
  accessToken: string,
  eventName: string,
  lead: Lead,
  customData?: Record<string, any>
): Promise<{ success: boolean; error?: string }> {
  try {
    const eventTime = Math.floor(Date.now() / 1000)
    const response = await fetch(`https://graph.facebook.com/v18.0/${pixelId}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: [{
          event_name: eventName,
          event_time: eventTime,
          action_source: 'system_generated',
          user_data: {
            em: lead.email ? [lead.email.toLowerCase().trim()] : [],
            ph: lead.phone ? [lead.phone.replace(/\D/g, '').slice(-10)] : [],
            fn: lead.name ? [lead.name.split(' ')[0].toLowerCase()] : [],
            ct: lead.city ? [lead.city.toLowerCase().replace(/\s/g, '')] : [],
            country: ['in'],
          },
          custom_data: {
            content_category: 'study_abroad',
            destination_country: lead.destinationCountries?.join(',') || '',
            intended_degree: lead.intendedDegree || '',
            stage: lead.stage || '',
            ...customData,
          },
        }],
        access_token: accessToken,
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      return { success: false, error: err.error?.message || 'Meta CAPI error' }
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ─── Google Ads Offline Conversions ───
// Send conversion events back to Google for Smart Bidding optimization
export async function sendGoogleOfflineConversion(
  googleClickId: string,
  conversionAction: string,
  conversionDateTime: string,
  conversionValue?: number
): Promise<{ success: boolean; error?: string }> {
  // Note: Full implementation requires Google Ads API OAuth + developer token
  // This is a placeholder structure — actual implementation needs server-side Google Ads API client
  try {
    console.log('Google Offline Conversion:', { googleClickId, conversionAction, conversionDateTime, conversionValue })
    // TODO: Implement with google-ads-api npm package on server side
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ─── Portal Sync (app.goeduabroad.com) ───
export async function syncToPortal(
  portalApiUrl: string,
  portalApiToken: string,
  action: 'create_lead' | 'update_status' | 'push_application',
  payload: Record<string, any>
): Promise<{ success: boolean; data?: any; error?: string }> {
  try {
    const response = await fetch(`${portalApiUrl}/api/crm-sync`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${portalApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...payload }),
    })

    if (!response.ok) {
      const err = await response.text()
      return { success: false, error: `Portal sync error: ${err}` }
    }

    const data = await response.json()
    return { success: true, data }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ─── Gmail via Google Apps Script (legacy fallback) ───
export async function sendGmail(
  gasUrl: string,
  lead: Lead,
  message: string,
  subject: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await fetch(gasUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: lead.email,
        subject: subject,
        body: message,
      }),
    })
    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

// ─── WhatsApp Web Fallback ───
export function triggerWAFallback(phone: string, message: string): void {
  const cleanPhone = phone.replace(/\D/g, '').slice(-10)
  const encoded = encodeURIComponent(message)
  const waLink = `https://wa.me/91${cleanPhone}?text=${encoded}`
  window.open(waLink, '_blank')
}
