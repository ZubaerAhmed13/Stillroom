create schema stillroom_private;
revoke all on schema stillroom_private from public, anon, authenticated;
grant usage on schema stillroom_private to service_role, supabase_auth_admin;

create table stillroom_private.bridge_keys (
  digest bytea primary key check (octet_length(digest) = 32)
);

create table stillroom_private.owner_setup (
  digest bytea primary key check (octet_length(digest) = 32),
  expires_at timestamptz not null
);

create table stillroom_private.members (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  role text not null check (role in ('owner', 'guest'))
);
create unique index stillroom_single_owner on stillroom_private.members (role) where role = 'owner';

create table stillroom_private.invites (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  digest bytea unique,
  status text not null check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table stillroom_private.sessions (
  digest bytea primary key check (octet_length(digest) = 32),
  member_id uuid not null references stillroom_private.members(id) on delete cascade,
  expires_at timestamptz not null
);
create index stillroom_sessions_member on stillroom_private.sessions (member_id);
create index stillroom_sessions_expiry on stillroom_private.sessions (expires_at);

create table stillroom_private.auth_attempts (
  window_start timestamptz not null,
  source_digest bytea not null,
  attempts integer not null,
  primary key (window_start, source_digest)
);

create table stillroom_private.collections (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80)
);
create unique index stillroom_collection_name on stillroom_private.collections (lower(name));

create table stillroom_private.media (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  name text not null check (char_length(name) between 1 and 255),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm')),
  size bigint not null check (size between 1 and 4294967296),
  created_at timestamptz not null default now(),
  status text not null check (status in ('uploading', 'ready', 'trashed')),
  collection_id uuid references stillroom_private.collections(id) on delete set null,
  description text not null default '' check (char_length(description) <= 2000),
  favourite boolean not null default false
);
create index stillroom_media_status on stillroom_private.media (status, created_at desc);
create index stillroom_media_collection on stillroom_private.media (collection_id);

alter table stillroom_private.bridge_keys enable row level security;
alter table stillroom_private.owner_setup enable row level security;
alter table stillroom_private.members enable row level security;
alter table stillroom_private.invites enable row level security;
alter table stillroom_private.sessions enable row level security;
alter table stillroom_private.auth_attempts enable row level security;
alter table stillroom_private.collections enable row level security;
alter table stillroom_private.media enable row level security;

grant select, insert, update, delete on all tables in schema stillroom_private to service_role;
revoke insert, update, delete on stillroom_private.bridge_keys from service_role;

-- Only the project admin API sets app metadata. Public signups supply user metadata.
-- Enroll the member and consume the claim in the same transaction as Auth user creation.
create function stillroom_private.provision_member()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  claim_hash bytea;
  invitation_id uuid;
  checked_at timestamptz;
begin
  if new.raw_app_meta_data -> 'stillroom_provisioned' is distinct from 'true'::jsonb or
    coalesce(new.raw_app_meta_data ->> 'stillroom_claim', '') !~ '^[a-f0-9]{64}$' or new.email is null then
    raise exception 'Stillroom accounts require an invitation';
  end if;
  perform pg_advisory_xact_lock(216401, 1);
  checked_at := clock_timestamp();
  claim_hash := decode(new.raw_app_meta_data ->> 'stillroom_claim', 'hex');
  if new.raw_app_meta_data ->> 'stillroom_mode' = 'setup' then
    if exists (select from stillroom_private.members where role = 'owner') or not exists (
      select from stillroom_private.owner_setup where digest = claim_hash and expires_at > checked_at
    ) then raise exception 'Stillroom owner setup is unavailable'; end if;
    insert into stillroom_private.members (id, email, role) values (new.id, lower(new.email), 'owner');
    delete from stillroom_private.owner_setup where digest = claim_hash;
  elsif new.raw_app_meta_data ->> 'stillroom_mode' = 'redeem' then
    select id into invitation_id from stillroom_private.invites where digest = claim_hash and email = lower(new.email)
      and status = 'pending' and expires_at > checked_at;
    if invitation_id is null then raise exception 'Stillroom invitation is unavailable'; end if;
    insert into stillroom_private.members (id, email, role) values (new.id, lower(new.email), 'guest');
    update stillroom_private.invites set status = 'active', digest = null where id = invitation_id;
  else
    raise exception 'Stillroom accounts require an invitation';
  end if;
  return new;
