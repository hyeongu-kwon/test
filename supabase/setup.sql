-- 자산관리 대시보드 · 계정 저장소 설정
-- Supabase 대시보드 → SQL Editor 에 이 파일 전체를 붙여넣고 Run 을 한 번 누르세요.
-- (여러 번 실행해도 안전합니다. 기존 데이터는 지워지지 않습니다.)
--
-- 구조: 계정마다 암호화된 데이터 한 덩어리(data)를 보관합니다.
--  · data 는 브라우저에서 비밀번호로 암호화된 상태로 올라오므로 서버에서는 내용을 읽을 수 없습니다.
--  · 표(vaults)는 외부에서 직접 읽거나 쓸 수 없고, 아래 함수로만 접근합니다.
--  · 함수는 아이디와 인증값이 맞을 때만 데이터를 돌려주며, 5번 틀리면 5분간 잠깁니다.

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

alter table public.vaults enable row level security;
revoke all on public.vaults from public, anon, authenticated;

create or replace function public.vault_hash(p_auth text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p_auth, 'utf8')), 'hex') $$;

-- 내부용: 'ok' | 'invalid' | 'locked'
create or replace function public.vault_check(p_id text, p_auth text) returns text
language plpgsql security definer set search_path = public as $$
declare v public.vaults%rowtype;
begin
  select * into v from public.vaults where id = p_id for update;
  if not found then return 'invalid'; end if;
  if v.locked_until is not null and v.locked_until > now() then return 'locked'; end if;
  if v.auth = public.vault_hash(p_auth) then
    if v.fails > 0 or v.locked_until is not null then
      update public.vaults set fails = 0, locked_until = null where id = p_id;
    end if;
    return 'ok';
  end if;
  if v.fails + 1 >= 5 then
    update public.vaults set fails = 0, locked_until = now() + interval '5 minutes' where id = p_id;
  else
    update public.vaults set fails = v.fails + 1, locked_until = null where id = p_id;
  end if;
  return 'invalid';
end $$;

create or replace function public.vault_signup(p_id text, p_auth text, p_data text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if p_id is null or p_id <> lower(btrim(p_id)) or char_length(p_id) not between 2 and 32
     or p_auth is null or char_length(p_auth) not between 40 and 64
     or p_data is null or char_length(p_data) > 600000 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
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
