-- Apply once through the owner's Supabase SQL editor after reviewing usage.md. Safe to re-run, including
-- on a database that already has the first version of these tables.
-- Counts only: a random install ID or the account ID, app version, OS, CPU architecture, per-day session
-- counts, and the model-use totals from Settings > Usage & streaks (tokens by type, recorded cost, per-day
-- tokens, tasks and cost, models and providers with their token shares, effort levels, chats, streaks and
-- task timing). Never prompts, code, file names or paths, model output, keys, IP addresses or user agents.
begin;

create table if not exists public.vector_usage_daily (
  key text not null check (key ~ '^(install|account):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  client text not null check (client in ('desktop', 'cli')),
  day date not null,
  account_id uuid references auth.users(id) on delete cascade,
  version text not null check (char_length(version) between 1 and 32),
  platform text not null check (platform ~ '^[a-z0-9]{1,16}$'),
  arch text not null check (arch ~ '^[a-z0-9]{1,16}$'),
  sessions integer not null default 0 check (sessions between 0 and 100000),
  subagent_sessions integer not null default 0 check (subagent_sessions between 0 and 100000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (key, client, day),
  check ((client = 'desktop' and key like 'install:%') or (client = 'cli' and key like 'account:%'))
);
create index if not exists vector_usage_daily_day on public.vector_usage_daily(day);
create index if not exists vector_usage_daily_account on public.vector_usage_daily(account_id);
-- The day's latest usage report from that install or CLI account, without its per-day list (kept below).
alter table public.vector_usage_daily add column if not exists usage jsonb
  check (usage is null or (jsonb_typeof(usage) = 'object' and pg_column_size(usage) <= 16384));

-- Tokens, recorded cost and tasks per install or CLI account and calendar day, as the app reports the
-- last seven days with any use. Each report repeats days already sent, so a day keeps its largest values
-- instead of adding up. Two computers of one CLI account on the same day also keep the larger: an
-- undercount, never a double count.
create table if not exists public.vector_usage_tokens (
  key text not null check (key ~ '^(install|account):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  client text not null check (client in ('desktop', 'cli')),
  day date not null,
  account_id uuid references auth.users(id) on delete cascade,
  tokens bigint not null default 0 check (tokens between 0 and 10000000000),
  cost numeric not null default 0 check (cost between 0 and 1000000),
  tasks integer not null default 0 check (tasks between 0 and 1000000),
  updated_at timestamptz not null default now(),
  primary key (key, client, day),
  check ((client = 'desktop' and key like 'install:%') or (client = 'cli' and key like 'account:%'))
);
create index if not exists vector_usage_tokens_day on public.vector_usage_tokens(day);
create index if not exists vector_usage_tokens_account on public.vector_usage_tokens(account_id);

create table if not exists public.vector_usage_downloads (
  id bigint generated always as identity primary key,
  account_id uuid not null references auth.users(id) on delete cascade,
  target text not null check (target ~ '^[a-z0-9-]{1,32}$'),
  version text not null check (char_length(version) between 1 and 32),
  created_at timestamptz not null default now()
);
create index if not exists vector_usage_downloads_created on public.vector_usage_downloads(created_at);
create index if not exists vector_usage_downloads_account on public.vector_usage_downloads(account_id);

-- Read-only links to the aggregate dashboard. Only a SHA-256 hash of each link's random token is stored,
-- so a link can be shown once, when it is made, and never recovered from this table.
create table if not exists public.vector_usage_shares (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null check (char_length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  views integer not null default 0 check (views >= 0),
  last_viewed_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '31 days')
);

-- No policies: browsers never read or write these tables. Only the functions below touch them.
alter table public.vector_usage_daily enable row level security;
alter table public.vector_usage_downloads enable row level security;
alter table public.vector_usage_tokens enable row level security;
alter table public.vector_usage_shares enable row level security;
revoke all on public.vector_usage_daily, public.vector_usage_downloads, public.vector_usage_tokens,
  public.vector_usage_shares from public, anon, authenticated;

-- True when value is a JSON number from 0 to maximum, and a whole number when whole is set.
create or replace function public.vector_usage_number(value jsonb, maximum numeric, whole boolean)
returns boolean language sql immutable security definer set search_path = public, pg_temp as $$
  select case
    when jsonb_typeof(value) is distinct from 'number' then false
    else value::numeric between 0 and maximum and (not whole or value::numeric = trunc(value::numeric))
  end
$$;
revoke all on function public.vector_usage_number(jsonb, numeric, boolean) from public, anon, authenticated;
grant execute on function public.vector_usage_number(jsonb, numeric, boolean) to service_role;

-- The usage report a check-in may carry, exactly as packages/schema/src/usage-report.ts defines it: these
-- keys and no others, bounded non-negative numbers (at most 1e12 tokens in a total and 1e10 tokens, a
-- million tasks and a million dollars in a day, far above one computer's use), real calendar days, at most
-- 8 days, 10 models and 10 effort levels, each listed once, and no model named by a file path. Each step only runs once the steps before it hold, so a malformed
-- report is refused instead of raising an error.
create or replace function public.vector_usage_report_valid(report jsonb)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(report) is distinct from 'object' then
    return false;
  end if;
  if (select count(*) from jsonb_object_keys(report)) <> 17
     or exists (select 1 from jsonb_object_keys(report) as field where field <> all (array[
       'lifetimeTokens', 'lifetimeCost', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cachedTokens',
       'completedChats', 'conversations', 'activeDays', 'currentStreak', 'longestStreak', 'averageTaskMs',
       'longestTaskMs', 'modelResponses', 'days', 'favoriteModels', 'effortLevels'])) then
    return false;
  end if;
  if exists (
    select 1
    from (values
      ('lifetimeTokens', 1e12, true), ('lifetimeCost', 1e9, false), ('inputTokens', 1e12, true),
      ('outputTokens', 1e12, true), ('reasoningTokens', 1e12, true), ('cachedTokens', 1e12, true),
      ('completedChats', 1e9, true), ('conversations', 1e9, true), ('activeDays', 1e5, true),
      ('currentStreak', 1e5, true), ('longestStreak', 1e5, true), ('averageTaskMs', 1e12, true),
      ('longestTaskMs', 1e12, true), ('modelResponses', 1e9, true)
    ) as rule(field, maximum, whole)
    where not public.vector_usage_number(report->rule.field, rule.maximum, rule.whole)
  ) then
    return false;
  end if;
  if jsonb_typeof(report->'days') is distinct from 'array'
     or jsonb_typeof(report->'favoriteModels') is distinct from 'array'
     or jsonb_typeof(report->'effortLevels') is distinct from 'array' then
    return false;
  end if;
  if jsonb_array_length(report->'days') > 8
     or jsonb_array_length(report->'favoriteModels') > 10
     or jsonb_array_length(report->'effortLevels') > 10
     or exists (
       select 1
       from jsonb_array_elements((report->'days') || (report->'favoriteModels') || (report->'effortLevels')) as entry
       where jsonb_typeof(entry) is distinct from 'object'
     ) then
    return false;
  end if;
  if exists (
    select 1 from jsonb_array_elements(report->'days') as entry
    where (select count(*) from jsonb_object_keys(entry)) <> 4
       or exists (select 1 from jsonb_object_keys(entry) as field where field <> all (array['date', 'tokens', 'tasks', 'cost']))
       or jsonb_typeof(entry->'date') is distinct from 'string'
       or entry->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or not public.vector_usage_number(entry->'tokens', 1e10, true)
       or not public.vector_usage_number(entry->'tasks', 1e6, true)
       or not public.vector_usage_number(entry->'cost', 1e6, false)
  ) then
    return false;
  end if;
  -- An impossible date such as 2026-02-30 raises on the cast; either way it is refused.
  begin
    if exists (
      select 1 from jsonb_array_elements(report->'days') as entry
      where to_char((entry->>'date')::date, 'YYYY-MM-DD') <> entry->>'date'
    ) then
      return false;
    end if;
  exception when others then
    return false;
  end;
  if exists (
    select 1 from jsonb_array_elements(report->'favoriteModels') as entry
    where (select count(*) from jsonb_object_keys(entry)) <> 4
       or exists (select 1 from jsonb_object_keys(entry) as field
         where field <> all (array['providerID', 'modelID', 'tokens', 'percentage']))
       or jsonb_typeof(entry->'providerID') is distinct from 'string'
       or entry->>'providerID' !~ '^[A-Za-z0-9._:/@+-]{1,120}$'
       or entry->>'providerID' ~* '^[/.]|^[a-z]:/|(^|/)(users|home)/'
       or jsonb_typeof(entry->'modelID') is distinct from 'string'
       or entry->>'modelID' !~ '^[A-Za-z0-9._:/@+-]{1,120}$'
       or entry->>'modelID' ~* '^[/.]|^[a-z]:/|(^|/)(users|home)/'
       or not public.vector_usage_number(entry->'tokens', 1e12, true)
       or not public.vector_usage_number(entry->'percentage', 100, false)
  ) then
    return false;
  end if;
  if exists (
    select 1 from jsonb_array_elements(report->'effortLevels') as entry
    where (select count(*) from jsonb_object_keys(entry)) <> 5
       or exists (select 1 from jsonb_object_keys(entry) as field
         where field <> all (array['id', 'label', 'tokens', 'responses', 'percentage']))
       or jsonb_typeof(entry->'id') is distinct from 'string'
       or entry->>'id' !~ '^[A-Za-z0-9._:/@+-]{1,40}$'
       or jsonb_typeof(entry->'label') is distinct from 'string'
       or entry->>'label' !~ '^[A-Za-z0-9._:/@+ -]{1,40}$'
       or not public.vector_usage_number(entry->'tokens', 1e12, true)
       or not public.vector_usage_number(entry->'responses', 1e9, true)
       or not public.vector_usage_number(entry->'percentage', 100, false)
  ) then
    return false;
  end if;
  return (select count(distinct entry->>'date') from jsonb_array_elements(report->'days') as entry)
      = jsonb_array_length(report->'days')
    and (select count(distinct (entry->>'providerID') || ' ' || (entry->>'modelID'))
        from jsonb_array_elements(report->'favoriteModels') as entry)
      = jsonb_array_length(report->'favoriteModels')
    and (select count(distinct entry->>'id') from jsonb_array_elements(report->'effortLevels') as entry)
      = jsonb_array_length(report->'effortLevels');
end;
$$;
revoke all on function public.vector_usage_report_valid(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_report_valid(jsonb) to service_role;

-- One row per install (desktop) or account (CLI) per UTC day. A repeated check-in on the same day
-- never lowers a count, keeps the usage report with the most lifetime tokens, and an account stays
-- attached once known. A usage report is kept only with an account that exists: anyone can invent an
-- install ID, and these totals reach the dashboard's share links. The CLI is keyed by its account, so one person's terminals on several computers
-- are one row a day. Rows older than 400 days (about 13 months) are removed here, so retention needs no
-- separate job.
-- SECURITY DEFINER lets the server's service role check auth.users without reading that table.
create or replace function public.vector_usage_record(request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  usage_day date := (pg_catalog.now() at time zone 'utc')::date;
  usage_client text := request->>'client';
  usage_version text := request->>'version';
  usage_platform text := request->>'platform';
  usage_arch text := request->>'arch';
  usage_account uuid;
  usage_key text;
  usage_sessions numeric := 0;
  usage_subagents numeric := 0;
  usage_report jsonb;
begin
  if jsonb_typeof(request) is distinct from 'object'
     or usage_client is null or usage_client not in ('desktop', 'cli')
     or usage_version is null or char_length(usage_version) > 32
     or usage_version !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
     or usage_platform is null or usage_platform !~ '^[a-z0-9]{1,16}$'
     or usage_arch is null or usage_arch !~ '^[a-z0-9]{1,16}$'
     or (request ? 'accountId' and (jsonb_typeof(request->'accountId') is distinct from 'string'
         or request->>'accountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    return jsonb_build_object('status', 'invalid');
  end if;

  if usage_client = 'desktop' then
    if jsonb_typeof(request->'installId') is distinct from 'string'
       or request->>'installId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or usage_platform not in ('darwin', 'win32', 'linux') or usage_arch not in ('x64', 'arm64')
       or jsonb_typeof(request->'sessions') is distinct from 'number'
       or jsonb_typeof(request->'subagentSessions') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    usage_sessions := (request->>'sessions')::numeric;
    usage_subagents := (request->>'subagentSessions')::numeric;
    if usage_sessions <> trunc(usage_sessions) or usage_sessions not between 0 and 100000
       or usage_subagents <> trunc(usage_subagents) or usage_subagents not between 0 and 100000 then
      return jsonb_build_object('status', 'invalid');
    end if;
  end if;

  if request ? 'usage' then
    if not public.vector_usage_report_valid(request->'usage') then
      return jsonb_build_object('status', 'invalid');
    end if;
    usage_report := (request->'usage') - 'days';
  end if;

  if request ? 'accountId' then
    usage_account := (request->>'accountId')::uuid;
    -- A signed token outlives a deleted account; never attach counts to an account that is gone.
    if not exists (select 1 from auth.users u where u.id = usage_account) then
      usage_account := null;
    end if;
  end if;

  if usage_client = 'cli' then
    if usage_account is null then
      return jsonb_build_object('status', 'skipped');
    end if;
    usage_key := 'account:' || usage_account::text;
  else
    usage_key := 'install:' || (request->>'installId');
  end if;
  if usage_account is null then
    usage_report := null;
  end if;

  delete from public.vector_usage_daily where day < usage_day - 400;
  delete from public.vector_usage_tokens where day < usage_day - 400;

  insert into public.vector_usage_daily as existing
    (key, client, day, account_id, version, platform, arch, sessions, subagent_sessions, usage)
  values
    (usage_key, usage_client, usage_day, usage_account, usage_version, usage_platform, usage_arch,
     usage_sessions::integer, usage_subagents::integer, usage_report)
  on conflict (key, client, day) do update set
    account_id = coalesce(excluded.account_id, existing.account_id),
    version = excluded.version,
    platform = excluded.platform,
    arch = excluded.arch,
    sessions = greatest(existing.sessions, excluded.sessions),
    subagent_sessions = greatest(existing.subagent_sessions, excluded.subagent_sessions),
    -- Lifetime tokens only grow on one computer; a CLI account's other computer may report less.
    usage = case
      when excluded.usage is null then existing.usage
      when existing.usage is null then excluded.usage
      when (excluded.usage->'lifetimeTokens')::numeric >= (existing.usage->'lifetimeTokens')::numeric
        then excluded.usage
      else existing.usage
    end,
    updated_at = pg_catalog.now();

  -- Days outside retention, or more than a day ahead of UTC (a local calendar day can be), are skipped.
  if usage_report is not null then
    insert into public.vector_usage_tokens as existing (key, client, day, account_id, tokens, cost, tasks)
    select usage_key, usage_client, (entry->>'date')::date, usage_account,
      (entry->'tokens')::numeric::bigint, (entry->'cost')::numeric, (entry->'tasks')::numeric::integer
    from jsonb_array_elements(request->'usage'->'days') as entry
    where (entry->>'date')::date between usage_day - 400 and usage_day + 1
    on conflict (key, client, day) do update set
      account_id = coalesce(excluded.account_id, existing.account_id),
      tokens = greatest(existing.tokens, excluded.tokens),
      cost = greatest(existing.cost, excluded.cost),
      tasks = greatest(existing.tasks, excluded.tasks),
      updated_at = pg_catalog.now();
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.vector_usage_record(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_record(jsonb) to service_role;

-- One row per successful installer request by a signed-in account. Same 400-day retention.
create or replace function public.vector_usage_download(request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  download_account uuid;
begin
  if jsonb_typeof(request) is distinct from 'object'
     or jsonb_typeof(request->'accountId') is distinct from 'string'
     or request->>'accountId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(request->'target') is distinct from 'string'
     or request->>'target' !~ '^[a-z0-9-]{1,32}$'
     or jsonb_typeof(request->'version') is distinct from 'string'
     or char_length(request->>'version') > 32
     or request->>'version' !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  download_account := (request->>'accountId')::uuid;
  if not exists (select 1 from auth.users u where u.id = download_account) then
    return jsonb_build_object('status', 'skipped');
  end if;
  delete from public.vector_usage_downloads where created_at < pg_catalog.now() - interval '400 days';
  insert into public.vector_usage_downloads(account_id, target, version)
    values (download_account, request->>'target', request->>'version');
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.vector_usage_download(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_download(jsonb) to service_role;

-- Account deletion calls this before removing the identity. It removes every day an install
-- reported once that install was linked to the account, not only the linked days. The foreign
-- keys also cascade when an identity is removed some other way.
create or replace function public.vector_usage_forget(account uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if account is null then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Per-day tokens first: which installs were linked is read from the daily rows deleted next.
  delete from public.vector_usage_tokens
    where account_id = account
       or key = 'account:' || account::text
       or key in (select linked.key from public.vector_usage_daily linked where linked.account_id = account);
  delete from public.vector_usage_daily
    where key = 'account:' || account::text
       or key in (select linked.key from public.vector_usage_daily linked where linked.account_id = account);
  delete from public.vector_usage_downloads where account_id = account;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.vector_usage_forget(uuid) from public, anon, authenticated;
grant execute on function public.vector_usage_forget(uuid) to service_role;

-- Aggregates for the owner's dashboard and its read-only share links. A person is their account when any
-- row of that install or CLI was signed in, otherwise the install, so a signed-in desktop and CLI count
-- once. Weeks are ISO weeks starting Monday (UTC). Model use adds up the latest usage report of each
-- install and CLI account (the desktop app and the CLI keep separate histories; where an XDG_DATA_HOME
-- both inherit gives them one, the desktop marks it and the CLI does not report it, so nothing is counted
-- twice). Reports are kept only with an account, so the people behind a model or effort level are
-- accounts. Nothing returned identifies an account or install.
create or replace function public.vector_usage_summary(request jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  today date := (pg_catalog.now() at time zone 'utc')::date;
  this_week date := today - (extract(isodow from today)::integer - 1);
begin
  if jsonb_typeof(request) is distinct from 'object' then
    return null;
  end if;
  return (
    -- The dashboard owners' own accounts, named by email in request.excludeEmails: every install ever linked to
    -- them, their CLI days, tokens and downloads, and the accounts themselves are left out of every count.
    with excluded_accounts as (
      select u.id
      from auth.users u
      where lower(u.email) in (
        select lower(emails.value)
        from jsonb_array_elements_text(
          case when jsonb_typeof(request->'excludeEmails') = 'array' then request->'excludeEmails' else '[]'::jsonb end
        ) as emails(value)
      )
    ),
    excluded_keys as (
      select d.key from public.vector_usage_daily d where d.account_id in (select id from excluded_accounts)
      union
      select t.key from public.vector_usage_tokens t where t.account_id in (select id from excluded_accounts)
    ),
    counted_daily as (
      select d.* from public.vector_usage_daily d where d.key not in (select key from excluded_keys)
    ),
    counted_tokens as (
      select t.* from public.vector_usage_tokens t
      where t.key not in (select key from excluded_keys)
        and (t.account_id is null or t.account_id not in (select id from excluded_accounts))
    ),
    counted_downloads as (
      select dl.* from public.vector_usage_downloads dl where dl.account_id not in (select id from excluded_accounts)
    ),
    counted_users as (
      select u.* from auth.users u where u.id not in (select id from excluded_accounts)
    ),
    links as (
      select d.key, max(d.account_id::text) as account
      from counted_daily d
      group by d.key
    ),
    activity as (
      select d.day, d.client, d.key, coalesce(links.account, d.key) as actor,
        d.day - (extract(isodow from d.day)::integer - 1) as week,
        date_trunc('month', d.day::timestamp)::date as month,
        d.version, d.platform, d.arch, d.sessions, d.subagent_sessions
      from counted_daily d
      join links on links.key = d.key
    ),
    daily as (
      select days.day,
        count(distinct activity.actor) as active,
        count(distinct activity.key) filter (where activity.client = 'desktop') as desktop,
        count(distinct activity.key) filter (where activity.client = 'cli') as cli,
        coalesce(sum(activity.sessions), 0) as sessions,
        coalesce(sum(activity.subagent_sessions), 0) as subagent_sessions
      from (select today - series.n as day from pg_catalog.generate_series(0, 89) as series(n)) as days
      left join activity on activity.day = days.day
      group by days.day
    ),
    weekly as (
      select counted.*, lag(counted.active) over (order by counted.week) as previous
      from (
        select weeks.week,
          count(distinct activity.actor) as active,
          count(distinct activity.key) filter (where activity.client = 'desktop') as desktop,
          count(distinct activity.key) filter (where activity.client = 'cli') as cli
        from (select this_week - 7 * series.n as week from pg_catalog.generate_series(0, 26) as series(n)) as weeks
        left join activity on activity.week = weeks.week
        group by weeks.week
      ) as counted
    ),
    monthly as (
      select months.month, count(distinct activity.actor) as active
      from (
        select (date_trunc('month', today::timestamp) - pg_catalog.make_interval(months => series.n))::date as month
        from pg_catalog.generate_series(0, 11) as series(n)
      ) as months
      left join activity on activity.month = months.month
      group by months.month
    ),
    rolling as (
      select
        count(distinct activity.actor) filter (where activity.day = today) as active_today,
        count(distinct activity.actor) filter (where activity.day > today - 7) as active7,
        count(distinct activity.actor) filter (where activity.day <= today - 7 and activity.day > today - 14) as previous7,
        count(distinct activity.actor) filter (where activity.day > today - 30) as active30,
        coalesce(sum(activity.sessions) filter (where activity.day > today - 7), 0) as sessions7,
        coalesce(sum(activity.subagent_sessions) filter (where activity.day > today - 7), 0) as subagent_sessions7
      from activity
    ),
    firsts as (
      select activity.actor, min(activity.week) as cohort
      from activity
      group by activity.actor
    ),
    cohort_sizes as (
      select cohorts.cohort, count(firsts.actor) as size
      from (select this_week - 7 * series.n as cohort from pg_catalog.generate_series(0, 11) as series(n)) as cohorts
      left join firsts on firsts.cohort = cohorts.cohort
      group by cohorts.cohort
    ),
    returning_actors as (
      select firsts.cohort, (activity.week - firsts.cohort) / 7 as offset_weeks,
        count(distinct activity.actor) as retained
      from firsts
      join activity on activity.actor = firsts.actor
      where activity.week > firsts.cohort and activity.week <= firsts.cohort + 28
      group by firsts.cohort, (activity.week - firsts.cohort) / 7
    ),
    signups as (
      select u.id,
        (u.created_at at time zone 'utc')::date
          - (extract(isodow from (u.created_at at time zone 'utc')::date)::integer - 1) as week,
        exists (select 1 from counted_downloads dl where dl.account_id = u.id) as downloaded,
        exists (select 1 from counted_daily ud where ud.account_id = u.id) as active
      from counted_users u
      where u.created_at >= ((this_week - 77)::timestamp at time zone 'utc')
    ),
    funnel as (
      select signup_weeks.week,
        count(signups.id) as signups,
        count(signups.id) filter (where signups.downloaded) as downloaded,
        count(signups.id) filter (where signups.active) as active
      from (select this_week - 7 * series.n as week from pg_catalog.generate_series(0, 11) as series(n)) as signup_weeks
      left join signups on signups.week = signup_weeks.week
      group by signup_weeks.week
    ),
    latest as (
      select distinct on (d.key) d.key, d.client, d.version, d.platform, d.arch
      from counted_daily d
      where d.day > today - 7
      order by d.key, d.day desc
    ),
    -- An install's latest report holds its whole history. A CLI account's computers each report their own,
    -- and a second computer may hold far less, so the account keeps the largest report any of them sent.
    snapshots as (
      select distinct on (d.key) d.key, d.day, d.usage, coalesce(links.account, d.key) as actor
      from counted_daily d
      join links on links.key = d.key
      where d.usage is not null
      order by d.key,
        case when d.client = 'cli' then (d.usage->'lifetimeTokens')::numeric end desc nulls last,
        d.day desc
    ),
    reported as (
      select count(*) as reporting,
        coalesce(sum((snapshots.usage->'lifetimeTokens')::numeric), 0) as lifetime_tokens,
        coalesce(sum((snapshots.usage->'lifetimeCost')::numeric), 0) as lifetime_cost,
        coalesce(sum((snapshots.usage->'inputTokens')::numeric), 0) as input_tokens,
        coalesce(sum((snapshots.usage->'outputTokens')::numeric), 0) as output_tokens,
        coalesce(sum((snapshots.usage->'reasoningTokens')::numeric), 0) as reasoning_tokens,
        coalesce(sum((snapshots.usage->'cachedTokens')::numeric), 0) as cached_tokens,
        coalesce(sum((snapshots.usage->'completedChats')::numeric), 0) as completed_chats,
        coalesce(sum((snapshots.usage->'conversations')::numeric), 0) as conversations,
        coalesce(sum((snapshots.usage->'modelResponses')::numeric), 0) as model_responses
      from snapshots
    ),
    token_days as (
      select t.day, sum(t.tokens) as tokens, sum(t.cost) as cost, sum(t.tasks) as tasks
      from counted_tokens t
      where t.day > today - 90
      group by t.day
    ),
    token_windows as (
      select
        coalesce(sum(t.tokens) filter (where t.day > today - 7), 0) as tokens7,
        coalesce(sum(t.tokens) filter (where t.day <= today - 7), 0) as previous_tokens7,
        coalesce(sum(t.cost) filter (where t.day > today - 7), 0) as cost7,
        coalesce(sum(t.cost) filter (where t.day <= today - 7), 0) as previous_cost7
      from counted_tokens t
      where t.day > today - 14
    ),
    -- Each report lists its install's five most-used models, so this is an estimate that misses the tail.
    model_use as (
      select entry->>'providerID' as provider_id, entry->>'modelID' as model_id,
        sum((entry->'tokens')::numeric) as tokens, count(distinct snapshots.actor) as people
      from snapshots
      cross join lateral jsonb_array_elements(snapshots.usage->'favoriteModels') as entry
      group by entry->>'providerID', entry->>'modelID'
    ),
    effort_use as (
      select entry->>'id' as id, max(entry->>'label') as label, sum((entry->'tokens')::numeric) as tokens,
        sum((entry->'responses')::numeric) as responses, count(distinct snapshots.actor) as people
      from snapshots
      cross join lateral jsonb_array_elements(snapshots.usage->'effortLevels') as entry
      group by entry->>'id'
    ),
    -- A streak is current only in a report from today or yesterday (UTC); an older one may have ended. Every
    -- such report counts, so a person's longest current streak wins over another computer's shorter one.
    streaks as (
      select coalesce(links.account, d.key) as actor, max((d.usage->'currentStreak')::numeric) as streak
      from counted_daily d
      join links on links.key = d.key
      where d.usage is not null and d.day >= today - 1
      group by coalesce(links.account, d.key)
    )
    select jsonb_build_object(
      'generatedAt', to_char(pg_catalog.now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'today', today,
      'totals', jsonb_build_object(
        'accounts', (select count(*) from counted_users),
        'installs', (select count(distinct d.key) from counted_daily d where d.client = 'desktop'),
        'cliAccounts', (select count(distinct d.key) from counted_daily d where d.client = 'cli'),
        'downloads', (select count(*) from counted_downloads),
        'downloadAccounts', (select count(distinct dl.account_id) from counted_downloads dl),
        'activeToday', rolling.active_today,
        'active7', rolling.active7,
        'previous7', rolling.previous7,
        'active30', rolling.active30,
        'sessions7', rolling.sessions7,
        'subagentSessions7', rolling.subagent_sessions7
      ),
      'daily', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'day', daily.day, 'active', daily.active, 'desktop', daily.desktop, 'cli', daily.cli,
          'sessions', daily.sessions, 'subagentSessions', daily.subagent_sessions,
          'tokens', coalesce(token_days.tokens, 0), 'cost', round(coalesce(token_days.cost, 0), 4),
          'tasks', coalesce(token_days.tasks, 0)
        ) order by daily.day), '[]'::jsonb)
        from daily
        left join token_days on token_days.day = daily.day
      ),
      'weekly', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'week', weekly.week, 'active', weekly.active, 'desktop', weekly.desktop, 'cli', weekly.cli,
          'growth', case when weekly.previous > 0
            then round((weekly.active - weekly.previous)::numeric / weekly.previous, 4) end
        ) order by weekly.week), '[]'::jsonb)
        from weekly
        where weekly.week > this_week - 182
      ),
      'monthly', (
        select coalesce(jsonb_agg(jsonb_build_object('month', monthly.month, 'active', monthly.active)
          order by monthly.month), '[]'::jsonb)
        from monthly
      ),
      'retention', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'cohort', cohort_sizes.cohort,
          'size', cohort_sizes.size,
          'weeks', (
            select jsonb_agg(
              case when cohort_sizes.cohort + 7 * offsets.k >= this_week or cohort_sizes.size = 0 then null
                else round(coalesce(returning_actors.retained, 0)::numeric / cohort_sizes.size, 4) end
              order by offsets.k)
            from pg_catalog.generate_series(1, 4) as offsets(k)
            left join returning_actors
              on returning_actors.cohort = cohort_sizes.cohort and returning_actors.offset_weeks = offsets.k
          )
        ) order by cohort_sizes.cohort), '[]'::jsonb)
        from cohort_sizes
      ),
      'funnel', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'week', funnel.week, 'signups', funnel.signups, 'downloaded', funnel.downloaded, 'active', funnel.active
        ) order by funnel.week), '[]'::jsonb)
        from funnel
      ),
      'versions', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'client', counted.client, 'version', counted.version, 'active', counted.active
        ) order by counted.active desc, counted.client, counted.version desc), '[]'::jsonb)
        from (
          select latest.client, latest.version, count(*) as active
          from latest
          group by latest.client, latest.version
          order by count(*) desc
          limit 40
        ) as counted
      ),
      'platforms', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'client', counted.client, 'platform', counted.platform, 'arch', counted.arch, 'active', counted.active
        ) order by counted.active desc, counted.client, counted.platform, counted.arch), '[]'::jsonb)
        from (
          select latest.client, latest.platform, latest.arch, count(*) as active
          from latest
          group by latest.client, latest.platform, latest.arch
          order by count(*) desc
          limit 40
        ) as counted
      ),
      'usage', jsonb_build_object(
        'reporting', reported.reporting,
        'lifetimeTokens', reported.lifetime_tokens,
        'lifetimeCost', round(reported.lifetime_cost, 4),
        'inputTokens', reported.input_tokens,
        'outputTokens', reported.output_tokens,
        'reasoningTokens', reported.reasoning_tokens,
        'cachedTokens', reported.cached_tokens,
        'completedChats', reported.completed_chats,
        'conversations', reported.conversations,
        'modelResponses', reported.model_responses,
        'tokens7', token_windows.tokens7,
        'previousTokens7', token_windows.previous_tokens7,
        'cost7', round(token_windows.cost7, 4),
        'previousCost7', round(token_windows.previous_cost7, 4),
        'tokensPerActive7', case when rolling.active7 > 0 then round(token_windows.tokens7 / rolling.active7) end
      ),
      'models', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'providerID', ranked.provider_id, 'modelID', ranked.model_id, 'tokens', ranked.tokens,
          'people', ranked.people, 'share', ranked.share
        ) order by ranked.tokens desc, ranked.people desc, ranked.provider_id, ranked.model_id), '[]'::jsonb)
        from (
          select model_use.*,
            case when sum(model_use.tokens) over () > 0
              then round(model_use.tokens / sum(model_use.tokens) over (), 4) else 0 end as share
          from model_use
          order by model_use.tokens desc, model_use.people desc, model_use.provider_id, model_use.model_id
          limit 20
        ) as ranked
      ),
      'efforts', (
        select coalesce(jsonb_agg(jsonb_build_object(
          'id', ranked.id, 'label', ranked.label, 'tokens', ranked.tokens, 'responses', ranked.responses,
          'people', ranked.people, 'share', ranked.share
        ) order by ranked.tokens desc, ranked.responses desc, ranked.id), '[]'::jsonb)
        from (
          select effort_use.*,
            case
              when sum(effort_use.tokens) over () > 0 then round(effort_use.tokens / sum(effort_use.tokens) over (), 4)
              when sum(effort_use.responses) over () > 0
                then round(effort_use.responses / sum(effort_use.responses) over (), 4)
              else 0
            end as share
          from effort_use
          order by effort_use.tokens desc, effort_use.responses desc, effort_use.id
          limit 20
        ) as ranked
      ),
      'streaks', jsonb_build_object(
        'one', (select count(*) from streaks where streaks.streak = 1),
        'twoToSix', (select count(*) from streaks where streaks.streak between 2 and 6),
        'sevenPlus', (select count(*) from streaks where streaks.streak >= 7)
      )
    )
    from rolling, reported, token_windows
  );
