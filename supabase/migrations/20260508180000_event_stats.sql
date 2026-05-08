-- ============================================================
-- Event-weite Statistiken (Key-Value), z. B. main_total_peak
-- ============================================================

create table if not exists public.event_stats (
  key         text primary key,
  value_int   bigint,
  updated_at  timestamptz not null default now()
);

alter table public.event_stats enable row level security;

drop policy if exists "public_read_stats" on public.event_stats;
create policy "public_read_stats" on public.event_stats
  for select to anon, authenticated using (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'event_stats'
  ) then
    alter publication supabase_realtime add table public.event_stats;
  end if;
end $$;

-- Initial: Twitch-Peak (135.672) aus TwitchTracker als Mindestwert.
-- Cron überschreibt nur, wenn aktueller Total > stored.
insert into public.event_stats (key, value_int) values ('main_total_peak', 135672)
  on conflict (key) do update
    set value_int = greatest(coalesce(public.event_stats.value_int, 0), excluded.value_int),
        updated_at = now();
