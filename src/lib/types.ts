// ─── EduAbroad CRM — Type Definitions ───

export interface ConvEntry {
  type: 'incoming' | 'outgoing' | 'system'
  content: string
  channel: 'WhatsApp' | 'Email' | 'Call' | 'SMS' | 'Web' | 'Portal'
  timestamp: number
}

export interface SentMessage {
  day: string
  label: string
  message?: string
  text?: string
  preview?: string
  channel: string
  sentAt?: number
  timestamp?: number
  sent?: boolean
}

export interface CallTranscript {
  date: number
  duration: number
  transcript: string
  summary: string
  emotions: string[]
  objections: string[]
  extractedFields: Record<string, string>
  source?: 'manual' | 'bolna'
}

export interface BolnaCall {
  callId: string
  agentId: string
  phone: string
  status: 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'failed'
  duration: number
  transcript: string
  summary: string
  extractedData: Record<string, string>
  timestamp: number
}

export interface Application {
  id: string
  universityName: string
  country: string
  course: string
  applicationStatus: 'Not Started' | 'Documents Ready' | 'Submitted' | 'Under Review' | 'Offer Received' | 'Offer Accepted' | 'Deposit Paid' | 'CAS/COE Received'
  deadline: number
  submittedAt: number
  offerType: '' | 'Conditional' | 'Unconditional'
  scholarshipOffered: string
  notes: string
}

export interface DocumentItem {
  documentType: string
  status: 'Not Started' | 'In Progress' | 'Ready' | 'Submitted' | 'Verified'
  uploadedAt: number
  verifiedBy: string
}

export interface TestScore {
  score: string
  date: string
}

export interface RemarkEntry {
  text: string
  by: string
  date: number
}

export interface Lead {
  id: string
  name: string
  phone: string
  email: string
  city: string
  state: string
  source: string

  // Parent/Guardian
  parentName: string
  parentPhone: string
  parentEmail: string

  // Academic profile
  currentEducation: string
  tenthMarks: string
  twelfthMarks: string
  ugCGPA: string
  fieldOfStudy: string
  workExperience: string
  gapYears: number

  // Study abroad specifics
  destinationCountries: string[]
  intendedDegree: string
  targetIntake: string
  budget: string
  passportStatus: string
  scholarshipInterest: boolean
  testScores: Record<string, TestScore>
  preferredUniversities: string[]

  // Pipeline & scoring
  stage: string
  score: number
  scoreLabel: string
  scoreReason: string
  notes: string
  assignedTo: string
  leadStatus: string

  // Timestamps
  createdAt: number
  followUpAt: number
  followUpNote: string

  // Service & payment
  serviceType: string
  feeAmount: number
  paymentLink: string
  paymentPendingAt: number
  enrolledAt: number

  // Applications & documents
  applications: Application[]
  documents: DocumentItem[]

  // Visa tracking
  visaCountry: string
  visaType: string
  visaApplicationDate: number
  visaInterviewDate: number
  visaStatus: string

  // Communication
  conversations: ConvEntry[]
  sentMessages: SentMessage[]
  callTranscripts: CallTranscript[]

  // Re-engagement
  zombieResurrected: boolean
  zombieAttempts: number
  lastZombieAt: number

  // Drip tracking
  dripCount: number
  lastDripAt: number

  // Remarks
  remarks: RemarkEntry[]

  // Attribution
  utmSource: string
  utmMedium: string
  utmCampaign: string
  googleClickId: string
  metaLeadId: string

  // Portal
  portalUserId: string

  // Bolna AI
  bolnaCalls: BolnaCall[]
}

export interface TeamMember {
  name: string
  branch: string
  email?: string
  role?: 'admin' | 'member'
}

export interface Settings {
  team: TeamMember[]
  templates: string[]
  sources: string[]
  theme: 'dark' | 'light'

  // Interakt WhatsApp
  interaktApiKey: string
  interaktWebhookSecret: string

  // Bolna AI Voice
  bolnaAgentId: string
  bolnaApiKey: string

  // Google Ads
  googleAdsWebhookKey: string

  // Meta Ads
  metaAppId: string
  metaAccessToken: string
  metaPixelId: string

  // Portal
  portalApiUrl: string
  portalApiToken: string

  // Email
  gasUrl: string
  gasSender: string
  gmailAppPassword: string
  resendKey: string

  // AI
  geminiKey: string
  autoFollowUp: boolean
}
