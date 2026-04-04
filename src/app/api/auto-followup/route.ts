import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'

export const runtime = 'nodejs'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || ''

// ── 21-Day WhatsApp Funnel ──
const FUNNEL_DAYS = [0, 1, 3, 5, 7, 10, 12, 14, 17, 21, 30]
const FUNNEL = [
  { day: 'D0', label: 'Welcome', obj: 'Warm intro, confirm enquiry, ask preferred country' },
  { day: 'D1', label: 'Value Hook', obj: '5 mistakes students make when applying abroad' },
  { day: 'D3', label: 'Profile Check', obj: 'Ask for test scores, academics, eligibility' },
  { day: 'D5', label: 'Country Guide', obj: 'Country-specific guidance based on preference' },
  { day: 'D7', label: 'Social Proof', obj: 'Success story of a similar student' },
  { day: 'D10', label: 'Counselling CTA', obj: 'Book free profile evaluation session' },
  { day: 'D12', label: 'Scholarship Hook', obj: 'Scholarship eligibility check' },
  { day: 'D14', label: 'Deadline Urgency', obj: 'Application deadlines closing' },
  { day: 'D17', label: 'Parent Pitch', obj: 'ROI of studying abroad for parents' },
  { day: 'D21', label: 'Last Touch', obj: 'Final outreach with social proof' },
  { day: 'D30', label: 'Zombie', obj: 'Re-engagement for cold leads' },
]

// ── 12-Email Drip Sequence (Study Abroad) ──
const DRIP_SCHEDULE_DAYS = [0, 1, 3, 7, 12, 18, 25, 32, 40, 48, 55, 60]

