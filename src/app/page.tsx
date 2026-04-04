'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase'
import {
  Lead,
  Settings,
  TeamMember,
  ConvEntry,
  SentMessage,
  CallTranscript,
  BolnaCall,
  Application,
  DocumentItem,
  TestScore,
  RemarkEntry,
} from '@/lib/types'
import { STAGES, STAGE_COLORS, FUNNEL, FUNNEL_DAYS, OBJECTIONS, CSV_FIELDS, PROMPT_LIBRARY, DESTINATION_COUNTRIES, DEGREE_LEVELS, EDUCATION_LEVELS, BUDGET_RANGES, PASSPORT_STATUSES, INTAKE_OPTIONS, TEST_TYPES, FIELDS_OF_STUDY, SERVICE_TYPES, VISA_STATUSES, DOCUMENT_TYPES, APPLICATION_STATUSES } from '@/lib/constants'
import { callGemini, buildPrompt, buildPersonalisedPrompt, buildEmailPrompt } from '@/lib/gemini'
import { sendInteraktMessage, sendGmail, triggerWAFallback, triggerBolnaCall, sendMetaConversionEvent, syncToPortal } from '@/lib/integrations'
import { sendResendEmail } from '@/lib/resend-email'
import { leadToRow, rowToLead, settingsToRow, rowToSettings } from '@/lib/db-mapper'

// ────────────────── Utility functions ──────────────────
function daysSince(timestamp: number): number {
  if (!timestamp) return 999
  return Math.floor((Date.now() - timestamp) / (1000 * 60 * 60 * 24))
}

function getHeat(lead: Lead): 'hot' | 'warm' | 'cold' | 'enrolled' {
  if (lead.stage === 'Enrolled / Flew') return 'enrolled'
  const days = daysSince(lead.followUpAt || lead.createdAt)
  if (days <= 3) return 'hot'
  if (days <= 7) return 'warm'
  return 'cold'
}

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
}

function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleDateString('en-IN')
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// ────────────────── Lead Scoring Engine (Study Abroad) ──────────────────
function calculateLeadScore(lead: Lead): { score: number; label: string; reason: string } {
  let score = 0
  const reasons: string[] = []

  // Profile completeness (0-15)
  let profileScore = 0
  if (lead.name) profileScore += 3
  if (lead.phone) profileScore += 3
  if (lead.email) profileScore += 3
  if (lead.city) profileScore += 3
  if (lead.parentName) profileScore += 3
  score += Math.min(15, profileScore)
  if (profileScore < 15) reasons.push(`Profile ${profileScore}/15`)
  else reasons.push('Full profile')

  // Test readiness (0-15)
  const testEntries = Object.entries(lead.testScores || {}).filter(([_, v]) => v?.score)
  if (testEntries.length >= 2) { score += 15; reasons.push('Tests ready') }
  else if (testEntries.length === 1) { score += 8; reasons.push('1 test done') }

  // Budget clarity (0-10)
  if (lead.budget && lead.budget !== 'Need Scholarship') { score += 10; reasons.push('Budget clear') }
  else if (lead.budget === 'Need Scholarship') { score += 5 }

  // Intake urgency (0-10)
  if (lead.targetIntake) {
    const intake = lead.targetIntake.toLowerCase()
    if (intake.includes('2026')) { score += 10; reasons.push('Urgent intake') }
    else if (intake.includes('2027') && intake.includes('spring')) { score += 8 }
    else if (intake.includes('2027')) { score += 5 }
  }

  // Engagement (0-20)
  const convCount = lead.conversations?.length || 0
  const sentCount = lead.sentMessages?.length || 0
  if (convCount > 5) { score += 12; reasons.push('High engagement') }
  else if (convCount > 2) { score += 8; reasons.push('Some engagement') }
  else if (convCount > 0) { score += 4 }
  if (sentCount > 3) score += 8
  else if (sentCount > 0) score += 4

  // Stage progression (0-15)
  const stageIndex = STAGES.indexOf(lead.stage)
  if (stageIndex >= 9) { score += 15; reasons.push('Visa stage') }
  else if (stageIndex >= 6) { score += 12; reasons.push('Application stage') }
  else if (stageIndex >= 3) { score += 8; reasons.push('Counselling done') }
  else if (stageIndex >= 1) { score += 4 }

  // Parent involvement (0-5)
  if (lead.parentPhone || lead.parentEmail) { score += 5; reasons.push('Parent involved') }

  // Recency (0-10)
  const daysSinceCreated = daysSince(lead.createdAt)
  if (daysSinceCreated <= 3) { score += 10; reasons.push('Fresh') }
  else if (daysSinceCreated <= 7) { score += 7 }
  else if (daysSinceCreated <= 14) { score += 3 }

  score = Math.min(100, score)
  const label = score >= 80 ? 'Hot' : score >= 50 ? 'Warm' : score >= 25 ? 'Cool' : 'Cold'

  return { score, label, reason: reasons.join(' | ') }
}

// ────────────────── Duplicate Detection ──────────────────
function findDuplicates(newLead: Partial<Lead>, existingLeads: Lead[]): Lead[] {
  return existingLeads.filter(existing => {
    if (newLead.phone && existing.phone) {
      const cleanNew = newLead.phone.replace(/\D/g, '').slice(-10)
      const cleanExisting = existing.phone.replace(/\D/g, '').slice(-10)
      if (cleanNew === cleanExisting && cleanNew.length === 10) return true
    }
    if (newLead.email && existing.email) {
      if (newLead.email.toLowerCase().trim() === existing.email.toLowerCase().trim()) return true
    }
    return false
  })
}

const DEFAULT_SETTINGS: Settings = {
  team: [{ name: 'You', branch: 'HQ' }],
  templates: [],
  sources: ['Google Ads', 'Meta Ads', 'Instagram', 'Website', 'Portal', 'Referral', 'WhatsApp', 'Walk-in', 'Education Fair', 'Partner Agent'],
  theme: 'light',
  interaktApiKey: '',
  interaktWebhookSecret: '',
  bolnaAgentId: '',
  bolnaApiKey: '',
  googleAdsWebhookKey: '',
  metaAppId: '',
  metaAccessToken: '',
  metaPixelId: '',
  portalApiUrl: '',
  portalApiToken: '',
  gasUrl: '',
  gasSender: 'goeduabroadonline@gmail.com',
  gmailAppPassword: '',
  resendKey: '',
  geminiKey: '',
  autoFollowUp: false,
}

// ═══════════════════════════════════════════════════════════
// MAIN CRM COMPONENT
// ═══════════════════════════════════════════════════════════
export default function CRMApp() {
  const supabase = createClient()

  // Auth state
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  // CRM state
  const [leads, setLeads] = useState<Lead[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [currentView, setCurrentView] = useState('dashboard')

  // Search
  const [searchQuery, setSearchQuery] = useState('')

  // Filters & sorting
  const [activeStageFilter, setActiveStageFilter] = useState('all')
  const [activeSort, setActiveSort] = useState('date')
  const [showDueOnly, setShowDueOnly] = useState(false)
  const [dateFilter, setDateFilter] = useState('all')
  const [customDateFrom, setCustomDateFrom] = useState('')
  const [customDateTo, setCustomDateTo] = useState('')

  // Message generator state
  const [selectedDay, setSelectedDay] = useState(0)
  const [selectedTone, setSelectedTone] = useState('persuasive')
  const [apiKey, setApiKey] = useState('')
  const [generatedMessage, setGeneratedMessage] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)

  // Modal states
  const [showAddLeadModal, setShowAddLeadModal] = useState(false)
  const [showEnrollModal, setShowEnrollModal] = useState(false)
  const [showCSVModal, setShowCSVModal] = useState(false)
  const [showCallAssistantModal, setShowCallAssistantModal] = useState(false)
  const [showBulkSequenceModal, setShowBulkSequenceModal] = useState(false)
  const [showAddSourceModal, setShowAddSourceModal] = useState(false)

  // Bulk selection
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set())
  const [showBulkActions, setShowBulkActions] = useState(false)

  // Form state
  const [formData, setFormData] = useState<Partial<Lead>>({})
  const [csvFile, setCSVFile] = useState<File | null>(null)

  // Notifications
  const [notifications, setNotifications] = useState<Array<{ id: string; message: string; type: string }>>([])

  // Theme
  const [theme, setTheme] = useState('dark')

  // Role-based access
  const userEmail = user?.email || ''
  const isAdmin = userEmail === 'admin@goeduabroad.com' || userEmail === 'goeduabroadonline@gmail.com'

  // ────────────────── Auth check on mount ──────────────────
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const { data } = await supabase.auth.getSession()
        if (data.session?.user) {
          setUser(data.session.user)
          const { data: leadsData } = await supabase.from('leads').select('*')
          if (leadsData) setLeads(leadsData.map(rowToLead))

          const { data: settingsData } = await supabase
            .from('settings')
            .select('*')
            .eq('id', `global-${data.session.user.id}`)
            .maybeSingle()
          if (settingsData) setSettings(rowToSettings(settingsData))
        }
      } catch (error) {
        console.error('Auth check failed:', error)
      } finally {
        setLoading(false)
      }
    }
    checkAuth()
  }, [])

  // Real-time subscription
  useEffect(() => {
    if (!user) return
    const channel = supabase
      .channel('leads-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, () => { loadLeads() })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [user])

  // Request notification permission and check for due follow-ups
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
    // Check for follow-ups due within the next hour
    const interval = setInterval(() => {
      const now = Date.now()
      leads.forEach(lead => {
        if (lead.followUpAt && lead.stage !== 'Enrolled / Flew') {
          const diff = lead.followUpAt - now
          if (diff > 0 && diff < 60000) { // Due within 1 minute
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification('EduAbroad - Follow-up Due NOW', { body: `Follow up with ${lead.name}: ${lead.followUpNote || 'No note'}` })
            }
            addNotification(`Follow-up due NOW: ${lead.name}`, 'info')
          }
        }
      })
    }, 60000) // Check every minute
    return () => clearInterval(interval)
  }, [leads])

  // ────────────────── Helper functions ──────────────────
  const addNotification = (message: string, type: string = 'info') => {
    const id = generateId()
    setNotifications(prev => [...prev, { id, message, type }])
    setTimeout(() => { setNotifications(prev => prev.filter(n => n.id !== id)) }, 3000)
  }

  const loadLeads = async () => {
    try {
      const { data } = await supabase.from('leads').select('*')
      if (data) setLeads(data.map(rowToLead))
    } catch (error) {
      console.error('Failed to load leads:', error)
    }
  }

  const saveLeadToDb = async (lead: Lead) => {
    try {
      if (!user?.id) {
        addNotification('Not authenticated', 'error')
        return
      }
      const row = leadToRow(lead, user.id)
      const { error } = await supabase.from('leads').upsert(row, { onConflict: 'id' })
      if (error) throw error
      addNotification('Lead saved', 'success')
      await loadLeads()
    } catch (error: any) {
      console.error('Failed to save lead:', error)
      addNotification(`Failed to save: ${error?.message || error}`, 'error')
    }
  }

  const deleteLeadFromDb = async (id: string) => {
    try {
      const { error } = await supabase.from('leads').delete().eq('id', id)
      if (error) throw error
      addNotification('Lead deleted', 'success')
      await loadLeads()
      setSelectedId(null)
    } catch (error) {
      console.error('Failed to delete lead:', error)
      addNotification('Failed to delete lead', 'error')
    }
  }

  const bulkDeleteLeads = async () => {
    if (!confirm(`Delete ${selectedLeadIds.size} leads?`)) return
    for (const id of selectedLeadIds) {
      await supabase.from('leads').delete().eq('id', id)
    }
    setSelectedLeadIds(new Set())
    await loadLeads()
    addNotification(`Deleted ${selectedLeadIds.size} leads`, 'success')
  }

  const bulkChangeStage = async (stage: string) => {
    for (const id of selectedLeadIds) {
      const lead = leads.find(l => l.id === id)
      if (lead) {
        const row = leadToRow({ ...lead, stage }, user.id)
        await supabase.from('leads').upsert(row, { onConflict: 'id' })
      }
    }
    setSelectedLeadIds(new Set())
    await loadLeads()
    addNotification(`Moved ${selectedLeadIds.size} leads to ${stage}`, 'success')
  }

  const bulkAssign = async (assignee: string) => {
    for (const id of selectedLeadIds) {
      const lead = leads.find(l => l.id === id)
      if (lead) {
        const row = leadToRow({ ...lead, assignedTo: assignee }, user.id)
        await supabase.from('leads').upsert(row, { onConflict: 'id' })
      }
    }
    setSelectedLeadIds(new Set())
    await loadLeads()
    addNotification(`Assigned ${selectedLeadIds.size} leads to ${assignee}`, 'success')
  }

  const saveSettingsToDb = async (newSettings: Settings) => {
    try {
      if (!user?.id) return
      const row = settingsToRow(newSettings, user.id)
      const { error } = await supabase.from('settings').upsert(row, { onConflict: 'id' })
      if (error) throw error
      setSettings(newSettings)
      addNotification('Settings saved', 'success')
    } catch (error) {
      console.error('Failed to save settings:', error)
      addNotification('Failed to save settings', 'error')
    }
  }

  // ────────────────── Filter & sort leads ──────────────────
  const getFilteredLeads = useCallback(() => {
    let filtered = [...leads]

    // Role-based filtering: team members only see their assigned leads
    if (!isAdmin && userEmail) {
      const teamMember = settings.team?.find(m => m.email === userEmail)
      if (teamMember) {
        filtered = filtered.filter(l => l.assignedTo === teamMember.name)
      }
    }

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(l =>
        l.name.toLowerCase().includes(q) ||
        l.phone.includes(q) ||
        l.email.toLowerCase().includes(q) ||
        l.city.toLowerCase().includes(q) ||
        l.source.toLowerCase().includes(q) ||
        l.notes.toLowerCase().includes(q)
      )
    }

    // Stage filter
    if (activeStageFilter !== 'all') {
      filtered = filtered.filter(l => l.stage === activeStageFilter)
    }

    // Due only filter
    if (showDueOnly) {
      filtered = filtered.filter(l => daysSince(l.followUpAt || l.createdAt) > 0)
    }

    // Date filter
    if (dateFilter === 'custom') {
      if (customDateFrom) {
        const from = new Date(customDateFrom).getTime()
        filtered = filtered.filter(l => l.createdAt >= from)
      }
      if (customDateTo) {
        const to = new Date(customDateTo).getTime() + 86400000 // end of that day
        filtered = filtered.filter(l => l.createdAt <= to)
      }
    } else if (dateFilter !== 'all') {
      const now = new Date()
      let cutoff = 0
      if (dateFilter === 'today') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      else if (dateFilter === 'week') cutoff = Date.now() - 7 * 86400000
      else if (dateFilter === 'month') cutoff = Date.now() - 30 * 86400000
      filtered = filtered.filter(l => l.createdAt >= cutoff)
    }

    // Sort
    filtered.sort((a, b) => {
      switch (activeSort) {
        case 'date': return b.createdAt - a.createdAt
        case 'heat':
          const heatOrder: Record<string, number> = { hot: 0, warm: 1, cold: 2, enrolled: 3 }
          return heatOrder[getHeat(a)] - heatOrder[getHeat(b)]
        case 'score': return b.score - a.score
        case 'name': return a.name.localeCompare(b.name)
        default: return 0
      }
    })

    return filtered
  }, [leads, searchQuery, activeStageFilter, showDueOnly, dateFilter, customDateFrom, customDateTo, activeSort])

  const selectedLead = selectedId ? leads.find(l => l.id === selectedId) : null
  const filteredLeads = getFilteredLeads()

  // ────────────────── Message generation ──────────────────
  const generateMessage = async () => {
    if (!selectedLead || !apiKey) {
      addNotification('Select a lead and enter API key', 'error')
      return
    }
    setIsGenerating(true)
    try {
      const prompt = buildPrompt(selectedLead, selectedDay, selectedTone)
      const message = await callGemini(prompt, apiKey)
      setGeneratedMessage(message)
    } catch (error) {
      console.error('Generation failed:', error)
      addNotification('Generation failed', 'error')
    } finally {
      setIsGenerating(false)
    }
  }

  // ────────────────── Auth handlers ──────────────────
  const handleLogin = async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    setUser(data.user)
    await loadLeads()
    addNotification('Logged in', 'success')
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setUser(null)
  }

  // ────────────────── Save lead (Add/Edit) ──────────────────
  const handleSaveLead = async (skipDupeCheck = false) => {
    if (!formData.name || !formData.phone || !formData.email) {
      addNotification('Fill required fields (Name, Phone, Email)', 'error')
      return
    }

    // Duplicate detection
    if (!skipDupeCheck && !selectedId) {
      const dupes = findDuplicates(formData, leads)
      if (dupes.length > 0) {
        const dupeNames = dupes.map(d => d.name).join(', ')
        if (!confirm(`Possible duplicate found: ${dupeNames}. Add anyway?`)) return
      }
    }

    const lead: Lead = {
      id: selectedId || generateId(),
      name: formData.name || '',
      phone: formData.phone || '',
      email: formData.email || '',
      city: formData.city || '',
      state: formData.state || '',
      source: formData.source || 'Direct',
      parentName: formData.parentName || '',
      parentPhone: formData.parentPhone || '',
      parentEmail: formData.parentEmail || '',
      currentEducation: formData.currentEducation || '',
      tenthMarks: formData.tenthMarks || '',
      twelfthMarks: formData.twelfthMarks || '',
      ugCGPA: formData.ugCGPA || '',
      fieldOfStudy: formData.fieldOfStudy || '',
      workExperience: formData.workExperience || '',
      gapYears: formData.gapYears || 0,
      destinationCountries: formData.destinationCountries || [],
      intendedDegree: formData.intendedDegree || '',
      targetIntake: formData.targetIntake || '',
      budget: formData.budget || '',
      passportStatus: formData.passportStatus || '',
      scholarshipInterest: formData.scholarshipInterest || false,
      testScores: formData.testScores || {},
      preferredUniversities: formData.preferredUniversities || [],
      stage: formData.stage || 'New Enquiry',
      score: formData.score || 50,
      scoreLabel: formData.scoreLabel || 'Pending',
      scoreReason: formData.scoreReason || '',
      notes: formData.notes || '',
      assignedTo: formData.assignedTo || '',
      leadStatus: formData.leadStatus || 'active',
      createdAt: formData.createdAt || Date.now(),
      followUpAt: formData.followUpAt || 0,
      followUpNote: formData.followUpNote || '',
      serviceType: formData.serviceType || '',
      feeAmount: formData.feeAmount || 0,
      paymentLink: formData.paymentLink || '',
      paymentPendingAt: formData.paymentPendingAt || 0,
      enrolledAt: formData.enrolledAt || 0,
      applications: formData.applications || [],
      documents: formData.documents || [],
      visaCountry: formData.visaCountry || '',
      visaType: formData.visaType || '',
      visaApplicationDate: formData.visaApplicationDate || 0,
      visaInterviewDate: formData.visaInterviewDate || 0,
      visaStatus: formData.visaStatus || '',
      conversations: formData.conversations || [],
      sentMessages: formData.sentMessages || [],
      callTranscripts: formData.callTranscripts || [],
      zombieResurrected: formData.zombieResurrected || false,
      zombieAttempts: formData.zombieAttempts || 0,
      lastZombieAt: formData.lastZombieAt || 0,
      dripCount: formData.dripCount || 0,
      lastDripAt: formData.lastDripAt || 0,
      remarks: formData.remarks || [],
      utmSource: formData.utmSource || '',
      utmMedium: formData.utmMedium || '',
      utmCampaign: formData.utmCampaign || '',
      googleClickId: formData.googleClickId || '',
      metaLeadId: formData.metaLeadId || '',
      portalUserId: formData.portalUserId || '',
      bolnaCalls: formData.bolnaCalls || [],
    }

    // Auto-score the lead
    const scoreResult = calculateLeadScore(lead)
    lead.score = scoreResult.score
    lead.scoreLabel = scoreResult.label
    lead.scoreReason = scoreResult.reason

    const isNewLead = !selectedId
    await saveLeadToDb(lead)
    setShowAddLeadModal(false)
    setFormData({})
    setSelectedId(lead.id)

    // Auto-send welcome message for NEW leads
    if (isNewLead) {
      sendAutoWelcome(lead)
    }
  }

  // ────────────────── Drip Email 1 Template ──────────────────
  const DRIP_1_SUBJECT = `Welcome to EduAbroad, {{name}}!`
  const DRIP_1_HTML = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0">
