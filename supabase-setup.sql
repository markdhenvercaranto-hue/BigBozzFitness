-- Before running this script:
-- 1. Create the owner in Supabase Authentication > Users.
-- 2. This policy is restricted to owner@bigbozzfitness.com.
-- 3. Disable public sign-ups in Authentication settings.

create table if not exists public.plans (
    id text primary key check (id in ('walkin', 'monthly', '6month')),
    name text not null,
    price numeric(10, 2) not null check (price >= 0),
    duration text not null,
    description text not null default ''
);

create table if not exists public.registrations (
    id uuid primary key default gen_random_uuid(),
    full_name text not null check (char_length(btrim(full_name)) between 1 and 150),
    contact_number text not null check (char_length(btrim(contact_number)) between 1 and 30),
    email text check (email is null or char_length(email) <= 320),
    plan_id text not null references public.plans(id) on update cascade on delete restrict,
    start_date date not null default current_date,
    status text not null default 'pending' check (status in ('pending', 'confirmed', 'cancelled')),
    notes text check (notes is null or char_length(notes) <= 1000),
    created_at timestamptz not null default now()
);

insert into public.plans (id, name, price, duration, description)
values
    ('walkin', 'Walk-in / Per Session', 50, '1 Session', 'Single gym visit.'),
    ('monthly', 'Monthly Standard Plan', 500, '1 Month', 'Standard monthly gym membership.'),
    ('6month', '6-Month Plan (₱450/mo)', 2700, '6 Months', 'Six-month gym membership.')
on conflict (id) do update
set name = excluded.name,
    price = excluded.price,
    duration = excluded.duration,
    description = excluded.description;

alter table public.plans enable row level security;
alter table public.registrations enable row level security;

drop policy if exists "Anyone can view plans" on public.plans;
create policy "Anyone can view plans"
on public.plans for select
to anon, authenticated
using (true);

drop policy if exists "Public can submit pending registrations" on public.registrations;
create policy "Public can submit pending registrations"
on public.registrations for insert
to anon
with check (status = 'pending');

drop policy if exists "Owner can view registrations" on public.registrations;
create policy "Owner can view registrations"
on public.registrations for select
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = lower('owner@bigbozzfitness.com'));

drop policy if exists "Owner can change registration status" on public.registrations;
create policy "Owner can change registration status"
on public.registrations for update
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = lower('owner@bigbozzfitness.com'))
with check (
    lower(coalesce(auth.jwt() ->> 'email', '')) = lower('owner@bigbozzfitness.com')
    and status in ('pending', 'confirmed', 'cancelled')
);

drop policy if exists "Owner can delete registrations" on public.registrations;
create policy "Owner can delete registrations"
on public.registrations for delete
to authenticated
using (lower(coalesce(auth.jwt() ->> 'email', '')) = lower('owner@bigbozzfitness.com'));

revoke all on table public.plans from public, anon, authenticated;
revoke all on table public.registrations from public, anon, authenticated;
grant select on table public.plans to anon, authenticated;
grant insert (id, full_name, contact_number, email, plan_id, start_date, notes)
on table public.registrations to anon;
grant select, delete on table public.registrations to authenticated;
grant update (status) on table public.registrations to authenticated;
