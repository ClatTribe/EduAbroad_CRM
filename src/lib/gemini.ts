import { Lead } from './types'

// ─── EduAbroad CRM — Gemini AI Integration ───

export async function callGeminiRaw(prompt: string, apiKey: string) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`Gemini API error: ${response.statusText}`)
  }

  return response.json()
}

export async function callGemini(prompt: string, apiKey: string): Promise<string> {
  const data = await callGeminiRaw(prompt, apiKey)
  return data.candidates?.[0]?.content?.parts?.[0]?.text || ''
}

export function buildPersonalisedContext(lead: Lead): string {
  const countries = lead.destinationCountries?.length > 0 ? lead.destinationCountries.join(', ') : 'Not decided'
  const tests = lead.testScores ? Object.entries(lead.testScores).map(([k, v]) => `${k}: ${v.score || 'Not taken'}`).join(', ') : 'No scores'

  return `Student: ${lead.name}
Phone: ${lead.phone}
Email: ${lead.email}
City: ${lead.city}
Current Education: ${lead.currentEducation || 'N/A'}
Field of Study: ${lead.fieldOfStudy || 'N/A'}
10th Marks: ${lead.tenthMarks || 'N/A'}
12th Marks: ${lead.twelfthMarks || 'N/A'}
UG CGPA: ${lead.ugCGPA || 'N/A'}
Work Experience: ${lead.workExperience || 'None'}
Destination Countries: ${countries}
Intended Degree: ${lead.intendedDegree || 'N/A'}
Target Intake: ${lead.targetIntake || 'Not decided'}
Budget: ${lead.budget || 'N/A'}
Passport: ${lead.passportStatus || 'Unknown'}
Test Scores: ${tests}
Scholarship Interest: ${lead.scholarshipInterest ? 'Yes' : 'No'}
Parent: ${lead.parentName || 'N/A'}
Current Stage: ${lead.stage}
Engagement Score: ${lead.score}/100
Source: ${lead.source}
Notes: ${lead.notes}`
}

export function buildPrompt(lead: Lead, dayIndex: number, tone: string): string {
  const funnelStages = [
    { day: 'D0', label: 'Welcome', objective: 'Warm intro, confirm enquiry, ask preferred country' },
    { day: 'D1', label: 'Value Hook', objective: '5 mistakes students make when applying abroad' },
    { day: 'D3', label: 'Profile Check', objective: 'Ask for test scores, academics, eligibility' },
    { day: 'D5', label: 'Country Guide', objective: 'Country-specific guidance based on preference' },
    { day: 'D7', label: 'Social Proof', objective: 'Success story of similar student' },
    { day: 'D10', label: 'Counselling CTA', objective: 'Book free profile evaluation session' },
    { day: 'D12', label: 'Scholarship Hook', objective: 'Scholarship eligibility check' },
    { day: 'D14', label: 'Deadline Urgency', objective: 'Application deadlines closing' },
    { day: 'D17', label: 'Parent Pitch', objective: 'ROI message for parents' },
    { day: 'D21', label: 'Last Touch', objective: 'Final outreach with social proof' },
    { day: 'D30', label: 'Zombie', objective: 'Re-engagement' },
  ]

  const stage = funnelStages[dayIndex] || funnelStages[0]
  const context = buildPersonalisedContext(lead)

  const countryTips: Record<string, string> = {
    'USA': 'Emphasize OPT (3-year STEM OPT), high ROI, Ivy League prestige, campus diversity, research opportunities',
    'UK': 'Emphasize 1-year masters (save time + money), Russell Group universities, post-study work visa (2 years), no GRE needed for most programs',
    'Canada': 'Emphasize PR pathway (post-graduation work permit → Express Entry), affordable tuition, multicultural environment, co-op programs',
    'Australia': 'Emphasize post-study work visa (2-4 years), high quality of life, part-time work rights (48 hrs/fortnight), Group of Eight universities',
    'Germany': 'Emphasize zero tuition at public universities, strong engineering programs, 18-month post-study job seeker visa, Studienkolleg pathway',
    'Ireland': 'Emphasize 2-year stay-back visa, tech hub (Google/Meta/Amazon HQ), lower cost than UK, English-speaking',
  }

  const countryContext = lead.destinationCountries?.map(c => countryTips[c] || '').filter(Boolean).join('\n') || 'No specific country selected yet — provide general study abroad benefits'

  return `You are an EduAbroad enrollment counsellor AI. Generate a WhatsApp message for this study abroad aspirant.

Stage: ${stage.day} - ${stage.label}
Objective: ${stage.objective}
Tone: ${tone}

${context}

EduAbroad Context:
- Leading study abroad consultancy for Indian students (app.goeduabroad.com)
- Destinations: USA, UK, Canada, Australia, Germany, Ireland, and 20+ countries
- Services: Profile evaluation, university shortlisting, SOP/LOR guidance, application filing, visa assistance, pre-departure briefing
- Success: 5000+ students placed at top universities worldwide
- Partners with 500+ universities across 25 countries
- Free initial counselling session available

Country-Specific Selling Points:
${countryContext}

Generate a SHORT, CASUAL WhatsApp message (2-3 sentences max) that's conversational and matches the stage objective.
Do NOT include emojis unless appropriate.
Do NOT sound salesy.
Do NOT end with a CTA unless it's day 10+.
Personalize based on the student's profile — mention their destination country, degree level, or field if available.`
}