<h2 style="margin:0">Welcome to EduAbroad, {{name}}!</h2>
</div>
<div style="padding:20px 24px;border:1px solid #eee;border-top:0;border-radius:0 0 8px 8px">
<p>We're excited that you're exploring opportunities to <strong>study abroad</strong>! At EduAbroad, we've helped hundreds of Indian students get into top universities across the USA, UK, Canada, Australia, Germany, and more.</p>
<p>Here's what we can help you with:</p>
<ul>
<li>Expert counselling for the right country and university match</li>
<li>Test preparation guidance (IELTS, TOEFL, GRE, GMAT)</li>
<li>Application assistance including SOP, LOR, and document support</li>
<li>Scholarship guidance — we've helped students win scholarships worth 10L-50L</li>
<li>Complete visa support and pre-departure briefing</li>
</ul>
<p>We'd love to understand your profile and goals. <strong>Reply to this email</strong> or WhatsApp us — we'll schedule a free 30-min profile evaluation call.</p>
<p style="margin-top:20px">Best regards,<br><strong>Team EduAbroad</strong><br><a href="https://goeduabroad.com" style="color:#af0100">goeduabroad.com</a></p>
</div>
</div>`

  // ────────────────── Auto Welcome (WhatsApp + Email Drip 1) ──────────────────
  const sendAutoWelcome = async (lead: Lead) => {
    const geminiKey = apiKey || settings.geminiKey
    if (!geminiKey) {
      addNotification('Tip: Add Gemini API key to auto-send personalised welcome messages', 'info')
    }

    const countries = (lead.destinationCountries || []).join(', ') || 'abroad'
    const defaultWelcome = `Hi ${lead.name}! Thanks for your interest in studying ${countries}. I'm from EduAbroad — India's trusted study abroad consultancy. We help students get into top universities with scholarships. Can we schedule a quick call to understand your profile and goals?`

    let whatsappMessage = defaultWelcome
    if (geminiKey) {
      try {
        const prompt = `You are an EduAbroad enrollment AI. A brand new lead just enquired about studying abroad. Generate a warm, friendly FIRST TOUCH WhatsApp welcome message.

Student: ${lead.name}
Phone: ${lead.phone}
Email: ${lead.email}
Destination Countries: ${countries}
City: ${lead.city || 'Unknown'}
Current Education: ${lead.currentEducation || 'Unknown'}
Intended Degree: ${lead.intendedDegree || 'Unknown'}
Target Intake: ${lead.targetIntake || 'Unknown'}
Source: ${lead.source}

EduAbroad Context:
- Leading study abroad consultancy for Indian students
- Helps with USA, UK, Canada, Australia, Germany, Ireland, and more
- Services: University shortlisting, SOP/LOR writing, Application filing, Visa support, Scholarship guidance
- Known for high acceptance rates and scholarship wins (10L-50L)
- Free 30-minute profile evaluation for every student

