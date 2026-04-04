import { NextRequest, NextResponse } from 'next/server'
import nodemailer from 'nodemailer'

// Force Node.js runtime — nodemailer uses SMTP/TCP which doesn't work on Edge
export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const { to, subject, html, from, appPassword } = await req.json()

    if (!to || !subject || !html || !from || !appPassword) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields: to, subject, html, from, appPassword' },
        { status: 400 }
      )
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: from,
        pass: appPassword,
      },
    })

    const info = await transporter.sendMail({
      from: `EduAbroad <${from}>`,
      to,
      subject,
      html,
    })

    return NextResponse.json({ success: true, messageId: info.messageId })
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('Email send error:', message)
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
