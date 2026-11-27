-- Applied to the live project on 2026-11-27. Kept here so the schema is
-- reproducible from the repository rather than only from the dashboard.
--
-- Every payment confirmation the arena is told about, whatever told it.
-- This table is the idempotency gate: (provider, external_id) is unique, so a
-- retried webhook loses in the database rather than in application code.
create table if not exists public.payment_events (
  id            bigint generated always as identity primary key,
  provider      text        not null,
  external_id   text        not null,
  amount        numeric     not null check (amount > 0),
  reference     text,
  method        text,
  payer_name    text,
  status        text        not null default 'received'
                check (status in ('received','credited','review','unmatched','rejected')),
  topup_request_id bigint,
  credited_user_id uuid,
  note          text,
  raw           jsonb,
  received_at   timestamptz not null default timezone('utc', now()),
  settled_at    timestamptz,
  constraint payment_events_provider_external_id_key unique (provider, external_id)
);

create index if not exists payment_events_reference_idx on public.payment_events (reference);
create index if not exists payment_events_status_idx
  on public.payment_events (status, received_at desc);
create index if not exists payment_events_request_idx on public.payment_events (topup_request_id);
create index if not exists topup_requests_pay_code_idx
  on public.topup_requests (pay_code) where status = 'pending';

alter table public.payment_events enable row level security;

-- Players have no business reading the payment feed; it carries other people's
-- names and amounts. Admins read, only the service role writes.
drop policy if exists payment_events_admin_read on public.payment_events;
create policy payment_events_admin_read on public.payment_events
  for select using (public.is_admin());

comment on table public.payment_events is
  'Incoming payment confirmations. (provider, external_id) unique is what makes crediting idempotent under webhook retries.';
