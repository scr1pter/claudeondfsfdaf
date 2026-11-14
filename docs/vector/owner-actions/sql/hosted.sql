-- The cloud computer's ledger (WP A51): the durable, pseudonymous record of every charge Vector makes into a
-- subscriber's Codium pool for a computer it hosts. Apply once through the owner's Supabase SQL editor after reviewing
-- docs/vector/owner-actions/hosted-computer.md. The server calls only public.vector_hosted(jsonb) with the service role;
-- no other role can read or write these tables. Later work packages (sessions, jobs) add their tables to this file.
--
-- What is stored. An account is named only by an HMAC of its id under VECTOR_HOSTED_ACCOUNT_SALT (never the id or an
-- email). A line is one charge: a block of computer time (minutes, rounded up), the minutes a computer ran past its
-- block's hold (overrun), a day of snapshot storage (GB-days) or egress (GB), or an ended plan's disk retention (days),
-- with what it was charged, the provider's worst-case cost of the same units at the pinned rates, a true-up if one
-- lowered it, the period it was charged to (null when no period could take it) and when the usage happened. Refs are
-- the server's own: hb-<session>-<block>[-over], hs-/he-<computer>-<day>, hr-<computer>-<subscription>-<start>.
--
-- Lines are financial records: they are never deleted, and account deletion (WP A57) does not touch them, because the
-- account cannot be recovered from the HMAC once the account is gone (P5's exception for pseudonymous ledger lines).
-- There is deliberately no foreign key to any account table, so nothing cascades into this one.
--
-- A charge is never below its worst-case cost (M8). A true-up lowers a charge toward the provider's actual cost and
-- never raises it. Times are milliseconds since the epoch and come from the server (`now` in each request).
begin;

create table if not exists public.vector_hosted_ledger (
  mode text not null check (mode in ('live', 'test')),
  account text not null check (account ~ '^[a-f0-9]{64}$'),
  ref text not null check (ref ~ '^h[bser]-[A-Za-z0-9_.:-]{1,197}$'),
  kind text not null check (kind in ('block', 'overrun', 'storage', 'egress', 'retention')),
  size text check (size in ('standard', 'large')),
  units numeric not null check (units >= 0),
  charged_micro bigint not null check (charged_micro >= 0),
  cost_micro bigint not null check (cost_micro >= 0),
  trued_micro bigint check (trued_micro >= 0),
  period_start bigint,
  period_end bigint,
  occurred_at bigint not null check (occurred_at >= 0),
  settled_at bigint not null check (settled_at >= 0),
  trued_at bigint,
  primary key (mode, ref),
  check (charged_micro >= cost_micro),
  check (trued_micro is null or trued_micro < charged_micro),
  check ((trued_micro is null) = (trued_at is null)),
  check ((period_start is null) = (period_end is null)),
  check (period_end is null or period_end > period_start),
  check ((kind in ('block', 'overrun')) = (size is not null))
);
create index if not exists vector_hosted_ledger_period on public.vector_hosted_ledger (mode, account, period_start);

alter table public.vector_hosted_ledger enable row level security;
revoke all on public.vector_hosted_ledger from public, anon, authenticated;
-- The server inserts lines and lowers them; it never deletes one.
grant select, insert, update on public.vector_hosted_ledger to service_role;

-- One entry point. Every answer is {status, ...}; `invalid` means the server sent something it never should.
create or replace function public.vector_hosted(request jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_action text := request->>'action';
  v_mode text := request->>'mode';
  v_account text := request->>'account';
  v_ref text;
  v_owner text;
  v_now bigint;
  v_line jsonb;
  v_trued bigint;
  v_result jsonb;
begin
  if v_mode is null or v_mode not in ('live', 'test') or jsonb_typeof(request->'now') is distinct from 'number'
     or v_account is null or v_account !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_now := (request->>'now')::numeric;

  -- record: writes a line once. A ref already written is answered as it is, so a retried charge records nothing new.
  if v_action = 'record' then
    v_line := request->'line';
    if jsonb_typeof(v_line) is distinct from 'object'
       or jsonb_typeof(v_line->'ref') is distinct from 'string'
       or jsonb_typeof(v_line->'kind') is distinct from 'string'
       or jsonb_typeof(v_line->'units') is distinct from 'number'
       or jsonb_typeof(v_line->'chargedMicro') is distinct from 'number'
       or jsonb_typeof(v_line->'costMicro') is distinct from 'number'
       or jsonb_typeof(v_line->'occurredAt') is distinct from 'number'
       or jsonb_typeof(v_line->'size') not in ('string', 'null')
       or jsonb_typeof(v_line->'periodStart') not in ('number', 'null')
       or jsonb_typeof(v_line->'periodEnd') not in ('number', 'null') then
      return jsonb_build_object('status', 'invalid');
    end if;
    v_ref := v_line->>'ref';
    if v_ref !~ '^h[bser]-[A-Za-z0-9_.:-]{1,197}$'
       or (v_line->>'kind') not in ('block', 'overrun', 'storage', 'egress', 'retention')
       or ((v_line->>'kind') in ('block', 'overrun')) is distinct from (jsonb_typeof(v_line->'size') = 'string')
       or (v_line->>'size') not in ('standard', 'large')
       or (v_line->>'units')::numeric < 0
       or (v_line->>'chargedMicro')::numeric <> trunc((v_line->>'chargedMicro')::numeric)
       or (v_line->>'costMicro')::numeric <> trunc((v_line->>'costMicro')::numeric)
       or (v_line->>'costMicro')::numeric < 0
       or (v_line->>'chargedMicro')::numeric < (v_line->>'costMicro')::numeric
       or (v_line->>'occurredAt')::numeric < 0
       or (jsonb_typeof(v_line->'periodStart') = 'null') is distinct from (jsonb_typeof(v_line->'periodEnd') = 'null')
       or (v_line->>'periodEnd')::numeric <= (v_line->>'periodStart')::numeric then
      return jsonb_build_object('status', 'invalid');
    end if;
    insert into public.vector_hosted_ledger
      (mode, account, ref, kind, size, units, charged_micro, cost_micro, period_start, period_end, occurred_at, settled_at)
    values (
      v_mode, v_account, v_ref, v_line->>'kind', v_line->>'size', (v_line->>'units')::numeric,
      (v_line->>'chargedMicro')::bigint, (v_line->>'costMicro')::bigint,
      (v_line->>'periodStart')::bigint, (v_line->>'periodEnd')::bigint, (v_line->>'occurredAt')::bigint, v_now
    )
    on conflict (mode, ref) do nothing;
  elsif v_action in ('get', 'trued') then
    if jsonb_typeof(request->'ref') is distinct from 'string' or (request->>'ref') !~ '^h[bser]-[A-Za-z0-9_.:-]{1,197}$' then
      return jsonb_build_object('status', 'invalid');
    end if;
    v_ref := request->>'ref';
    -- trued: lowers the line's charge to `trued`, never raising it and never below zero.
    if v_action = 'trued' then
      if jsonb_typeof(request->'trued') is distinct from 'number' or (request->>'trued')::numeric < 0
         or (request->>'trued')::numeric <> trunc((request->>'trued')::numeric) then
        return jsonb_build_object('status', 'invalid');
      end if;
      v_trued := (request->>'trued')::bigint;
      update public.vector_hosted_ledger l
         set trued_micro = v_trued, trued_at = v_now
       where l.mode = v_mode and l.ref = v_ref and l.account = v_account
         and v_trued < coalesce(l.trued_micro, l.charged_micro);
    end if;
  elsif v_action = 'period' then
    -- What one period charged the account (WP A53's drift check): totals only.
    if jsonb_typeof(request->'periodStart') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    select jsonb_build_object(
             'chargedMicro', coalesce(sum(l.charged_micro), 0),
             'truedMicro', coalesce(sum(coalesce(l.trued_micro, l.charged_micro)), 0),
             'minutes', coalesce(sum(l.units) filter (where l.kind in ('block', 'overrun')), 0)::bigint,
             'lines', count(*))
      into v_result
      from public.vector_hosted_ledger l
     where l.mode = v_mode and l.account = v_account and l.period_start = (request->>'periodStart')::bigint;
    return jsonb_build_object('status', 'ok', 'totals', v_result);
  else
    return jsonb_build_object('status', 'invalid');
  end if;

  select l.account, jsonb_build_object(
           'ref', l.ref, 'kind', l.kind, 'size', l.size, 'units', l.units, 'chargedMicro', l.charged_micro,
           'costMicro', l.cost_micro, 'truedMicro', l.trued_micro, 'periodStart', l.period_start,
           'periodEnd', l.period_end, 'occurredAt', l.occurred_at, 'settledAt', l.settled_at)
    into v_owner, v_result
    from public.vector_hosted_ledger l
   where l.mode = v_mode and l.ref = v_ref;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  -- A ref belongs to one account: another account's line is never shown or changed.
  if v_owner is distinct from v_account then
    return jsonb_build_object('status', case when v_action = 'record' then 'conflict' else 'not_found' end);
  end if;
  return jsonb_build_object('status', 'ok', 'line', v_result);
end;
$$;
revoke all on function public.vector_hosted(jsonb) from public, anon, authenticated;
grant execute on function public.vector_hosted(jsonb) to service_role;

commit;
