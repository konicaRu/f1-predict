-- 0006_invite_membership.sql — регистрация по инвайт-коду + членство.
create table public.invite_codes (
  code text primary key, active boolean not null default true, note text,
  created_at timestamptz not null default now()
);
alter table public.invite_codes enable row level security;  -- без политик: обычным юзерам недоступна

create or replace function public.is_member() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists(select 1 from public.users where id = auth.uid()) $$;

create or replace function public.redeem_invite(p_code text, p_display_name text)
  returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(coalesce(trim(p_display_name),'')) = 0 then raise exception 'display_name required'; end if;
  if not exists(select 1 from public.invite_codes where code = p_code and active) then
    raise exception 'invalid invite code'; end if;
  insert into public.users(id, display_name) values (auth.uid(), trim(p_display_name))
    on conflict (id) do update set display_name = excluded.display_name;
end $$;

grant execute on function public.is_member() to authenticated;
grant execute on function public.redeem_invite(text,text) to authenticated;

-- закрыть чтение данных лиги по членству (было using(true))
alter policy users_select   on public.users            using (public.is_member());
alter policy drivers_select on public.drivers          using (public.is_member());
alter policy races_select   on public.races            using (public.is_member());
alter policy pool_select    on public.race_driver_pool using (public.is_member());
alter policy results_select on public.results          using (public.is_member());
alter policy rc_select      on public.result_changes   using (public.is_member());