const DRIP_EMAILS = [
  // Drip 1 — Day 0: Welcome
  {
    subject: 'Welcome to EduAbroad, {{name}}!',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:20px;text-align:center"><h1 style="color:#fff;margin:0;font-size:24px">EduAbroad</h1><p style="color:#ffcdd2;margin:4px 0 0;font-size:14px">Your Study Abroad Journey Starts Here</p></div>
<div style="padding:20px">
<h2 style="color:#af0100">Welcome, {{name}}!</h2>
<p>We're excited that you're exploring study abroad options! At <strong>EduAbroad</strong>, we've helped over 5,000 Indian students get into their dream universities across USA, UK, Canada, Australia, Germany, and 20+ countries.</p>
<p><strong>Here's what we'll help you with:</strong></p>
<ul>
<li>Free profile evaluation and country recommendation</li>
<li>University shortlisting based on your academic profile and budget</li>
<li>SOP, LOR, and application guidance</li>
<li>Visa documentation and interview preparation</li>
<li>Scholarship identification and application support</li>
<li>Pre-departure briefing and accommodation assistance</li>
</ul>
<p><strong>Your next step:</strong> Reply to this email or WhatsApp us to book your <strong>free 30-minute counselling session</strong>.</p>
<p style="margin-top:20px">Warm regards,<br><strong>Team EduAbroad</strong><br><a href="https://app.goeduabroad.com" style="color:#af0100">app.goeduabroad.com</a></p>
</div></div>`,
  },
  // Drip 2 — Day 1: Study Abroad Checklist
  {
    subject: '{{name}}, your complete study abroad checklist',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">Your Study Abroad Checklist</h2>
<p>Hi {{name}},</p>
<p>Planning to study abroad can feel overwhelming. Here's a simple checklist to keep you on track:</p>
<table style="width:100%;border-collapse:collapse;margin:15px 0">
<tr style="background:#af0100;color:#fff"><th style="padding:10px;text-align:left">Step</th><th style="padding:10px">Timeline</th><th style="padding:10px">Status</th></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:10px">Research countries and universities</td><td style="padding:10px;text-align:center">12-15 months before</td><td style="padding:10px;text-align:center">Start now</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:10px">Take IELTS/TOEFL/GRE/GMAT</td><td style="padding:10px;text-align:center">10-12 months before</td><td style="padding:10px;text-align:center">Plan dates</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:10px">Prepare SOP, LOR, Resume</td><td style="padding:10px;text-align:center">8-10 months before</td><td style="padding:10px;text-align:center">-</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:10px">Submit applications</td><td style="padding:10px;text-align:center">6-9 months before</td><td style="padding:10px;text-align:center">-</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:10px">Apply for scholarships</td><td style="padding:10px;text-align:center">Along with applications</td><td style="padding:10px;text-align:center">-</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:10px">Accept offer and pay deposit</td><td style="padding:10px;text-align:center">4-6 months before</td><td style="padding:10px;text-align:center">-</td></tr>
<tr><td style="padding:10px">Apply for visa</td><td style="padding:10px;text-align:center">3-4 months before</td><td style="padding:10px;text-align:center">-</td></tr>
</table>
<p>Feeling lost about where to start? <strong>Book a free counselling call</strong> — we'll create a personalized plan for you.</p>
<p style="margin-top:20px">Best,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 3 — Day 3: Country Comparison
  {
    subject: '{{name}}, which country is right for you?',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">USA vs UK vs Canada vs Australia — Which is Right for You?</h2>
<p>Hi {{name}},</p>
<p>Choosing the right country is the biggest decision. Here's a quick comparison:</p>
<table style="width:100%;border-collapse:collapse;margin:15px 0;font-size:13px">
<tr style="background:#af0100;color:#fff"><th style="padding:8px">Factor</th><th style="padding:8px">USA</th><th style="padding:8px">UK</th><th style="padding:8px">Canada</th><th style="padding:8px">Australia</th></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:8px"><strong>Masters Duration</strong></td><td style="padding:8px;text-align:center">2 years</td><td style="padding:8px;text-align:center">1 year</td><td style="padding:8px;text-align:center">1.5-2 years</td><td style="padding:8px;text-align:center">1.5-2 years</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:8px"><strong>Annual Cost</strong></td><td style="padding:8px;text-align:center">25-55L</td><td style="padding:8px;text-align:center">20-40L</td><td style="padding:8px;text-align:center">15-30L</td><td style="padding:8px;text-align:center">20-35L</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:8px"><strong>Work Visa</strong></td><td style="padding:8px;text-align:center">OPT (3yr STEM)</td><td style="padding:8px;text-align:center">2yr Graduate</td><td style="padding:8px;text-align:center">3yr PGWP</td><td style="padding:8px;text-align:center">2-4yr PSW</td></tr>
<tr><td style="padding:8px"><strong>PR Pathway</strong></td><td style="padding:8px;text-align:center">H1B lottery</td><td style="padding:8px;text-align:center">Skilled Worker</td><td style="padding:8px;text-align:center">Express Entry</td><td style="padding:8px;text-align:center">Points-based</td></tr>
</table>
<p>The best country depends on YOUR goals, budget, and career plans. Let us help you decide — <strong>reply "COMPARE" and we'll send a personalized analysis.</strong></p>
<p style="margin-top:20px">Cheers,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 4 — Day 7: Test Prep Guide
  {
    subject: '{{name}}, IELTS vs TOEFL vs PTE — which test should you take?',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">Which English Test Should You Take?</h2>
<p>Hi {{name}},</p>
<p>Confused about IELTS, TOEFL, and PTE? Here's the truth — all three are accepted by most universities. But the right choice depends on your strengths:</p>
<ul>
<li><strong>IELTS</strong> — Best for UK, Australia, Canada. Face-to-face speaking test. Good if you're comfortable with British English.</li>
<li><strong>TOEFL</strong> — Best for USA. Fully computer-based. Good if you prefer typing over handwriting.</li>
<li><strong>PTE</strong> — Fastest results (48 hours). Fully computer-based. AI-scored. Good if you want quick results.</li>
</ul>
<p><strong>Pro tip:</strong> Many universities now accept Duolingo English Test (DET) — it's cheaper and quicker. Ask us which universities accept it.</p>
<p>Need help choosing? <strong>Reply and we'll recommend the best test for your target universities.</strong></p>
<p style="margin-top:20px">Best,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 5 — Day 12: Scholarship Guide
  {
    subject: '{{name}}, how to get scholarships worth 10-50 Lakhs',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">Scholarships Worth 10-50 Lakhs — Are You Eligible?</h2>
<p>Hi {{name}},</p>
<p>Most students don't know this: <strong>thousands of scholarships go unclaimed every year</strong> because students don't apply. Here's what's available:</p>
<ul>
<li><strong>Merit-based:</strong> Based on academic scores — 10-100% tuition waiver</li>
<li><strong>Need-based:</strong> Based on financial situation — grants that don't need repayment</li>
<li><strong>Country-specific:</strong> Chevening (UK), Fulbright (USA), DAAD (Germany), Endeavour (Australia)</li>
<li><strong>University-specific:</strong> Many universities offer automatic scholarships based on your application</li>
</ul>
<p style="background:#fff3e0;padding:15px;border-radius:8px;border-left:4px solid #af0100"><strong>Did you know?</strong> At EduAbroad, we've helped students secure scholarships totaling over 50 Crores in the last 3 years alone.</p>
<p>Want us to check your scholarship eligibility? <strong>Reply "SCHOLARSHIP" and we'll do a free scholarship assessment.</strong></p>
<p style="margin-top:20px">Cheers,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 6 — Day 18: Success Story
  {
    subject: 'How Priya got into University of Toronto with a 50% scholarship',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">From Mumbai to Toronto — A Real Success Story</h2>
<p>Hi {{name}},</p>
<p>Let me share something inspiring. Last year, <strong>Priya from Mumbai</strong> came to us confused about studying abroad. She had a 7.5 CGPA and IELTS 7.0.</p>
<p><strong>Here's what happened:</strong></p>
<ul>
<li>Our counsellors evaluated her profile and recommended <strong>Canada</strong> based on her budget and PR goals</li>
<li>We shortlisted 8 universities with strong CS programs and scholarship opportunities</li>
<li>Crafted a compelling SOP highlighting her internship experience and research projects</li>
<li>She got admits from <strong>5 universities</strong> including University of Toronto</li>
<li>Secured a <strong>50% tuition scholarship</strong> worth CAD 25,000/year!</li>
</ul>
<p style="background:#f5f5f5;padding:15px;border-radius:8px;border-left:4px solid #af0100"><em>"EduAbroad made the impossible feel possible. I never thought I could get into U of T with a scholarship. Their SOP guidance was a game-changer."</em><br>— <strong>Priya S., University of Toronto, MS Computer Science</strong></p>
<p>Your story could be next. <strong>Let's talk?</strong></p>
<p style="margin-top:20px">Warm regards,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 7 — Day 25: Budget Breakdown
  {
    subject: '{{name}}, the real cost of studying abroad — complete breakdown',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">The Real Cost of Studying Abroad</h2>
<p>Hi {{name}},</p>
<p>Let's be transparent about costs. Here's what studying abroad actually costs for Indian students:</p>
<table style="width:100%;border-collapse:collapse;margin:15px 0;font-size:13px">
<tr style="background:#af0100;color:#fff"><th style="padding:8px;text-align:left">Expense</th><th style="padding:8px">USA</th><th style="padding:8px">UK</th><th style="padding:8px">Canada</th><th style="padding:8px">Germany</th></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:8px">Tuition/year</td><td style="padding:8px;text-align:center">25-55L</td><td style="padding:8px;text-align:center">18-35L</td><td style="padding:8px;text-align:center">12-25L</td><td style="padding:8px;text-align:center">0-5L</td></tr>
<tr style="border-bottom:1px solid #ddd"><td style="padding:8px">Living/year</td><td style="padding:8px;text-align:center">10-18L</td><td style="padding:8px;text-align:center">10-15L</td><td style="padding:8px;text-align:center">8-12L</td><td style="padding:8px;text-align:center">7-10L</td></tr>
<tr><td style="padding:8px"><strong>Total/year</strong></td><td style="padding:8px;text-align:center"><strong>35-73L</strong></td><td style="padding:8px;text-align:center"><strong>28-50L</strong></td><td style="padding:8px;text-align:center"><strong>20-37L</strong></td><td style="padding:8px;text-align:center"><strong>7-15L</strong></td></tr>
</table>
<p><strong>Ways to reduce costs:</strong> scholarships, part-time work (allowed in most countries), assistantships, and education loans covering up to 100% with moratorium period.</p>
<p>Want a personalized budget plan? <strong>Reply "BUDGET" and we'll create one for your target country.</strong></p>
<p style="margin-top:20px">Best,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 8 — Day 32: SOP/LOR Guide
  {
    subject: '{{name}}, what universities ACTUALLY want in your SOP',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">SOP & LOR Guide — What Universities Want</h2>
<p>Hi {{name}},</p>
<p>Your SOP (Statement of Purpose) can make or break your application. Here's what admissions committees actually look for:</p>
<ul>
<li><strong>Your story</strong> — Not your grades. Why this field? What drives you?</li>
<li><strong>Specificity</strong> — Why THIS university and THIS program specifically?</li>
<li><strong>Research fit</strong> — Have you looked at faculty and their research areas?</li>
<li><strong>Career clarity</strong> — How does this degree connect to your 5-year plan?</li>
<li><strong>Authenticity</strong> — Generic SOPs get rejected instantly</li>
</ul>
<p><strong>Common mistakes we see:</strong></p>
<ul>
<li>Using the same SOP for every university</li>
<li>Starting with "Since childhood, I was fascinated by..."</li>
<li>Listing achievements instead of telling a story</li>
<li>Not mentioning the specific program or faculty</li>
</ul>
<p>Our SOP experts have helped 5,000+ students craft winning statements. <strong>Reply "SOP HELP" and we'll review your draft for free.</strong></p>
<p style="margin-top:20px">Cheers,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 9 — Day 40: Parent-focused
  {
    subject: 'A message for {{name}}\'s family — the ROI of studying abroad',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">Dear Parents — Why Studying Abroad is Worth the Investment</h2>
<p>Dear {{name}} & Family,</p>
<p>We understand that sending your child abroad is a significant decision — both emotionally and financially. Here's why it's one of the best investments you can make:</p>
<ul>
<li><strong>Global career opportunities</strong> — International graduates earn 2-5x more than domestic graduates in similar fields</li>
<li><strong>Immigration pathways</strong> — Countries like Canada, Australia, and Germany offer permanent residency routes for international students</li>
<li><strong>Personal growth</strong> — Living independently abroad builds confidence, adaptability, and a global network</li>
<li><strong>Loan options</strong> — Education loans cover 100% of costs with repayment starting only after the student gets a job</li>
<li><strong>ROI in 3-5 years</strong> — Most families recover their investment within 3-5 years of their child graduating abroad</li>
</ul>
<p><strong>Safety & support:</strong> At EduAbroad, we assist with accommodation, airport pickup, local orientation, and maintain regular check-ins even after the student arrives abroad.</p>
<p>We'd be happy to speak with your family directly. <strong>Reply to schedule a family counselling call.</strong></p>
<p style="margin-top:20px">With respect,<br><strong>Team EduAbroad</strong><br><a href="https://app.goeduabroad.com" style="color:#af0100">app.goeduabroad.com</a></p>
</div></div>`,
  },
  // Drip 10 — Day 48: Deadline Alert
  {
    subject: '{{name}}, application deadlines you can\'t miss',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#c62828">Application Deadlines You Can't Miss</h2>
<p>Hi {{name}},</p>
<p>Universities have strict deadlines, and missing them means waiting another year. Here are key dates to keep in mind:</p>
<ul>
<li><strong>USA (Fall):</strong> Most deadlines between December - March</li>
<li><strong>UK (Fall):</strong> Rolling admissions, but apply before March for best chances</li>
<li><strong>Canada (Fall):</strong> January - April deadlines for most universities</li>
<li><strong>Australia (July):</strong> Apply by March-April for Semester 2</li>
<li><strong>Germany (Winter):</strong> July deadlines through uni-assist</li>
</ul>
<p style="background:#fff3e0;padding:15px;border-radius:8px;border-left:4px solid #c62828"><strong>Early applications get priority</strong> — for scholarship consideration, housing, and visa processing. Don't wait until the last minute.</p>
<p>We track all deadlines for your shortlisted universities. <strong>Start your applications now — reply "START" to begin.</strong></p>
<p style="margin-top:20px">Don't delay,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 11 — Day 55: Free Profile Evaluation
  {
    subject: '{{name}}, free profile evaluation — limited slots this month',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">Free Profile Evaluation — Limited Slots</h2>
<p>Hi {{name}},</p>
<p>It's been a while since we connected. I wanted to personally offer you a <strong>free, no-obligation profile evaluation</strong>.</p>
<p><strong>In this 30-minute session, we'll cover:</strong></p>
<ul>
<li>Which countries and universities match your profile</li>
<li>Your chances of admission at target universities</li>
<li>Scholarship opportunities you qualify for</li>
<li>Complete timeline and cost estimation</li>
<li>Test score requirements and preparation tips</li>
</ul>
<p>We only have a limited number of free slots each month, and they fill up quickly.</p>
<p><strong>Reply "EVALUATE" or call us to book your slot.</strong></p>
<p style="margin-top:20px">Looking forward to helping you,<br><strong>Team EduAbroad</strong></p>
</div></div>`,
  },
  // Drip 12 — Day 60: Final Touch
  {
    subject: '{{name}}, this is our last email (unless you say otherwise)',
    html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333">
<div style="background:#af0100;padding:15px;text-align:center"><h2 style="color:#fff;margin:0">EduAbroad</h2></div>
<div style="padding:20px">
<h2 style="color:#af0100">A Final Note From Us</h2>
<p>Hi {{name}},</p>
<p>This is the last email we'll send you about studying abroad. We respect your inbox and your decision timeline.</p>
<p><strong>Quick recap of what EduAbroad offers:</strong></p>
<ul>
<li>Free profile evaluation and counselling</li>
<li>University shortlisting across 25+ countries</li>
<li>Expert SOP, LOR, and application guidance</li>
<li>Visa documentation and interview preparation</li>
<li>Scholarship identification (we've helped students secure 50+ Crores in scholarships)</li>
<li>Post-arrival support including accommodation and orientation</li>
</ul>
<p>If you ever decide to study abroad — whether it's next month, next year, or three years from now — <strong>we'll be here</strong>. Just reply to this email or visit <a href="https://app.goeduabroad.com" style="color:#af0100">app.goeduabroad.com</a>.</p>
<p style="background:#e8f5e9;padding:15px;border-radius:8px;border-left:4px solid #4caf50"><strong>Special offer:</strong> This email comes with a standing <strong>waiver on our counselling fee</strong> — valid anytime you decide to start. Just mention this email.</p>
<p>Wishing you the very best in whatever path you choose.</p>
<p style="margin-top:20px">With warm regards,<br><strong>Team EduAbroad</strong><br><a href="https://app.goeduabroad.com" style="color:#af0100">app.goeduabroad.com</a></p>
</div></div>`,
  },
]

// ── Helpers ──
function daysSince(ts: number): number {
  if (!ts) return 999
  return Math.floor((Date.now() - ts) / 86400000)
}

function pickFunnelStage(leadAgeDays: number): number {
  for (let i = FUNNEL_DAYS.length - 1; i >= 0; i--) {
    if (leadAgeDays >= FUNNEL_DAYS[i]) return i
  }
  return 0
}

async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  )
  if (!res.ok) throw new Error(`Gemini error: ${res.statusText}`)
  const data = await res.json()
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

