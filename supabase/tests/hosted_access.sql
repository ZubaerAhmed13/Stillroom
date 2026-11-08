-- Run only against an empty Stillroom project. The transaction rolls back all fixtures.
begin;
do $qa$
declare
  bridge text := repeat('B', 43);
  setup_token text := repeat('S', 43);
  owner_session text := repeat('O', 43);
  guest_session text := repeat('G', 43);
  guest_claim text := repeat('I', 43);
  owner_id uuid := gen_random_uuid();
  guest_id uuid := gen_random_uuid();
  invite_id uuid;
  result jsonb;
  fixture_count integer;
begin
  if exists (select from stillroom_private.members) then raise exception 'QA requires an empty pilot'; end if;
  insert into stillroom_private.bridge_keys values (stillroom_private.digest(bridge));
  insert into stillroom_private.owner_setup values (stillroom_private.digest(setup_token), clock_timestamp() + interval '10 minutes');

  begin
    insert into auth.users (id, email, raw_user_meta_data)
      values (gen_random_uuid(), 'public-signup@example.com', '{"stillroom_provisioned":true}');
    set constraints auth.stillroom_invitation_only immediate;
    raise exception 'Public signup unexpectedly succeeded' using errcode = 'XX000';
  exception when raise_exception then
    if sqlerrm <> 'Stillroom accounts require an invitation' then raise; end if;
  end;

  insert into auth.users (id, email) values (owner_id, 'stillroom-owner-qa@example.com');
  update auth.users set raw_app_meta_data = jsonb_build_object('stillroom_provisioned', true,
    'stillroom_mode', 'setup', 'stillroom_claim', encode(stillroom_private.digest(setup_token), 'hex')) where id = owner_id;
  set constraints auth.stillroom_invitation_only immediate;
  set constraints auth.stillroom_invitation_only deferred;
  if exists (select from stillroom_private.owner_setup where digest = stillroom_private.digest(setup_token)) then
    raise exception 'Owner setup was not consumed';
  end if;
  result := public.stillroom_dispatch(bridge, null, 'login', jsonb_build_object('id', owner_id, 'token', owner_session));
  if result #>> '{user,role}' is distinct from 'owner' then raise exception 'Owner identity is missing'; end if;

  result := public.stillroom_dispatch(bridge, owner_session, 'invite',
    jsonb_build_object('email', 'stillroom-guest-qa@example.com', 'token', guest_claim));
  invite_id := (result->>'id')::uuid;
  for slot in 2..10 loop
    perform public.stillroom_dispatch(bridge, owner_session, 'invite', jsonb_build_object(
      'email', 'stillroom-guest-' || slot || '@example.com', 'token', lpad(slot::text, 43, 'x')));
  end loop;
  begin
    perform public.stillroom_dispatch(bridge, owner_session, 'invite',
      jsonb_build_object('email', 'stillroom-over-cap@example.com', 'token', repeat('X', 43)));
    raise exception 'Eleventh invitation succeeded';
  exception when sqlstate 'PT409' then null;
  end;
  insert into auth.users (id, email) values (guest_id, 'stillroom-guest-qa@example.com');
  update auth.users set raw_app_meta_data = jsonb_build_object('stillroom_provisioned', true,
    'stillroom_mode', 'redeem', 'stillroom_claim', encode(stillroom_private.digest(guest_claim), 'hex')) where id = guest_id;
  set constraints auth.stillroom_invitation_only immediate;
  set constraints auth.stillroom_invitation_only deferred;
  begin
    perform public.stillroom_dispatch(bridge, null, 'claim', jsonb_build_object('claim', guest_claim, 'mode', 'redeem'));
    raise exception 'Reused invitation succeeded';
  exception when sqlstate 'PT404' then null;
  end;
  result := public.stillroom_dispatch(bridge, null, 'login', jsonb_build_object('id', guest_id, 'token', guest_session));
  if result #>> '{user,role}' is distinct from 'guest' then raise exception 'Guest identity is missing'; end if;

  perform public.stillroom_dispatch(bridge, owner_session, 'create_collection', '{"name":"Pilot collection"}');
  insert into stillroom_private.media (name, title, mime, size, status, favourite)
    values ('sample.png', 'Sample', 'image/png', 100, 'ready', true);
  result := public.stillroom_dispatch(bridge, guest_session, 'media', '{}');
  if result #>> '{collections,0,name}' is distinct from 'Pilot collection' or (result #> '{items,0}') ? 'favourite' then
    raise exception 'Guest catalog visibility is incorrect';
  end if;
  begin
    perform public.stillroom_dispatch(bridge, guest_session, 'create_collection', '{"name":"Should fail"}');
    raise exception 'Guest write succeeded';
  exception when sqlstate 'PT403' then null;
  end;

  perform public.stillroom_dispatch(bridge, owner_session, 'revoke', jsonb_build_object('id', invite_id));
  begin
    perform public.stillroom_dispatch(bridge, guest_session, 'media', '{}');
    raise exception 'Revoked session could still access the catalog';
  exception when sqlstate 'PT401' then null;
  end;
  begin
    perform public.stillroom_dispatch(bridge, null, 'login', jsonb_build_object('id', guest_id, 'token', guest_session));
    raise exception 'Revoked guest could still sign in';
  exception when sqlstate 'PT401' then null;
  end;
  perform public.stillroom_dispatch(bridge, owner_session, 'invite',
    jsonb_build_object('email', 'stillroom-guest-qa@example.com', 'token', repeat('R', 43)));
  result := public.stillroom_dispatch(bridge, null, 'activate', jsonb_build_object('id', guest_id,
    'token', repeat('N', 43), 'claim', repeat('R', 43), 'mode', 'redeem', 'email', 'stillroom-guest-qa@example.com'));
  if result #>> '{user,role}' is distinct from 'guest' then raise exception 'Could not reactivate guest'; end if;
  select count(*) into fixture_count from stillroom_private.sessions where member_id = guest_id;
  if fixture_count <> 1 then raise exception 'Revocation did not clear old sessions'; end if;
end
$qa$;
rollback;
select 'hosted access checks passed' as result;
