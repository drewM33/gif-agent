-- gif-agent core schema (Postgres / Supabase)
-- Apply with: supabase db push, or paste into SQL Editor in the Supabase dashboard.

create table if not exists public.users (
  id text primary key,
  email text not null unique,
  encrypted_api_key text null,
  llm_provider text not null default 'anthropic',
  created_at text not null,
  updated_at text not null
);

create table if not exists public.magic_links (
  id text primary key,
  user_id text not null references public.users (id) on delete cascade,
  token_hash text not null unique,
  expires_at text not null,
  used_at text null,
  created_at text not null
);

create table if not exists public.sessions (
  id text primary key,
  user_id text not null references public.users (id) on delete cascade,
  token_hash text not null unique,
  expires_at text not null,
  revoked_at text null,
  created_at text not null
);

create table if not exists public.connections (
  id text primary key,
  name text not null,
  domain text not null,
  start_url text not null,
  encrypted_state text not null,
  created_at text not null,
  updated_at text not null
);

create table if not exists public.tasks (
  id text primary key,
  question text not null,
  connection_id text null references public.connections (id) on delete set null,
  status text not null,
  plan_json text null,
  output_url text null,
  error text null,
  created_at text not null,
  updated_at text not null
);
