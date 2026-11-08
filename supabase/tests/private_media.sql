-- This check requires an empty media catalog and a configured owner.
-- Fixtures and temporary limits are rolled back and no R2 calls are made.
begin;
do $qa$
declare
  bridge text := repeat('T', 43);
  owner_session text := repeat('Q', 43);
  owner_id uuid;
  id uuid;
  lease uuid := gen_random_uuid();
  next_lease uuid := gen_random_uuid();
  data jsonb;
  result jsonb;
  code text;
begin
  if exists (select from stillroom_private.media) then raise exception 'Test requires an empty media catalog'; end if;
  select m.id into strict owner_id from stillroom_private.members m where role = 'owner';
  if has_function_privilege('anon', 'public.stillroom_storage(text,text,text,jsonb)', 'execute') or
    has_function_privilege('authenticated', 'public.stillroom_storage(text,text,text,jsonb)', 'execute') then
    raise exception 'Storage RPC permissions are too broad';
  end if;
  insert into stillroom_private.bridge_keys values (stillroom_private.digest(bridge));
  insert into stillroom_private.sessions values (stillroom_private.digest(owner_session), owner_id, now() + interval '5 minutes');
  update stillroom_private.storage_limits set max_bytes = 12, write_limit = 3, read_limit = 2;

  data := jsonb_build_object('name', 'qa.png', 'title', 'QA', 'mime', 'image/png', 'size', 8, 'fingerprint', repeat('a', 64));
  result := public.stillroom_storage(bridge, owner_session, 'storage_reserve', data);
  id := (result->>'id')::uuid;
  result := public.stillroom_storage(bridge, owner_session, 'storage_reserve', data);
  if result->>'id' is distinct from id::text or (result->>'created')::boolean then raise exception 'Reservation retry changed the media ID'; end if;
  begin
    perform public.stillroom_storage(bridge, owner_session, 'storage_reserve', data || jsonb_build_object('fingerprint', repeat('b', 64)));
    raise exception 'Reservation exceeded storage limit';
  exception when sqlstate 'PT409' then
    get stacked diagnostics code = pg_exception_detail;
    if code is distinct from 'storage_limit' then raise; end if;
  end;

  data := jsonb_build_object('id', id, 'lease', lease, 'offset', 0, 'length', 8, 'hash', repeat('c', 64));
  result := public.stillroom_storage(bridge, owner_session, 'storage_part', data);
  if (result->>'partNumber')::int is distinct from 1 then raise exception 'Unexpected part number'; end if;
  begin
    perform public.stillroom_storage(bridge, owner_session, 'storage_part', data || jsonb_build_object('lease', next_lease));
    raise exception 'A parallel writer obtained the same part';
  exception when sqlstate 'PT409' then null;
  end;

  perform public.stillroom_storage(bridge, owner_session, 'storage_save_multipart', data || '{"uploadId":"synthetic"}');
  result := public.stillroom_storage(bridge, owner_session, 'storage_save_part', data || '{"etag":"synthetic-etag"}');
  if (result->>'offset')::integer is distinct from 8 then raise exception 'Upload offset was not recorded'; end if;
  result := public.stillroom_storage(bridge, owner_session, 'storage_part', data);
  if not (result->>'alreadySaved')::boolean then raise exception 'A retry attempted to upload a saved part'; end if;

  perform public.stillroom_storage(bridge, owner_session, 'storage_finish', data);
  perform public.stillroom_storage(bridge, owner_session, 'storage_complete_budget', data);
  begin
    perform public.stillroom_storage(bridge, owner_session, 'storage_complete_budget', data);
    raise exception 'A write exceeded the R2 limit';
  exception when sqlstate 'PT429' then
    get stacked diagnostics code = pg_exception_detail;
    if code is distinct from 'r2_write_limit' then raise; end if;
  end;
  perform public.stillroom_storage(bridge, owner_session, 'storage_publish', data);
  begin
    perform public.stillroom_storage(bridge, null, 'storage_read', data);
    raise exception 'An anonymous read reached the meter';
  exception when sqlstate 'PT401' then null;
  end;
  perform public.stillroom_storage(bridge, owner_session, 'storage_read', data);
  begin
    perform public.stillroom_storage(bridge, owner_session, 'storage_read', data);
    raise exception 'A read exceeded the R2 limit';
  exception when sqlstate 'PT429' then
    get stacked diagnostics code = pg_exception_detail;
    if code is distinct from 'r2_read_limit' then raise; end if;
  end;

  perform public.stillroom_storage(bridge, owner_session, 'storage_trash', data);
  result := public.stillroom_storage(bridge, owner_session, 'storage_status', '{}');
  if (result #>> '{usage,trash}')::integer is distinct from 8 then raise exception 'Trash released storage early'; end if;
  perform public.stillroom_storage(bridge, owner_session, 'storage_remove', data || '{"status":"trashed"}');
  result := public.stillroom_storage(bridge, owner_session, 'storage_status', '{}');
  if (result #>> '{usage,total}')::integer is distinct from 8 then raise exception 'Unconfirmed cleanup released storage early'; end if;
  perform public.stillroom_storage(bridge, owner_session, 'storage_removed', data);
  result := public.stillroom_storage(bridge, owner_session, 'storage_status', '{}');
  if (result #>> '{usage,total}')::integer is distinct from 0 then raise exception 'Confirmed cleanup did not release storage'; end if;
end
$qa$;
rollback;
select 'private media accounting checks passed' as result;
