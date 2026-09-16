-- Give each account a private workspace automatically and isolate every
-- application record by tenant_id. Run in Supabase SQL Editor once.

create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.tenants where owner_id = auth.uid()
$$;

revoke all on function public.current_tenant_id() from public, anon;
grant execute on function public.current_tenant_id() to authenticated;

create or replace function public.create_tenant_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenants (owner_id)
  values (new.id)
  on conflict (owner_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_tenant_for_new_user on auth.users;
create trigger create_tenant_for_new_user
  after insert on auth.users
  for each row execute function public.create_tenant_for_new_user();

-- Provision a private tenant for every account that already exists.
insert into public.tenants (owner_id)
select id from auth.users
on conflict (owner_id) do nothing;

do $$
declare
  protected_table text;
  existing_policy text;
  legacy_owner uuid;
  legacy_tenant uuid;
begin
  -- Existing shared records are retained for the original account: the oldest
  -- Auth account. Newer accounts receive an empty private workspace.
  select id into legacy_owner from auth.users order by created_at limit 1;
  select id into legacy_tenant from public.tenants where owner_id = legacy_owner;

  if legacy_tenant is null then
    raise exception 'No account exists to own the current rental data.';
  end if;

  foreach protected_table in array array[
    'clients',
    'vehicles',
    'reservations',
    'contracts',
    'contract_events',
    'reservation_audit_log',
    'payments'
  ]
  loop
    if to_regclass(format('public.%I', protected_table)) is not null then
      execute format('alter table public.%I add column if not exists tenant_id uuid references public.tenants(id)', protected_table);
      execute format('update public.%I set tenant_id = $1 where tenant_id is null', protected_table) using legacy_tenant;
      execute format('alter table public.%I alter column tenant_id set default public.current_tenant_id()', protected_table);
      execute format('alter table public.%I alter column tenant_id set not null', protected_table);
      execute format('alter table public.%I enable row level security', protected_table);

      -- Remove old policies that permit every authenticated user to see data.
      for existing_policy in
        select policyname from pg_policies
        where schemaname = 'public' and tablename = protected_table
      loop
        execute format('drop policy if exists %I on public.%I', existing_policy, protected_table);
      end loop;

      execute format(
        'create policy tenant_isolation on public.%I for all to authenticated using (tenant_id = (select public.current_tenant_id())) with check (tenant_id = (select public.current_tenant_id()))',
        protected_table
      );
    end if;
  end loop;
end $$;

alter table public.tenants enable row level security;
drop policy if exists tenant_owner_can_view on public.tenants;
create policy tenant_owner_can_view on public.tenants
  for select to authenticated
  using (owner_id = auth.uid());

-- A browser account must not be able to invoke a privileged maintenance RPC.
do $$
begin
  if to_regprocedure('public.mark_overdue_reservations()') is not null then
    revoke execute on function public.mark_overdue_reservations() from public, anon, authenticated;
  end if;
end $$;
