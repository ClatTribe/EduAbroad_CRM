-- ============================================
-- EduAbroad CRM v1 — Supabase Database Setup
-- RUN THIS IN THE SUPABASE SQL EDITOR
-- ============================================

-- 0. DROP existing tables (clean slate)
drop table if exists public.leads cascade;
drop table if exists public.settings cascade;

-- 1. LEADS TABLE
create table public.leads (
  id text primary key,
  name text not null default '',
  phone text not null default '',
  email text not null default '',
  city text not null default '',
  state text not null default '',
  source text not null default '',
  parent_name text not null default '',
  parent_phone text not null default '',
  parent_email text not null default '',
  current_education text not null default '',
  tenth_marks text not null default '',
  twelfth_marks text not null default '',
  ug_cgpa text not null default '',
  field_of_study text not null default '',
  work_experience text not null default '',
  gap_years integer not null default 0,
  destination_countries jsonb not null default '[]'::jsonb,
  intended_degree text not null default '',
  target_intake text not null default '',
  budget text not null default '',
  passport_status text not null default '',
  scholarship_interest boolean not null default false,
  test_scores jsonb not null default '{}'::jsonb,
  preferred_universities jsonb not null default '[]'::jsonb,
  stage text not null default 'New Enquiry',
  score integer not null default 0,
  score_label text not null default '',
  score_reason text not null default '',
  notes text not null default '',
  assigned_to text not null default '',
  lead_status text not null default 'active',
  created_at bigint not null default 0,
  follow_up_at bigint not null default 0,
  follow_up_note text not null default '',
  service_type text not null default '',
  fee_amount numeric not null default 0,
  payment_link text not null default '',
  payment_pending_at bigint not null default 0,
  enrolled_at bigint not null default 0,
  applications jsonb not null default '[]'::jsonb,
  documents jsonb not null default '[]'::jsonb,
  visa_country text not null default '',
  visa_type text not null default '',
  visa_application_date bigint not null default 0,
  visa_interview_date bigint not null default 0,
  visa_status text not null default '',
  conversations jsonb not null default '[]'::jsonb,
  sent_messages jsonb not null default '[]'::jsonb,
  call_transcripts jsonb not null default '[]'::jsonb,
  zombie_resurrected boolean not null default false,
  zombie_attempts integer not null default 0,
  last_zombie_at bigint not null default 0,
  drip_count integer not null default 0,
  last_drip_at bigint not null default 0,
  remarks jsonb not null default '[]'::jsonb,
  utm_source text not null default '',
  utm_medium text not null default '',
  utm_campaign text not null default '',
  google_click_id text not null default '',
  meta_lead_id text not null default '',
  portal_user_id text not null default '',
  bolna_calls jsonb not null default '[]'::jsonb,
  user_id text not null default ''
);

-- 2. SETTINGS TABLE
create table public.settings (
  id text primary key,
  team jsonb not null default '[]'::jsonb,
  templates jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  theme text not null default 'light',
  interakt_api_key text not null default '',
  interakt_webhook_secret text not null default '',
  bolna_agent_id text not null default '',
  bolna_api_key text not null default '',
  google_ads_webhook_key text not null default '',
  meta_app_id text not null default '',
  meta_access_token text not null default '',
  meta_pixel_id text not null default '',
  portal_api_url text not null default '',
  portal_api_token text not null default '',
  gas_url text not null default '',
  gas_sender text not null default '',
  gmail_app_password text not null default '',
  resend_key text not null default '',
  gemini_key text not null default '',
  auto_follow_up boolean not null default false,
  user_id text not null default ''
);

-- 3. Enable Row Level Security
alter table public.leads enable row level security;
alter table public.settings enable row level security;

-- 4. RLS Policies for leads
create policy "Users can view their own leads" on public.leads for select using (auth.uid()::text = user_id);
create policy "Users can insert their own leads" on public.leads for insert with check (auth.uid()::text = user_id);
create policy "Users can update their own leads" on public.leads for update using (auth.uid()::text = user_id);
create policy "Users can delete their own leads" on public.leads for delete using (auth.uid()::text = user_id);

-- 5. RLS Policies for settings
create policy "Users can view their own settings" on public.settings for select using (auth.uid()::text = user_id);
create policy "Users can insert their own settings" on public.settings for insert with check (auth.uid()::text = user_id);
create policy "Users can update their own settings" on public.settings for update using (auth.uid()::text = user_id);
create policy "Users can delete their own settings" on public.settings for delete using (auth.uid()::text = user_id);

-- 6. Enable Realtime
alter publication supabase_realtime add table public.leads;

-- 7. Indexes
create index if not exists idx_leads_user_id on public.leads(user_id);
create index if not exists idx_leads_stage on public.leads(stage);
create index if not exists idx_leads_follow_up_at on public.leads(follow_up_at);
create index if not exists idx_leads_destination on public.leads using gin(destination_countries);
create index if not exists idx_leads_target_intake on public.leads(target_intake);
create index if not exists idx_leads_visa_status on public.leads(visa_status);
create index if not exists idx_leads_lead_status on public.leads(lead_status);
create index if not exists idx_settings_user_id on public.settings(user_id);
