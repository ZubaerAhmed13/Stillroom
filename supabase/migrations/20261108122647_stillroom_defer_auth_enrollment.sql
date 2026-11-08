create or replace function stillroom_private.provision_member()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  claim_hash bytea;
  invitation_id uuid;
  checked_at timestamptz;
  app_meta jsonb;
  email_address text;
begin
  -- GoTrue adds admin app metadata after inserting the Auth user.
  select u.raw_app_meta_data, lower(u.email) into app_meta, email_address
    from auth.users u where u.id = new.id;
  if not found then return null; end if;
  if app_meta -> 'stillroom_provisioned' is distinct from 'true'::jsonb or
    coalesce(app_meta ->> 'stillroom_claim', '') !~ '^[a-f0-9]{64}$' or email_address is null then
    raise exception 'Stillroom accounts require an invitation';
  end if;
  perform pg_advisory_xact_lock(216401, 1);
  checked_at := clock_timestamp();
  claim_hash := decode(app_meta ->> 'stillroom_claim', 'hex');
  if app_meta ->> 'stillroom_mode' = 'setup' then
    if exists (select from stillroom_private.members where role = 'owner') or not exists (
      select from stillroom_private.owner_setup where digest = claim_hash and expires_at > checked_at
    ) then raise exception 'Stillroom owner setup is unavailable'; end if;
    insert into stillroom_private.members (id, email, role) values (new.id, email_address, 'owner');
    delete from stillroom_private.owner_setup where digest = claim_hash;
  elsif app_meta ->> 'stillroom_mode' = 'redeem' then
    select id into invitation_id from stillroom_private.invites where digest = claim_hash and email = email_address
      and status = 'pending' and expires_at > checked_at;
    if invitation_id is null then raise exception 'Stillroom invitation is unavailable'; end if;
    insert into stillroom_private.members (id, email, role) values (new.id, email_address, 'guest');
    update stillroom_private.invites set status = 'active', digest = null where id = invitation_id;
  else
    raise exception 'Stillroom accounts require an invitation';
  end if;
  return new;
end;
$$;
revoke execute on function stillroom_private.provision_member() from public, anon, authenticated;
grant execute on function stillroom_private.provision_member() to supabase_auth_admin;
drop trigger stillroom_invitation_only on auth.users;
create constraint trigger stillroom_invitation_only after insert on auth.users
  deferrable initially deferred for each row execute function stillroom_private.provision_member();
