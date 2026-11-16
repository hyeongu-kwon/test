-- 자산관리 대시보드 · 계정 저장소 설정
-- Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run 을 한 번 누르세요.
-- (여러 번 실행해도 안전합니다. 기존 데이터는 지워지지 않습니다.)
--
-- 구조: 계정마다 암호화된 데이터 한 덩어리(data)를 보관합니다.
--  · data 는 브라우저에서 비밀번호로 암호화된 상태로 올라오므로 서버에서는 내용을 읽을 수 없습니다.
--  · 표(vaults)는 외부에서 직접 읽거나 쓸 수 없고, 아래 함수로만 접근합니다.
--  · 함수는 아이디와 인증값이 맞을 때만 데이터를 돌려줍니다.
--  · 무차별 대입 막기 (남이 내 계정을 잠그는 일은 막고, 비밀번호 맞히기는 어렵게):
--      - 한 IP에서 10분에 10번 틀리면 그 IP만 10분간 막습니다. (없는 아이디도 똑같이 셉니다 → 아이디가 있는지 알 수 없음)
--      - 한 계정이 1시간에 50번 틀리면 (여러 IP를 동원한 공격) 그 계정을 1시간 잠급니다.
--      - 가입 시도는 한 IP에서 1시간에 10번까지입니다.

create table if not exists public.vaults (
  id           text primary key check (char_length(id) between 2 and 32),
  auth         text not null,
  data         text not null check (char_length(data) <= 600000),
  rev          integer not null default 1,
  fails        integer not null default 0,
  locked_until timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.vaults add column if not exists fail_since timestamptz;

alter table public.vaults enable row level security;
revoke all on public.vaults from public, anon, authenticated;

-- IP별 시도 횟수 기록 (key: 'fail:<ip>' 또는 'signup:<ip>')
create table if not exists public.vault_throttle (
  key           text primary key,
  hits          integer not null default 0,
  since         timestamptz not null default now(),
  blocked_until timestamptz
);
alter table public.vault_throttle enable row level security;
revoke all on public.vault_throttle from public, anon, authenticated;

create or replace function public.vault_hash(p_auth text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p_auth, 'utf8')), 'hex') $$;

-- 요청한 사람의 IP (Supabase API가 넘겨주는 헤더). 알 수 없으면 null → IP 제한은 건너뛰고 계정 제한만 적용
create or replace function public.vault_client_ip() returns text
language plpgsql stable as $$
declare h json;
begin
  h := nullif(current_setting('request.headers', true), '')::json;
  return coalesce(
    nullif(btrim(h ->> 'cf-connecting-ip'), ''),
    nullif(btrim(split_part(h ->> 'x-forwarded-for', ',', 1)), ''));
exception when others then return null;
end $$;

create or replace function public.vault_is_blocked(p_key text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.vault_throttle where key = p_key and blocked_until > now())
$$;

-- 시도 1회 기록. p_window 안에 p_limit 번이 되면 p_window 동안 막습니다.
create or replace function public.vault_hit(p_key text, p_limit integer, p_window interval) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.vault_throttle as t (key, hits, since) values (p_key, 1, now())
  on conflict (key) do update set
    hits  = case when t.since < now() - p_window then 1 else t.hits + 1 end,
    since = case when t.since < now() - p_window then now() else t.since end;
  update public.vault_throttle set hits = 0, since = now(), blocked_until = now() + p_window
   where key = p_key and hits >= p_limit;
  -- 하루 지난 기록 정리
  delete from public.vault_throttle
   where since < now() - interval '1 day' and (blocked_until is null or blocked_until < now());
end $$;

-- 내부용: 'ok' | 'invalid' | 'locked'
create or replace function public.vault_check(p_id text, p_auth text) returns text
language plpgsql security definer set search_path = public as $$
declare v public.vaults%rowtype; has_row boolean; ip text := public.vault_client_ip();
begin
  if ip is not null and public.vault_is_blocked('fail:' || ip) then return 'locked'; end if;
  select * into v from public.vaults where id = p_id for update;
  has_row := found;
  if has_row and v.locked_until > now() then return 'locked'; end if;
  if has_row and v.auth = public.vault_hash(p_auth) then
    if v.fails > 0 or v.locked_until is not null or v.fail_since is not null then
      update public.vaults set fails = 0, fail_since = null, locked_until = null where id = p_id;
    end if;
    return 'ok';
  end if;
  -- 틀림 (없는 아이디도 같은 결과)
  if ip is not null then perform public.vault_hit('fail:' || ip, 10, interval '10 minutes'); end if;
  if has_row then
    if v.fail_since is null or v.fail_since < now() - interval '1 hour' then
      update public.vaults set fails = 1, fail_since = now(), locked_until = null where id = p_id;
    elsif v.fails + 1 >= 50 then
      update public.vaults set fails = 0, fail_since = null, locked_until = now() + interval '1 hour' where id = p_id;
    else
      update public.vaults set fails = v.fails + 1 where id = p_id;
    end if;
  end if;
  return 'invalid';
