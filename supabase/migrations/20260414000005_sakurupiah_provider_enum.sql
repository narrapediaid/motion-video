-- Add Sakurupiah as the active payment provider while keeping Midtrans historical rows valid.

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
      and t.typname = 'provider_name'
      and e.enumlabel = 'sakurupiah'
  ) then
    alter type public.provider_name add value 'sakurupiah';
  end if;
end;
$$;