Generate a SHORT, WARM, CASUAL WhatsApp message (2-3 sentences). Welcome them, mention EduAbroad briefly, and ask one engaging question about their study abroad plans. Do NOT be salesy.`
        whatsappMessage = await callGemini(prompt, geminiKey)
      } catch (err) {
        console.error('Gemini welcome generation failed, using default:', err)
      }
    }

    // Send WhatsApp via Interakt or fallback
    if (lead.phone) {
      if (settings.interaktApiKey) {
        try {
          const result = await sendInteraktMessage(settings.interaktApiKey, lead.phone, whatsappMessage)
          if (result.success) addNotification(`Welcome WhatsApp sent to ${lead.name}`, 'success')
        } catch (err) { console.error('WhatsApp welcome failed:', err) }
      } else {
        triggerWAFallback(lead.phone, whatsappMessage)
        addNotification(`WhatsApp opened for ${lead.name} — send the welcome message`, 'info')
      }
    }

    // Send Drip Email #1
    let emailSent = false
    if (lead.email) {
      const emailSubject = DRIP_1_SUBJECT.replace(/\{\{name\}\}/g, lead.name || 'there')
      const emailHtml = DRIP_1_HTML.replace(/\{\{name\}\}/g, lead.name || 'there')
      const senderEmail = settings.gasSender || 'goeduabroadonline@gmail.com'

      if (settings.gmailAppPassword) {
        try {
          const res = await fetch('/api/send-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: lead.email, subject: emailSubject, html: emailHtml, from: senderEmail, appPassword: settings.gmailAppPassword }) })
          if (res.ok) { const r = await res.json(); if (r.success) { emailSent = true; addNotification(`Drip Email #1 sent to ${lead.name}`, 'success') } }
        } catch (err) { console.error('Drip email 1 failed:', err) }
      } else if (settings.resendKey) {
        try {
          const result = await sendResendEmail(settings.resendKey, lead.email, emailSubject, emailHtml)
          if (result.success) { emailSent = true; addNotification(`Drip Email #1 sent to ${lead.name}`, 'success') }
        } catch (err) { console.error('Drip email 1 failed:', err) }
      } else if (settings.gasUrl) {
        try {
          await sendGmail(settings.gasUrl, lead, emailHtml, emailSubject)
          emailSent = true
          addNotification(`Drip Email #1 sent to ${lead.name}`, 'success')
        } catch (err) { console.error('GAS drip email failed:', err) }
      }

      if (!emailSent) {
        addNotification('Drip email could not be sent — configure Gmail App Password in Settings', 'error')
      }
    }

    // Record on the lead
    const updatedLead: Lead = {
      ...lead,
      dripCount: emailSent ? 1 : 0,
      lastDripAt: emailSent ? Date.now() : 0,
      sentMessages: [...lead.sentMessages,
        { day: 'D0', label: 'Auto Welcome', message: whatsappMessage, channel: 'WhatsApp', sentAt: Date.now() },
        ...(emailSent ? [{ day: 'Drip 1', label: 'Email Drip 1', message: DRIP_1_SUBJECT.replace(/\{\{name\}\}/g, lead.name), channel: 'Email', sentAt: Date.now() }] : []),
      ],
      conversations: [...lead.conversations, {
        type: 'outgoing' as const, content: `[Auto Welcome] ${whatsappMessage}`,
        channel: 'WhatsApp' as const, timestamp: Date.now(),
      }],
    }
    await saveLeadToDb(updatedLead)
  }

  // ────────────────── CSV Import ──────────────────
  const handleCSVImport = async () => {
    if (!csvFile) {
      addNotification('Select a CSV file', 'error')
      return
    }
    const reader = new FileReader()
    reader.onerror = () => { addNotification('Failed to read CSV file', 'error') }
    reader.onload = async (e) => {
      try {
        const text = e.target?.result as string
        const lines = text.split('\n')
        const headers = lines[0].split(',').map(h => h.trim())
        let imported = 0
        let skipped = 0

        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue
          const values = lines[i].split(',')
          const leadData: Partial<Lead> = { id: generateId() }

          CSV_FIELDS.forEach(field => {
            const colIndex = headers.findIndex(h => h.toLowerCase().includes(field.label.replace(' *', '').toLowerCase()))
            if (colIndex >= 0) {
              (leadData as any)[field.key] = values[colIndex]?.trim() || ''
            }
          })

          // Duplicate check
          const dupes = findDuplicates(leadData, leads)
          if (dupes.length > 0) { skipped++; continue }

          const lead: Lead = {
            id: leadData.id || generateId(),
            name: leadData.name || '', phone: leadData.phone || '', email: leadData.email || '',
            city: leadData.city || '', state: '', source: leadData.source || 'CSV Import',
            parentName: leadData.parentName || '', parentPhone: '', parentEmail: '',
            currentEducation: leadData.currentEducation || '', tenthMarks: '', twelfthMarks: '',
            ugCGPA: '', fieldOfStudy: '', workExperience: '', gapYears: 0,
            destinationCountries: [], intendedDegree: leadData.intendedDegree || '',
            targetIntake: leadData.targetIntake || '', budget: '',
            passportStatus: '', scholarshipInterest: false, testScores: {},
            preferredUniversities: [],
            stage: leadData.stage || 'New Enquiry', score: 50, scoreLabel: 'Pending',
            scoreReason: '', notes: leadData.notes || '', assignedTo: '',
            leadStatus: 'active',
            createdAt: Date.now(), followUpAt: 0, followUpNote: '',
            serviceType: '', feeAmount: 0, paymentLink: '', paymentPendingAt: 0, enrolledAt: 0,
            applications: [], documents: [],
            visaCountry: '', visaType: '', visaApplicationDate: 0, visaInterviewDate: 0, visaStatus: '',
            conversations: [], sentMessages: [], callTranscripts: [],
            zombieResurrected: false, zombieAttempts: 0, lastZombieAt: 0,
            dripCount: 0, lastDripAt: 0, remarks: [],
            utmSource: '', utmMedium: '', utmCampaign: '',
            googleClickId: '', metaLeadId: '', portalUserId: '',
            bolnaCalls: [],
          }

          const scoreResult = calculateLeadScore(lead)
          lead.score = scoreResult.score
          lead.scoreLabel = scoreResult.label
          lead.scoreReason = scoreResult.reason

          await saveLeadToDb(lead)
          imported++
        }

        addNotification(`Imported ${imported} leads${skipped > 0 ? `, skipped ${skipped} duplicates` : ''}`, 'success')
        setShowCSVModal(false)
        setCSVFile(null)
      } catch (error) {
        console.error('CSV import failed:', error)
        addNotification('CSV import failed', 'error')
      }
    }
    reader.readAsText(csvFile)
  }

  // ────────────────── CSV Export ──────────────────
  const handleCSVExport = () => {
    const headers = ['Name', 'Phone', 'Email', 'City', 'Current Education', 'Intended Degree', 'Target Intake', 'Destination Countries', 'Source', 'Stage', 'Score', 'Notes', 'Assigned To', 'Created']
    const rows = filteredLeads.map(l => [
      l.name, l.phone, l.email, l.city, l.currentEducation, l.intendedDegree, l.targetIntake,
      (l.destinationCountries || []).join(';'), l.source, l.stage, l.score,
      l.notes.replace(/,/g, ';'), l.assignedTo, formatDate(l.createdAt)
    ])
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `eduabroad-leads-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
    addNotification('CSV exported', 'success')
  }

  // ────────────────── Enroll Lead ──────────────────
  const handleEnroll = async (feeAmount: number, paymentLink: string) => {
    if (!selectedLead) return
    const updated: Lead = {
      ...selectedLead,
      stage: 'Enrolled / Flew',
      feeAmount,
      paymentLink,
      enrolledAt: Date.now(),
    }
    const scoreResult = calculateLeadScore(updated)
    updated.score = scoreResult.score
    updated.scoreLabel = scoreResult.label
    updated.scoreReason = scoreResult.reason
    await saveLeadToDb(updated)
    setShowEnrollModal(false)
  }

  // ────────────────── Send message ──────────────────
  const handleSendMessage = async (channel: string) => {
    if (!selectedLead || !generatedMessage) {
      addNotification('No message to send', 'error')
      return
    }
    try {
      if (channel === 'whatsapp' && settings.interaktApiKey) {
        const result = await sendInteraktMessage(settings.interaktApiKey, selectedLead.phone, generatedMessage)
        if (result.success) {
          const updatedLead = {
            ...selectedLead,
            sentMessages: [...selectedLead.sentMessages, {
              day: `D${selectedDay + 1}`, label: FUNNEL[selectedDay]?.label || 'Message',
              message: generatedMessage, channel: 'WhatsApp', sentAt: Date.now(),
            }],
          }
          await saveLeadToDb(updatedLead)
          addNotification('Message sent on WhatsApp', 'success')
        } else throw new Error(result.error)
      } else if (channel === 'email') {
        let emailResult: { success: boolean; error?: string } = { success: false, error: 'No email provider configured' }
        if (settings.gmailAppPassword || settings.resendKey) {
          if (settings.gmailAppPassword) {
            const res = await fetch('/api/send-email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: selectedLead.email, subject: 'Message from EduAbroad', html: generatedMessage.replace(/\n/g, '<br>'), from: settings.gasSender || 'goeduabroadonline@gmail.com', appPassword: settings.gmailAppPassword }) })
            if (!res.ok) throw new Error(`Email API error: ${res.statusText}`)
            emailResult = await res.json()
          } else {
            emailResult = await sendResendEmail(settings.resendKey, selectedLead.email, 'Message from EduAbroad', generatedMessage)
          }
        } else if (settings.gasUrl) {
          emailResult = await sendGmail(settings.gasUrl, selectedLead, generatedMessage, 'Message from EduAbroad')
        }
        if (emailResult.success) {
          const updatedLead = {
            ...selectedLead,
            sentMessages: [...selectedLead.sentMessages, {
              day: `D${selectedDay + 1}`, label: FUNNEL[selectedDay]?.label || 'Message',
              message: generatedMessage, channel: 'Email', sentAt: Date.now(),
            }],
          }
          await saveLeadToDb(updatedLead)
          addNotification('Email sent via ' + (settings.gmailAppPassword ? 'Gmail' : 'Resend'), 'success')
        } else throw new Error(emailResult.error)
      } else {
        triggerWAFallback(selectedLead.phone, generatedMessage)
        addNotification('Open WhatsApp to send message', 'info')
      }
      setGeneratedMessage('')
    } catch (error) {
      console.error('Send failed:', error)
      addNotification('Failed to send message', 'error')
    }
  }

  // Theme toggle
  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)
    document.documentElement.classList.toggle('dark')
    const newSettings = { ...settings, theme: newTheme as 'dark' | 'light' }
    setSettings(newSettings)
    saveSettingsToDb(newSettings)
  }

  // Toggle bulk select
  const toggleLeadSelection = (id: string) => {
    setSelectedLeadIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllFiltered = () => {
    setSelectedLeadIds(new Set(filteredLeads.map(l => l.id)))
  }

  const deselectAll = () => {
    setSelectedLeadIds(new Set())
  }

  // ────────────────── RENDER ──────────────────
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner"></div>
        <div className="loading-text">Loading CRM...</div>
      </div>
    )
  }

  if (!user) return <LoginScreen onLogin={handleLogin} />

  return (
    <div className="app">
      {/* Topbar */}
      <div className="topbar">
        <div className="topbar-left">
          <a href="#" className="logo">EduAbroad</a>
          <div className="nav-tabs">
            {['dashboard', 'leads', 'followups', 'ghost', 'commsai', 'analytics', 'settings'].map(tab => (
              <button
                key={tab}
                className={`nav-tab ${currentView === tab ? 'active' : ''}`}
                onClick={() => setCurrentView(tab)}
              >
                {tab === 'commsai' ? 'Comms AI' : tab === 'followups' ? 'Follow-ups' : tab === 'ghost' ? 'Ghost Leads' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="topbar-right">
          <input
            type="text"
            placeholder="Gemini API Key"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            className="form-input"
            style={{ width: '180px' }}
          />
          <button className="csv-import-btn" onClick={() => setShowCSVModal(true)}>Import CSV</button>
          <button className="csv-import-btn" onClick={handleCSVExport}>Export CSV</button>
          <button className="theme-toggle" onClick={toggleTheme}>
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <div className="user-badge">{user.email}</div>
          <button className="logout-btn" onClick={handleLogout}>Logout</button>
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">
        {/* Sidebar */}
        {currentView !== 'dashboard' && currentView !== 'analytics' && currentView !== 'ghost' && (
          <div className="sidebar">
            <input
              type="text"
              placeholder="Search leads..."
              className="search-box"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />

            <div className="filter-group">
              <label className="filter-label">Stage</label>
              <div className="filter-options">
                <button className={`filter-option ${activeStageFilter === 'all' ? 'active' : ''}`} onClick={() => setActiveStageFilter('all')}>All</button>
                {STAGES.map(stage => (
                  <button key={stage} className={`filter-option ${activeStageFilter === stage ? 'active' : ''}`} onClick={() => setActiveStageFilter(stage)}>
                    {stage}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <label className="filter-label">Sort</label>
              <div className="filter-options">
                {['date', 'heat', 'score', 'name'].map(sort => (
                  <button key={sort} className={`filter-option ${activeSort === sort ? 'active' : ''}`} onClick={() => setActiveSort(sort)}>
                    {sort.charAt(0).toUpperCase() + sort.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            <div className="filter-group">
              <label className="filter-label">Date</label>
              <div className="filter-options">
                {[{ key: 'all', label: 'All' }, { key: 'today', label: 'Today' }, { key: 'week', label: 'This Week' }, { key: 'month', label: 'This Month' }, { key: 'custom', label: 'Custom' }].map(df => (
                  <button key={df.key} className={`filter-option ${dateFilter === df.key ? 'active' : ''}`} onClick={() => { setDateFilter(df.key); if (df.key !== 'custom') { setCustomDateFrom(''); setCustomDateTo('') } }}>
                    {df.label}
                  </button>
                ))}
              </div>
              {dateFilter === 'custom' && (
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>From</label>
                  <input type="date" className="form-input" value={customDateFrom} onChange={e => setCustomDateFrom(e.target.value)} style={{ padding: '4px 6px', fontSize: '11px', width: '130px' }} />
                  <label style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>To</label>
                  <input type="date" className="form-input" value={customDateTo} onChange={e => setCustomDateTo(e.target.value)} style={{ padding: '4px 6px', fontSize: '11px', width: '130px' }} />
                  {(customDateFrom || customDateTo) && (
                    <button className="filter-option" onClick={() => { setCustomDateFrom(''); setCustomDateTo('') }} style={{ fontSize: '10px', padding: '2px 6px' }}>Clear</button>
                  )}
                </div>
              )}
            </div>

            {/* Bulk select controls */}
            {filteredLeads.length > 0 && (
              <div style={{ display: 'flex', gap: '4px', padding: '0 8px', marginBottom: '6px' }}>
                <button className="filter-option" onClick={selectAllFiltered} style={{ fontSize: '11px' }}>Select All</button>
                {selectedLeadIds.size > 0 && (
                  <>
                    <button className="filter-option" onClick={deselectAll} style={{ fontSize: '11px' }}>Clear ({selectedLeadIds.size})</button>
                    <button className="filter-option active" onClick={() => setShowBulkActions(true)} style={{ fontSize: '11px' }}>Bulk Actions</button>
                  </>
                )}
              </div>
            )}

            <div className="lead-list">
              {filteredLeads.map(lead => {
                const lastConv = lead.conversations?.length > 0 ? lead.conversations[lead.conversations.length - 1] : null
                const totalRemarks = (lead.conversations?.length || 0) + (lead.sentMessages?.length || 0) + (lead.callTranscripts?.length || 0)
                return (
                <div
                  key={lead.id}
                  className={`lead-item ${selectedId === lead.id ? 'selected' : ''}`}
                  onClick={() => { setSelectedId(lead.id); if (currentView === 'followups') setCurrentView('leads') }}
                  style={{ flexDirection: 'column', alignItems: 'stretch', gap: '4px' }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <input
                        type="checkbox"
                        checked={selectedLeadIds.has(lead.id)}
                        onChange={e => { e.stopPropagation(); toggleLeadSelection(lead.id) }}
                        onClick={e => e.stopPropagation()}
                        style={{ accentColor: '#4caf50' }}
                      />
                      <div>
                        <div className="lead-item-name">{lead.name}</div>
                        <div className="lead-item-meta">
                          {lead.city} {lead.phone && `• ${lead.phone}`}
                          {lead.assignedTo && <span style={{ color: '#81d4fa' }}> [{lead.assignedTo}]</span>}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                      <span style={{
                        fontSize: '10px', padding: '2px 6px', borderRadius: '8px',
                        background: STAGE_COLORS[lead.stage] || '#666', color: '#000'
                      }}>
                        {lead.stage}
                      </span>
                      <span style={{
                        fontSize: '10px', padding: '2px 4px',
                        color: lead.score >= 80 ? '#4caf50' : lead.score >= 50 ? '#ff9800' : '#f44336'
                      }}>
                        {lead.score}
                      </span>
                    </div>
                  </div>
                  {/* Date + Activity count */}
                  <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', paddingLeft: '28px', display: 'flex', gap: '8px' }}>
                    <span>{lead.createdAt ? formatDate(lead.createdAt) : 'No date'}</span>
                    {totalRemarks > 0 && <span style={{ color: '#81d4fa' }}>{totalRemarks} interactions</span>}
                  </div>
                  {/* Follow-up info */}
                  {lead.followUpAt > 0 && (
                    <div style={{ fontSize: '10px', paddingLeft: '28px', color: lead.followUpAt < Date.now() ? '#f44336' : '#4caf50' }}>
                      Follow-up: {formatDate(lead.followUpAt)} {lead.followUpNote ? `— ${lead.followUpNote.substring(0, 40)}` : ''}
                    </div>
                  )}
                  {/* Notes snippet */}
                  {lead.notes && (
                    <div style={{ fontSize: '10px', paddingLeft: '28px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Notes: {lead.notes.substring(0, 50)}{lead.notes.length > 50 ? '...' : ''}
                    </div>
                  )}
                  {/* Last conversation snippet */}
                  {lastConv && (
                    <div style={{ fontSize: '10px', paddingLeft: '28px', color: '#af0100', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      Last: {lastConv.type === 'incoming' ? '📥' : '📤'} {lastConv.content.substring(0, 45)}{lastConv.content.length > 45 ? '...' : ''}
                    </div>
                  )}
                  {/* Drip status */}
                  {lead.stage !== 'Enrolled / Flew' && (
                    <div style={{ fontSize: '10px', paddingLeft: '28px', display: 'flex', gap: '2px', alignItems: 'center' }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>Drip:</span>
                      {Array.from({ length: 10 }, (_, i) => (
                        <div key={i} style={{ width: '6px', height: '6px', borderRadius: '50%', background: i < (lead.dripCount || 0) ? '#4caf50' : 'var(--border)' }} />
                      ))}
                      <span style={{ color: 'var(--text-tertiary)', marginLeft: '2px' }}>{lead.dripCount || 0}/10</span>
                    </div>
                  )}
                </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Content Area */}
        <div className="content-area">
          {currentView === 'dashboard' && (
            <DashboardView
              leads={leads}
              settings={settings}
              onNewLead={() => { setFormData({}); setSelectedId(null); setShowAddLeadModal(true) }}
              onViewLeads={() => setCurrentView('leads')}
            />
          )}

          {currentView === 'leads' && selectedLead && (
            <LeadsDetailView
              lead={selectedLead}
              settings={settings}
              apiKey={apiKey}
              generatedMessage={generatedMessage}
              isGenerating={isGenerating}
              selectedDay={selectedDay}
              selectedTone={selectedTone}
              onUpdateLead={saveLeadToDb}
              onDeleteLead={() => deleteLeadFromDb(selectedLead.id)}
              onGenerateMessage={generateMessage}
              onSendMessage={handleSendMessage}
              onEditLeadClick={() => {
                setFormData(selectedLead)
                setShowAddLeadModal(true)
              }}
              onEnrollClick={() => setShowEnrollModal(true)}
              onEditDay={d => setSelectedDay(d)}
              onEditTone={t => setSelectedTone(t)}
              onMessageChange={m => setGeneratedMessage(m)}
              onShowBulkSequence={() => setShowBulkSequenceModal(true)}
              onShowCallAssistant={() => setShowCallAssistantModal(true)}
              addNotification={addNotification}
            />
          )}

          {currentView === 'leads' && !selectedLead && (
            <div style={{ padding: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>All Leads ({filteredLeads.length})</div>
                <button className="lead-action-btn" onClick={() => { setFormData({}); setSelectedId(null); setShowAddLeadModal(true) }}>+ Add New Lead</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '1rem' }}>
                {filteredLeads.map(lead => {
                  const lastConv = lead.conversations?.length > 0 ? lead.conversations[lead.conversations.length - 1] : null
                  const totalActivity = (lead.conversations?.length || 0) + (lead.sentMessages?.length || 0) + (lead.callTranscripts?.length || 0)
                  return (
                  <div key={lead.id} onClick={() => setSelectedId(lead.id)} style={{
                    padding: '1rem', background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                    borderRadius: '0.75rem', cursor: 'pointer', transition: 'all 0.3s'
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ fontWeight: 600 }}>{lead.name}</div>
                      <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{lead.createdAt ? formatDate(lead.createdAt) : ''}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{lead.phone} • {lead.email}</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>{(lead.destinationCountries || []).join(', ')} • {lead.city}</div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
                      <span style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '8px', background: STAGE_COLORS[lead.stage] || '#af0100', color: '#000', fontWeight: 600 }}>{lead.stage}</span>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        {totalActivity > 0 && <span style={{ fontSize: '10px', color: '#81d4fa' }}>{totalActivity} interactions</span>}
                        <span style={{ fontSize: '12px', color: lead.score >= 80 ? '#4caf50' : lead.score >= 50 ? '#ff9800' : '#f44336' }}>Score: {lead.score}</span>
                      </div>
                    </div>
                    {lead.assignedTo && <div style={{ fontSize: '11px', color: '#81d4fa', marginTop: '4px' }}>Assigned: {lead.assignedTo}</div>}

                    {/* Notes / Remarks */}
                    {lead.notes && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '6px', padding: '6px 8px', background: 'var(--card-bg)', borderRadius: '6px', borderLeft: '3px solid #af0100' }}>
                        <span style={{ fontWeight: 600, color: '#af0100' }}>Notes:</span> {lead.notes.substring(0, 100)}{lead.notes.length > 100 ? '...' : ''}
                      </div>
                    )}

                    {/* Follow-up info */}
                    {lead.followUpAt > 0 && (
                      <div style={{ fontSize: '11px', marginTop: '4px', padding: '4px 8px', borderRadius: '6px', background: lead.followUpAt < Date.now() ? 'rgba(244,67,54,0.1)' : 'rgba(76,175,80,0.1)', borderLeft: `3px solid ${lead.followUpAt < Date.now() ? '#f44336' : '#4caf50'}` }}>
                        <span style={{ fontWeight: 600, color: lead.followUpAt < Date.now() ? '#f44336' : '#4caf50' }}>
                          {lead.followUpAt < Date.now() ? 'Overdue' : 'Follow-up'}:
                        </span>{' '}
                        {formatDate(lead.followUpAt)} {formatTime(lead.followUpAt)}
                        {lead.followUpNote && <span> — {lead.followUpNote.substring(0, 60)}{lead.followUpNote.length > 60 ? '...' : ''}</span>}
                      </div>
                    )}

                    {/* Last conversation */}
                    {lastConv && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', padding: '4px 8px', background: 'var(--card-bg)', borderRadius: '6px', borderLeft: '3px solid #64b5f6' }}>
                        <span style={{ fontWeight: 600, color: '#64b5f6' }}>
                          {lastConv.type === 'incoming' ? '📥 Last received' : '📤 Last sent'} ({lastConv.channel}):
                        </span>{' '}
                        {lastConv.content.substring(0, 80)}{lastConv.content.length > 80 ? '...' : ''}
                        <div style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{lastConv.timestamp ? formatDate(lastConv.timestamp) + ' ' + formatTime(lastConv.timestamp) : ''}</div>
                      </div>
                    )}

                    {/* Recent call transcript summary */}
                    {lead.callTranscripts?.length > 0 && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px', padding: '4px 8px', background: 'var(--card-bg)', borderRadius: '6px', borderLeft: '3px solid #ce93d8' }}>
                        <span style={{ fontWeight: 600, color: '#ce93d8' }}>📞 Last call:</span>{' '}
                        {lead.callTranscripts[lead.callTranscripts.length - 1].summary?.substring(0, 80)}
                        {lead.callTranscripts[lead.callTranscripts.length - 1].objections?.length > 0 && (
                          <span style={{ color: '#ff9800' }}> | Objections: {lead.callTranscripts[lead.callTranscripts.length - 1].objections.join(', ')}</span>
                        )}
                      </div>
                    )}

                    {/* Drip status */}
                    <div style={{ display: 'flex', gap: '2px', alignItems: 'center', marginTop: '6px' }}>
                      <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', marginRight: '4px' }}>Drip:</span>
                      {Array.from({ length: 10 }, (_, i) => (
                        <div key={i} style={{ width: '8px', height: '8px', borderRadius: '50%', background: i < (lead.dripCount || 0) ? '#4caf50' : 'var(--border)' }} />
                      ))}
                      <span style={{ fontSize: '10px', color: lead.stage === 'Enrolled / Flew' ? '#4caf50' : 'var(--text-tertiary)', marginLeft: '4px' }}>
                        {lead.stage === 'Enrolled / Flew' ? 'Enrolled ✓' : `${lead.dripCount || 0}/10`}
                      </span>
                    </div>
                  </div>
                  )
                })}
              </div>
            </div>
          )}

          {currentView === 'followups' && (
            <FollowUpsView
              leads={leads}
              onSelectLead={id => { setSelectedId(id); setCurrentView('leads') }}
            />
          )}

          {currentView === 'ghost' && (
            <GhostLeadsView
              leads={leads}
              onSelectLead={id => { setSelectedId(id); setCurrentView('leads') }}
              onResurrect={async (lead: Lead) => {
                const updated: Lead = {
                  ...lead,
                  zombieResurrected: true,
                  zombieAttempts: (lead.zombieAttempts || 0) + 1,
                  lastZombieAt: Date.now(),
                  followUpAt: Date.now(),
                  followUpNote: `Zombie resurrection #${(lead.zombieAttempts || 0) + 1}`,
                }
                const scoreResult = calculateLeadScore(updated)
                updated.score = scoreResult.score
                updated.scoreLabel = scoreResult.label
                updated.scoreReason = scoreResult.reason
                await saveLeadToDb(updated)
                addNotification(`${lead.name} resurrected! Follow-up scheduled.`, 'success')
              }}
              onBulkResurrect={async (ghostLeads: Lead[]) => {
                for (const lead of ghostLeads) {
                  const updated: Lead = {
                    ...lead,
                    zombieResurrected: true,
                    zombieAttempts: (lead.zombieAttempts || 0) + 1,
                    lastZombieAt: Date.now(),
                    followUpAt: Date.now(),
                    followUpNote: `Zombie resurrection #${(lead.zombieAttempts || 0) + 1}`,
                  }
                  const scoreResult = calculateLeadScore(updated)
                  updated.score = scoreResult.score
                  updated.scoreLabel = scoreResult.label
                  updated.scoreReason = scoreResult.reason
                  await saveLeadToDb(updated)
                }
                addNotification(`${ghostLeads.length} leads resurrected!`, 'success')
              }}
            />
          )}

          {currentView === 'commsai' && (
            <CommsAIView
              leads={leads}
              selectedId={selectedId}
              generatedMessage={generatedMessage}
              isGenerating={isGenerating}
              apiKey={apiKey}
              onSelectLead={setSelectedId}
              onGeneratePersonalised={async (objective: string, tone: string) => {
                const lead = leads.find(l => l.id === selectedId)
                if (!lead || !apiKey) { addNotification('Select a lead and enter API key', 'error'); return }
                setIsGenerating(true)
                try {
                  const prompt = buildPersonalisedPrompt(lead, objective, tone)
                  const message = await callGemini(prompt, apiKey)
                  setGeneratedMessage(message)
                } catch (error) {
                  addNotification('Generation failed', 'error')
                } finally { setIsGenerating(false) }
              }}
              onGenerateEmail={async () => {
                const lead = leads.find(l => l.id === selectedId)
                if (!lead || !apiKey) { addNotification('Select a lead and enter API key', 'error'); return }
                setIsGenerating(true)
                try {
                  const prompt = buildEmailPrompt(lead)
                  const message = await callGemini(prompt, apiKey)
                  setGeneratedMessage(message)
                } catch (error) {
                  addNotification('Generation failed', 'error')
                } finally { setIsGenerating(false) }
              }}
              onSendMessage={handleSendMessage}
              onMessageChange={setGeneratedMessage}
            />
          )}

          {currentView === 'analytics' && (
            <AnalyticsView leads={leads} settings={settings} />
          )}

          {currentView === 'settings' && (
            <SettingsView
              settings={settings}
              onSaveSettings={saveSettingsToDb}
              onAddSource={() => setShowAddSourceModal(true)}
            />
          )}
        </div>
      </div>

      {/* ────── MODALS ────── */}

      {showAddLeadModal && (
        <AddLeadModal
          lead={selectedLead}
          settings={settings}
          onClose={() => { setShowAddLeadModal(false); setFormData({}) }}
          onSave={handleSaveLead}
          onFormChange={setFormData}
          formData={formData}
        />
      )}

      {showCSVModal && (
        <CSVImportModal
          onClose={() => setShowCSVModal(false)}
          onImport={handleCSVImport}
          onFileSelect={setCSVFile}
        />
      )}

      {showEnrollModal && selectedLead && (
        <EnrollModal
          lead={selectedLead}
          onClose={() => setShowEnrollModal(false)}
          onEnroll={handleEnroll}
        />
      )}

      {showAddSourceModal && (
        <AddSourceModal
          settings={settings}
          onClose={() => setShowAddSourceModal(false)}
          onSave={async (source: string) => {
            const newSettings = { ...settings, sources: [...(settings.sources || []), source] }
            await saveSettingsToDb(newSettings)
            setShowAddSourceModal(false)
          }}
        />
      )}

      {showCallAssistantModal && selectedLead && (
        <CallAssistantModal
          lead={selectedLead}
          onClose={() => setShowCallAssistantModal(false)}
          onSaveTranscript={async (transcript: CallTranscript) => {
            const updated = {
              ...selectedLead,
              callTranscripts: [...(selectedLead.callTranscripts || []), transcript],
            }
            const scoreResult = calculateLeadScore(updated)
            updated.score = scoreResult.score
            updated.scoreLabel = scoreResult.label
            updated.scoreReason = scoreResult.reason
            await saveLeadToDb(updated)
            setShowCallAssistantModal(false)
          }}
        />
      )}

      {showBulkSequenceModal && (
        <BulkSequenceModal
          leads={selectedLeadIds.size > 0 ? leads.filter(l => selectedLeadIds.has(l.id)) : (selectedLead ? [selectedLead] : [])}
          apiKey={apiKey}
          settings={settings}
          onClose={() => setShowBulkSequenceModal(false)}
          onSendComplete={async (updatedLeads: Lead[]) => {
            for (const lead of updatedLeads) await saveLeadToDb(lead)
            setShowBulkSequenceModal(false)
            addNotification(`Bulk sequence sent to ${updatedLeads.length} leads`, 'success')
          }}
        />
      )}

      {showBulkActions && (
        <BulkActionsModal
          count={selectedLeadIds.size}
          settings={settings}
          onClose={() => setShowBulkActions(false)}
          onChangeStage={bulkChangeStage}
          onDelete={bulkDeleteLeads}
          onAssign={bulkAssign}
          onBulkSequence={() => { setShowBulkActions(false); setShowBulkSequenceModal(true) }}
        />
      )}

      {/* Notifications */}
      <div style={{ position: 'fixed', top: '70px', right: '20px', zIndex: 9999, display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {notifications.map(notif => (
          <div key={notif.id} className={`notification ${notif.type}`}>
            {notif.message}
          </div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// LOGIN SCREEN
// ═══════════════════════════════════════════════════════════
function LoginScreen({ onLogin }: { onLogin: (email: string, password: string) => Promise<void> }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setErrorMsg('')
    try { await onLogin(email, password) }
    catch (err: any) { setErrorMsg(err?.message || 'Login failed') }
    finally { setIsLoading(false) }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-title">EduAbroad</div>
        <div className="login-subtitle">Sign in to continue</div>
        <form className="login-form" onSubmit={handleSubmit}>
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} className="login-input" required />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} className="login-input" required />
          {errorMsg && <div style={{ color: '#ff6b6b', fontSize: '14px', marginBottom: '8px' }}>{errorMsg}</div>}
          <button type="submit" className="login-btn" disabled={isLoading}>
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// DASHBOARD VIEW
// ═══════════════════════════════════════════════════════════
function DashboardView({ leads, settings, onNewLead, onViewLeads }: {
  leads: Lead[]; settings: Settings; onNewLead: () => void; onViewLeads: () => void
}) {
  const [dashDateFilter, setDashDateFilter] = useState('all')
  const [dashDateFrom, setDashDateFrom] = useState('')
  const [dashDateTo, setDashDateTo] = useState('')

  // Filter leads based on dashboard date filter
  const filtered = useMemo(() => {
    if (dashDateFilter === 'all') return leads
    let result = [...leads]
    if (dashDateFilter === 'custom') {
      if (dashDateFrom) {
        const from = new Date(dashDateFrom).getTime()
        result = result.filter(l => l.createdAt >= from)
      }
      if (dashDateTo) {
        const to = new Date(dashDateTo).getTime() + 86400000
        result = result.filter(l => l.createdAt <= to)
      }
    } else {
      const now = new Date()
      let cutoff = 0
      if (dashDateFilter === 'today') cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      else if (dashDateFilter === 'week') cutoff = Date.now() - 7 * 86400000
      else if (dashDateFilter === 'month') cutoff = Date.now() - 30 * 86400000
      else if (dashDateFilter === '3months') cutoff = Date.now() - 90 * 86400000
      result = result.filter(l => l.createdAt >= cutoff)
    }
    return result
  }, [leads, dashDateFilter, dashDateFrom, dashDateTo])

  const dateLabel = dashDateFilter === 'all' ? 'All time' : dashDateFilter === 'today' ? 'Today' : dashDateFilter === 'week' ? 'This week' : dashDateFilter === 'month' ? 'Last 30 days' : dashDateFilter === '3months' ? 'Last 90 days' : dashDateFrom || dashDateTo ? `${dashDateFrom || '...'} → ${dashDateTo || '...'}` : 'Custom range'

  const stats = {
    total: filtered.length,
    hot: filtered.filter(l => daysSince(l.followUpAt || l.createdAt) <= 3 && l.stage !== 'Enrolled / Flew').length,
    enrolled: filtered.filter(l => l.stage === 'Enrolled / Flew').length,
    avgScore: filtered.length > 0 ? Math.round(filtered.reduce((s, l) => s + l.score, 0) / filtered.length) : 0,
    feeCollected: filtered.filter(l => l.stage === 'Enrolled' && l.feeAmount > 0).reduce((sum, l) => sum + l.feeAmount, 0),
    feePending: filtered.filter(l => l.stage === 'Offer Accepted' && l.feeAmount > 0 && l.enrolledAt === 0).length,
  }

  const stageCounts: Record<string, number> = {}
  STAGES.forEach(s => { stageCounts[s] = filtered.filter(l => l.stage === s).length })

  const sourceCounts: Record<string, number> = {}
  filtered.forEach(l => { sourceCounts[l.source] = (sourceCounts[l.source] || 0) + 1 })

  return (
    <div className="dashboard">
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
          <div className="greeting">Welcome back!</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
              {[{ key: 'all', label: 'All' }, { key: 'today', label: 'Today' }, { key: 'week', label: 'Week' }, { key: 'month', label: '30d' }, { key: '3months', label: '90d' }, { key: 'custom', label: 'Custom' }].map(df => (
                <button key={df.key} className={`filter-option ${dashDateFilter === df.key ? 'active' : ''}`} onClick={() => { setDashDateFilter(df.key); if (df.key !== 'custom') { setDashDateFrom(''); setDashDateTo('') } }}
                  style={{ fontSize: '11px', padding: '3px 8px' }}>
                  {df.label}
                </button>
              ))}
            </div>
            {dashDateFilter === 'custom' && (
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>From</label>
                <input type="date" className="form-input" value={dashDateFrom} onChange={e => setDashDateFrom(e.target.value)} style={{ padding: '3px 6px', fontSize: '11px', width: '130px' }} />
                <label style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>To</label>
                <input type="date" className="form-input" value={dashDateTo} onChange={e => setDashDateTo(e.target.value)} style={{ padding: '3px 6px', fontSize: '11px', width: '130px' }} />
                {(dashDateFrom || dashDateTo) && (
                  <button className="filter-option" onClick={() => { setDashDateFrom(''); setDashDateTo('') }} style={{ fontSize: '10px', padding: '2px 6px' }}>Clear</button>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="stats-row">
          <div className="stat-card"><div className="stat-label">Total Leads</div><div className="stat-value">{stats.total}</div><div className="stat-subtext">{dateLabel}</div></div>
          <div className="stat-card"><div className="stat-label">Hot Leads</div><div className="stat-value">{stats.hot}</div><div className="stat-subtext">Due within 3 days</div></div>
          <div className="stat-card"><div className="stat-label">Enrolled</div><div className="stat-value">{stats.enrolled}</div><div className="stat-subtext">Converted</div></div>
          <div className="stat-card"><div className="stat-label">Avg Score</div><div className="stat-value">{stats.avgScore}</div><div className="stat-subtext">Lead quality</div></div>
          <div className="stat-card"><div className="stat-label">Fee Collected</div><div className="stat-value" style={{ color: '#4caf50' }}>₹{stats.feeCollected.toLocaleString()}</div><div className="stat-subtext">From enrolled leads</div></div>
          <div className="stat-card"><div className="stat-label">Payment Pending</div><div className="stat-value" style={{ color: '#ff9800' }}>{stats.feePending}</div><div className="stat-subtext">Awaiting payment</div></div>
        </div>
      </div>

      <div className="funnel">
        <div className="funnel-title">Pipeline Funnel {dashDateFilter !== 'all' && <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', fontWeight: 400 }}>({dateLabel})</span>}</div>
        <div className="funnel-stages">
          {STAGES.map(stage => (
            <div key={stage} className="funnel-stage">
              <div className="funnel-stage-name">{stage}</div>
              <div className="funnel-stage-count">{stageCounts[stage] || 0}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="pipeline-section">
        <div className="section-title">Top Sources {dashDateFilter !== 'all' && <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontWeight: 400 }}>({dateLabel})</span>}</div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([src, count]) => (
            <div key={src} style={{ background: 'var(--card-bg)', padding: '8px 14px', borderRadius: '8px', fontSize: '13px' }}>
              {src}: <strong>{count}</strong>
            </div>
          ))}
        </div>
      </div>

      <div className="action-items">
        <div className="action-items-title">Action Items</div>
        {filtered.filter(l => l.stage !== 'Enrolled / Flew' && daysSince(l.followUpAt || l.createdAt) > 0).slice(0, 5).map(lead => (
          <div key={lead.id} className="action-item">
            <div className="action-item-lead">Follow up with {lead.name}</div>
            <div className="action-item-note">{lead.followUpNote || 'No notes'}</div>
            <div className="action-item-time">{daysSince(lead.followUpAt || lead.createdAt)} days overdue</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="lead-action-btn" onClick={onNewLead}>Add New Lead</button>
        <button className="lead-action-btn" onClick={onViewLeads}>View All Leads</button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// LEADS DETAIL VIEW
// ═══════════════════════════════════════════════════════════
function LeadsDetailView({
  lead, settings, apiKey, generatedMessage, isGenerating, selectedDay, selectedTone,
  onUpdateLead, onDeleteLead, onGenerateMessage, onSendMessage,
  onEditLeadClick, onEnrollClick, onEditDay, onEditTone, onMessageChange,
  onShowBulkSequence, onShowCallAssistant, addNotification,
}: any) {
  const [followUpDate, setFollowUpDate] = useState('')
  const [followUpTime, setFollowUpTime] = useState('')
  const [followUpNote, setFollowUpNote] = useState('')
  const [showPreview, setShowPreview] = useState(false)
  const [showAddConv, setShowAddConv] = useState(false)
  const [newRemark, setNewRemark] = useState('')
  const [newConvType, setNewConvType] = useState<'incoming' | 'outgoing' | 'system'>('incoming')
  const [newConvChannel, setNewConvChannel] = useState<'WhatsApp' | 'Email' | 'Call' | 'SMS' | 'Web'>('WhatsApp')
  const [newConvContent, setNewConvContent] = useState('')

  return (
    <div className="leads-detail">
      <div className="lead-header">
        <div>
          <div className="lead-name">{lead.name}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            Score: {lead.score}/100 ({lead.scoreLabel}) {lead.assignedTo && `| Assigned: ${lead.assignedTo}`}
          </div>
        </div>
        <div className="lead-actions">
          <button className="lead-action-btn" onClick={onEditLeadClick}>Edit</button>
          <button className="lead-action-btn" onClick={onEnrollClick}>Enroll</button>
          <button className="lead-action-btn" onClick={onShowCallAssistant}>Call</button>
          <button className="lead-action-btn" onClick={onShowBulkSequence}>Sequence</button>
          <button className="lead-action-btn" onClick={() => { if (confirm('Delete this lead?')) onDeleteLead() }}>Delete</button>
        </div>
      </div>

      <div className="lead-info-card">
        <div className="info-row">
          <div className="info-field"><div className="info-label">Phone</div><div className="info-value">{lead.phone}</div></div>
          <div className="info-field"><div className="info-label">Email</div><div className="info-value">{lead.email}</div></div>
          <div className="info-field"><div className="info-label">City</div><div className="info-value">{lead.city}</div></div>
        </div>
        <div className="info-row">
          <div className="info-field"><div className="info-label">Intended Degree</div><div className="info-value">{lead.intendedDegree || '-'}</div></div>
          <div className="info-field"><div className="info-label">Current Education</div><div className="info-value">{lead.currentEducation || '-'}</div></div>
          <div className="info-field"><div className="info-label">Target Intake</div><div className="info-value">{lead.targetIntake || '-'}</div></div>
        </div>
        <div className="info-row">
          <div className="info-field"><div className="info-label">Destination Countries</div><div className="info-value">{(lead.destinationCountries || []).join(', ') || '-'}</div></div>
          <div className="info-field"><div className="info-label">Source</div><div className="info-value">{lead.source}</div></div>
          <div className="info-field"><div className="info-label">Budget</div><div className="info-value">{lead.budget || '-'}</div></div>
        </div>
        <div className="info-row">
          <div className="info-field"><div className="info-label">Parent Name</div><div className="info-value">{lead.parentName || '-'}</div></div>
          <div className="info-field"><div className="info-label">Assigned To</div>
            <select
              className="form-input"
              value={lead.assignedTo || ''}
              onChange={async e => await onUpdateLead({ ...lead, assignedTo: e.target.value })}
              style={{ padding: '4px', fontSize: '13px' }}
            >
              <option value="">Unassigned</option>
              {settings.team?.map((m: TeamMember) => <option key={m.name} value={m.name}>{m.name}</option>)}
            </select>
          </div>
          <div className="info-field"><div className="info-label">Score Reason</div><div className="info-value" style={{ fontSize: '11px' }}>{lead.scoreReason || '-'}</div></div>
        </div>
        {lead.feeAmount > 0 && (
          <div className="info-row">
            <div className="info-field"><div className="info-label">Fee Amount</div><div className="info-value">Rs. {lead.feeAmount}</div></div>
            <div className="info-field"><div className="info-label">Payment Link</div><div className="info-value"><a href={lead.paymentLink} target="_blank" rel="noreferrer" style={{ color: '#81d4fa' }}>{lead.paymentLink || '-'}</a></div></div>
            <div className="info-field"><div className="info-label">Enrolled</div><div className="info-value">{lead.enrolledAt ? formatDate(lead.enrolledAt) : '-'}</div></div>
          </div>
        )}
        {lead.notes && <div style={{ padding: '8px 0', fontSize: '13px', color: 'var(--text-secondary)' }}>Notes: {lead.notes}</div>}
      </div>

      {/* Remarks Section */}
      <div className="pipeline-section">
        <div className="section-title">Remarks ({lead.remarks?.length || 0})</div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <input
            type="text"
            className="form-input"
            placeholder="Add a remark after talking to the lead..."
            value={newRemark}
            onChange={e => setNewRemark(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && newRemark.trim()) {
                const entry = { text: newRemark.trim(), by: lead.assignedTo || 'You', date: Date.now() }
                onUpdateLead({ ...lead, remarks: [...(lead.remarks || []), entry] })
                setNewRemark('')
                addNotification('Remark added', 'success')
              }
            }}
            style={{ flex: 1 }}
          />
          <button className="lead-action-btn" onClick={() => {
            if (!newRemark.trim()) return
            const entry = { text: newRemark.trim(), by: lead.assignedTo || 'You', date: Date.now() }
            onUpdateLead({ ...lead, remarks: [...(lead.remarks || []), entry] })
            setNewRemark('')
            addNotification('Remark added', 'success')
          }}>Add Remark</button>
        </div>
        {lead.remarks?.length > 0 ? (
          [...lead.remarks].reverse().map((r: any, idx: number) => (
            <div key={idx} style={{ padding: '10px', background: 'var(--card-bg)', borderRadius: '8px', marginBottom: '6px', borderLeft: '3px solid #af0100' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '4px' }}>
                <span style={{ fontWeight: 600, color: '#af0100' }}>{r.by || 'Team'}</span>
                <span>{r.date ? new Date(r.date).toLocaleDateString('en-IN') + ' ' + new Date(r.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text)' }}>{r.text}</div>
            </div>
          ))
        ) : (
          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>No remarks yet. Add one after talking to this lead.</div>
        )}
      </div>

      {/* Pipeline Stage */}
      <div className="pipeline-section">
        <div className="section-title">Pipeline Stage</div>
        <div className="stage-buttons">
          {STAGES.map(stage => (
            <button key={stage} className={`stage-btn ${lead.stage === stage ? 'active' : ''}`}
              onClick={async () => {
                if (stage === 'Enrolled / Flew') { onEnrollClick(); return }
                await onUpdateLead({ ...lead, stage })
              }}>
              {stage}
            </button>
          ))}
        </div>
      </div>

      {/* Email Drip Status */}
      <div className="pipeline-section">
        <div className="section-title">Email Drip Sequence ({lead.dripCount || 0}/10)</div>
        <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} style={{
              flex: 1, height: '8px', borderRadius: '4px',
              background: i < (lead.dripCount || 0) ? '#4caf50' : 'var(--border)',
              transition: 'background 0.3s',
            }} title={`Drip ${i + 1}${i < (lead.dripCount || 0) ? ' — Sent' : ' — Pending'}`} />
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {['Welcome', 'Study Abroad Checklist', 'Country Comparison', 'IELTS/TOEFL Guide', 'Scholarship Guide', 'Success Story', 'Budget Breakdown', 'SOP/LOR Guide', 'Parent ROI Email', 'Deadline Alert', 'Free Evaluation', 'Final Touch'].map((label, i) => (
            <div key={i} style={{
              fontSize: '10px', padding: '3px 8px', borderRadius: '12px',
              background: i < (lead.dripCount || 0) ? 'rgba(76,175,80,0.2)' : 'var(--card-bg)',
              color: i < (lead.dripCount || 0) ? '#4caf50' : 'var(--text-tertiary)',
              border: `1px solid ${i < (lead.dripCount || 0) ? '#4caf50' : 'var(--border)'}`,
            }}>
              {i < (lead.dripCount || 0) ? '✓' : `${i + 1}.`} {label}
            </div>
          ))}
        </div>
        {lead.lastDripAt > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '6px' }}>
            Last drip sent: {formatDate(lead.lastDripAt)} {formatTime(lead.lastDripAt)}
            {lead.stage !== 'Enrolled / Flew' && (lead.dripCount || 0) < 10 && (
              <span style={{ color: '#af0100' }}> — Next drip: #{(lead.dripCount || 0) + 1}</span>
            )}
          </div>
        )}
        {lead.stage === 'Enrolled / Flew' && <div style={{ fontSize: '11px', color: '#4caf50', marginTop: '4px' }}>Drip sequence stopped — Lead enrolled!</div>}
      </div>

      {/* Follow-up Scheduler */}
      <div className="pipeline-section">
        <div className="section-title">Schedule Follow-up</div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="date" className="form-input" value={followUpDate} onChange={e => setFollowUpDate(e.target.value)} style={{ width: '160px' }} />
          <input type="time" className="form-input" value={followUpTime} onChange={e => setFollowUpTime(e.target.value)} style={{ width: '120px' }} />
          <input type="text" className="form-input" placeholder="Follow-up note..." value={followUpNote} onChange={e => setFollowUpNote(e.target.value)} style={{ flex: 1, minWidth: '150px' }} />
          <button className="lead-action-btn" onClick={async () => {
            if (!followUpDate) return
            const dateTimeStr = followUpTime ? `${followUpDate}T${followUpTime}` : followUpDate
            const timestamp = new Date(dateTimeStr).getTime()
            await onUpdateLead({ ...lead, followUpAt: timestamp, followUpNote: followUpNote || lead.followUpNote })
            setFollowUpDate('')
            setFollowUpTime('')
            setFollowUpNote('')
            // Browser notification
            if ('Notification' in window && Notification.permission === 'granted') {
              const delay = timestamp - Date.now()
              if (delay > 0 && delay < 86400000) {
                setTimeout(() => {
                  new Notification('EduAbroad - Follow-up Due', { body: `Follow up with ${lead.name}: ${followUpNote || 'No note'}` })
                }, delay)
              }
            }
            addNotification(`Follow-up scheduled for ${followUpDate}${followUpTime ? ' at ' + followUpTime : ''}`, 'success')
          }}>Schedule</button>
        </div>
        {lead.followUpAt > 0 && <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '4px' }}>Current: {formatDate(lead.followUpAt)} {formatTime(lead.followUpAt)} - {lead.followUpNote}</div>}
      </div>

      {/* 9-Day Funnel */}
      <div className="pipeline-section">
        <div className="section-title">9-Day Funnel Timeline</div>
        <div className="funnel-timeline">
          {FUNNEL.map((day, idx) => {
            const sent = lead.sentMessages?.find((m: SentMessage) => m.day === day.day)
            return (
              <div key={idx} className="funnel-day" style={{ opacity: sent ? 0.6 : 1 }}>
                <div className="funnel-day-label">{day.day}</div>
                <div className="funnel-day-content">
                  <div className="funnel-day-action">{day.label} {sent && '(Sent)'}</div>
                  <div className="funnel-day-note">{day.obj}</div>
                </div>
                <div className="funnel-day-buttons">
                  <button className="funnel-btn" onClick={() => onEditDay(idx)}>Select</button>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Message Generator */}
      <div className="message-generator">
        <div className="section-title">Message Generator</div>
        <div className="generator-controls">
          <select className="generator-select" value={selectedDay} onChange={e => onEditDay(Number(e.target.value))}>
            {FUNNEL.map((day, idx) => <option key={idx} value={idx}>{day.day} - {day.label}</option>)}
          </select>
          <select className="generator-select" value={selectedTone} onChange={e => onEditTone(e.target.value)}>
            <option value="warm">Warm</option><option value="persuasive">Persuasive</option>
            <option value="urgent">Urgent</option><option value="educational">Educational</option>
          </select>
          <button className="copy-btn" onClick={onGenerateMessage} disabled={isGenerating}>
            {isGenerating ? 'Generating...' : 'Generate'}
          </button>
        </div>

        {generatedMessage && (
          <>
            <textarea
              className="form-input"
              value={generatedMessage}
              onChange={e => onMessageChange(e.target.value)}
              rows={5}
              style={{ width: '100%', marginTop: '8px', fontFamily: 'inherit' }}
            />
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', margin: '4px 0' }}>
              Preview: You can edit the message above before sending
            </div>
            <div className="output-buttons">
              <button className="copy-btn" onClick={() => { navigator.clipboard.writeText(generatedMessage); addNotification('Copied!', 'success') }}>Copy</button>
              <button className="send-btn" onClick={() => onSendMessage('whatsapp')}>WhatsApp</button>
              <button className="send-btn" onClick={() => onSendMessage('email')}>Email</button>
            </div>
          </>
        )}
      </div>

      {/* Activity Timeline */}
      <div className="pipeline-section">
        <div className="section-title">Activity Timeline</div>
        {(() => {
          const events: Array<{time: number; type: string; content: string; channel?: string}> = []
          lead.conversations?.forEach((c: ConvEntry) => {
            events.push({ time: c.timestamp, type: c.type === 'incoming' ? '📥 Incoming' : c.type === 'outgoing' ? '📤 Outgoing' : '⚙️ System', content: c.content, channel: c.channel })
          })
          lead.sentMessages?.forEach((m: SentMessage) => {
            events.push({ time: m.sentAt || m.timestamp || 0, type: '📨 Sent', content: `${m.day} - ${m.label}: ${(m.message || m.text || '').substring(0, 100)}...`, channel: m.channel })
          })
          lead.callTranscripts?.forEach((ct: CallTranscript) => {
            events.push({ time: ct.date, type: '📞 Call', content: `${ct.duration}min - ${ct.summary}`, channel: 'Call' })
          })
          events.sort((a, b) => b.time - a.time)
          if (events.length === 0) return <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>No activity yet</div>
          return events.slice(0, 20).map((ev, idx) => (
            <div key={idx} style={{ padding: '10px', borderLeft: '3px solid var(--amber)', background: 'var(--card-bg)', borderRadius: '0 8px 8px 0', marginBottom: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px' }}>
                <span style={{ fontWeight: 600, color: 'var(--amber)' }}>{ev.type}</span>
                <span style={{ color: 'var(--text-tertiary)' }}>
                  {ev.time ? new Date(ev.time).toLocaleDateString('en-IN') + ' ' + new Date(ev.time).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}
                </span>
              </div>
              {ev.channel && <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{ev.channel}</div>}
              <div style={{ fontSize: '13px', marginTop: '4px', color: 'var(--text)' }}>{ev.content}</div>
            </div>
          ))
        })()}
      </div>

      {/* Conversation Log */}
      <div className="conversation-log">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div className="section-title">Conversations ({lead.conversations?.length || 0})</div>
          <button className="lead-action-btn" onClick={() => setShowAddConv(true)} style={{ fontSize: '11px' }}>+ Add Entry</button>
        </div>
        {showAddConv && (
          <div style={{ padding: '10px', background: 'var(--card-bg)', borderRadius: '8px', marginBottom: '8px' }}>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
              <select className="form-input" value={newConvType} onChange={e => setNewConvType(e.target.value as any)} style={{ width: '120px' }}>
                <option value="incoming">Incoming</option><option value="outgoing">Outgoing</option><option value="system">System</option>
              </select>
              <select className="form-input" value={newConvChannel} onChange={e => setNewConvChannel(e.target.value as any)} style={{ width: '120px' }}>
                <option value="WhatsApp">WhatsApp</option><option value="Email">Email</option><option value="Call">Call</option><option value="SMS">SMS</option><option value="Web">Web</option>
              </select>
            </div>
            <textarea className="form-input" placeholder="Message content..." value={newConvContent} onChange={e => setNewConvContent(e.target.value)} rows={2} style={{ width: '100%', marginBottom: '6px' }} />
            <div style={{ display: 'flex', gap: '6px' }}>
              <button className="lead-action-btn" onClick={async () => {
                if (!newConvContent.trim()) return
                const entry: ConvEntry = { type: newConvType, content: newConvContent, channel: newConvChannel, timestamp: Date.now() }
                await onUpdateLead({ ...lead, conversations: [...(lead.conversations || []), entry] })
                setNewConvContent('')
                setShowAddConv(false)
                addNotification('Conversation entry added', 'success')
              }}>Save</button>
              <button className="lead-action-btn" onClick={() => setShowAddConv(false)}>Cancel</button>
            </div>
          </div>
        )}
        {lead.conversations?.length > 0 ? (
          lead.conversations.map((conv: ConvEntry, idx: number) => (
            <div key={idx} className={`conversation-entry ${conv.type === 'outgoing' ? 'outgoing' : ''}`}>
              <div className="entry-header">
                <span className="entry-type">{conv.type}</span>
                <span className="entry-channel">{conv.channel}</span>
                <span className="entry-time">{formatTime(conv.timestamp)}</span>
              </div>
              <div className="entry-content">{conv.content}</div>
            </div>
          ))
        ) : <div style={{ color: 'var(--text-tertiary)' }}>No conversations yet</div>}
      </div>

      {/* Sent Messages Log */}
      {lead.sentMessages?.length > 0 && (
        <div className="pipeline-section">
          <div className="section-title">Sent Messages ({lead.sentMessages.length})</div>
          {lead.sentMessages.map((msg: SentMessage, idx: number) => (
            <div key={idx} style={{ padding: '8px', background: 'var(--card-bg)', borderRadius: '8px', marginBottom: '6px', fontSize: '13px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>{msg.day} - {msg.label}</span>
                <span style={{ color: 'var(--text-tertiary)' }}>{msg.channel} | {msg.sentAt ? formatDate(msg.sentAt) : ''}</span>
              </div>
              <div style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>{(msg.message || msg.text || '').substring(0, 120)}...</div>
            </div>
          ))}
        </div>
      )}

      {/* Call Transcripts */}
      {lead.callTranscripts?.length > 0 && (
        <div className="pipeline-section">
          <div className="section-title">Call Transcripts ({lead.callTranscripts.length})</div>
          {lead.callTranscripts.map((ct: CallTranscript, idx: number) => (
            <div key={idx} style={{ padding: '8px', background: 'var(--card-bg)', borderRadius: '8px', marginBottom: '6px', fontSize: '13px' }}>
              <div>{formatDate(ct.date)} | {ct.duration} min</div>
              <div style={{ color: 'var(--text-secondary)', marginTop: '4px' }}>{ct.summary}</div>
              {ct.objections?.length > 0 && <div style={{ color: '#ff9800', marginTop: '2px' }}>Objections: {ct.objections.join(', ')}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// FOLLOW-UPS VIEW
// ═══════════════════════════════════════════════════════════
function FollowUpsView({ leads, onSelectLead }: { leads: Lead[]; onSelectLead: (id: string) => void }) {
  const overdue = leads.filter(l => l.stage !== 'Enrolled / Flew' && l.followUpAt > 0 && l.followUpAt < Date.now())
  const today = leads.filter(l => {
    if (!l.followUpAt || l.stage === 'Enrolled / Flew') return false
    const d = new Date(l.followUpAt)
    const now = new Date()
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  })
  const upcoming = leads.filter(l => l.stage !== 'Enrolled / Flew' && l.followUpAt > Date.now())
  const noFollowUp = leads.filter(l => l.stage !== 'Enrolled / Flew' && (!l.followUpAt || l.followUpAt === 0))

  const renderSection = (title: string, items: Lead[], color: string) => (
    <div style={{ marginBottom: '16px' }}>
      <div style={{ fontSize: '14px', fontWeight: 600, color, marginBottom: '8px' }}>{title} ({items.length})</div>
      {items.map(lead => (
        <div key={lead.id} className="action-item" onClick={() => onSelectLead(lead.id)} style={{ cursor: 'pointer' }}>
          <div className="action-item-lead">{lead.name}</div>
          <div className="action-item-note">{lead.followUpNote || lead.stage}</div>
          <div className="action-item-time">
            {lead.followUpAt ? formatDate(lead.followUpAt) : 'No date set'} | {lead.phone}
          </div>
        </div>
      ))}
      {items.length === 0 && <div style={{ color: 'var(--text-tertiary)', fontSize: '13px' }}>None</div>}
    </div>
  )

  return (
    <div className="leads-detail">
      <div className="section-title">Follow-ups</div>
      {renderSection('Overdue', overdue, '#f44336')}
      {renderSection('Today', today, '#ff9800')}
      {renderSection('Upcoming', upcoming, '#4caf50')}
      {renderSection('No Follow-up Set', noFollowUp.slice(0, 10), '#9e9e9e')}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// COMMS AI VIEW
// ═══════════════════════════════════════════════════════════
function CommsAIView({ leads, selectedId, generatedMessage, isGenerating, apiKey, onSelectLead, onGeneratePersonalised, onGenerateEmail, onSendMessage, onMessageChange }: any) {
  const [objective, setObjective] = useState('first_contact')
  const [tone, setTone] = useState('warm')
  const selectedLead = leads.find((l: Lead) => l.id === selectedId)

  return (
    <div className="leads-detail">
      <div className="section-title">Communications AI</div>
      {!selectedId || !selectedLead ? (
        <div style={{ color: 'var(--text-tertiary)' }}>Select a lead from sidebar to generate personalized messages</div>
      ) : (
        <>
          <div style={{ padding: '8px 12px', background: 'var(--card-bg)', borderRadius: '8px', marginBottom: '12px', fontSize: '13px' }}>
            <strong>{selectedLead.name}</strong> | {selectedLead.phone} | {(selectedLead.destinationCountries || []).join(', ')} | {selectedLead.intendedDegree} | Stage: {selectedLead.stage} | Score: {selectedLead.score}
          </div>

          <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '6px' }}>WhatsApp / Custom Message</div>
          <div className="generator-controls">
            <select className="generator-select" value={objective} onChange={e => setObjective(e.target.value)}>
              {PROMPT_LIBRARY.map(p => <option key={p.objective} value={p.objective}>{p.label}</option>)}
            </select>
            <select className="generator-select" value={tone} onChange={e => setTone(e.target.value)}>
              <option value="warm">Warm</option><option value="persuasive">Persuasive</option>
              <option value="urgent">Urgent</option><option value="educational">Educational</option>
              <option value="professional">Professional</option><option value="logical">Logical</option>
              <option value="encouraging">Encouraging</option><option value="friendly">Friendly</option>
              <option value="celebratory">Celebratory</option><option value="patient">Patient</option>
              <option value="hopeful">Hopeful</option><option value="premium">Premium</option>
            </select>
            <button className="copy-btn" onClick={() => onGeneratePersonalised(objective, tone)} disabled={isGenerating}>
              {isGenerating ? 'Generating...' : 'Generate Message'}
            </button>
          </div>

          <div style={{ marginTop: '12px', marginBottom: '6px' }}>
            <button className="lead-action-btn" onClick={onGenerateEmail} disabled={isGenerating} style={{ fontSize: '12px' }}>
              Generate Professional Email
            </button>
          </div>

          {generatedMessage && (
            <>
              <textarea className="form-input" value={generatedMessage} onChange={e => onMessageChange(e.target.value)} rows={6} style={{ width: '100%', marginTop: '8px', fontFamily: 'inherit' }} />
              <div className="output-buttons">
                <button className="copy-btn" onClick={() => navigator.clipboard.writeText(generatedMessage)}>Copy</button>
                <button className="send-btn" onClick={() => onSendMessage('whatsapp')}>Send WhatsApp</button>
                <button className="send-btn" onClick={() => onSendMessage('email')}>Send Email</button>
              </div>
            </>
          )}

          {/* Quick Templates */}
          <div style={{ marginTop: '16px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Quick Objectives</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {PROMPT_LIBRARY.map(p => (
                <button
                  key={p.objective}
                  className={`filter-option ${objective === p.objective ? 'active' : ''}`}
                  onClick={() => { setObjective(p.objective); setTone(p.tone) }}
                  style={{ fontSize: '11px' }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// ANALYTICS VIEW
// ═══════════════════════════════════════════════════════════
function AnalyticsView({ leads, settings }: { leads: Lead[]; settings: Settings }) {
  // Stage distribution
  const stageCounts = STAGES.map(s => ({ stage: s, count: leads.filter(l => l.stage === s).length }))
  const maxStageCount = Math.max(...stageCounts.map(s => s.count), 1)

  // Source performance
  const sourceCounts: Record<string, { total: number; enrolled: number }> = {}
  leads.forEach(l => {
    if (!sourceCounts[l.source]) sourceCounts[l.source] = { total: 0, enrolled: 0 }
    sourceCounts[l.source].total++
    if (l.stage === 'Enrolled / Flew') sourceCounts[l.source].enrolled++
  })
  const sourceData = Object.entries(sourceCounts).sort((a, b) => b[1].total - a[1].total)

  // Team performance
  const teamCounts: Record<string, { total: number; enrolled: number }> = {}
  leads.forEach(l => {
    const assignee = l.assignedTo || 'Unassigned'
    if (!teamCounts[assignee]) teamCounts[assignee] = { total: 0, enrolled: 0 }
    teamCounts[assignee].total++
    if (l.stage === 'Enrolled / Flew') teamCounts[assignee].enrolled++
  })

  // Conversion rate
  const totalLeads = leads.length
  const enrolledLeads = leads.filter(l => l.stage === 'Enrolled / Flew').length
  const conversionRate = totalLeads > 0 ? ((enrolledLeads / totalLeads) * 100).toFixed(1) : '0'

  // Score distribution
  const scoreBuckets = [
    { label: '0-25 (Cold)', count: leads.filter(l => l.score < 25).length, color: '#f44336' },
    { label: '25-50 (Cool)', count: leads.filter(l => l.score >= 25 && l.score < 50).length, color: '#ff9800' },
    { label: '50-75 (Warm)', count: leads.filter(l => l.score >= 50 && l.score < 75).length, color: '#ffeb3b' },
    { label: '75-100 (Hot)', count: leads.filter(l => l.score >= 75).length, color: '#4caf50' },
  ]
  const maxScoreBucket = Math.max(...scoreBuckets.map(b => b.count), 1)

  // Weekly trend (last 8 weeks)
  const weeklyData: { week: string; count: number }[] = []
  for (let i = 7; i >= 0; i--) {
    const weekStart = Date.now() - (i + 1) * 7 * 86400000
    const weekEnd = Date.now() - i * 7 * 86400000
    const count = leads.filter(l => l.createdAt >= weekStart && l.createdAt < weekEnd).length
    weeklyData.push({ week: `W-${i}`, count })
  }
  const maxWeekly = Math.max(...weeklyData.map(w => w.count), 1)

  return (
    <div className="leads-detail" style={{ maxWidth: '900px' }}>
      <div className="section-title">Analytics & Reports</div>

      {/* KPI Row */}
      <div className="stats-row">
        <div className="stat-card"><div className="stat-label">Total Leads</div><div className="stat-value">{totalLeads}</div></div>
        <div className="stat-card"><div className="stat-label">Enrolled</div><div className="stat-value">{enrolledLeads}</div></div>
        <div className="stat-card"><div className="stat-label">Conversion</div><div className="stat-value">{conversionRate}%</div></div>
        <div className="stat-card"><div className="stat-label">Avg Score</div><div className="stat-value">{totalLeads > 0 ? Math.round(leads.reduce((s, l) => s + l.score, 0) / totalLeads) : 0}</div></div>
      </div>

      {/* Pipeline Chart */}
      <div className="pipeline-section">
        <div className="section-title">Pipeline Distribution</div>
        {stageCounts.map(({ stage, count }) => (
          <div key={stage} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <div style={{ width: '140px', fontSize: '12px', textAlign: 'right' }}>{stage}</div>
            <div style={{ flex: 1, background: 'var(--bg-secondary)', borderRadius: '4px', height: '24px', position: 'relative' }}>
              <div style={{
                width: `${(count / maxStageCount) * 100}%`, height: '100%', borderRadius: '4px',
                background: STAGE_COLORS[stage] || '#666', minWidth: count > 0 ? '20px' : '0',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: '#000', fontWeight: 600
              }}>{count > 0 ? count : ''}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Score Distribution */}
      <div className="pipeline-section">
        <div className="section-title">Lead Score Distribution</div>
        {scoreBuckets.map(b => (
          <div key={b.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
            <div style={{ width: '120px', fontSize: '12px', textAlign: 'right' }}>{b.label}</div>
            <div style={{ flex: 1, background: 'var(--bg-secondary)', borderRadius: '4px', height: '20px' }}>
              <div style={{
                width: `${(b.count / maxScoreBucket) * 100}%`, height: '100%', borderRadius: '4px',
                background: b.color, minWidth: b.count > 0 ? '20px' : '0',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', color: '#000', fontWeight: 600
              }}>{b.count > 0 ? b.count : ''}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Weekly Trend */}
      <div className="pipeline-section">
        <div className="section-title">Weekly New Leads (last 8 weeks)</div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: '100px', padding: '8px 0' }}>
          {weeklyData.map((w, i) => (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ fontSize: '10px', marginBottom: '2px' }}>{w.count}</div>
              <div style={{
                width: '100%', background: '#4caf50', borderRadius: '3px 3px 0 0',
                height: `${(w.count / maxWeekly) * 80}px`, minHeight: w.count > 0 ? '4px' : '0'
              }} />
              <div style={{ fontSize: '9px', color: 'var(--text-tertiary)', marginTop: '2px' }}>{w.week}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Source Performance */}
      <div className="pipeline-section">
        <div className="section-title">Source Performance</div>
        <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ textAlign: 'left', padding: '6px' }}>Source</th>
            <th style={{ textAlign: 'right', padding: '6px' }}>Total</th>
            <th style={{ textAlign: 'right', padding: '6px' }}>Enrolled</th>
            <th style={{ textAlign: 'right', padding: '6px' }}>Conv %</th>
          </tr></thead>
          <tbody>{sourceData.map(([src, data]) => (
            <tr key={src} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '6px' }}>{src}</td>
              <td style={{ textAlign: 'right', padding: '6px' }}>{data.total}</td>
              <td style={{ textAlign: 'right', padding: '6px' }}>{data.enrolled}</td>
              <td style={{ textAlign: 'right', padding: '6px' }}>{data.total > 0 ? ((data.enrolled / data.total) * 100).toFixed(0) : 0}%</td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      {/* Team Performance */}
      <div className="pipeline-section">
        <div className="section-title">Team Performance</div>
        <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
          <thead><tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th style={{ textAlign: 'left', padding: '6px' }}>Member</th>
            <th style={{ textAlign: 'right', padding: '6px' }}>Leads</th>
            <th style={{ textAlign: 'right', padding: '6px' }}>Enrolled</th>
            <th style={{ textAlign: 'right', padding: '6px' }}>Conv %</th>
          </tr></thead>
          <tbody>{Object.entries(teamCounts).sort((a, b) => b[1].total - a[1].total).map(([member, data]) => (
            <tr key={member} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '6px' }}>{member}</td>
              <td style={{ textAlign: 'right', padding: '6px' }}>{data.total}</td>
              <td style={{ textAlign: 'right', padding: '6px' }}>{data.enrolled}</td>
              <td style={{ textAlign: 'right', padding: '6px' }}>{data.total > 0 ? ((data.enrolled / data.total) * 100).toFixed(0) : 0}%</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// GHOST / ZOMBIE LEADS VIEW
// ═══════════════════════════════════════════════════════════
function GhostLeadsView({ leads, onSelectLead, onResurrect, onBulkResurrect }: {
  leads: Lead[]; onSelectLead: (id: string) => void
  onResurrect: (lead: Lead) => void; onBulkResurrect: (leads: Lead[]) => void
}) {
  const [resurrecting, setResurrecting] = useState<Set<string>>(new Set())

  // Ghost leads: no response for 14+ days, not enrolled
  const ghostLeads = leads.filter(l => {
    if (l.stage === 'Enrolled / Flew') return false
    const lastActivity = Math.max(l.followUpAt || 0, l.createdAt || 0, l.lastZombieAt || 0)
    return daysSince(lastActivity) >= 14
  }).sort((a, b) => {
    const aLast = Math.max(a.followUpAt || 0, a.createdAt || 0, a.lastZombieAt || 0)
    const bLast = Math.max(b.followUpAt || 0, b.createdAt || 0, b.lastZombieAt || 0)
    return aLast - bLast // oldest first
  })

  // Zombie leads: previously resurrected
  const zombieLeads = leads.filter(l => l.zombieResurrected && l.stage !== 'Enrolled / Flew')

  // Leads that went cold fast (within 7 days of creation, no engagement)
  const coldFast = leads.filter(l => {
    if (l.stage === 'Enrolled / Flew') return false
    const daysSinceCreation = daysSince(l.createdAt)
    return daysSinceCreation >= 7 && daysSinceCreation < 14 &&
      (l.conversations?.length || 0) === 0 && (l.sentMessages?.length || 0) <= 1
  })

  const stats = {
    total: ghostLeads.length,
    zombies: zombieLeads.length,
    coldFast: coldFast.length,
    avgDaysSilent: ghostLeads.length > 0
      ? Math.round(ghostLeads.reduce((sum, l) => sum + daysSince(Math.max(l.followUpAt || 0, l.createdAt || 0, l.lastZombieAt || 0)), 0) / ghostLeads.length)
      : 0,
  }

  const handleResurrect = async (lead: Lead) => {
    setResurrecting(prev => new Set([...prev, lead.id]))
    await onResurrect(lead)
    setResurrecting(prev => { const next = new Set(prev); next.delete(lead.id); return next })
  }

  const renderLeadCard = (lead: Lead, showResurrect = true) => {
    const lastActivity = Math.max(lead.followUpAt || 0, lead.createdAt || 0, lead.lastZombieAt || 0)
    const silentDays = daysSince(lastActivity)

    return (
      <div key={lead.id} style={{ padding: '12px', background: 'var(--card-bg)', borderRadius: '8px', marginBottom: '8px', borderLeft: `3px solid ${silentDays > 30 ? '#f44336' : silentDays > 21 ? '#ff9800' : '#ffeb3b'}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ cursor: 'pointer' }} onClick={() => onSelectLead(lead.id)}>
            <div style={{ fontWeight: 600, fontSize: '14px' }}>{lead.name}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              {lead.phone} | {lead.email} | {lead.city || 'N/A'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
              Stage: {lead.stage} | Score: {lead.score} | Source: {lead.source}
            </div>
            <div style={{ fontSize: '11px', color: silentDays > 30 ? '#f44336' : '#ff9800', marginTop: '4px', fontWeight: 600 }}>
              Silent for {silentDays} days
              {lead.zombieAttempts > 0 && ` | ${lead.zombieAttempts} resurrection attempt${lead.zombieAttempts > 1 ? 's' : ''}`}
            </div>
          </div>
          {showResurrect && (
            <button
              className="lead-action-btn"
              onClick={() => handleResurrect(lead)}
              disabled={resurrecting.has(lead.id)}
              style={{ fontSize: '11px', whiteSpace: 'nowrap', background: resurrecting.has(lead.id) ? '#666' : '#ff9800', color: '#000' }}
            >
              {resurrecting.has(lead.id) ? 'Resurrecting...' : 'Resurrect'}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="leads-detail" style={{ maxWidth: '900px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div className="section-title" style={{ margin: 0 }}>Ghost / Zombie Leads</div>
        {ghostLeads.length > 0 && (
          <button className="lead-action-btn" onClick={() => onBulkResurrect(ghostLeads)} style={{ background: '#ff9800', color: '#000' }}>
            Resurrect All ({ghostLeads.length})
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="stats-row">
        <div className="stat-card"><div className="stat-label">Ghost Leads</div><div className="stat-value" style={{ color: '#f44336' }}>{stats.total}</div><div className="stat-subtext">14+ days silent</div></div>
        <div className="stat-card"><div className="stat-label">Previously Resurrected</div><div className="stat-value" style={{ color: '#ff9800' }}>{stats.zombies}</div><div className="stat-subtext">Zombie leads</div></div>
        <div className="stat-card"><div className="stat-label">Going Cold</div><div className="stat-value" style={{ color: '#ffeb3b' }}>{stats.coldFast}</div><div className="stat-subtext">7-14 days, no engagement</div></div>
        <div className="stat-card"><div className="stat-label">Avg Silent Days</div><div className="stat-value">{stats.avgDaysSilent}</div><div className="stat-subtext">Ghost leads</div></div>
      </div>

      {/* Going Cold - Warning Section */}
      {coldFast.length > 0 && (
        <div className="pipeline-section" style={{ borderLeft: '3px solid #ffeb3b' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#ffeb3b', marginBottom: '8px' }}>
            Going Cold ({coldFast.length}) - Act now before they ghost!
          </div>
          {coldFast.slice(0, 5).map(lead => renderLeadCard(lead, true))}
          {coldFast.length > 5 && <div style={{ color: 'var(--text-tertiary)', fontSize: '12px' }}>+ {coldFast.length - 5} more</div>}
        </div>
      )}

      {/* Ghost Leads */}
      <div className="pipeline-section">
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#f44336', marginBottom: '8px' }}>
          Ghost Leads ({ghostLeads.length}) - No activity for 14+ days
        </div>
        {ghostLeads.length > 0 ? (
          ghostLeads.map(lead => renderLeadCard(lead))
        ) : (
          <div style={{ color: 'var(--text-tertiary)', fontSize: '13px', padding: '12px' }}>
            No ghost leads! All your leads have recent activity.
          </div>
        )}
      </div>

      {/* Previously Resurrected */}
      {zombieLeads.length > 0 && (
        <div className="pipeline-section">
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#ff9800', marginBottom: '8px' }}>
            Zombie History ({zombieLeads.length}) - Previously resurrected leads
          </div>
          {zombieLeads.map(lead => renderLeadCard(lead, false))}
        </div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// SETTINGS VIEW
// ═══════════════════════════════════════════════════════════
function SettingsView({ settings, onSaveSettings, onAddSource }: {
  settings: Settings; onSaveSettings: (s: Settings) => void; onAddSource: () => void
}) {
  const [localSettings, setLocalSettings] = useState(settings)
  const [newMemberName, setNewMemberName] = useState('')
  const [newMemberBranch, setNewMemberBranch] = useState('')
  const [newMemberEmail, setNewMemberEmail] = useState('')
  const [newMemberRole, setNewMemberRole] = useState<'admin' | 'member'>('member')

  return (
    <div className="leads-detail">
      <div className="section-title">Settings</div>

      <div className="pipeline-section">
        <div className="section-title">Integration Keys</div>
        <div className="payment-form">
          <div className="form-group">
            <div className="form-label">Interakt API Key (WhatsApp)</div>
            <input type="password" value={localSettings.interaktApiKey || ''} onChange={e => setLocalSettings({ ...localSettings, interaktApiKey: e.target.value })} className="form-input" placeholder="Interakt API Key" />
          </div>
          <div className="form-group">
            <div className="form-label">Interakt Webhook Secret</div>
            <input type="password" value={localSettings.interaktWebhookSecret || ''} onChange={e => setLocalSettings({ ...localSettings, interaktWebhookSecret: e.target.value })} className="form-input" placeholder="Webhook Secret" />
          </div>
          <div className="form-group">
            <div className="form-label">Google Apps Script URL</div>
            <input type="text" value={localSettings.gasUrl} onChange={e => setLocalSettings({ ...localSettings, gasUrl: e.target.value })} className="form-input" placeholder="GAS URL" />
          </div>
          <div className="form-group">
            <div className="form-label">Email Sender</div>
            <input type="text" value={localSettings.gasSender} onChange={e => setLocalSettings({ ...localSettings, gasSender: e.target.value })} className="form-input" placeholder="goeduabroadonline@gmail.com" />
          </div>
          <div className="form-group">
            <div className="form-label">Gmail App Password (for sending emails from Gmail)</div>
            <input type="password" value={localSettings.gmailAppPassword || ''} onChange={e => setLocalSettings({ ...localSettings, gmailAppPassword: e.target.value })} className="form-input" placeholder="xxxx xxxx xxxx xxxx (16-char app password)" />
          </div>
          <div className="form-group">
            <div className="form-label">Resend API Key (fallback, free 3,000 emails/month)</div>
            <input type="password" value={localSettings.resendKey || ''} onChange={e => setLocalSettings({ ...localSettings, resendKey: e.target.value })} className="form-input" placeholder="re_xxxxx (get free key at resend.com)" />
          </div>
          <div className="form-group">
            <div className="form-label">Gemini API Key</div>
            <input type="password" value={localSettings.geminiKey || ''} onChange={e => setLocalSettings({ ...localSettings, geminiKey: e.target.value })} className="form-input" placeholder="Gemini API Key for auto-messages" />
          </div>
          <div className="form-group">
            <div className="form-label">Bolna Agent ID</div>
            <input type="text" value={localSettings.bolnaAgentId || ''} onChange={e => setLocalSettings({ ...localSettings, bolnaAgentId: e.target.value })} className="form-input" placeholder="Bolna Agent ID" />
          </div>
          <div className="form-group">
            <div className="form-label">Bolna API Key</div>
            <input type="password" value={localSettings.bolnaApiKey || ''} onChange={e => setLocalSettings({ ...localSettings, bolnaApiKey: e.target.value })} className="form-input" placeholder="Bolna API Key" />
          </div>
          <div className="form-group">
            <div className="form-label">Google Ads Webhook Key</div>
            <input type="password" value={localSettings.googleAdsWebhookKey || ''} onChange={e => setLocalSettings({ ...localSettings, googleAdsWebhookKey: e.target.value })} className="form-input" placeholder="Google Ads Webhook Key" />
          </div>
          <div className="form-group">
            <div className="form-label">Meta App ID</div>
            <input type="text" value={localSettings.metaAppId || ''} onChange={e => setLocalSettings({ ...localSettings, metaAppId: e.target.value })} className="form-input" placeholder="Meta App ID" />
          </div>
          <div className="form-group">
            <div className="form-label">Meta Access Token</div>
            <input type="password" value={localSettings.metaAccessToken || ''} onChange={e => setLocalSettings({ ...localSettings, metaAccessToken: e.target.value })} className="form-input" placeholder="Meta Access Token" />
          </div>
          <div className="form-group">
            <div className="form-label">Meta Pixel ID</div>
            <input type="text" value={localSettings.metaPixelId || ''} onChange={e => setLocalSettings({ ...localSettings, metaPixelId: e.target.value })} className="form-input" placeholder="Meta Pixel ID" />
          </div>
          <div className="form-group">
            <div className="form-label">Portal API URL</div>
            <input type="text" value={localSettings.portalApiUrl || ''} onChange={e => setLocalSettings({ ...localSettings, portalApiUrl: e.target.value })} className="form-input" placeholder="Portal API URL" />
          </div>
          <div className="form-group">
            <div className="form-label">Portal API Token</div>
            <input type="password" value={localSettings.portalApiToken || ''} onChange={e => setLocalSettings({ ...localSettings, portalApiToken: e.target.value })} className="form-input" placeholder="Portal API Token" />
          </div>
          <div className="form-group">
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input type="checkbox" checked={localSettings.autoFollowUp || false} onChange={e => setLocalSettings({ ...localSettings, autoFollowUp: e.target.checked })} />
              <label style={{ fontSize: '14px' }}>Enable Auto Follow-up (daily at 9 AM via Vercel cron)</label>
            </div>
          </div>
          <button className="lead-action-btn" onClick={() => onSaveSettings(localSettings)}>Save Settings</button>
        </div>
      </div>

      <div className="pipeline-section">
        <div className="section-title">Team Members</div>
        {localSettings.team?.map((member, idx) => (
          <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <div>
              <span style={{ fontWeight: 600 }}>{member.name}</span>
              <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginLeft: '8px' }}>({member.branch})</span>
              {member.email && <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginLeft: '8px' }}>{member.email}</span>}
              {member.role && <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '4px', marginLeft: '8px', background: member.role === 'admin' ? '#af0100' : 'var(--bg-tertiary)', color: member.role === 'admin' ? '#000' : 'var(--text)' }}>{member.role}</span>}
            </div>
            <button style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer' }} onClick={() => {
              const updated = { ...localSettings, team: localSettings.team.filter((_, i) => i !== idx) }
              setLocalSettings(updated)
            }}>Remove</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
          <input type="text" className="form-input" placeholder="Name" value={newMemberName} onChange={e => setNewMemberName(e.target.value)} style={{ flex: 1, minWidth: '120px' }} />
          <input type="text" className="form-input" placeholder="Branch" value={newMemberBranch} onChange={e => setNewMemberBranch(e.target.value)} style={{ flex: 1, minWidth: '100px' }} />
          <input type="email" className="form-input" placeholder="Email (for login)" value={newMemberEmail} onChange={e => setNewMemberEmail(e.target.value)} style={{ flex: 1, minWidth: '150px' }} />
          <select className="form-input" value={newMemberRole} onChange={e => setNewMemberRole(e.target.value as 'admin' | 'member')} style={{ width: '100px' }}>
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button className="lead-action-btn" onClick={() => {
            if (!newMemberName) return
            setLocalSettings({ ...localSettings, team: [...(localSettings.team || []), { name: newMemberName, branch: newMemberBranch || 'HQ', email: newMemberEmail, role: newMemberRole }] })
            setNewMemberName('')
            setNewMemberBranch('')
            setNewMemberEmail('')
            setNewMemberRole('member')
          }}>Add</button>
        </div>
      </div>

      <div className="pipeline-section">
        <div className="section-title">Lead Sources</div>
        <div className="filter-options">
          {localSettings.sources?.map((source, idx) => (
            <div key={source} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px' }}>
              <span>{source}</span>
              <button style={{ background: 'none', border: 'none', color: '#f44336', cursor: 'pointer', fontSize: '12px' }} onClick={() => {
                setLocalSettings({ ...localSettings, sources: localSettings.sources.filter((_, i) => i !== idx) })
              }}>x</button>
            </div>
          ))}
        </div>
        <button className="lead-action-btn" onClick={onAddSource}>Add Source</button>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MODAL: ADD/EDIT LEAD (EXPANDED)
// ═══════════════════════════════════════════════════════════
function AddLeadModal({ lead, settings, onClose, onSave, onFormChange, formData }: {
  lead?: Lead | null; settings: Settings; onClose: () => void; onSave: () => void; onFormChange: (d: Partial<Lead>) => void; formData: Partial<Lead>
}) {
  const isEdit = !!lead && !!formData.name

  useEffect(() => {
    if (lead && !formData.name) {
      onFormChange({ ...lead })
    }
  }, [lead])

  return (
    <div className="modal active">
      <div className="modal-content" style={{ maxWidth: '600px' }}>
        <div className="modal-header">
          <div>{isEdit ? 'Edit Lead' : 'Add New Lead'}</div>
          <button className="modal-close" onClick={onClose}>x</button>
        </div>
        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <div className="form-label">Name *</div>
              <input type="text" value={formData.name || ''} onChange={e => onFormChange({ ...formData, name: e.target.value })} className="form-input" placeholder="Full name" />
            </div>
            <div className="form-group">
              <div className="form-label">Phone *</div>
              <input type="tel" value={formData.phone || ''} onChange={e => onFormChange({ ...formData, phone: e.target.value })} className="form-input" placeholder="10-digit number" />
            </div>
            <div className="form-group">
              <div className="form-label">Email *</div>
              <input type="email" value={formData.email || ''} onChange={e => onFormChange({ ...formData, email: e.target.value })} className="form-input" placeholder="Email" />
            </div>
            <div className="form-group">
              <div className="form-label">City</div>
              <input type="text" value={formData.city || ''} onChange={e => onFormChange({ ...formData, city: e.target.value })} className="form-input" placeholder="City" />
            </div>
            <div className="form-group">
              <div className="form-label">Current Education</div>
              <select className="form-input" value={formData.currentEducation || ''} onChange={e => onFormChange({ ...formData, currentEducation: e.target.value })}>
                <option value="">Select</option><option value="12th Pass">12th Pass</option><option value="Bachelors (Pursuing)">Bachelors (Pursuing)</option>
                <option value="Bachelors (Completed)">Bachelors (Completed)</option><option value="Masters (Pursuing)">Masters (Pursuing)</option>
                <option value="Masters (Completed)">Masters (Completed)</option><option value="Working Professional">Working Professional</option>
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Intended Degree</div>
              <select className="form-input" value={formData.intendedDegree || ''} onChange={e => onFormChange({ ...formData, intendedDegree: e.target.value })}>
                <option value="">Select</option><option value="Bachelors">Bachelors</option><option value="Masters">Masters</option>
                <option value="Diploma">Diploma</option><option value="PhD">PhD</option><option value="Certificate">Certificate</option>
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Source</div>
              <select className="form-input" value={formData.source || 'Direct'} onChange={e => onFormChange({ ...formData, source: e.target.value })}>
                {(settings.sources || ['Google', 'WhatsApp', 'Referral', 'Website', 'Meta Ads', 'Instagram', 'YouTube']).map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
                <option value="Direct">Direct</option>
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Target Intake</div>
              <select className="form-input" value={formData.targetIntake || ''} onChange={e => onFormChange({ ...formData, targetIntake: e.target.value })}>
                <option value="">Select</option><option value="Fall 2026">Fall 2026</option><option value="Spring 2027">Spring 2027</option><option value="Fall 2027">Fall 2027</option><option value="2028">2028</option>
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Budget</div>
              <select className="form-input" value={formData.budget || ''} onChange={e => onFormChange({ ...formData, budget: e.target.value })}>
                <option value="">Select</option><option value="Below 20L">Below 20L</option><option value="20L - 40L">20L - 40L</option><option value="40L - 60L">40L - 60L</option><option value="60L+">60L+</option>
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Parent Name</div>
              <input type="text" value={formData.parentName || ''} onChange={e => onFormChange({ ...formData, parentName: e.target.value })} className="form-input" placeholder="Parent name" />
            </div>
            <div className="form-group">
              <div className="form-label">Parent Phone</div>
              <input type="tel" value={formData.parentPhone || ''} onChange={e => onFormChange({ ...formData, parentPhone: e.target.value })} className="form-input" placeholder="Parent phone" />
            </div>
            <div className="form-group">
              <div className="form-label">Passport Status</div>
              <select className="form-input" value={formData.passportStatus || ''} onChange={e => onFormChange({ ...formData, passportStatus: e.target.value })}>
                <option value="">Select</option><option value="Not Applied">Not Applied</option><option value="Applied">Applied</option><option value="Ready">Ready</option><option value="Expired">Expired</option>
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Scholarship Interest</div>
              <select className="form-input" value={formData.scholarshipInterest ? 'yes' : 'no'} onChange={e => onFormChange({ ...formData, scholarshipInterest: e.target.value === 'yes' })}>
                <option value="no">Not Interested</option><option value="yes">Interested</option>
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Stage</div>
              <select className="form-input" value={formData.stage || 'New Enquiry'} onChange={e => onFormChange({ ...formData, stage: e.target.value })}>
                {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <div className="form-label">Assigned To</div>
              <select className="form-input" value={formData.assignedTo || ''} onChange={e => onFormChange({ ...formData, assignedTo: e.target.value })}>
                <option value="">Unassigned</option>
                {settings.team?.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group" style={{ marginTop: '12px' }}>
            <div className="form-label">Notes</div>
            <textarea value={formData.notes || ''} onChange={e => onFormChange({ ...formData, notes: e.target.value })} className="form-input" placeholder="Notes" rows={3} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={onSave}>{isEdit ? 'Update' : 'Add'} Lead</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MODAL: ENROLL
// ═══════════════════════════════════════════════════════════
function EnrollModal({ lead, onClose, onEnroll }: { lead: Lead; onClose: () => void; onEnroll: (fee: number, link: string) => void }) {
  const [fee, setFee] = useState(lead.feeAmount || 0)
  const [link, setLink] = useState(lead.paymentLink || '')

  return (
    <div className="modal active">
      <div className="modal-content">
        <div className="modal-header"><div>Enroll: {lead.name}</div><button className="modal-close" onClick={onClose}>x</button></div>
        <div className="modal-body">
          <div className="form-group">
            <div className="form-label">Fee Amount (Rs.)</div>
            <input type="number" value={fee} onChange={e => setFee(Number(e.target.value))} className="form-input" placeholder="e.g. 25000" />
          </div>
          <div className="form-group">
            <div className="form-label">Payment Link (optional)</div>
            <input type="text" value={link} onChange={e => setLink(e.target.value)} className="form-input" placeholder="https://..." />
          </div>
          <div style={{ padding: '8px', background: 'rgba(76,175,80,0.1)', borderRadius: '8px', fontSize: '13px', color: '#4caf50' }}>
            This will move {lead.name} to "Enrolled" stage and record enrollment date.
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={() => onEnroll(fee, link)}>Confirm Enrollment</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MODAL: ADD SOURCE
// ═══════════════════════════════════════════════════════════
function AddSourceModal({ settings, onClose, onSave }: { settings: Settings; onClose: () => void; onSave: (source: string) => void }) {
  const [source, setSource] = useState('')

  return (
    <div className="modal active">
      <div className="modal-content">
        <div className="modal-header"><div>Add Lead Source</div><button className="modal-close" onClick={onClose}>x</button></div>
        <div className="modal-body">
          <div className="form-group">
            <div className="form-label">Source Name</div>
            <input type="text" value={source} onChange={e => setSource(e.target.value)} className="form-input" placeholder="e.g. Instagram, YouTube" />
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
            Current sources: {settings.sources?.join(', ')}
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={() => { if (source.trim()) onSave(source.trim()) }}>Add Source</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MODAL: CALL ASSISTANT
// ═══════════════════════════════════════════════════════════
function CallAssistantModal({ lead, onClose, onSaveTranscript }: {
  lead: Lead; onClose: () => void; onSaveTranscript: (t: CallTranscript) => void
}) {
  const [duration, setDuration] = useState(0)
  const [transcript, setTranscript] = useState('')
  const [summary, setSummary] = useState('')
  const [emotions, setEmotions] = useState('')
  const [objections, setObjections] = useState<string[]>([])

  const callScript = `CALL SCRIPT FOR: ${lead.name}
---
1. GREETING: "Hi ${lead.name}, this is [Your Name] from EduAbroad. How are you doing? Thanks for your interest in studying abroad!"

2. RAPPORT: "I saw you were interested in studying ${(lead.destinationCountries || []).join(', ') || 'abroad'}. ${lead.city ? `Are you currently in ${lead.city}?` : 'Where are you currently based?'}"

3. DISCOVERY:
   - "What's your current education level? When do you plan to apply?"
   - "Which countries are you most interested in — USA, UK, Canada, Australia?"
   - "Are you looking at Masters, Bachelors, or another degree?"
   - "Have you taken IELTS/TOEFL or do you need guidance on exams?"

4. PITCH:
   - "We've helped 2000+ Indian students get into top universities with a 95% acceptance rate"
   - "Our services: university shortlisting, SOP/LOR writing, application filing, visa support"
   - "We've won scholarships worth 10L-50L for our students"
   - "Your dedicated counselor guides you through every step"

5. OBJECTION HANDLING:
   - Confused on country: "Let's have a 30-min evaluation. We'll assess your profile and recommend the best fit."
   - Cost concerns: "Our fees are transparent, typically 80K-2.5L depending on the package."
   - Timeline: "Most programs start Fall. We have Spring intakes too. Let's plan based on your readiness."
   - Test scores: "No worries — we have test prep partners. You can prepare while we shortlist universities."

6. CTA: "Can I schedule a 30-min profile evaluation this week to understand your goals better?"
   ${lead.parentName ? `7. PARENT: "${lead.parentName} is also welcome to join the call to understand the process and ROI."` : ''}`

  return (
    <div className="modal active">
      <div className="modal-content" style={{ maxWidth: '700px' }}>
        <div className="modal-header"><div>Call Assistant: {lead.name}</div><button className="modal-close" onClick={onClose}>x</button></div>
        <div className="modal-body" style={{ maxHeight: '65vh', overflowY: 'auto' }}>
          <div style={{ background: 'var(--card-bg)', padding: '12px', borderRadius: '8px', fontSize: '12px', whiteSpace: 'pre-wrap', marginBottom: '12px', maxHeight: '200px', overflowY: 'auto' }}>
            {callScript}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div className="form-group">
              <div className="form-label">Call Duration (minutes)</div>
              <input type="number" value={duration} onChange={e => setDuration(Number(e.target.value))} className="form-input" placeholder="Minutes" />
            </div>
            <div className="form-group">
              <div className="form-label">Emotions Detected</div>
              <input type="text" value={emotions} onChange={e => setEmotions(e.target.value)} className="form-input" placeholder="e.g. interested, hesitant" />
            </div>
          </div>

          <div className="form-group">
            <div className="form-label">Objections Raised</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {OBJECTIONS.map(obj => (
                <button key={obj.key}
                  className={`filter-option ${objections.includes(obj.key) ? 'active' : ''}`}
                  onClick={() => setObjections(prev => prev.includes(obj.key) ? prev.filter(o => o !== obj.key) : [...prev, obj.key])}
                >
                  {obj.icon} {obj.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <div className="form-label">Call Summary</div>
            <textarea value={summary} onChange={e => setSummary(e.target.value)} className="form-input" rows={2} placeholder="Brief summary of the call..." />
          </div>

          <div className="form-group">
            <div className="form-label">Transcript / Key Notes</div>
            <textarea value={transcript} onChange={e => setTranscript(e.target.value)} className="form-input" rows={4} placeholder="Paste call transcript or type key notes..." />
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={() => {
            onSaveTranscript({
              date: Date.now(), duration,
              transcript, summary,
              emotions: emotions.split(',').map(e => e.trim()).filter(Boolean),
              objections,
              extractedFields: {},
            })
          }}>Save Call Log</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MODAL: BULK SEQUENCE
// ═══════════════════════════════════════════════════════════
function BulkSequenceModal({ leads, apiKey, settings, onClose, onSendComplete }: {
  leads: Lead[]; apiKey: string; settings: Settings; onClose: () => void; onSendComplete: (leads: Lead[]) => void
}) {
  const [selectedFunnelDay, setSelectedFunnelDay] = useState(0)
  const [channel, setChannel] = useState('whatsapp')
  const [isSending, setIsSending] = useState(false)
  const [progress, setProgress] = useState(0)

  const handleBulkSend = async () => {
    if (!apiKey) { alert('Enter Gemini API key first'); return }
    setIsSending(true)
    const updatedLeads: Lead[] = []

    for (let i = 0; i < leads.length; i++) {
      setProgress(i + 1)
      try {
        const prompt = buildPrompt(leads[i], selectedFunnelDay, 'persuasive')
        const message = await callGemini(prompt, apiKey)

        if (channel === 'whatsapp' && settings.interaktApiKey) {
          await sendInteraktMessage(settings.interaktApiKey, leads[i].phone, message)
        } else {
          triggerWAFallback(leads[i].phone, message)
        }

        updatedLeads.push({
          ...leads[i],
          sentMessages: [...leads[i].sentMessages, {
            day: FUNNEL[selectedFunnelDay]?.day || `D${selectedFunnelDay + 1}`,
            label: FUNNEL[selectedFunnelDay]?.label || 'Bulk',
            message, channel: channel === 'whatsapp' ? 'WhatsApp' : 'Email',
            sentAt: Date.now(),
          }],
        })
      } catch (err) { console.error(`Failed for ${leads[i].name}:`, err) }
    }

    setIsSending(false)
    onSendComplete(updatedLeads)
  }

  return (
    <div className="modal active">
      <div className="modal-content">
        <div className="modal-header"><div>Bulk Sequence ({leads.length} leads)</div><button className="modal-close" onClick={onClose}>x</button></div>
        <div className="modal-body">
          <div style={{ marginBottom: '8px', fontSize: '13px' }}>
            Leads: {leads.map(l => l.name).join(', ')}
          </div>
          <div className="form-group">
            <div className="form-label">Funnel Day</div>
            <select className="form-input" value={selectedFunnelDay} onChange={e => setSelectedFunnelDay(Number(e.target.value))}>
              {FUNNEL.map((f, i) => <option key={i} value={i}>{f.day} - {f.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <div className="form-label">Channel</div>
            <select className="form-input" value={channel} onChange={e => setChannel(e.target.value)}>
              <option value="whatsapp">WhatsApp</option><option value="email">Email</option>
            </select>
          </div>
          {isSending && (
            <div style={{ padding: '8px', background: 'rgba(76,175,80,0.1)', borderRadius: '8px', fontSize: '13px' }}>
              Sending... {progress}/{leads.length}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={handleBulkSend} disabled={isSending}>
            {isSending ? `Sending ${progress}/${leads.length}...` : 'Start Bulk Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MODAL: BULK ACTIONS
// ═══════════════════════════════════════════════════════════
function BulkActionsModal({ count, settings, onClose, onChangeStage, onDelete, onAssign, onBulkSequence }: {
  count: number; settings: Settings; onClose: () => void; onChangeStage: (s: string) => void
  onDelete: () => void; onAssign: (a: string) => void; onBulkSequence: () => void
}) {
  const [selectedStage, setSelectedStage] = useState('')
  const [selectedAssignee, setSelectedAssignee] = useState('')

  return (
    <div className="modal active">
      <div className="modal-content">
        <div className="modal-header"><div>Bulk Actions ({count} selected)</div><button className="modal-close" onClick={onClose}>x</button></div>
        <div className="modal-body">
          <div className="form-group">
            <div className="form-label">Change Stage</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select className="form-input" value={selectedStage} onChange={e => setSelectedStage(e.target.value)} style={{ flex: 1 }}>
                <option value="">Select stage</option>
                {STAGES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <button className="lead-action-btn" onClick={() => { if (selectedStage) { onChangeStage(selectedStage); onClose() } }}>Apply</button>
            </div>
          </div>

          <div className="form-group">
            <div className="form-label">Assign To</div>
            <div style={{ display: 'flex', gap: '6px' }}>
              <select className="form-input" value={selectedAssignee} onChange={e => setSelectedAssignee(e.target.value)} style={{ flex: 1 }}>
                <option value="">Select member</option>
                {settings.team?.map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
              </select>
              <button className="lead-action-btn" onClick={() => { if (selectedAssignee) { onAssign(selectedAssignee); onClose() } }}>Apply</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
            <button className="lead-action-btn" onClick={() => { onBulkSequence() }}>Run Bulk Sequence</button>
            <button className="lead-action-btn" style={{ background: '#f44336' }} onClick={() => { onDelete(); onClose() }}>Delete Selected</button>
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════
// MODAL: CSV IMPORT
// ═══════════════════════════════════════════════════════════
function CSVImportModal({ onClose, onImport, onFileSelect }: {
  onClose: () => void; onImport: () => void; onFileSelect: (file: File) => void
}) {
  return (
    <div className="modal active">
      <div className="modal-content">
        <div className="modal-header"><div>Import CSV</div><button className="modal-close" onClick={onClose}>x</button></div>
        <div className="modal-body">
          <div className="form-group">
            <div className="form-label">Select CSV file</div>
            <input type="file" accept=".csv" onChange={e => { if (e.target.files?.[0]) onFileSelect(e.target.files[0]) }} className="form-input" />
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)' }}>
            CSV should have columns: Name, Phone, Email, City, Current Education, Intended Degree, Target Intake, Source, Parent Name, Stage, Notes.
            Duplicates (by phone or email) will be automatically skipped.
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn secondary" onClick={onClose}>Cancel</button>
          <button className="modal-btn primary" onClick={onImport}>Import</button>
        </div>
      </div>
    </div>
  )
}
// v2 - All features deployed Sat Mar 21 17:27:51 IST 2026