end $$;

create or replace function public.vault_signup(p_id text, p_auth text, p_data text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ip text := public.vault_client_ip();
begin
  if ip is not null and public.vault_is_blocked('signup:' || ip) then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;
  if p_id is null or p_id <> lower(btrim(p_id)) or char_length(p_id) not between 2 and 32
     or p_auth is null or char_length(p_auth) not between 40 and 64
     or p_data is null or char_length(p_data) > 600000 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  if ip is not null then perform public.vault_hit('signup:' || ip, 10, interval '1 hour'); end if;
  if (select count(*) from public.vaults) >= 200 then
    return jsonb_build_object('ok', false, 'error', 'full');
  end if;
  insert into public.vaults (id, auth, data) values (p_id, public.vault_hash(p_auth), p_data)
    on conflict (id) do nothing;
  if not found then return jsonb_build_object('ok', false, 'error', 'exists'); end if;
  return jsonb_build_object('ok', true, 'rev', 1);
end $$;

create or replace function public.vault_load(p_id text, p_auth text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text; v public.vaults%rowtype;
begin
  r := public.vault_check(p_id, p_auth);
  if r <> 'ok' then return jsonb_build_object('ok', false, 'error', r); end if;
  select * into v from public.vaults where id = p_id;
  return jsonb_build_object('ok', true, 'data', v.data, 'rev', v.rev, 'updated_at', v.updated_at);
end $$;

create or replace function public.vault_save(p_id text, p_auth text, p_data text, p_rev integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text; cur integer;
begin
  r := public.vault_check(p_id, p_auth);
  if r <> 'ok' then return jsonb_build_object('ok', false, 'error', r); end if;
  if p_data is null or char_length(p_data) > 600000 then
    return jsonb_build_object('ok', false, 'error', 'too_large');
  end if;
  select rev into cur from public.vaults where id = p_id;
  if cur <> p_rev then return jsonb_build_object('ok', false, 'error', 'conflict', 'rev', cur); end if;
  update public.vaults set data = p_data, rev = rev + 1, updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'rev', cur + 1);
end $$;

-- 비밀번호 변경: 새 인증값과, 새 비밀번호로 다시 암호화한 데이터를 함께 저장
create or replace function public.vault_change(p_id text, p_auth text, p_new_auth text, p_data text, p_rev integer) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text; cur integer;
begin
  r := public.vault_check(p_id, p_auth);
  if r <> 'ok' then return jsonb_build_object('ok', false, 'error', r); end if;
  if p_new_auth is null or char_length(p_new_auth) not between 40 and 64
     or p_data is null or char_length(p_data) > 600000 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  select rev into cur from public.vaults where id = p_id;
  if cur <> p_rev then return jsonb_build_object('ok', false, 'error', 'conflict', 'rev', cur); end if;
  update public.vaults set auth = public.vault_hash(p_new_auth), data = p_data, rev = rev + 1, updated_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'rev', cur + 1);
end $$;

create or replace function public.vault_delete(p_id text, p_auth text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  r := public.vault_check(p_id, p_auth);
  if r <> 'ok' then return jsonb_build_object('ok', false, 'error', r); end if;
  delete from public.vaults where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- 외부(anon)에서는 아래 5개 함수만 호출할 수 있습니다.
revoke all on function public.vault_hash(text) from public, anon, authenticated;
revoke all on function public.vault_check(text, text) from public, anon, authenticated;
revoke all on function public.vault_client_ip() from public, anon, authenticated;
revoke all on function public.vault_is_blocked(text) from public, anon, authenticated;
revoke all on function public.vault_hit(text, integer, interval) from public, anon, authenticated;
revoke all on function public.vault_signup(text, text, text) from public;
revoke all on function public.vault_load(text, text) from public;
revoke all on function public.vault_save(text, text, text, integer) from public;
revoke all on function public.vault_change(text, text, text, text, integer) from public;
revoke all on function public.vault_delete(text, text) from public;
grant execute on function public.vault_signup(text, text, text) to anon, authenticated;
grant execute on function public.vault_load(text, text) to anon, authenticated;
grant execute on function public.vault_save(text, text, text, integer) to anon, authenticated;
grant execute on function public.vault_change(text, text, text, text, integer) to anon, authenticated;
grant execute on function public.vault_delete(text, text) to anon, authenticated;