end;
$$;
revoke execute on function stillroom_private.provision_member() from public, anon, authenticated;
grant execute on function stillroom_private.provision_member() to supabase_auth_admin;
create trigger stillroom_invitation_only after insert on auth.users
  for each row execute function stillroom_private.provision_member();

create function stillroom_private.digest(value text)
returns bytea language sql immutable strict set search_path = ''
return sha256(convert_to(value, 'UTF8'));

create function stillroom_private.public_media(item stillroom_private.media, is_owner boolean)
returns jsonb language sql stable set search_path = ''
return jsonb_build_object(
  'id', item.id, 'title', item.title, 'name', item.name, 'mime', item.mime, 'size', item.size,
  'kind', case when item.mime like 'video/%' then 'video' else 'photo' end,
  'created', (extract(epoch from item.created_at) * 1000)::bigint,
  'description', item.description, 'collectionId', item.collection_id
) || case when is_owner then jsonb_build_object('favourite', item.favourite) else '{}'::jsonb end;

-- This invoker RPC is service-role only. The independent bridge key gates every action.
create function public.stillroom_dispatch(p_bridge text, p_session text, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  member stillroom_private.members;
  invitation stillroom_private.invites;
  item stillroom_private.media;
  collection stillroom_private.collections;
  email_address text;
  clean_name text;
  secret_digest bytea;
  window_start_at timestamptz;
  attempt_count integer;
  used_slots integer;
  token_value text;
  coll_id uuid;
  is_owner boolean;
  checked_at timestamptz;
begin
  if coalesce(p_bridge, '') !~ '^[A-Za-z0-9_-]{43}$' or not exists (
    select from stillroom_private.bridge_keys where digest = stillroom_private.digest(p_bridge)
  ) then
    raise sqlstate 'PT403' using message = 'Bridge access denied.';
  end if;

  if p_action = 'throttle' then
    window_start_at := date_bin(interval '15 minutes', now(), timestamptz '2000-01-01');
    delete from stillroom_private.auth_attempts where window_start < window_start_at;
    insert into stillroom_private.auth_attempts (window_start, source_digest, attempts)
      values (window_start_at, stillroom_private.digest('global'), 1)
      on conflict (window_start, source_digest) do update set attempts = auth_attempts.attempts + 1
      returning attempts into attempt_count;
    if attempt_count > 150 then
      raise sqlstate 'PT429' using message = 'Too many sign-in attempts. Try again in a few minutes.';
    end if;
    insert into stillroom_private.auth_attempts (window_start, source_digest, attempts)
      values (window_start_at, stillroom_private.digest('ip:' || coalesce(p_data->>'ip', 'unknown')), 1)
      on conflict (window_start, source_digest) do update set attempts = auth_attempts.attempts + 1
      returning attempts into attempt_count;
    if attempt_count > 20 then
      raise sqlstate 'PT429' using message = 'Too many sign-in attempts. Try again in a few minutes.';
    end if;
    return '{}'::jsonb;
  end if;

  if p_action in ('claim', 'activate', 'login') then
    -- Login and activation cannot issue a session after a concurrent revocation.
    perform pg_advisory_xact_lock(216401, 1);
    checked_at := clock_timestamp();
    if p_action <> 'login' then
      secret_digest := stillroom_private.digest(p_data->>'claim');
      if p_data->>'mode' = 'setup' then
        if p_action <> 'claim' or not exists (select from stillroom_private.owner_setup where digest = secret_digest and expires_at > checked_at)
          or exists (select from stillroom_private.members where role = 'owner') then
          raise sqlstate 'PT404' using message = 'This owner setup link is unavailable.';
        end if;
        email_address := p_data->>'email';
      else
        select * into invitation from stillroom_private.invites
          where digest = secret_digest and status = 'pending' and expires_at > checked_at;
        if not found then raise sqlstate 'PT404' using message = 'This invitation is unavailable.'; end if;
        email_address := invitation.email;
      end if;
      if p_action = 'claim' then return jsonb_build_object('email', email_address, 'digest', encode(secret_digest, 'hex')); end if;
      if email_address is distinct from p_data->>'email' then
        raise sqlstate 'PT403' using message = 'This identity does not match the invitation.';
      end if;

      select * into member from stillroom_private.members where id = (p_data->>'id')::uuid;
      if member.role is distinct from 'guest' or member.email is distinct from email_address then
        raise sqlstate 'PT403' using message = 'This identity does not match the invitation.';
      end if;
      update stillroom_private.invites set status = 'active', digest = null where id = invitation.id;
      delete from stillroom_private.sessions where member_id = member.id;
    else
      select * into member from stillroom_private.members where id = (p_data->>'id')::uuid;
      if not found or (member.role = 'guest' and not exists (
        select from stillroom_private.invites where email = member.email and status = 'active'
      )) then
        raise sqlstate 'PT401' using message = 'Email or password is incorrect, or access is inactive.';
      end if;
    end if;

    delete from stillroom_private.sessions where expires_at <= checked_at or digest = stillroom_private.digest(p_session);
    insert into stillroom_private.sessions (digest, member_id, expires_at)
      values (stillroom_private.digest(p_data->>'token'), member.id, checked_at + interval '7 days');
    return jsonb_build_object('user', jsonb_build_object('email', member.email, 'role', member.role));
  end if;

  if p_action = 'logout' then
    delete from stillroom_private.sessions where digest = stillroom_private.digest(p_session);
    return '{}'::jsonb;
  end if;

  select m.* into member from stillroom_private.sessions s join stillroom_private.members m on m.id = s.member_id
    where s.digest = stillroom_private.digest(p_session) and s.expires_at > now()
      and (m.role = 'owner' or exists (
        select from stillroom_private.invites i where i.email = m.email and i.status = 'active'
      ));
  if p_action = 'session' then
    return jsonb_build_object('user', case when member.id is null then null else jsonb_build_object('email', member.email, 'role', member.role) end);
  end if;
  if member.id is null then raise sqlstate 'PT401' using message = 'Sign in to continue.'; end if;
  is_owner := member.role = 'owner';
  if p_action = 'require_member' then return '{}'::jsonb; end if;
  if p_action = 'media' then
    return jsonb_build_object(
      'items', coalesce((select jsonb_agg(stillroom_private.public_media(m, is_owner) order by m.created_at desc, m.id)
        from stillroom_private.media m where m.status = 'ready'), '[]'::jsonb),
      'collections', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) order by lower(c.name))
        from stillroom_private.collections c), '[]'::jsonb)
    );
  end if;
  if not is_owner then raise sqlstate 'PT403' using message = 'Only the owner can do this.'; end if;

  if p_action = 'require_owner' then return '{}'::jsonb; end if;
  if p_action = 'owner' then
    return jsonb_build_object(
      'limit', 10, 'maxFile', 4294967296, 'mediaPaused', true, 'pending', '[]'::jsonb, 'trash', '[]'::jsonb,
      'used', (select count(*) from stillroom_private.invites where status = 'active' or (status = 'pending' and expires_at > now())),
      'invites', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'email', email, 'status', case when status = 'pending' and expires_at <= now() then 'expired' else status end,
        'created', (extract(epoch from created_at) * 1000)::bigint,
        'expires', (extract(epoch from expires_at) * 1000)::bigint
      ) order by created_at desc) from stillroom_private.invites), '[]'::jsonb),
      'usage', jsonb_build_object('limit', 9000000000, 'available', 9000000000, 'total', 0, 'ready', 0, 'trash', 0, 'reserved', 0)
    );
  end if;

  if p_action in ('invite', 'revoke') then
    perform pg_advisory_xact_lock(216401, 1);
    checked_at := clock_timestamp();
    if p_action = 'revoke' then
      update stillroom_private.invites set status = 'revoked', digest = null where id = (p_data->>'id')::uuid returning * into invitation;
      if not found then raise sqlstate 'PT404' using message = 'Invitation not found.'; end if;
      delete from stillroom_private.sessions where member_id in (
        select id from stillroom_private.members where email = invitation.email and role = 'guest'
      );
      return '{}'::jsonb;
    end if;
    email_address := lower(btrim(p_data->>'email'));
    if coalesce(email_address, '') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
       or char_length(email_address) > 254 or email_address = member.email then
      raise sqlstate 'PT400' using message = 'Enter a valid guest email address.';
    end if;
    select * into invitation from stillroom_private.invites where email = email_address;
    if invitation.status = 'active' then raise sqlstate 'PT409' using message = 'This guest already has access.'; end if;
    select count(*) into used_slots from stillroom_private.invites where status = 'active' or (status = 'pending' and expires_at > checked_at);
    if used_slots >= 10 and not coalesce(invitation.status = 'pending' and invitation.expires_at > checked_at, false) then
      raise sqlstate 'PT409' using message = 'All 10 guest slots are in use.';
    end if;
    token_value := p_data->>'token';
    insert into stillroom_private.invites (email, digest, status, expires_at)
      values (email_address, stillroom_private.digest(token_value), 'pending', checked_at + interval '7 days')
      on conflict (email) do update set digest = excluded.digest, status = 'pending', expires_at = excluded.expires_at, created_at = checked_at
      returning * into invitation;
    return jsonb_build_object('id', invitation.id, 'email', invitation.email,
      'expires', (extract(epoch from invitation.expires_at) * 1000)::bigint,
      'path', '/invite#' || token_value);
  end if;

  if p_action in ('create_collection', 'rename_collection') then
    clean_name := btrim(p_data->>'name');
    if jsonb_typeof(p_data->'name') is distinct from 'string' or coalesce(clean_name, '') = '' or char_length(clean_name) > 80 or clean_name ~ '[[:cntrl:]]' then
      raise sqlstate 'PT400' using message = 'Enter a collection name of up to 80 characters.';
    end if;
    begin
      if p_action = 'create_collection' then
        insert into stillroom_private.collections (name) values (clean_name) returning * into collection;
      else
        update stillroom_private.collections set name = clean_name where id = (p_data->>'id')::uuid returning * into collection;
        if not found then raise sqlstate 'PT404' using message = 'Collection not found.'; end if;
      end if;
    exception when unique_violation then
      raise sqlstate 'PT409' using message = 'A collection already has that name.';
    end;
    return jsonb_build_object('id', collection.id, 'name', collection.name);
  end if;

  if p_action = 'edit_media' then
    select * into item from stillroom_private.media where id = (p_data->>'id')::uuid and status = 'ready' for update;
    if not found then raise sqlstate 'PT404' using message = 'Media item not found.'; end if;
    if p_data ? 'title' and (jsonb_typeof(p_data->'title') <> 'string' or
      char_length(btrim(p_data->>'title')) not between 1 and 120 or (p_data->>'title') ~ '[[:cntrl:]]') then
      raise sqlstate 'PT400' using message = 'Enter a title of up to 120 characters.';
    end if;
    if p_data ? 'description' and (jsonb_typeof(p_data->'description') <> 'string' or char_length(p_data->>'description') > 2000) then
      raise sqlstate 'PT400' using message = 'Use a description of up to 2,000 characters.';
    end if;
    if p_data ? 'favourite' and jsonb_typeof(p_data->'favourite') <> 'boolean' then
      raise sqlstate 'PT400' using message = 'Invalid favourite setting.';
    end if;
    if p_data ? 'collectionId' and p_data->'collectionId' <> 'null'::jsonb then
      if coalesce(p_data->>'collectionId', '') !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
        raise sqlstate 'PT400' using message = 'Choose a valid collection.';
      end if;
      coll_id := (p_data->>'collectionId')::uuid;
      if not exists (select from stillroom_private.collections where id = coll_id) then
        raise sqlstate 'PT404' using message = 'Collection not found.';
      end if;
    end if;
    update stillroom_private.media set
      title = coalesce(btrim(p_data->>'title'), item.title),
      description = coalesce(btrim(p_data->>'description'), item.description),
      collection_id = case when p_data ? 'collectionId' then coll_id else item.collection_id end,
      favourite = coalesce((p_data->>'favourite')::boolean, item.favourite)
      where id = item.id returning * into item;
    return stillroom_private.public_media(item, true);
  end if;
  raise sqlstate 'PT404' using message = 'Page not found.';
end;
$$;

revoke execute on all functions in schema stillroom_private from public, anon, authenticated;
grant execute on function stillroom_private.digest(text), stillroom_private.public_media(stillroom_private.media, boolean) to service_role;
revoke execute on function public.stillroom_dispatch(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.stillroom_dispatch(text, text, text, jsonb) to service_role;
