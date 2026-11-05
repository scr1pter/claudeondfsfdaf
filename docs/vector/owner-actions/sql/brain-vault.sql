-- Brain Vault (WP A44): the durable records of Vector's end-to-end encrypted backup service. Apply once through the
-- owner's Supabase SQL editor after reviewing docs/vector/owner-actions/brain-vault.md. The server calls only
-- public.vector_brain_vault(jsonb) with the service role; no other role can read or write these tables.
--
-- What is stored. An account is named only by an HMAC of its id under VECTOR_VAULT_ACCOUNT_SALT (never the id or an
-- email). A vault holds its key wrapped under the person's recovery code (useless without the code), version ids, object
-- ids (keyed HMACs, never a plain hash of the content), sizes and times. The encrypted bytes live in the R2 bucket
-- vector-vault at <mode>/<account>/<vault>/objects/<id> and <mode>/<account>/<vault>/versions/<id>.
--
-- A blob is one stored object or one version's manifest:
--   pending  reserved and signed for upload, not yet confirmed by a HEAD at commit;
--   stored   confirmed;
--   trash    queued for deletion from R2;
--   claimed  a deletion from R2 is in flight (reclaimed when it is older than the caller's staleMs).
-- The quota counts pending and stored blobs. Every write to a vault's blobs first locks the vault's row, so two
-- reservations can never pass the quota together.
--
-- Times are milliseconds since the epoch and come from the server (`now` in each request).
begin;

create table if not exists public.vector_brain_vaults (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('live', 'test')),
  account text not null check (account ~ '^[a-f0-9]{64}$'),
  vault text not null check (vault ~ '^[a-f0-9]{32}$'),
  wrapped_key jsonb,
  deleting boolean not null default false,
  held boolean not null default false,
  version_days integer not null default 30 check (version_days between 1 and 3650),
  created_at bigint not null,
  updated_at bigint not null,
  notice_at bigint,
  delete_at bigint,
  check ((deleting and wrapped_key is null) or (not deleting and jsonb_typeof(wrapped_key) = 'object')),
  unique (mode, account, vault)
);
create unique index if not exists vector_brain_vaults_open on public.vector_brain_vaults (mode, account) where not deleting;

create table if not exists public.vector_brain_vault_versions (
  vault_id uuid not null references public.vector_brain_vaults(id) on delete cascade,
  id text not null check (id ~ '^v[0-9]{13}-[0-9a-f]{8}$'),
  committed boolean not null default false,
  created_at bigint not null,
  touched_at bigint not null,
  committed_at bigint,
  objects integer not null default 0 check (objects >= 0),
  bytes bigint not null default 0 check (bytes >= 0),
  primary key (vault_id, id),
  check (committed = (committed_at is not null))
);

create table if not exists public.vector_brain_vault_refs (
  vault_id uuid not null,
  version text not null,
  object text not null check (object ~ '^[0-9a-f]{64}$'),
  primary key (vault_id, version, object),
  foreign key (vault_id, version) references public.vector_brain_vault_versions(vault_id, id) on delete cascade
);
create index if not exists vector_brain_vault_refs_object on public.vector_brain_vault_refs (vault_id, object);

create table if not exists public.vector_brain_vault_blobs (
  vault_id uuid not null references public.vector_brain_vaults(id) on delete cascade,
  kind text not null check (kind in ('object', 'manifest')),
  id text not null,
  size bigint not null check (size >= 0),
  state text not null check (state in ('pending', 'stored', 'trash', 'claimed')),
  reserved_until bigint,
  claimed_at bigint,
  updated_at bigint not null,
  primary key (vault_id, kind, id),
  check ((kind = 'object' and id ~ '^[0-9a-f]{64}$') or (kind = 'manifest' and id ~ '^v[0-9]{13}-[0-9a-f]{8}$')),
  check ((state = 'claimed') = (claimed_at is not null))
);
create index if not exists vector_brain_vault_blobs_state on public.vector_brain_vault_blobs (vault_id, state);
create index if not exists vector_brain_vault_blobs_trash on public.vector_brain_vault_blobs (updated_at)
  where state in ('trash', 'claimed');

