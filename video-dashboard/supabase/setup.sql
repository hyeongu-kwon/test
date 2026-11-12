-- 여행 영상 대시보드 — Supabase 초기 설정
-- Supabase 대시보드 → SQL Editor 에 전체를 붙여 넣고 한 번 실행하세요. (여러 번 실행해도 안전합니다)

-- ============ 1. 계정별 권한 ============
-- role: 'admin'(업로드·수정·삭제), 'guest'(보기만), 'pending'(아직 권한 없음 — 아무것도 볼 수 없음)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  role text not null default 'pending' check (role in ('admin', 'guest', 'pending')),
  created_at timestamptz not null default now()
);

-- 새 계정이 생기면 권한 없는(pending) 프로필을 자동으로 만듭니다.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- 이미 만들어 둔 계정도 프로필을 채웁니다.
insert into public.profiles (id, email) select id, email from auth.users on conflict (id) do nothing;

-- 지금 로그인한 사람의 권한
create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- ============ 2. 영상 정보 ============
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  location text not null default '' check (char_length(location) <= 60),
  trip_date date,
  tags text[] not null default '{}',
  featured boolean not null default false,
  duration numeric not null default 0,
  width int not null default 0,
  height int not null default 0,
  video_path text not null,
  thumb_path text,
  views int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  -- 조회수만 바뀐 경우는 수정 시각을 건드리지 않습니다.
  if new.views is not distinct from old.views then new.updated_at = now(); end if;
  return new;
end $$;

drop trigger if exists videos_touch on public.videos;
create trigger videos_touch before update on public.videos
  for each row execute function public.touch_updated_at();

