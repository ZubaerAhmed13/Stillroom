create table stillroom_private.storage_limits (
  singleton boolean primary key default true check (singleton),
  max_bytes bigint not null default 9000000000 check (max_bytes between 1 and 9000000000),
  write_limit integer not null default 100000 check (write_limit between 0 and 100000),
  read_limit integer not null default 1000000 check (read_limit between 0 and 1000000)
);
insert into stillroom_private.storage_limits default values;

create table stillroom_private.r2_usage (
  hour_at timestamptz primary key,
  writes integer not null default 0 check (writes >= 0),
  reads integer not null default 0 check (reads >= 0)
);

alter table stillroom_private.media
  add column fingerprint text,
  add column multipart_id text,
  add column uploaded_bytes bigint not null default 0 check (uploaded_bytes between 0 and size),
  add column uploaded_parts jsonb not null default '[]'::jsonb,
  add column pending_hash text,
  add column lease_id uuid,
  add column lease_until timestamptz,
  add column removal_pending boolean not null default false;

create index stillroom_upload_fingerprint on stillroom_private.media (fingerprint)
  where status in ('uploading', 'ready');

alter table stillroom_private.storage_limits enable row level security;
alter table stillroom_private.r2_usage enable row level security;
grant select on stillroom_private.storage_limits to service_role;
grant select, insert, update, delete on stillroom_private.r2_usage to service_role;

-- Include the entire first hour intersecting the last 32 days, so partial hours
-- can only make the meter more conservative.
create function stillroom_private.storage_operations(at_time timestamptz)
returns table (writes bigint, reads bigint)
language sql stable security invoker set search_path = ''
as $$
  select coalesce(sum(u.writes), 0), coalesce(sum(u.reads), 0)
  from stillroom_private.r2_usage u
  where u.hour_at >= date_bin(interval '1 hour', at_time - interval '32 days', timestamptz '2000-01-01 UTC')
$$;

create function stillroom_private.charge_r2(add_writes integer, add_reads integer)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  checked_at timestamptz;
  hour_start timestamptz;
  limits stillroom_private.storage_limits;
  used_writes bigint;
  used_reads bigint;
begin
  perform pg_advisory_xact_lock(216401, 2);
  checked_at := clock_timestamp();
  hour_start := date_bin(interval '1 hour', checked_at, timestamptz '2000-01-01 UTC');
  select * into strict limits from stillroom_private.storage_limits;
  select writes, reads into used_writes, used_reads from stillroom_private.storage_operations(checked_at);
  if add_writes > 0 and used_writes + add_writes > limits.write_limit then
    raise sqlstate 'PT429' using message = 'Stillroom has reached its R2 write request limit.', detail = 'r2_write_limit';
  end if;
  if add_reads > 0 and used_reads + add_reads > limits.read_limit then
    raise sqlstate 'PT429' using message = 'Stillroom has reached its R2 read request limit.', detail = 'r2_read_limit';
  end if;
  delete from stillroom_private.r2_usage where hour_at < hour_start - interval '32 days';
  insert into stillroom_private.r2_usage (hour_at, writes, reads) values (hour_start, add_writes, add_reads)
  on conflict (hour_at) do update set writes = r2_usage.writes + excluded.writes, reads = r2_usage.reads + excluded.reads;
end;
$$;

