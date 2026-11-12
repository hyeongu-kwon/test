# 여행 영상 대시보드 (Supabase)

여행 영상을 올려 두고, 로그인한 사람에게만 보여 주는 대시보드입니다.
서버 없이 정적 파일만으로 동작하며(로그인·DB·영상 저장은 Supabase), GitHub Pages 같은 곳에 그대로 올릴 수 있습니다.

## 계정별 권한
| 권한 | 할 수 있는 일 |
| --- | --- |
| **관리자** (`admin`) | 보기 + 업로드, 정보 수정, 썸네일 변경, 삭제, 다른 계정 권한 변경 |
| **게스트** (`guest`) | 영상 보기, 검색·필터만 |
| **권한 없음** (`pending`) | 로그인해도 아무것도 볼 수 없음 (새 계정의 기본값) |

권한은 화면에서 버튼을 숨기는 것이 아니라 **Supabase DB의 접근 규칙(RLS)** 으로 막습니다.
게스트 계정으로 직접 API를 호출해도 업로드·수정·삭제·권한 변경은 거부되고, 영상 파일은 비공개 버킷에 있어 로그인 없이는 열 수 없습니다.

## 설정 순서
1. **프로젝트 만들기** — [supabase.com](https://supabase.com)에서 새 프로젝트를 만듭니다.
2. **DB 설정** — SQL Editor에 [`supabase/setup.sql`](supabase/setup.sql) 전체를 붙여 넣고 실행합니다.
3. **가입 막기(권장)** — Authentication → Sign In / Providers 에서 "Allow new users to sign up"을 끕니다.
   켜 두어도 새 계정은 `권한 없음` 상태라 영상을 볼 수 없습니다.
4. **계정 만들기** — Authentication → Users → Add user → Create new user (Auto Confirm User 체크)
   - 내 계정: 예) `me@example.com`
   - 게스트 계정: 예) `guest@travel.film` → 로그인 화면에서는 아이디 `guest`만 입력하면 됩니다.
5. **첫 관리자 지정** — SQL Editor에서 한 번 실행합니다.
   ```sql
   update public.profiles set role = 'admin' where email = 'me@example.com';
   ```
6. **연결 정보 입력** — Project Settings → API 의 Project URL과 `anon` `public` 키를 [`config.js`](config.js)에 넣습니다.
   `anon` 키는 공개되어도 되는 키입니다. **`service_role` 키는 절대 넣지 마세요.**
7. **게스트 권한 주기** — 관리자로 로그인 → 설정 → 계정별 권한에서 `게스트`로 바꿉니다.
8. **배포** — 이 폴더를 정적 호스팅에 올립니다. (GitHub Pages라면 `…/video-dashboard/` 주소)
   로컬 확인: `python3 -m http.server 8000` 후 `http://localhost:8000`

아이디에 `@`가 없으면 `config.js`의 `loginDomain`을 붙여 로그인합니다(`guest` → `guest@travel.film`).
실제로 메일을 받을 필요가 없는 주소여도 됩니다.

## 화면
- **대표 영상**: 고정한 영상(없으면 가장 최근 여행)이 첫 화면에 크게 표시
- **요약**: 영상 수, 총 재생시간, 여행지 수, 총 조회수
- **찾기**: 검색(제목·여행지·태그), 여행지 칩, 연도, 정렬
- **카드**: 마우스를 올리면 소리 없이 미리보기, 누르면 재생
- **재생**: 이전/다음, 끝나면 다음 영상 이어보기
- **업로드(관리자)**: 여러 개를 끌어다 놓기, 진행률 표시, 길이와 썸네일 자동 추출
- **수정(관리자)**: 제목·설명·여행지·날짜·태그, 대표 고정, 썸네일 교체, 삭제
- **설정(관리자)**: 계정별 권한 변경, 내 비밀번호 변경

## 용량과 영상 형식
- Supabase **무료 플랜은 파일 하나에 50MB, 전체 저장 용량 1GB** 정도로 제한됩니다(정확한 수치는 Supabase 요금 안내 확인).
  2분 영상을 50MB 안에 넣으려면 대략 3Mbps 이하로 내보내야 합니다. 더 크게 올리려면 유료 플랜에서 Storage 업로드 한도를 올리세요.
- 무료 프로젝트는 한동안 사용이 없으면 일시 중지될 수 있습니다.
- MP4, MOV, WebM을 올릴 수 있습니다. 모든 브라우저에서 재생되게 하려면 **H.264 + AAC MP4**를 권합니다.
  ```bash
  ffmpeg -i input.mov -c:v libx264 -b:v 3M -vf scale=-2:1080 -c:a aac -b:a 128k -movflags +faststart output.mp4
  ```

## 파일
- `index.html`, `style.css`, `app.js` — 화면
- `config.js` — Supabase 연결 정보
- `supabase/setup.sql` — 테이블, 권한 규칙, 저장소 버킷
- `vendor/supabase.js` — Supabase 클라이언트 라이브러리(v2.119.0)