-- 조회수 +1 (게스트는 영상 정보를 고칠 수 없으므로 전용 함수로만 올립니다)
create or replace function public.increment_views(video_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if coalesce(public.my_role(), '') not in ('admin', 'guest') then raise exception 'not allowed'; end if;
  update public.videos set views = views + 1 where id = video_id returning views into n;
  return n;
end $$;
revoke execute on function public.increment_views(uuid) from public, anon;
grant execute on function public.increment_views(uuid) to authenticated;

-- ============ 3. 접근 규칙 (Row Level Security) ============
alter table public.profiles enable row level security;
alter table public.videos enable row level security;

drop policy if exists "profiles: 본인 또는 관리자가 조회" on public.profiles;
create policy "profiles: 본인 또는 관리자가 조회" on public.profiles for select to authenticated
  using (id = auth.uid() or public.my_role() = 'admin');

drop policy if exists "profiles: 관리자만 권한 변경" on public.profiles;
create policy "profiles: 관리자만 권한 변경" on public.profiles for update to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

drop policy if exists "videos: 관리자·게스트 조회" on public.videos;
create policy "videos: 관리자·게스트 조회" on public.videos for select to authenticated
  using (public.my_role() in ('admin', 'guest'));

drop policy if exists "videos: 관리자만 추가" on public.videos;
create policy "videos: 관리자만 추가" on public.videos for insert to authenticated
  with check (public.my_role() = 'admin');

drop policy if exists "videos: 관리자만 수정" on public.videos;
create policy "videos: 관리자만 수정" on public.videos for update to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

drop policy if exists "videos: 관리자만 삭제" on public.videos;
create policy "videos: 관리자만 삭제" on public.videos for delete to authenticated
  using (public.my_role() = 'admin');

revoke all on public.profiles, public.videos from anon;
grant select, update (role) on public.profiles to authenticated;
grant select, insert, update, delete on public.videos to authenticated;

-- ============ 4. 파일 저장소 (비공개 버킷) ============
-- file_size_limit: 영상 한 개 최대 크기(바이트). 무료 플랜은 프로젝트 전체 한도가 50MB라 그 이상은 올라가지 않습니다.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('videos', 'videos', false, 2147483648, array['video/mp4', 'video/quicktime', 'video/webm']),
  ('thumbs', 'thumbs', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "travel: 관리자·게스트 파일 조회" on storage.objects;
create policy "travel: 관리자·게스트 파일 조회" on storage.objects for select to authenticated
  using (bucket_id in ('videos', 'thumbs') and public.my_role() in ('admin', 'guest'));

drop policy if exists "travel: 관리자만 파일 추가" on storage.objects;
create policy "travel: 관리자만 파일 추가" on storage.objects for insert to authenticated
  with check (bucket_id in ('videos', 'thumbs') and public.my_role() = 'admin');

drop policy if exists "travel: 관리자만 파일 수정" on storage.objects;
create policy "travel: 관리자만 파일 수정" on storage.objects for update to authenticated
  using (bucket_id in ('videos', 'thumbs') and public.my_role() = 'admin')
  with check (bucket_id in ('videos', 'thumbs') and public.my_role() = 'admin');

drop policy if exists "travel: 관리자만 파일 삭제" on storage.objects;
create policy "travel: 관리자만 파일 삭제" on storage.objects for delete to authenticated
  using (bucket_id in ('videos', 'thumbs') and public.my_role() = 'admin');

-- ============ 5. 대시보드에서 계정 관리 (관리자 전용) ============
-- 앱의 설정 화면에서 계정을 만들고, 비밀번호를 바꾸고, 삭제할 수 있게 하는 함수입니다.
-- 모두 호출한 사람이 관리자인지 먼저 확인합니다.
create or replace function public.admin_create_user(p_email text, p_password text, p_role text default 'guest') returns uuid
language plpgsql security definer set search_path = public, extensions, auth as $$
declare
  uid uuid := gen_random_uuid();
  v_email text := lower(trim(p_email));
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'not allowed'; end if;
  if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then raise exception 'invalid email'; end if;
  if char_length(coalesce(p_password, '')) < 8 or char_length(p_password) > 72 then raise exception 'password length'; end if;
  if p_role not in ('admin', 'guest', 'pending') then raise exception 'invalid role'; end if;
  if exists (select 1 from auth.users where email = v_email) then raise exception 'already exists'; end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(),
    '', '', '', ''
  );
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values (
    gen_random_uuid(), uid, uid::text, 'email',
    jsonb_build_object('sub', uid::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
    now(), now(), now()
  );
  -- 프로필은 위 트리거가 만들어 주므로 권한만 지정합니다.
  insert into public.profiles (id, email, role) values (uid, v_email, p_role)
    on conflict (id) do update set role = excluded.role;
  return uid;
end $$;

create or replace function public.admin_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'not allowed'; end if;
  if char_length(coalesce(p_password, '')) < 8 or char_length(p_password) > 72 then raise exception 'password length'; end if;
  update auth.users set encrypted_password = crypt(p_password, gen_salt('bf')), updated_at = now() where id = p_user;
  if not found then raise exception 'user not found'; end if;
end $$;

create or replace function public.admin_delete_user(p_user uuid) returns void
language plpgsql security definer set search_path = public, extensions, auth as $$
begin
  if coalesce(public.my_role(), '') <> 'admin' then raise exception 'not allowed'; end if;
  if p_user = auth.uid() then raise exception 'cannot delete self'; end if;
  delete from auth.users where id = p_user;  -- 프로필도 함께 지워집니다.
  if not found then raise exception 'user not found'; end if;
end $$;

revoke execute on function public.admin_create_user(text, text, text), public.admin_set_password(uuid, text), public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_create_user(text, text, text), public.admin_set_password(uuid, text), public.admin_delete_user(uuid) to authenticated;

-- 관리자가 자기 권한을 스스로 내려 관리자가 없어지는 일을 막습니다.
create or replace function public.protect_own_role() returns trigger
language plpgsql as $$
begin
  if new.role is distinct from old.role and old.id = auth.uid() then raise exception 'cannot change own role'; end if;
  return new;
end $$;
drop trigger if exists profiles_protect_own_role on public.profiles;
create trigger profiles_protect_own_role before update on public.profiles
  for each row execute function public.protect_own_role();

-- ============ 6. 첫 관리자 지정 ============
-- 첫 관리자 계정만은 Supabase 대시보드(Authentication → Users → Add user)에서 만들어야 합니다.
-- 만든 뒤 아래 줄의 이메일을 바꿔 따로 실행하세요. 그다음부터는 앱의 설정 화면에서 계정을 관리합니다.
-- update public.profiles set role = 'admin' where email = 'me@example.com';