end;
$$;
revoke all on function public.vector_usage_summary(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_summary(jsonb) to service_role;

-- A share link as the owner sees it. Times are UTC ISO strings.
create or replace function public.vector_usage_share_view(share public.vector_usage_shares)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'id', share.id,
    'label', share.label,
    'createdAt', to_char(share.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'expiresAt', to_char(share.expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'revokedAt', to_char(share.revoked_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'lastViewedAt', to_char(share.last_viewed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'views', share.views,
    'state', case
      when share.revoked_at is not null then 'revoked'
      when share.expires_at <= pg_catalog.now() then 'expired'
      else 'active'
    end
  )
$$;
revoke all on function public.vector_usage_share_view(public.vector_usage_shares) from public, anon, authenticated;
grant execute on function public.vector_usage_share_view(public.vector_usage_shares) to service_role;

-- Makes a link that lasts 7, 14 or 30 days. The server sends only the token's hash. Links that ended more
-- than 90 days ago are removed here, and at most 50 may be live at once.
create or replace function public.vector_usage_share_create(request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  share_label text := pg_catalog.btrim(request->>'label');
  created public.vector_usage_shares;
begin
  if jsonb_typeof(request) is distinct from 'object'
     or jsonb_typeof(request->'tokenHash') is distinct from 'string'
     or request->>'tokenHash' !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(request->'label') is distinct from 'string'
     or char_length(share_label) not between 1 and 80
     or share_label ~ '[[:cntrl:]]'
     or jsonb_typeof(request->'days') is distinct from 'number'
     or request->>'days' not in ('7', '14', '30') then
    return jsonb_build_object('status', 'invalid');
  end if;
  delete from public.vector_usage_shares
    where coalesce(revoked_at, expires_at) < pg_catalog.now() - interval '90 days';
  if (select count(*) from public.vector_usage_shares
      where revoked_at is null and expires_at > pg_catalog.now()) >= 50 then
    return jsonb_build_object('status', 'limit');
  end if;
  insert into public.vector_usage_shares (token_hash, label, expires_at)
    values (request->>'tokenHash', share_label,
      pg_catalog.now() + pg_catalog.make_interval(days => (request->>'days')::integer))
    returning * into created;
  return jsonb_build_object('status', 'ok', 'share', public.vector_usage_share_view(created));
end;
$$;
revoke all on function public.vector_usage_share_create(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_share_create(jsonb) to service_role;

-- The owner's list of links, newest first.
create or replace function public.vector_usage_share_list(request jsonb)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(request) is distinct from 'object' then
    return jsonb_build_object('status', 'invalid');
  end if;
  return jsonb_build_object('status', 'ok', 'shares', (
    select coalesce(jsonb_agg(recent.view order by recent.created_at desc), '[]'::jsonb)
    from (
      select public.vector_usage_share_view(share) as view, share.created_at
      from public.vector_usage_shares as share
      order by share.created_at desc
      limit 100
    ) as recent
  ));
end;
$$;
revoke all on function public.vector_usage_share_list(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_share_list(jsonb) to service_role;

-- Turns a link off for good. Revoking twice keeps the first time.
create or replace function public.vector_usage_share_revoke(request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if jsonb_typeof(request) is distinct from 'object'
     or jsonb_typeof(request->'id') is distinct from 'string'
     or request->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  update public.vector_usage_shares set revoked_at = coalesce(revoked_at, pg_catalog.now())
    where id = (request->>'id')::uuid;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;
revoke all on function public.vector_usage_share_revoke(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_share_revoke(jsonb) to service_role;

-- Opens a link by its token's hash: ok with its expiry while it is live, otherwise why not. Each opening
-- counts one view; nothing about the viewer is kept.
create or replace function public.vector_usage_share_open(request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  share public.vector_usage_shares;
begin
  if jsonb_typeof(request) is distinct from 'object'
     or jsonb_typeof(request->'tokenHash') is distinct from 'string'
     or request->>'tokenHash' !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into share from public.vector_usage_shares where token_hash = request->>'tokenHash';
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;
  if share.revoked_at is not null then
    return jsonb_build_object('status', 'revoked');
  end if;
  if share.expires_at <= pg_catalog.now() then
    return jsonb_build_object('status', 'expired');
  end if;
  update public.vector_usage_shares
    set views = least(views, 2147483646) + 1, last_viewed_at = pg_catalog.now()
    where id = share.id;
  return jsonb_build_object('status', 'ok',
    'expiresAt', to_char(share.expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
end;
$$;
revoke all on function public.vector_usage_share_open(jsonb) from public, anon, authenticated;
grant execute on function public.vector_usage_share_open(jsonb) to service_role;

commit;