export function buildPersonalisedPrompt(lead: Lead, objectiveKey: string, tone: string): string {
  const context = buildPersonalisedContext(lead)
  const objectiveLabels: Record<string, string> = {
    first_contact: 'Initial contact to establish credibility and understand their study abroad dream',
    social_proof: 'Share success story of a student with similar profile who got into a top university',
    objection_expensive: 'Address cost concerns with scholarship opportunities, education loans, part-time work options, and long-term ROI',
    objection_country: 'Help them compare countries based on their profile, budget, career goals, and immigration pathways',
    objection_scores: 'Address low test score concerns with pathway programs, conditional offers, and score improvement plans',
    objection_parents: 'Professional message for parents — focus on ROI, safety, career outcomes, and return on education investment',
    objection_self_apply: 'Explain value of expert guidance — university selection accuracy, SOP quality, visa success rate, scholarship negotiation',
    fomo: 'Create urgency with application deadlines, scholarship cutoffs, and intake closing dates',
    cta_counselling: 'Convince to book a free 30-minute profile evaluation call',
    cta_apply: 'Encourage them to start their application process with us',
    followup: 'Gentle follow-up for non-responders — add value, not pressure',
    winback: 'Re-engage cold leads with a fresh angle or new opportunity',
    parent: 'Message specifically for parents — formal, ROI-focused, career-trajectory framing',
    scholarship: 'Alert about scholarship opportunities matching their profile',
    vip: 'Premium positioning for high-intent leads with strong profiles',
  }

  return `You are an EduAbroad study abroad counsellor expert. Generate a message for WhatsApp, Email, or Parent communication.

Objective: ${objectiveLabels[objectiveKey] || objectiveKey}
Tone: ${tone}

Student Profile:
${context}

EduAbroad Context:
- Leading study abroad consultancy (app.goeduabroad.com)
- 5000+ students placed at top universities
- 500+ university partners across 25 countries
- Services: counselling, shortlisting, applications, visa, SOP/LOR, pre-departure
- Free initial profile evaluation available

Generate a persuasive, personalized message that:
1. Feels authentic and conversational
2. Addresses the student's specific situation (country, degree, budget)
3. Aligns with the objective
4. Uses the tone specified
5. Is concise and actionable
6. Mentions specific country benefits if destination is known

Message:`
}

export function buildEmailPrompt(lead: Lead): string {
  const context = buildPersonalisedContext(lead)

  return `You are an EduAbroad email specialist. Draft a professional email for this study abroad aspirant.

${context}

Email should:
1. Have a clear, compelling subject line
2. Personalize to their destination country and degree level
3. Include 1 relevant success story or data point
4. Address potential concerns subtly (cost, eligibility, process complexity)
5. Include a soft CTA (book free counselling or start free profile evaluation)
6. Be warm but professional
7. Mention app.goeduabroad.com

Format:
Subject: [subject]

[email body]`
}
