// ─── EduAbroad CRM — Direct Supabase DB Operations ───
// NOTE: The main CRM (page.tsx) uses leadToRow/rowToLead from db-mapper.ts
// for all DB operations. This module is a legacy utility for direct access.

import { createClient } from './supabase'
import { Lead, Settings } from './types'
import { leadToRow, rowToLead, settingsToRow, rowToSettings } from './db-mapper'

const supabase = createClient()

export async function saveLeadToSupabase(lead: Lead, userId: string): Promise<void> {
  const row = leadToRow(lead, userId)
  const { error } = await supabase
    .from('leads')
    .upsert(row, { onConflict: 'id' })
  if (error) throw error
}

export async function deleteLeadFromSupabase(id: string): Promise<void> {
  const { error } = await supabase.from('leads').delete().eq('id', id)
  if (error) throw error
}

export async function loadLeadsFromSupabase(): Promise<Lead[]> {
  const { data, error } = await supabase.from('leads').select('*')
  if (error) throw error
  return (data || []).map(rowToLead)
}

export async function saveSettingsToSupabase(settings: Settings, userId: string): Promise<void> {
  const row = settingsToRow(settings, userId)
  const { error } = await supabase
    .from('settings')
    .upsert(row, { onConflict: 'id' })
  if (error) throw error
}

export async function loadSettingsFromSupabase(userId: string): Promise<Settings | null> {
  const { data, error } = await supabase
    .from('settings')
    .select('*')
    .eq('id', `global-${userId}`)
    .single()

  if (error && error.code !== 'PGRST116') throw error
  return data ? rowToSettings(data) : null
}

export function subscribeToLeads(
  callback: (leads: Lead[]) => void
): (() => void) {
  // Real-time subscriptions are handled in the component with channel.subscribe()
  return () => {}
}
