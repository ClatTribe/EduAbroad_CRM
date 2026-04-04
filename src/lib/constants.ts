import { Lead } from './types'

// ─── EduAbroad CRM — Constants ───

export const STAGES = [
  'New Enquiry',
  'Not Contacted',
  'Counselling Scheduled',
  'Counselling Done',
  'Profile Evaluation',
  'University Shortlisting',
  'Application In Progress',
  'Offer Received',
  'Offer Accepted',
  'Visa Processing',
  'Pre-Departure',
  'Enrolled / Flew'
]

export const STAGE_COLORS: Record<string, string> = {
  'New Enquiry': '#fff59d',
  'Not Contacted': '#e0e0e0',
  'Counselling Scheduled': '#bbdefb',
  'Counselling Done': '#90caf9',
  'Profile Evaluation': '#ce93d8',
  'University Shortlisting': '#ffcc80',
  'Application In Progress': '#ffb74d',
  'Offer Received': '#ff7043',
  'Offer Accepted': '#ef5350',
  'Visa Processing': '#7e57c2',
  'Pre-Departure': '#66bb6a',
  'Enrolled / Flew': '#4caf50'
}

export const DESTINATION_COUNTRIES = [
  'USA', 'UK', 'Canada', 'Australia', 'Germany', 'Ireland',
  'New Zealand', 'Singapore', 'France', 'Netherlands', 'Italy',
  'Japan', 'South Korea', 'UAE', 'Other'
]

export const DEGREE_LEVELS = [
  'UG (Bachelors)', 'PG (Masters)', 'PhD', 'MBA', 'Diploma', 'Pathway/Foundation'
]

export const EDUCATION_LEVELS = [
  '10th', '12th', 'UG Year 1', 'UG Year 2', 'UG Year 3', 'UG Year 4',
  'Graduate', 'Working Professional', 'Other'
]

export const BUDGET_RANGES = [
  'Below 10L', '10-20L', '20-30L', '30-50L', '50L+', 'Need Scholarship'
]

export const PASSPORT_STATUSES = [
  'Not Applied', 'Applied', 'Have Passport'
]

export const INTAKE_OPTIONS = [
  'Fall 2026', 'Spring 2027', 'Summer 2027', 'Fall 2027', 'Spring 2028', 'Not Decided'
]

export const TEST_TYPES = [
  'IELTS', 'TOEFL', 'PTE', 'Duolingo', 'GRE', 'GMAT', 'SAT', 'ACT'
]

export const FIELDS_OF_STUDY = [
  'Engineering', 'Computer Science', 'Business/Management', 'Medicine/Healthcare',
  'Arts & Humanities', 'Science', 'Law', 'Design', 'Architecture',
  'Hospitality', 'Media & Communications', 'Education', 'Other'
]

export const SERVICE_TYPES = [
  'Counselling Only', 'Test Prep Only', 'Application + Visa',
  'Full Package', 'Visa Only', 'SOP/LOR Only'
]

export const VISA_STATUSES = [
  'Not Applied', 'Documents Gathering', 'Applied', 'Interview Scheduled',
  'Approved', 'Rejected', 'Deferred'
]

export const DOCUMENT_TYPES = [
  'Passport', '10th Marksheet', '12th Marksheet', 'UG Transcripts',
  'Degree Certificate', 'SOP', 'LOR 1', 'LOR 2', 'LOR 3',
  'Resume/CV', 'IELTS/TOEFL Scorecard', 'GRE/GMAT Scorecard',
  'Financial Documents', 'Bank Statements', 'Affidavit of Support',
  'Medical Certificate', 'Police Clearance', 'Photographs',
  'Work Experience Letters', 'Portfolio'
]

export const APPLICATION_STATUSES = [
  'Not Started', 'Documents Ready', 'Submitted', 'Under Review',
  'Offer Received', 'Offer Accepted', 'Deposit Paid', 'CAS/COE Received'
]

export const LEAD_STATUSES = [
  'active', 'lost', 'deferred'
]

// ─── 21-Day WhatsApp Nurture Funnel ───

export interface FunnelItem {
  day: string
  label: string
  ch: string
  sender: string
  obj: string
}

