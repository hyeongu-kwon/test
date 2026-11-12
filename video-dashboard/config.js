// Supabase 프로젝트 정보를 넣어 주세요. (Supabase 대시보드 → Project Settings → API)
// anon(public) 키는 공개되어도 되는 키입니다. 접근 제한은 DB의 권한 규칙(RLS)이 담당합니다.
// service_role 키는 절대 여기에 넣지 마세요.
window.TV_CONFIG = {
  supabaseUrl: '',      // 예: 'https://abcdefghijkl.supabase.co'
  supabaseAnonKey: '',  // 예: 'eyJhbGciOi...'
  siteTitle: '여행 필름',
  // 아이디에 @가 없으면 이 도메인을 붙여 로그인합니다. (guest → guest@travel.film)
  loginDomain: 'travel.film',
};
