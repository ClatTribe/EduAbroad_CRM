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
        const d = body.data || {}
        const cleanPhone = (d.phone || '').replace(/\D/g, '').slice(-10)

        // ── Build notes from rich portal fields ──
        const notesParts: string[] = []
        if (d.tenthBoard || d.tenthYear)
          notesParts.push(`10th: ${[d.tenthBoard, d.tenthYear].filter(Boolean).join(', ')}`)
        if (d.twelfthBoard || d.twelfthYear || d.twelfthStream)
          notesParts.push(`12th: ${[d.twelfthBoard, d.twelfthYear, d.twelfthStream].filter(Boolean).join(', ')}`)
        if (d.ugDegree || d.ugUniversity || d.ugYear)
          notesParts.push(`UG: ${[d.ugDegree, d.ugField, d.ugUniversity, d.ugYear, d.ugScore ? `CGPA ${d.ugScore}` : ''].filter(Boolean).join(' | ')}`)
        if (d.pgDegree || d.pgUniversity || d.pgYear)
          notesParts.push(`PG: ${[d.pgDegree, d.pgField, d.pgUniversity, d.pgYear, d.pgScore ? `Score ${d.pgScore}` : ''].filter(Boolean).join(' | ')}`)
        if (d.extracurricular)
          notesParts.push(`Extracurriculars: ${d.extracurricular}`)
        if (d.preferredCourse)
          notesParts.push(`Preferred course: ${d.preferredCourse}`)
        if (d.contactPreferences?.length)
          notesParts.push(`Contact preference: ${Array.isArray(d.contactPreferences) ? d.contactPreferences.join(', ') : d.contactPreferences}`)

        // ── Build work experience string ──
        let workExp = ''
        if (d.hasExperience) {
          workExp = [
            d.experienceYears ? `${d.experienceYears} years` : '',
            d.experienceField || '',
          ].filter(Boolean).join(' in ')
        }

        // ── Normalise test scores: [{exam, score}] → {IELTS: {score, date}} ──
        let testScores: Record<string, { score: string; date: string }> = {}
        if (Array.isArray(d.testScores)) {
          for (const t of d.testScores) {
            if (t.exam && t.score) testScores[t.exam] = { score: t.score, date: '' }
          }
        } else if (d.testScores && typeof d.testScores === 'object') {
          testScores = d.testScores
        }

        // ── Full lead row ──
        const leadRow = {
          name: d.name || '',
          phone: cleanPhone,
          email: d.email || '',
          city: d.city || '',
          state: d.state || '',
          source: d.source || 'Portal',
          stage: 'New Enquiry',
          lead_status: 'active',
          portal_user_id: d.portalUserId || '',
          intended_degree: d.intendedDegree || '',
          target_intake: d.targetIntake || '',
          destination_countries: d.destinationCountries || [],
          budget: d.budget || '',
          field_of_study: d.fieldOfStudy || '',
          tenth_marks: d.tenthMarks || '',
          twelfth_marks: d.twelfthMarks || '',
          ug_cgpa: d.ugCGPA || d.ugScore || '',
          test_scores: testScores,
          work_experience: workExp,
          notes: notesParts.join('\n'),
          // Attribution
          google_click_id: d.googleClickId || '',
          utm_source: d.utmSource || '',
          utm_medium: d.utmMedium || '',
          utm_campaign: d.utmCampaign || '',
          created_at: Date.now(),
          user_id: userId,
        }

        // ── Duplicate check ──
        if (cleanPhone) {
          const { data: existing } = await supabase
            .from('leads')
            .select('id')
            .like('phone', `%${cleanPhone}%`)
            .limit(1)

          if (existing && existing.length > 0) {
            // Update existing lead with all new portal data (excluding stage/status)
            const { id } = existing[0]
            const { created_at, stage, lead_status, ...updateFields } = leadRow
            await supabase.from('leads').update(updateFields).eq('id', id)
            return NextResponse.json({ success: true, message: 'Updated existing lead', leadId: id })
          }
        }

        // ── Create new lead ──
        const newLeadId = `portal-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        const { error } = await supabase.from('leads').insert({ id: newLeadId, ...leadRow })
        if (error) {
          console.error('Portal lead creation error:', error)
          return NextResponse.json({ error: 'Failed to create lead' }, { status: 500 })
        }

        return NextResponse.json({ success: true, leadId: newLeadId })
      }

      case 'document_uploaded': {
        const { portalUserId, documentType, fileName } = body.data || {}
        if (portalUserId) {
          const { data: leads } = await supabase
            .from('leads')
            .select('id, documents')
            .eq('portal_user_id', portalUserId)
            .limit(1)

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
        const { portalUserId, scheduledAt, notes } = body.data || {}
        if (portalUserId) {
          const { data: leads } = await supabase
            .from('leads')
            .select('id, conversations, stage')
            .eq('portal_user_id', portalUserId)
            .limit(1)

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
