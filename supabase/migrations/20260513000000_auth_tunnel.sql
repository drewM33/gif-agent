-- Auth tunnel: extension pairing + per-user connections (Postgres / Supabase)

alter table public.connections add column if not exists user_id text null references public.users (id) on delete set null;

create table if not exists public.connection_pairings (
  id text primary key,
  user_id text not null references public.users (id) on delete cascade,
  code_hash text not null,
  expires_at text not null,
  consumed_at text null,
  created_at text not null
);

create table if not exists public.extension_tokens (
  id text primary key,
  user_id text not null references public.users (id) on delete cascade,
  token_id text not null unique,
  expires_at text not null,
  revoked_at text null,
  created_at text not null
);

create index if not exists idx_connection_pairings_code_hash on public.connection_pairings (code_hash);
