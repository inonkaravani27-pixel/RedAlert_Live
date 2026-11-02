-- RedAlert Live: persistent per-browser device registry.
-- Run once in the Supabase SQL Editor for the existing redalert-access project.
create table if not exists public.access_devices (
  device_id text primary key check (device_id ~ '^[A-Za-z0-9_-]{20,64}$'),
  session_hash text,
  label text check (label is null or char_length(label) <= 60),
  device_type text not null default 'מכשיר לא מזוהה',
  os text not null default 'לא מזוהה',
  browser text not null default 'לא מזוהה',
  user_agent text,
  ip_address text,
  blocked boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists access_devices_last_seen_idx
  on public.access_devices (last_seen_at desc);
alter table public.access_devices enable row level security;
revoke all on table public.access_devices from anon, authenticated;
grant all on table public.access_devices to service_role;
