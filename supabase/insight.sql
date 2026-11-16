-- 자산UP AI 데일리 브리핑 저장 테이블
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run 을 한 번 누르세요. (여러 번 실행해도 안전합니다.)
--
-- 하루에 한 행씩 공통 브리핑(뉴스·주식·부동산 동향)을 저장합니다. 사용자 개인 데이터는 들어가지 않습니다.
-- 외부(anon)에서는 직접 읽거나 쓸 수 없고, Edge Function "insight" 만 서버 권한으로 접근합니다.

create table if not exists public.briefings (
  day        date primary key,
  status     text not null check (status in ('pending', 'ready', 'error')),
  data       jsonb,
  error      text,
  updated_at timestamptz not null default now()
);

alter table public.briefings enable row level security;
revoke all on public.briefings from public, anon, authenticated;
