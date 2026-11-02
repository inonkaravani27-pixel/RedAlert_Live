-- RedAlert Live: persistent access requests and approvals.
-- Run this once in Supabase SQL Editor for project redalert-access.

create table if not exists public.access_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 2 and 100),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  access_token_hash text not null unique
    check (access_token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index if not exists access_requests_status_created_at_idx
  on public.access_requests (status, created_at desc);

alter table public.access_requests enable row level security;

-- Only the server's Supabase secret key may read or modify these records.
revoke all on table public.access_requests from anon, authenticated;
grant all on table public.access_requests to service_role;