export const FUNNEL: FunnelItem[] = [
  { day: 'D0', label: 'Welcome', ch: 'WhatsApp', sender: 'Auto', obj: 'Warm intro, confirm enquiry, ask preferred country' },
  { day: 'D1', label: 'Value Hook', ch: 'WhatsApp', sender: 'Auto', obj: '5 mistakes Indian students make when applying abroad' },
  { day: 'D3', label: 'Profile Check', ch: 'WhatsApp', sender: 'Auto', obj: 'Ask for test scores, academics, eligibility assessment' },
  { day: 'D5', label: 'Country Guide', ch: 'WhatsApp', sender: 'Auto', obj: 'Send relevant country guide based on preference' },
  { day: 'D7', label: 'Social Proof', ch: 'WhatsApp', sender: 'Auto', obj: 'Success story of similar student at dream university' },
  { day: 'D10', label: 'Counselling CTA', ch: 'WhatsApp', sender: 'Team', obj: 'Book free 30-min profile evaluation session' },
  { day: 'D12', label: 'Scholarship Hook', ch: 'WhatsApp', sender: 'Auto', obj: '50-100% scholarship eligibility check offer' },
  { day: 'D14', label: 'Deadline Urgency', ch: 'WhatsApp', sender: 'Auto', obj: 'Application deadlines closing for target intake' },
  { day: 'D17', label: 'Parent Pitch', ch: 'WhatsApp', sender: 'Team', obj: 'ROI of studying abroad — share with parents' },
  { day: 'D21', label: 'Last Touch', ch: 'WhatsApp', sender: 'Team', obj: 'We are still here — what students like you achieved' },
  { day: 'D30', label: 'Zombie Resurrection', ch: 'Email', sender: 'Auto', obj: 'Re-engagement for cold leads' },
]

export const FUNNEL_DAYS = [0, 1, 3, 5, 7, 10, 12, 14, 17, 21, 30]

// ─── Objections (Study Abroad specific) ───

export interface Objection {
  key: string
  label: string
  icon: string
}

export const OBJECTIONS: Objection[] = [
  { key: 'expensive', label: 'Too expensive', icon: '💰' },
  { key: 'country_unsure', label: 'Not sure about country', icon: '🌍' },
  { key: 'low_scores', label: 'Low test scores', icon: '📉' },
  { key: 'parents', label: 'Parents not convinced', icon: '👨‍👩‍👧' },
  { key: 'later', label: 'Want to decide later', icon: '📅' },
  { key: 'competitor', label: 'Using another consultant', icon: '🎯' },
  { key: 'self_apply', label: 'Will apply myself', icon: '✍️' },
]

// ─── CSV Import Fields ───

export interface CSVField {
  key: keyof Lead
  label: string
  required: boolean
}

export const CSV_FIELDS: CSVField[] = [
  { key: 'name', label: 'Full Name *', required: true },
  { key: 'phone', label: 'Phone (10 digits) *', required: true },
  { key: 'email', label: 'Email *', required: true },
  { key: 'city', label: 'City', required: false },
  { key: 'currentEducation', label: 'Current Education', required: false },
  { key: 'intendedDegree', label: 'Intended Degree', required: false },
  { key: 'targetIntake', label: 'Target Intake', required: false },
  { key: 'source', label: 'Source', required: false },
  { key: 'parentName', label: 'Parent Name', required: false },
  { key: 'stage', label: 'Stage', required: false },
  { key: 'notes', label: 'Notes', required: false },
]

// ─── AI Prompt Library (Study Abroad) ───

export interface PromptTemplate {
  label: string
  objective: string
  tone: string
  ctx: string
}

export const PROMPT_LIBRARY: PromptTemplate[] = [
  { label: 'Intro — first touch', objective: 'first_contact', tone: 'warm', ctx: '' },
  { label: 'Social proof — student success', objective: 'social_proof', tone: 'persuasive', ctx: 'University admission success stories' },
  { label: 'Objection — too expensive', objective: 'objection_expensive', tone: 'logical', ctx: 'Scholarships, ROI, education loans' },
  { label: 'Objection — country unsure', objective: 'objection_country', tone: 'educational', ctx: 'Country comparison framework' },
  { label: 'Objection — low scores', objective: 'objection_scores', tone: 'encouraging', ctx: 'Pathway programs, conditional offers' },
  { label: 'Objection — parents not convinced', objective: 'objection_parents', tone: 'professional', ctx: 'ROI, career outcomes, safety' },
  { label: 'Objection — will apply myself', objective: 'objection_self_apply', tone: 'helpful', ctx: 'Value of expert guidance' },
  { label: 'FOMO — deadline urgency', objective: 'fomo', tone: 'urgent', ctx: 'Application deadlines, scholarship deadlines' },
  { label: 'CTA — book counselling', objective: 'cta_counselling', tone: 'friendly', ctx: 'Free profile evaluation' },
  { label: 'CTA — start application', objective: 'cta_apply', tone: 'celebratory', ctx: 'Begin application journey' },
  { label: 'Follow-up — no response', objective: 'followup', tone: 'patient', ctx: 'Gentle reminder' },
  { label: 'Win-back — zombie', objective: 'winback', tone: 'hopeful', ctx: 'Re-engagement' },
  { label: 'Parent engagement', objective: 'parent', tone: 'professional', ctx: 'ROI, safety, career outcomes for parents' },
  { label: 'Scholarship alert', objective: 'scholarship', tone: 'exciting', ctx: 'Scholarship opportunities' },
  { label: 'VIP — high score lead', objective: 'vip', tone: 'premium', ctx: 'Priority service positioning' },
]