create function public.stillroom_storage(p_bridge text, p_session text, p_action text, p_data jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item stillroom_private.media;
  limits stillroom_private.storage_limits;
  item_id uuid;
  lease uuid;
  checked_at timestamptz;
  used_bytes bigint;
  bytes_ready bigint;
  bytes_trash bigint;
  bytes_reserved bigint;
  file_size bigint;
  part_bytes integer;
  offset_bytes bigint;
  expected_bytes integer;
  part_no integer;
  part_hash text;
  existing boolean;
  used_writes bigint;
  used_reads bigint;
  chunk_size constant integer := 8388608;
begin
  perform public.stillroom_dispatch(p_bridge, p_session,
    case when p_action in ('storage_lookup', 'storage_read') then 'require_member' else 'require_owner' end, '{}'::jsonb);
  select * into strict limits from stillroom_private.storage_limits;

  if p_action = 'storage_status' then
    select coalesce(sum(size) filter (where status = 'ready'), 0),
      coalesce(sum(size) filter (where status = 'trashed'), 0),
      coalesce(sum(size) filter (where status = 'uploading'), 0)
    into bytes_ready, bytes_trash, bytes_reserved from stillroom_private.media;
    used_bytes := bytes_ready + bytes_trash + bytes_reserved;
    select writes, reads into used_writes, used_reads from stillroom_private.storage_operations(clock_timestamp());
    return jsonb_build_object(
      'usage', jsonb_build_object('ready', bytes_ready, 'trash', bytes_trash, 'reserved', bytes_reserved,
        'total', used_bytes, 'limit', limits.max_bytes, 'available', greatest(0, limits.max_bytes - used_bytes)),
      'operations', jsonb_build_object('writes', used_writes, 'reads', used_reads, 'writeLimit', limits.write_limit, 'readLimit', limits.read_limit),
      'pending', coalesce((select jsonb_agg(stillroom_private.public_media(m, true) ||
        jsonb_build_object('offset', m.uploaded_bytes) order by m.created_at desc)
        from stillroom_private.media m where m.status = 'uploading'), '[]'::jsonb),
      'trash', coalesce((select jsonb_agg(stillroom_private.public_media(m, true) order by m.created_at desc)
        from stillroom_private.media m where m.status = 'trashed'), '[]'::jsonb)
    );
  end if;

  if p_action in ('storage_lookup', 'storage_read') then
    select * into item from stillroom_private.media where id = (p_data->>'id')::uuid and status = 'ready';
    if not found then raise sqlstate 'PT404' using message = 'Media item not found.'; end if;
    if p_action = 'storage_read' then perform stillroom_private.charge_r2(0, 1); end if;
    return jsonb_build_object('size', item.size, 'mime', item.mime);
  end if;

  -- All admissions and state changes share the same lock as the request meter.
  perform pg_advisory_xact_lock(216401, 2);
  checked_at := clock_timestamp();
  if p_action = 'storage_reserve' then
    file_size := (p_data->>'size')::bigint;
    if file_size is null or file_size not between 1 and 4294967296 or
       coalesce(p_data->>'fingerprint', '') !~ '^[a-f0-9]{64}$' then
      raise sqlstate 'PT400' using message = 'Invalid upload metadata.';
    end if;
    select * into item from stillroom_private.media
      where fingerprint = p_data->>'fingerprint' and size = file_size and name = p_data->>'name'
        and mime = p_data->>'mime' and status in ('uploading', 'ready') order by created_at desc limit 1;
    existing := found;
    if not existing then
      select coalesce(sum(size), 0) into used_bytes from stillroom_private.media;
      if used_bytes + file_size > limits.max_bytes then
        raise sqlstate 'PT409' using message = 'This file would exceed the storage limit. Cancel an upload or free space in Trash.', detail = 'storage_limit';
      end if;
      if (select count(*) from stillroom_private.media where status = 'uploading') >= 12 then
        raise sqlstate 'PT409' using message = 'Finish or cancel an interrupted upload before starting another.';
      end if;
      insert into stillroom_private.media (name, title, mime, size, status, fingerprint)
        values (p_data->>'name', p_data->>'title', p_data->>'mime', file_size, 'uploading', p_data->>'fingerprint')
        returning * into item;
    elsif item.removal_pending then
      raise sqlstate 'PT409' using message = 'Finish canceling this upload before trying again.';
    end if;
    return jsonb_build_object('id', item.id, 'created', not existing, 'complete', item.status = 'ready',
      'offset', case when item.status = 'ready' then item.size else item.uploaded_bytes end);
  end if;

  item_id := (p_data->>'id')::uuid;
  lease := (p_data->>'lease')::uuid;
  select * into item from stillroom_private.media where id = item_id for update;
  if not found then
    if p_action = 'storage_remove' then return jsonb_build_object('removed', true); end if;
    raise sqlstate 'PT404' using message = 'Media item not found.';
  end if;

  if p_action in ('storage_trash', 'storage_restore') then
    if item.removal_pending or (p_action = 'storage_trash' and item.status = 'uploading') or
        (p_action = 'storage_restore' and item.status = 'uploading') then
      raise sqlstate 'PT409' using message = 'This media item is not available for that action.';
    end if;
    update stillroom_private.media set status = case when p_action = 'storage_trash' then 'trashed' else 'ready' end where id = item_id;
    return '{}'::jsonb;
  end if;

  if p_action = 'storage_finish' and item.status = 'ready' then
    return jsonb_build_object('complete', true, 'item', stillroom_private.public_media(item, true));
  end if;

  if lease is null then raise sqlstate 'PT400' using message = 'Invalid upload operation.'; end if;
  if p_action in ('storage_part', 'storage_finish', 'storage_remove') then
    if item.lease_id is not null and item.lease_until > checked_at then
      raise sqlstate 'PT409' using message = 'This file is already being updated. Try again shortly.';
    end if;
    if p_action = 'storage_remove' then
      if item.status not in ('uploading', 'trashed') or item.status is distinct from p_data->>'status' then
        raise sqlstate 'PT409' using message = 'Move this media item to Trash before deleting it.';
      end if;
      update stillroom_private.media set lease_id = lease, lease_until = checked_at + interval '2 minutes',
        removal_pending = true where id = item_id;
      return jsonb_build_object('uploadId', item.multipart_id);
    end if;
    if item.status <> 'uploading' or item.removal_pending then
      raise sqlstate 'PT409' using message = 'This upload is no longer active.';
    end if;
    if p_action = 'storage_finish' then
      if item.uploaded_bytes <> item.size or item.multipart_id is null then
        raise sqlstate 'PT409' using message = 'The upload is incomplete.';
      end if;
      perform stillroom_private.charge_r2(0, 1);
      update stillroom_private.media set lease_id = lease, lease_until = checked_at + interval '2 minutes' where id = item_id;
      return jsonb_build_object('uploadId', item.multipart_id, 'size', item.size, 'parts', item.uploaded_parts);
    end if;

    offset_bytes := (p_data->>'offset')::bigint;
    part_bytes := (p_data->>'length')::integer;
    part_hash := p_data->>'hash';
    if offset_bytes >= 0 and offset_bytes < item.uploaded_bytes then
      return jsonb_build_object('alreadySaved', true, 'offset', item.uploaded_bytes);
    end if;
    if offset_bytes is distinct from item.uploaded_bytes then
      raise sqlstate 'PT409' using message = 'The upload position changed. Resume the upload to continue.';
    end if;
    expected_bytes := least(chunk_size, item.size - item.uploaded_bytes);
    if expected_bytes <= 0 or part_bytes is distinct from expected_bytes or coalesce(part_hash, '') !~ '^[a-f0-9]{64}$' then
      raise sqlstate 'PT400' using message = 'The upload part is incomplete.';
    end if;
    if item.pending_hash is not null and item.pending_hash <> part_hash then
      raise sqlstate 'PT409' using message = 'Resume using the same original file.';
    end if;
    -- Recheck the byte cap even for a reservation if the configured limit was lowered.
    if (select coalesce(sum(size), 0) from stillroom_private.media) > limits.max_bytes then
      raise sqlstate 'PT409' using message = 'Free space before resuming this upload.', detail = 'storage_limit';
    end if;
    perform stillroom_private.charge_r2(case when item.multipart_id is null then 2 else 1 end, 0);
    update stillroom_private.media set lease_id = lease, lease_until = checked_at + interval '2 minutes',
      pending_hash = part_hash where id = item_id;
    return jsonb_build_object('mime', item.mime, 'uploadId', item.multipart_id,
      'partNumber', jsonb_array_length(item.uploaded_parts) + 1);
  end if;

  if item.lease_id is distinct from lease then
    raise sqlstate 'PT409' using message = 'The file update expired. Resume to continue.';
  end if;
  if item.removal_pending then
    if p_action = 'storage_removed' then
      delete from stillroom_private.media where id = item_id;
    else
      raise sqlstate 'PT409' using message = 'This file is being removed.';
    end if;
    return '{}'::jsonb;
  end if;
  if item.status <> 'uploading' then raise sqlstate 'PT409' using message = 'This upload is no longer active.'; end if;

  case p_action
    when 'storage_reject_part' then
      update stillroom_private.media set lease_id = null, lease_until = null, pending_hash = null where id = item_id;
    when 'storage_save_multipart' then
      if item.multipart_id is not null or coalesce(p_data->>'uploadId', '') = '' then
        raise sqlstate 'PT409' using message = 'The upload already has a storage reservation.';
      end if;
      update stillroom_private.media set multipart_id = p_data->>'uploadId' where id = item_id;
    when 'storage_save_part' then
      if item.multipart_id is null or item.pending_hash is null or coalesce(p_data->>'etag', '') = '' then
        raise sqlstate 'PT409' using message = 'The upload part could not be recorded.';
      end if;
      part_no := jsonb_array_length(item.uploaded_parts) + 1;
      update stillroom_private.media set uploaded_bytes = least(size, uploaded_bytes + chunk_size),
        uploaded_parts = uploaded_parts || jsonb_build_array(jsonb_build_object('partNumber', part_no, 'etag', p_data->>'etag')),
        pending_hash = null, lease_id = null, lease_until = null where id = item_id returning * into item;
      return jsonb_build_object('offset', item.uploaded_bytes);
    when 'storage_complete_budget' then
      perform stillroom_private.charge_r2(1, 0);
    when 'storage_release' then
      update stillroom_private.media set lease_id = null, lease_until = null where id = item_id;
    when 'storage_publish' then
      if item.uploaded_bytes <> item.size or item.multipart_id is null then
        raise sqlstate 'PT409' using message = 'The upload is incomplete.';
      end if;
      update stillroom_private.media set status = 'ready', lease_id = null, lease_until = null,
        multipart_id = null, uploaded_parts = '[]'::jsonb where id = item_id returning * into item;
      return stillroom_private.public_media(item, true);
    else
      raise sqlstate 'PT404' using message = 'Page not found.';
  end case;
  return '{}'::jsonb;
end;
$$;

revoke execute on function stillroom_private.storage_operations(timestamptz), stillroom_private.charge_r2(integer, integer) from public, anon, authenticated;
grant execute on function stillroom_private.storage_operations(timestamptz), stillroom_private.charge_r2(integer, integer) to service_role;
revoke execute on function public.stillroom_storage(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.stillroom_storage(text, text, text, jsonb) to service_role;