async function sendInteraktMsg(apiKey: string, phone: string, message: string) {
  const cleanPhone = phone.replace(/\D/g, '').slice(-10)
  await fetch('https://api.interakt.ai/v1/public/message/', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      countryCode: '+91',
      phoneNumber: cleanPhone,
      callbackData: 'eduabroad-auto',
      type: 'Text',
      data: { message },
    }),
  })
}

async function sendGmailSMTP(from: string, appPassword: string, to: string, subject: string, html: string): Promise<boolean> {
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: from, pass: appPassword },
    })
    await transporter.sendMail({ from: `EduAbroad <${from}>`, to, subject, html })
    return true
  } catch (err) {
    console.error('Gmail SMTP error:', err)
    return false
  }
}

async function sendResendEmail(apiKey: string, to: string, subject: string, html: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'EduAbroad <onboarding@resend.dev>', to: [to], subject, html }),
  })
  if (!res.ok) throw new Error(`Resend error: ${res.statusText}`)
}

async function sendGASEmail(gasUrl: string, email: string, message: string, subject: string) {
  await fetch(gasUrl, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: email, subject, body: message }),
  })
}

// ── Main Cron Handler ──
export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!serviceKey || !SUPABASE_URL) {
    return NextResponse.json({ error: 'Missing service role key or Supabase URL' }, { status: 500 })
  }

  const supabase = createClient(SUPABASE_URL, serviceKey)

  // Load settings
  const { data: settingsRows } = await supabase.from('settings').select('*').limit(1)
  const settings = settingsRows?.[0]
  if (!settings) {
    return NextResponse.json({ error: 'No settings found' }, { status: 400 })
  }

  // Load active, non-enrolled leads
  const { data: leadsData } = await supabase
    .from('leads')
    .select('*')
    .neq('stage', 'Enrolled / Flew')
    .eq('lead_status', 'active')

  if (!leadsData || leadsData.length === 0) {
    return NextResponse.json({ message: 'No leads to follow up' })
  }

  let whatsappSent = 0
  let emailDripSent = 0
  let errors = 0

  for (const lead of leadsData) {
    try {
      const ageDays = daysSince(lead.created_at)

      // ═══════════ PART 1: WhatsApp Funnel ═══════════
      if (settings.gemini_key && settings.interakt_api_key) {
        const stageIdx = pickFunnelStage(ageDays)
        const stage = FUNNEL[stageIdx]
        const existingMessages = lead.sent_messages || []

        if (!existingMessages.some((m: any) => m.day === stage.day)) {
          const countries = (lead.destination_countries || []).join(', ') || 'Not decided'
          const prompt = `You are an EduAbroad study abroad counsellor AI. Generate a WhatsApp message for a student exploring study abroad.
Stage: ${stage.day} - ${stage.label}
Objective: ${stage.obj}
Tone: warm and helpful

Student: ${lead.name}
Phone: ${lead.phone}
Email: ${lead.email}
City: ${lead.city}
Education: ${lead.current_education || 'Unknown'}
Destination Countries: ${countries}
Intended Degree: ${lead.intended_degree || 'Not decided'}
Target Intake: ${lead.target_intake || 'Not decided'}
Budget: ${lead.budget || 'Unknown'}
Stage: ${lead.stage}
Score: ${lead.score}/100

EduAbroad Context:
- Leading study abroad consultancy (app.goeduabroad.com)
- 5000+ students placed, 500+ university partners
- Free profile evaluation available

Generate a SHORT, CASUAL WhatsApp message (2-3 sentences max). Personalize to their destination and degree if available.`

          const message = await callGemini(prompt, settings.gemini_key)
          if (message) {
            if (lead.phone) {
              await sendInteraktMsg(settings.interakt_api_key, lead.phone, message)
            }

            const newMessage = {
              day: stage.day, label: stage.label, message,
              channel: 'WhatsApp', sentAt: Date.now(),
            }
            await supabase.from('leads').update({
              sent_messages: [...existingMessages, newMessage],
            }).eq('id', lead.id)
            whatsappSent++
          }
        }
      }

      // ═══════════ PART 2: Email Drip Sequence ═══════════
      if (!lead.email) continue

      const dripCount = lead.drip_count || 0
      const lastDripAt = lead.last_drip_at || lead.created_at || 0

      if (dripCount >= DRIP_EMAILS.length) continue

      const nextDripIndex = dripCount
      const nextDripDay = DRIP_SCHEDULE_DAYS[nextDripIndex]
      if (ageDays < nextDripDay) continue

      const hoursSinceLastDrip = (Date.now() - lastDripAt) / (1000 * 60 * 60)
      if (dripCount > 0 && hoursSinceLastDrip < 20) continue

      const drip = DRIP_EMAILS[nextDripIndex]
      const subject = drip.subject.replace(/\{\{name\}\}/g, lead.name || 'there')
      const html = drip.html.replace(/\{\{name\}\}/g, lead.name || 'there')

      let emailSent = false
      const senderEmail = settings.gas_sender || 'goeduabroadonline@gmail.com'
      const appPassword = settings.gmail_app_password

      if (appPassword && senderEmail) {
        emailSent = await sendGmailSMTP(senderEmail, appPassword, lead.email, subject, html)
      } else if (settings.resend_key) {
        try {
          await sendResendEmail(settings.resend_key, lead.email, subject, html)
          emailSent = true
        } catch { emailSent = false }
      } else if (settings.gas_url) {
        try {
          await sendGASEmail(settings.gas_url, lead.email, html, subject)
          emailSent = true
        } catch { emailSent = false }
      }

      if (emailSent) {
        const existingMessages = lead.sent_messages || []
        const newMessage = {
          day: `Drip ${nextDripIndex + 1}`,
          label: `Email Drip ${nextDripIndex + 1}`,
          message: subject,
          channel: 'Email',
          sentAt: Date.now(),
        }
        await supabase.from('leads').update({
          drip_count: nextDripIndex + 1,
          last_drip_at: Date.now(),
          sent_messages: [...existingMessages, newMessage],
        }).eq('id', lead.id)
        emailDripSent++
      }

    } catch (err) {
      console.error(`Auto-followup failed for ${lead.name}:`, err)
      errors++
    }
  }

  return NextResponse.json({
    message: `EduAbroad auto-followup complete. WhatsApp: ${whatsappSent}, Email drips: ${emailDripSent}, Errors: ${errors}`,
    whatsappSent,
    emailDripSent,
    errors,
  })
}
