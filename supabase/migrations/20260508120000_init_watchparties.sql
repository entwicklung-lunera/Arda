-- ============================================================
-- Watchparties Tabelle + RLS für Arda 600km Live Tracker
-- ============================================================

create table if not exists public.watchparties (
  id            bigint generated always as identity primary key,
  platform      text not null check (platform in ('twitch','youtube')),
  channel       text not null,                       -- twitch login OR youtube videoId
  display_name  text,                                -- optional, kann von Twitch-API gefüllt werden
  approved      boolean not null default false,      -- Moderation
  status        text not null default 'unknown'
                check (status in ('live','offline','unknown','error')),
  last_viewers  integer,
  last_check    timestamptz,
  submitted_at  timestamptz not null default now(),
  submitted_ip  text,                                -- für Spam-Throttling
  unique (platform, channel)
);

create index if not exists watchparties_approved_status_idx
  on public.watchparties (approved, status, last_viewers desc);

-- ============================================================
-- Row Level Security
-- ============================================================

alter table public.watchparties enable row level security;

-- Public: nur approved + live/offline lesen
drop policy if exists "public_read_approved" on public.watchparties;
create policy "public_read_approved" on public.watchparties
  for select
  to anon, authenticated
  using (approved = true);

-- Inserts/Updates/Deletes laufen ausschließlich über Edge Functions
-- mit service_role-Key — keine Policies für anon/authenticated nötig.

-- ============================================================
-- Realtime: Tabelle in supabase_realtime Publication aufnehmen
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'watchparties'
  ) then
    alter publication supabase_realtime add table public.watchparties;
  end if;
end $$;
