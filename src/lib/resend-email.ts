export async function sendResendEmail(
  apiKey: string,
  to: string,
  subject: string,
  message: string,
  from?: string,
  replyTo?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: from || 'EduAbroad <onboarding@resend.dev>',
        to: [to],
        subject,
        reply_to: replyTo || 'goeduabroadonline@gmail.com',
        html: message.replace(/\n/g, '<br>'),
      }),
    })

    if (!response.ok) {
      const err = await response.json()
      return { success: false, error: err.message || response.statusText }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
