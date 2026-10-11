-- Mochi Days beta app storage. Run once in YOUR Supabase project's SQL Editor.
-- Every planner item is owned by its signed-in user. NEVER turn off RLS.
create table if not exists public.planner_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null check (category in ('days','weeks','months','habits','drawings')),
  item_key text not null,
  value jsonb not null default '{}'::jsonb,
  client_updated_at bigint not null default 1,
  primary key (user_id, category, item_key)
);
alter table public.planner_items enable row level security;
revoke all on table public.planner_items from anon;
grant select, insert, update on table public.planner_items to authenticated;
-- Safe to re-run in Supabase SQL Editor.
drop policy if exists "planner select own" on public.planner_items;
drop policy if exists "planner insert own" on public.planner_items;
drop policy if exists "planner update own" on public.planner_items;
create policy "planner select own" on public.planner_items
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "planner insert own" on public.planner_items
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "planner update own" on public.planner_items
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
-- Production requirement: test SELECT/INSERT/UPDATE denials using two distinct users.