alter table public.vector_brain_vaults enable row level security;
alter table public.vector_brain_vault_versions enable row level security;
alter table public.vector_brain_vault_refs enable row level security;
alter table public.vector_brain_vault_blobs enable row level security;
revoke all on public.vector_brain_vaults, public.vector_brain_vault_versions, public.vector_brain_vault_refs,
  public.vector_brain_vault_blobs from public, anon, authenticated;
grant select, insert, update, delete on public.vector_brain_vaults, public.vector_brain_vault_versions,
  public.vector_brain_vault_refs, public.vector_brain_vault_blobs to service_role;

-- One entry point. Every answer is {status, ...}; `invalid` means the server sent something it never should.
create or replace function public.vector_brain_vault(request jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_action text := request->>'action';
  v_mode text := request->>'mode';
  v_account text := request->>'account';
  v_version text := request->>'version';
  v_now bigint;
  v_limit integer;
  v_exists boolean;
  v_manifest bigint;
  v_used bigint;
  v_count bigint;
  v_new bigint;
  v_new_count bigint;
  v_refs bigint;
  v_added bigint;
  v_cursor uuid;
  v_items jsonb;
  v_ids text[];
  v_sizes bigint[];
  v_present text[];
  v_sign text[];
  n_lapsed bigint := 0;
  n_versions bigint := 0;
  n_pending bigint := 0;
  n_pruned bigint := 0;
  n_objects bigint := 0;
  n_step bigint;
  item public.vector_brain_vaults%rowtype;
  ver public.vector_brain_vault_versions%rowtype;
  blob public.vector_brain_vault_blobs%rowtype;
begin
  if v_mode is null or v_mode not in ('live', 'test') or jsonb_typeof(request->'now') is distinct from 'number' then
    return jsonb_build_object('status', 'invalid');
  end if;
  v_now := (request->>'now')::bigint;
  if v_account is not null and v_account !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('status', 'invalid');
  end if;
  if v_version is not null and v_version !~ '^v[0-9]{13}-[0-9a-f]{8}$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  -- ── Deletion from R2: claim queued blobs, then remove those the server deleted ─────────────────────────────────────
  if v_action = 'claim' then
    if jsonb_typeof(request->'staleMs') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    v_limit := least(greatest(coalesce((request->>'limit')::integer, 100), 1), 1000);
    with picked as (
      select b.vault_id, b.kind, b.id
        from public.vector_brain_vault_blobs b
        join public.vector_brain_vaults v on v.id = b.vault_id
       where v.mode = v_mode and (v_account is null or v.account = v_account)
         and (b.state = 'trash' or (b.state = 'claimed' and b.claimed_at < v_now - (request->>'staleMs')::bigint))
       order by b.updated_at, b.id
       limit v_limit
       for update of b skip locked
    ), claimed as (
      update public.vector_brain_vault_blobs b
         set state = 'claimed', claimed_at = v_now, updated_at = v_now
        from picked p
       where b.vault_id = p.vault_id and b.kind = p.kind and b.id = p.id
      returning b.vault_id, b.kind, b.id
    )
    select coalesce(jsonb_agg(jsonb_build_object('vaultId', c.vault_id, 'account', v.account, 'vault', v.vault,
                                                 'kind', c.kind, 'id', c.id)), '[]'::jsonb)
      into v_items
      from claimed c join public.vector_brain_vaults v on v.id = c.vault_id;
    return jsonb_build_object('status', 'ok', 'items', v_items, 'claimedAt', v_now);
  end if;

  if v_action = 'purged' then
    if jsonb_typeof(request->'items') is distinct from 'array' or jsonb_typeof(request->'claimedAt') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    with gone as (
      delete from public.vector_brain_vault_blobs b
       using jsonb_to_recordset(request->'items') as x("vaultId" uuid, kind text, id text)
       where b.vault_id = x."vaultId" and b.kind = x.kind and b.id = x.id
         and b.state = 'claimed' and b.claimed_at = (request->>'claimedAt')::bigint
         and exists (select 1 from public.vector_brain_vaults v where v.id = b.vault_id and v.mode = v_mode)
      returning b.vault_id
    )
    select count(*) into n_step from gone;
    delete from public.vector_brain_vaults v
     where v.mode = v_mode and v.deleting
       and not exists (select 1 from public.vector_brain_vault_blobs b where b.vault_id = v.id);
    return jsonb_build_object('status', 'ok', 'removed', n_step);
  end if;

  -- ── Daily cleanup, a batch of vaults at a time (each locked while it is cleaned; a busy one waits for tomorrow) ────
  if v_action = 'cleanup' then
    if jsonb_typeof(request->'uncommittedMs') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    v_limit := least(greatest(coalesce((request->>'limit')::integer, 50), 1), 500);
    v_cursor := case when jsonb_typeof(request->'cursor') = 'string' then (request->>'cursor')::uuid end;
    v_count := 0;
    for item in
      select * from public.vector_brain_vaults v
       where v.mode = v_mode and not v.deleting and (v_cursor is null or v.id > v_cursor)
       order by v.id
       limit v_limit
       for update skip locked
    loop
      v_count := v_count + 1;
      v_cursor := item.id;
      -- A read-only vault whose notice ran out is deleted: the wrapped key first, then every blob.
      if not item.held and item.notice_at is not null and item.delete_at is not null and item.delete_at <= v_now then
        update public.vector_brain_vaults
           set deleting = true, wrapped_key = null, notice_at = null, delete_at = null, updated_at = v_now
         where id = item.id;
        delete from public.vector_brain_vault_versions where vault_id = item.id;
        update public.vector_brain_vault_blobs
           set state = 'trash', reserved_until = null, updated_at = v_now
         where vault_id = item.id and state in ('pending', 'stored');
        delete from public.vector_brain_vaults v
         where v.id = item.id and not exists (select 1 from public.vector_brain_vault_blobs b where b.vault_id = v.id);
        n_lapsed := n_lapsed + 1;
        continue;
      end if;
      -- Backups that never committed: an hour after their last request.
      with gone as (
        delete from public.vector_brain_vault_versions s
         where s.vault_id = item.id and not s.committed
           and s.touched_at < v_now - (request->>'uncommittedMs')::bigint
        returning s.id
      ), manifests as (
        update public.vector_brain_vault_blobs b
           set state = 'trash', reserved_until = null, updated_at = v_now
          from gone g
         where b.vault_id = item.id and b.kind = 'manifest' and b.id = g.id and b.state in ('pending', 'stored')
        returning 1
      )
      select count(*) into n_step from gone;
      n_versions := n_versions + n_step;
      -- Uploads whose reservation ran out and that no remaining version names.
      update public.vector_brain_vault_blobs b
         set state = 'trash', reserved_until = null, updated_at = v_now
       where b.vault_id = item.id and b.state = 'pending' and b.reserved_until < v_now
         and ((b.kind = 'object' and not exists (
                 select 1 from public.vector_brain_vault_refs r where r.vault_id = b.vault_id and r.object = b.id))
           or (b.kind = 'manifest' and not exists (
                 select 1 from public.vector_brain_vault_versions s where s.vault_id = b.vault_id and s.id = b.id)));
      get diagnostics n_step = row_count;
      n_pending := n_pending + n_step;
      -- A held vault (a payment dispute or a fraud warning) loses nothing it committed.
      if item.held then
        continue;
      end if;
      -- Versions past the plan's version days; the newest committed version is always kept.
      with ranked as (
        select s.id, s.created_at,
               row_number() over (order by s.created_at desc, s.id desc) as n
          from public.vector_brain_vault_versions s
         where s.vault_id = item.id and s.committed
      ), aged as (
        delete from public.vector_brain_vault_versions s
         using ranked r
         where s.vault_id = item.id and s.id = r.id and r.n > 1
           and r.created_at < v_now - item.version_days::bigint * 86400000
        returning s.id
      ), manifests as (
        update public.vector_brain_vault_blobs b
           set state = 'trash', reserved_until = null, updated_at = v_now
          from aged o
         where b.vault_id = item.id and b.kind = 'manifest' and b.id = o.id and b.state in ('pending', 'stored')
        returning 1
      )
      select count(*) into n_step from aged;
      n_pruned := n_pruned + n_step;
      -- Objects and manifests no version names any more.
      update public.vector_brain_vault_blobs b
         set state = 'trash', reserved_until = null, updated_at = v_now
       where b.vault_id = item.id and b.state = 'stored'
         and ((b.kind = 'object' and not exists (
                 select 1 from public.vector_brain_vault_refs r where r.vault_id = b.vault_id and r.object = b.id))
           or (b.kind = 'manifest' and not exists (
                 select 1 from public.vector_brain_vault_versions s where s.vault_id = b.vault_id and s.id = b.id)));
      get diagnostics n_step = row_count;
      n_objects := n_objects + n_step;
    end loop;
    return jsonb_build_object('status', 'ok', 'vaults', v_count, 'lapsed', n_lapsed, 'uncommitted', n_versions,
      'expired', n_pending, 'pruned', n_pruned, 'collected', n_objects,
      'cursor', case when v_count < v_limit then null else v_cursor::text end);
  end if;

  -- ── Everything below acts on one account's vault ───────────────────────────────────────────────────────────────────
  if v_account is null then
    return jsonb_build_object('status', 'invalid');
  end if;

  if v_action = 'setup' then
    if coalesce(request->>'vault', '') !~ '^[a-f0-9]{32}$' or jsonb_typeof(request->'key') is distinct from 'object'
       or jsonb_typeof(request->'versionDays') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('vector-brain-vault:' || v_mode || ':' || v_account, 0));
    select * into item from public.vector_brain_vaults v where v.mode = v_mode and v.account = v_account and not v.deleting;
    if found then
      if item.vault = request->>'vault' then
        return jsonb_build_object('status', 'ok', 'vault', item.vault, 'key', item.wrapped_key, 'createdAt', item.created_at);
      end if;
      return jsonb_build_object('status', 'exists');
    end if;
    -- A vault id being deleted cannot come back while its blobs are still going.
    if exists (select 1 from public.vector_brain_vaults v
                where v.mode = v_mode and v.account = v_account and v.vault = request->>'vault') then
      return jsonb_build_object('status', 'exists');
    end if;
    insert into public.vector_brain_vaults (mode, account, vault, wrapped_key, version_days, created_at, updated_at)
    values (v_mode, v_account, request->>'vault', request->'key', (request->>'versionDays')::integer, v_now, v_now)
    returning * into item;
    return jsonb_build_object('status', 'ok', 'vault', item.vault, 'key', item.wrapped_key, 'createdAt', item.created_at);
  end if;

  if v_action in ('read', 'usage', 'list', 'lapse-status') then
    select * into item from public.vector_brain_vaults v where v.mode = v_mode and v.account = v_account and not v.deleting;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    select coalesce(sum(b.size), 0) into v_used
      from public.vector_brain_vault_blobs b where b.vault_id = item.id and b.state in ('pending', 'stored');
    if v_action = 'read' then
      return jsonb_build_object('status', 'ok', 'vault', item.vault, 'key', item.wrapped_key, 'createdAt', item.created_at,
        'deleteAt', item.delete_at, 'usedBytes', v_used);
    elsif v_action = 'usage' then
      return jsonb_build_object('status', 'ok', 'usedBytes', v_used);
    elsif v_action = 'lapse-status' then
      return jsonb_build_object('status', 'ok', 'held', item.held, 'noticeAt', item.notice_at, 'deleteAt', item.delete_at);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'createdAt', s.created_at, 'bytes', s.bytes,
                                                 'objects', s.objects) order by s.created_at desc, s.id desc), '[]'::jsonb)
      into v_items
      from public.vector_brain_vault_versions s where s.vault_id = item.id and s.committed;
    return jsonb_build_object('status', 'ok', 'vault', item.vault, 'snapshots', v_items, 'usedBytes', v_used,
      'deleteAt', item.delete_at);
  end if;

  if v_action = 'reserve' then
    if v_version is null or jsonb_typeof(request->'objects') is distinct from 'array'
       or jsonb_typeof(request->'versionAt') is distinct from 'number' or jsonb_typeof(request->'quota') is distinct from 'number'
       or jsonb_typeof(request->'reserveMs') is distinct from 'number'
       or jsonb_typeof(request->'versionDays') is distinct from 'number'
       or jsonb_typeof(request->'limits') is distinct from 'object'
       or (request ? 'manifest' and jsonb_typeof(request->'manifest') is distinct from 'number') then
      return jsonb_build_object('status', 'invalid');
    end if;
    v_manifest := case when request ? 'manifest' then (request->>'manifest')::bigint end;
    select coalesce(array_agg(s.id order by s.id), '{}'::text[]), coalesce(array_agg(s.size order by s.id), '{}'::bigint[])
      into v_ids, v_sizes
      from (select distinct on (e->>'id') e->>'id' as id, (e->>'size')::bigint as size
              from jsonb_array_elements(request->'objects') e
             order by e->>'id') s;
    if exists (select 1 from unnest(v_ids, v_sizes) as i(id, size)
                where i.id is null or i.id !~ '^[0-9a-f]{64}$' or i.size is null or i.size < 0)
       or (v_manifest is not null and v_manifest < 0) then
      return jsonb_build_object('status', 'invalid');
    end if;
    select * into item from public.vector_brain_vaults v
     where v.mode = v_mode and v.account = v_account and not v.deleting for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    select * into ver from public.vector_brain_vault_versions s where s.vault_id = item.id and s.id = v_version;
    v_exists := found;
    if v_exists and ver.committed then
      return jsonb_build_object('status', 'committed');
    end if;
    if not v_exists then
      if (select count(*) from public.vector_brain_vault_versions s where s.vault_id = item.id and not s.committed)
         >= (request->'limits'->>'open')::bigint then
        return jsonb_build_object('status', 'open');
      end if;
      if (select count(*) from public.vector_brain_vault_versions s where s.vault_id = item.id and s.committed)
         >= (request->'limits'->>'versions')::bigint then
        return jsonb_build_object('status', 'versions');
      end if;
    end if;
    perform 1 from public.vector_brain_vault_blobs b
     where b.vault_id = item.id
       and ((b.kind = 'object' and b.id = any(v_ids)) or (b.kind = 'manifest' and b.id = v_version))
       for update;
    if exists (select 1 from public.vector_brain_vault_blobs b
                where b.vault_id = item.id and b.state = 'claimed'
                  and ((b.kind = 'object' and b.id = any(v_ids))
                    or (v_manifest is not null and b.kind = 'manifest' and b.id = v_version))) then
      return jsonb_build_object('status', 'busy');
    end if;
    if exists (select 1 from public.vector_brain_vault_blobs b join unnest(v_ids, v_sizes) as i(id, size) on b.id = i.id
                where b.vault_id = item.id and b.kind = 'object' and b.state = 'pending' and b.size <> i.size)
       or exists (select 1 from public.vector_brain_vault_blobs b
                   where v_manifest is not null and b.vault_id = item.id and b.kind = 'manifest' and b.id = v_version
                     and b.state in ('pending', 'stored') and b.size <> v_manifest) then
      return jsonb_build_object('status', 'mismatch');
    end if;
    select coalesce(array_agg(b.id order by b.id), '{}'::text[]) into v_present
      from public.vector_brain_vault_blobs b
     where b.vault_id = item.id and b.kind = 'object' and b.id = any(v_ids) and b.state = 'stored';
    select coalesce(sum(i.size), 0), count(*) into v_new, v_new_count
      from unnest(v_ids, v_sizes) as i(id, size)
      left join public.vector_brain_vault_blobs b on b.vault_id = item.id and b.kind = 'object' and b.id = i.id
     where b.id is null or b.state = 'trash';
    if v_manifest is not null and not exists (
         select 1 from public.vector_brain_vault_blobs b
          where b.vault_id = item.id and b.kind = 'manifest' and b.id = v_version and b.state in ('pending', 'stored')) then
      v_new := v_new + v_manifest;
      v_new_count := v_new_count + 1;
    end if;
    select coalesce(sum(b.size), 0), count(*) into v_used, v_count
      from public.vector_brain_vault_blobs b where b.vault_id = item.id and b.state in ('pending', 'stored');
    if v_used + v_new > (request->>'quota')::bigint
       or v_count + v_new_count > (request->'limits'->>'objects')::bigint then
      return jsonb_build_object('status', 'quota', 'usedBytes', v_used);
    end if;
    select count(*) into v_refs from public.vector_brain_vault_refs r where r.vault_id = item.id and r.version = v_version;
    select count(*) into v_added from unnest(v_ids) as i(id)
     where not exists (select 1 from public.vector_brain_vault_refs r
                        where r.vault_id = item.id and r.version = v_version and r.object = i.id);
    if v_refs + v_added > (request->'limits'->>'refs')::bigint then
      return jsonb_build_object('status', 'quota', 'usedBytes', v_used);
    end if;
    -- Everything checked: reserve.
    if v_exists then
      update public.vector_brain_vault_versions s set touched_at = greatest(s.touched_at, v_now)
       where s.vault_id = item.id and s.id = v_version;
    else
      insert into public.vector_brain_vault_versions (vault_id, id, created_at, touched_at)
      values (item.id, v_version, (request->>'versionAt')::bigint, v_now);
    end if;
    update public.vector_brain_vaults v set version_days = (request->>'versionDays')::integer, updated_at = v_now
     where v.id = item.id;
    insert into public.vector_brain_vault_blobs as b (vault_id, kind, id, size, state, reserved_until, claimed_at, updated_at)
    select item.id, 'object', i.id, i.size, 'pending', v_now + (request->>'reserveMs')::bigint, null, v_now
      from unnest(v_ids, v_sizes) as i(id, size)
    on conflict (vault_id, kind, id) do update
       set size = excluded.size, state = 'pending', claimed_at = null, updated_at = excluded.updated_at,
           reserved_until = greatest(coalesce(b.reserved_until, 0), excluded.reserved_until)
     where b.state in ('pending', 'trash');
    if v_manifest is not null then
      insert into public.vector_brain_vault_blobs as b (vault_id, kind, id, size, state, reserved_until, claimed_at, updated_at)
      values (item.id, 'manifest', v_version, v_manifest, 'pending', v_now + (request->>'reserveMs')::bigint, null, v_now)
      on conflict (vault_id, kind, id) do update
         set size = excluded.size, state = 'pending', claimed_at = null, updated_at = excluded.updated_at,
             reserved_until = greatest(coalesce(b.reserved_until, 0), excluded.reserved_until)
       where b.state in ('pending', 'trash');
    end if;
    insert into public.vector_brain_vault_refs (vault_id, version, object)
    select item.id, v_version, i.id from unnest(v_ids) as i(id)
    on conflict do nothing;
    v_sign := array(select i.id from unnest(v_ids) as i(id) where not (i.id = any(v_present)) order by i.id);
    return jsonb_build_object('status', 'ok', 'vault', item.vault, 'sign', to_jsonb(v_sign), 'present', to_jsonb(v_present),
      'manifest', v_manifest is not null, 'usedBytes', v_used + v_new);
  end if;

  if v_action in ('check', 'commit') then
    if v_version is null or jsonb_typeof(request->'objects') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    if v_action = 'commit' then
      select * into item from public.vector_brain_vaults v
       where v.mode = v_mode and v.account = v_account and not v.deleting for update;
    else
      select * into item from public.vector_brain_vaults v
       where v.mode = v_mode and v.account = v_account and not v.deleting;
    end if;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    select * into ver from public.vector_brain_vault_versions s where s.vault_id = item.id and s.id = v_version;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    if ver.committed then
      return jsonb_build_object('status', 'committed', 'vault', item.vault, 'snapshot', jsonb_build_object('id', ver.id,
        'createdAt', ver.created_at, 'bytes', ver.bytes, 'objects', ver.objects));
    end if;
    select count(*) into v_refs from public.vector_brain_vault_refs r where r.vault_id = item.id and r.version = v_version;
    if v_refs <> (request->>'objects')::bigint then
      return jsonb_build_object('status', 'count');
    end if;
    if v_action = 'commit' and jsonb_typeof(request->'verified') = 'array' then
      update public.vector_brain_vault_blobs b
         set state = 'stored', reserved_until = null, updated_at = v_now
        from jsonb_to_recordset(request->'verified') as x(kind text, id text, size bigint)
       where b.vault_id = item.id and b.kind = x.kind and b.id = x.id and b.size = x.size and b.state = 'pending'
         and (x.kind = 'object' or x.id = v_version);
    end if;
    select * into blob from public.vector_brain_vault_blobs b
     where b.vault_id = item.id and b.kind = 'manifest' and b.id = v_version;
    if not found or blob.state not in ('pending', 'stored') then
      return jsonb_build_object('status', 'manifest');
    end if;
    if exists (select 1 from public.vector_brain_vault_refs r
                 left join public.vector_brain_vault_blobs b on b.vault_id = r.vault_id and b.kind = 'object' and b.id = r.object
                where r.vault_id = item.id and r.version = v_version and (b.id is null or b.state not in ('pending', 'stored'))) then
      return jsonb_build_object('status', 'missing');
    end if;
    if v_action = 'check' then
      select coalesce(jsonb_agg(h.head order by h.ord, h.id), '[]'::jsonb) into v_items from (
        select 0 as ord, blob.id as id, jsonb_build_object('kind', 'manifest', 'id', blob.id, 'size', blob.size) as head
         where blob.state = 'pending'
        union all
        (select 1, b.id, jsonb_build_object('kind', 'object', 'id', b.id, 'size', b.size)
           from public.vector_brain_vault_refs r
           join public.vector_brain_vault_blobs b on b.vault_id = r.vault_id and b.kind = 'object' and b.id = r.object
          where r.vault_id = item.id and r.version = v_version and b.state = 'pending'
          order by b.id
          limit least(greatest(coalesce((request->>'limit')::integer, 1000), 1), 10000))
      ) h;
      return jsonb_build_object('status', 'ok', 'vault', item.vault, 'heads', v_items);
    end if;
    if blob.state = 'pending' or exists (
         select 1 from public.vector_brain_vault_refs r
           join public.vector_brain_vault_blobs b on b.vault_id = r.vault_id and b.kind = 'object' and b.id = r.object
          where r.vault_id = item.id and r.version = v_version and b.state = 'pending') then
      return jsonb_build_object('status', 'more');
    end if;
    update public.vector_brain_vault_versions s
       set committed = true, committed_at = v_now, touched_at = v_now, objects = v_refs::integer,
           bytes = blob.size + (select coalesce(sum(b.size), 0)
                                  from public.vector_brain_vault_refs r
                                  join public.vector_brain_vault_blobs b
                                    on b.vault_id = r.vault_id and b.kind = 'object' and b.id = r.object
                                 where r.vault_id = item.id and r.version = v_version)
     where s.vault_id = item.id and s.id = v_version
    returning * into ver;
    return jsonb_build_object('status', 'ok', 'vault', item.vault, 'snapshot', jsonb_build_object('id', ver.id,
      'createdAt', ver.created_at, 'bytes', ver.bytes, 'objects', ver.objects));
  end if;

  if v_action = 'discard' then
    if jsonb_typeof(request->'items') is distinct from 'array' then
      return jsonb_build_object('status', 'invalid');
    end if;
    select * into item from public.vector_brain_vaults v
     where v.mode = v_mode and v.account = v_account and not v.deleting for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    update public.vector_brain_vault_blobs b
       set state = 'trash', reserved_until = null, updated_at = v_now
      from jsonb_to_recordset(request->'items') as x(kind text, id text)
     where b.vault_id = item.id and b.kind = x.kind and b.id = x.id and b.state = 'pending';
    return jsonb_build_object('status', 'ok');
  end if;

  if v_action in ('version', 'downloads') then
    select * into item from public.vector_brain_vaults v where v.mode = v_mode and v.account = v_account and not v.deleting;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    select * into ver from public.vector_brain_vault_versions s
     where s.vault_id = item.id and s.id = v_version and s.committed;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    if v_action = 'version' then
      return jsonb_build_object('status', 'ok', 'vault', item.vault, 'snapshot', jsonb_build_object('id', ver.id,
        'createdAt', ver.created_at, 'bytes', ver.bytes, 'objects', ver.objects));
    end if;
    if jsonb_typeof(request->'objects') is distinct from 'array' then
      return jsonb_build_object('status', 'invalid');
    end if;
    select coalesce(jsonb_agg(r.object order by r.object), '[]'::jsonb) into v_items
      from public.vector_brain_vault_refs r
      join public.vector_brain_vault_blobs b on b.vault_id = r.vault_id and b.kind = 'object' and b.id = r.object
     where r.vault_id = item.id and r.version = v_version and b.state = 'stored'
       and r.object in (select jsonb_array_elements_text(request->'objects'));
    return jsonb_build_object('status', 'ok', 'vault', item.vault, 'objects', v_items);
  end if;

  if v_action = 'forget' then
    if v_version is null then
      return jsonb_build_object('status', 'invalid');
    end if;
    select * into item from public.vector_brain_vaults v
     where v.mode = v_mode and v.account = v_account and not v.deleting for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    select coalesce(array_agg(r.object), '{}'::text[]) into v_ids
      from public.vector_brain_vault_refs r where r.vault_id = item.id and r.version = v_version;
    delete from public.vector_brain_vault_versions s where s.vault_id = item.id and s.id = v_version and s.committed;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    update public.vector_brain_vault_blobs b
       set state = 'trash', reserved_until = null, updated_at = v_now
     where b.vault_id = item.id and b.kind = 'manifest' and b.id = v_version and b.state in ('pending', 'stored');
    update public.vector_brain_vault_blobs b
       set state = 'trash', reserved_until = null, updated_at = v_now
     where b.vault_id = item.id and b.kind = 'object' and b.id = any(v_ids) and b.state in ('pending', 'stored')
       and not exists (select 1 from public.vector_brain_vault_refs r where r.vault_id = b.vault_id and r.object = b.id);
    return jsonb_build_object('status', 'ok');
  end if;

  -- The person's own deletion, account deletion and a lapsed vault: the wrapped key goes in the same step as the
  -- vault's listing, so nothing can be restored from the moment this answers, and the blobs are queued for R2.
  if v_action = 'destroy' then
    select * into item from public.vector_brain_vaults v
     where v.mode = v_mode and v.account = v_account and not v.deleting for update;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    update public.vector_brain_vaults
       set deleting = true, wrapped_key = null, held = false, notice_at = null, delete_at = null, updated_at = v_now
     where id = item.id;
    delete from public.vector_brain_vault_versions where vault_id = item.id;
    update public.vector_brain_vault_blobs
       set state = 'trash', reserved_until = null, updated_at = v_now
     where vault_id = item.id and state in ('pending', 'stored');
    delete from public.vector_brain_vaults v
     where v.id = item.id and not exists (select 1 from public.vector_brain_vault_blobs b where b.vault_id = v.id);
    return jsonb_build_object('status', 'ok');
  end if;

  -- The vault provisioner (§4.4): frozen holds the vault, a live or paused plan releases it, an ended plan's notice
  -- starts the 30 read-only days once.
  if v_action in ('hold', 'release') then
    update public.vector_brain_vaults v
       set held = (v_action = 'hold'), notice_at = null, delete_at = null, updated_at = v_now
     where v.mode = v_mode and v.account = v_account and not v.deleting
       and (v.held is distinct from (v_action = 'hold') or v.notice_at is not null or v.delete_at is not null);
    return jsonb_build_object('status', 'ok');
  end if;

  if v_action = 'notice' then
    if jsonb_typeof(request->'deleteAt') is distinct from 'number' then
      return jsonb_build_object('status', 'invalid');
    end if;
    update public.vector_brain_vaults v
       set held = false, notice_at = coalesce(v.notice_at, v_now),
           delete_at = coalesce(v.delete_at, (request->>'deleteAt')::bigint), updated_at = v_now
     where v.mode = v_mode and v.account = v_account and not v.deleting
    returning * into item;
    if not found then
      return jsonb_build_object('status', 'not_found');
    end if;
    return jsonb_build_object('status', 'ok', 'noticeAt', item.notice_at, 'deleteAt', item.delete_at);
  end if;

  return jsonb_build_object('status', 'invalid');
end;
$$;
revoke all on function public.vector_brain_vault(jsonb) from public, anon, authenticated;
grant execute on function public.vector_brain_vault(jsonb) to service_role;

commit;
