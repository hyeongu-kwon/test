# 🎬 여행 영상 대시보드

여행 영상을 올려 두고, 로그인한 사람에게만 보여 주는 대시보드입니다.

**바로 열기 → https://hyeongu-kwon.github.io/test/video-dashboard/**

| | |
| --- | --- |
| 화면 | 정적 페이지 (GitHub Pages, `master` 브랜치) |
| 로그인 · DB · 영상 저장 | Supabase 프로젝트 `Movie` |
| 자산관리 대시보드와의 관계 | 같은 저장소의 다른 폴더, **Supabase 프로젝트는 서로 다름** |

## 목차
- [쓰는 법](#쓰는-법)
- [계정과 권한](#계정과-권한)
- [제한](#제한)
- [자주 가는 Supabase 화면](#자주-가는-supabase-화면)
- [문제가 생겼을 때](#문제가-생겼을-때)
- [수정하고 반영하는 흐름](#수정하고-반영하는-흐름)
- [파일 구성](#파일-구성)
- [처음부터 다시 설치할 때](#처음부터-다시-설치할-때)
- [변경 이력](#변경-이력)

## 쓰는 법
| 하고 싶은 일 | 방법 |
| --- | --- |
| 영상 보기 | 카드를 누르면 크게 재생. 이전/다음, 끝나면 다음 영상 이어보기 |
| 영상 찾기 | 검색(제목·여행지·태그), 여행지 칩, 연도, 정렬 |
| 영상 올리기 *(관리자)* | **＋ 업로드** → 영상 선택 → 제목·여행지·날짜·태그 입력 → 업로드. 여러 편을 한 번에 올릴 수 있고 길이와 썸네일은 자동으로 만들어짐 |
| 영상 정보 고치기 *(관리자)* | 재생 화면의 **수정** (PC는 카드에 마우스를 올리면 나오는 수정 버튼도 가능) |
| 썸네일 바꾸기 *(관리자)* | 재생 중 원하는 장면에서 **지금 장면을 썸네일로**, 또는 수정 화면에서 이미지 파일 선택 |
| 첫 화면 대표 영상 정하기 *(관리자)* | 수정 → **첫 화면 대표 영상으로 고정**. 고정한 영상이 없으면 가장 최근 여행이 표시됨 |
| 영상 삭제 *(관리자)* | 수정 → **삭제** (영상 파일도 함께 지워지며 되돌릴 수 없음) |

첫 화면 맨 위의 대표 영상은 소리 없이 자동 재생됩니다. PC에서는 카드에 마우스를 올리면 소리 없이 미리보기가 나옵니다.

## 계정과 권한
| 권한 | 할 수 있는 일 |
| --- | --- |
| **관리자** (`admin`) | 보기 + 업로드, 수정, 삭제, 계정 관리 |
| **게스트** (`guest`) | 보기, 검색·필터만 |
| **권한 없음** (`pending`) | 로그인해도 아무것도 볼 수 없음 |

관리자는 **설정**에서 계정을 관리합니다.
- **새 계정 만들기** — 아이디·비밀번호·권한을 정해 바로 만들기
- **권한 바꾸기**, **비밀번호 바꾸기**, **계정 삭제**
- 내 계정의 권한을 내리거나 내 계정을 삭제할 수는 없음 (관리자가 없어지는 것을 방지)

아이디에 `@`가 없으면 `config.js`의 `loginDomain`이 붙습니다 (`guest` → `guest@travel.film`). 실제로 메일을 받을 수 있는 주소가 아니어도 됩니다.

권한은 버튼을 숨기는 것이 아니라 **Supabase DB의 접근 규칙(RLS)** 으로 막습니다. 게스트 계정으로 API를 직접 호출해도 업로드·수정·삭제·권한 변경은 거부되고, 영상 파일은 비공개 저장소에 있어 로그인 없이는 열 수 없습니다.

## 제한
| 항목 | 한도 | 비고 |
| --- | --- | --- |
| 영상 한 편 | **50MB** | Supabase 무료 플랜의 프로젝트 한도. 2분 영상이면 약 3Mbps 이하로 내보내기 |
| 전체 저장 용량 | 약 1GB | 무료 플랜 기준, 50MB 영상 20편 남짓 |
| 영상 형식 | MP4, MOV, WebM | 모든 기기에서 재생되려면 **H.264 + AAC MP4** 권장 |
| 썸네일 | 5MB | JPG, PNG, WebP |

무료 플랜 수치는 바뀔 수 있으니 [Storage 설정](https://supabase.com/dashboard/project/gbjvqjqdetesjhmelnfi/storage/settings)에서 확인하세요. 유료 플랜으로 바꾸면 같은 화면에서 한도를 올릴 수 있고 코드는 바꿀 필요가 없습니다.

용량을 줄여 내보내는 예:
```bash
ffmpeg -i input.mov -c:v libx264 -b:v 3M -vf scale=-2:1080 -c:a aac -b:a 128k -movflags +faststart output.mp4
```

## 자주 가는 Supabase 화면
| 화면 | 용도 |
| --- | --- |
| [SQL Editor](https://supabase.com/dashboard/project/gbjvqjqdetesjhmelnfi/sql/new) | `setup.sql` 실행 |
| [Authentication → Users](https://supabase.com/dashboard/project/gbjvqjqdetesjhmelnfi/auth/users) | 계정 목록 (평소에는 앱의 설정 화면으로 충분) |
| [Storage](https://supabase.com/dashboard/project/gbjvqjqdetesjhmelnfi/storage/buckets) | 올라간 영상(`videos`)·썸네일(`thumbs`) 파일 |
| [Storage 설정](https://supabase.com/dashboard/project/gbjvqjqdetesjhmelnfi/storage/settings) | 업로드 한도 |
| [API Keys](https://supabase.com/dashboard/project/gbjvqjqdetesjhmelnfi/settings/api-keys) | 연결 키 |

## 문제가 생겼을 때
| 증상 | 확인할 것 |
| --- | --- |
| 수정한 내용이 사이트에 안 보임 | 반영까지 1~2분. 새로고침을 두세 번 하거나 주소 끝에 `?v=숫자`를 붙여 열기 |
| 사이트가 404 | [Pages 설정](https://github.com/hyeongu-kwon/test/settings/pages)의 Branch가 `master`인지 확인 |
| "파일이 Supabase 업로드 한도보다 큽니다" | 영상이 50MB를 넘음. 화질·비트레이트를 낮춰 다시 내보내기 |
| 영상이 특정 기기에서 재생 안 됨 | 아이폰 기본(HEVC) MOV는 크롬·안드로이드 일부에서 재생 불가. H.264 MP4로 변환 |
| 대표 영상이 자동 재생 안 됨 | 삼성 인터넷의 동영상 자동 재생 설정, 절전 모드, 휴대폰의 "애니메이션 삭제" 설정 |
| "이 계정은 아직 볼 수 있는 권한이 없어요" | 관리자가 설정에서 그 계정을 게스트로 변경 |
| "계정 관리 기능이 아직 설치되지 않았어요" | 최신 `supabase/setup.sql`을 SQL Editor에서 다시 실행 |
| 관리자 비밀번호를 잊음 | [Users 화면](https://supabase.com/dashboard/project/gbjvqjqdetesjhmelnfi/auth/users)에서 해당 계정의 비밀번호 재설정 |
| 한동안 안 쓰다가 접속이 안 됨 | 무료 프로젝트는 오래 쓰지 않으면 일시 중지될 수 있음. Supabase 대시보드에서 다시 켜기 |

## 수정하고 반영하는 흐름
```
작업 브랜치에서 수정 → PR → master에 Merge → GitHub Pages가 1~2분 안에 자동 반영
```
- 사이트는 **`master` 브랜치**에서 나옵니다. 자산관리 대시보드(저장소 루트)도 같은 브랜치입니다.
- 화면 파일(`style.css`, `config.js`, `app.js`)을 바꾸면 `index.html`의 `?v=숫자`를 함께 올립니다. 브라우저가 예전 파일을 계속 쓰는 것을 막기 위한 것입니다.
- DB 구조나 권한 규칙을 바꾸면 `supabase/setup.sql`을 고치고 **SQL Editor에서 다시 실행**해야 합니다. 이 파일은 여러 번 실행해도 안전하게 만들어져 있습니다.

## 파일 구성
| 파일 | 역할 |
| --- | --- |
| `index.html` | 화면 뼈대 (로그인, 대시보드, 재생·업로드·수정·설정 창) |
| `style.css` | 디자인 |
| `app.js` | 동작 전체 (로그인, 목록, 재생, 업로드, 계정 관리) |
| `config.js` | Supabase 주소와 공개용 `anon` 키, 사이트 이름, 로그인 도메인 |
| `supabase/setup.sql` | 테이블, 권한 규칙, 저장소, 계정 관리 함수 |
| `vendor/supabase.js` | Supabase 클라이언트 라이브러리 v2.119.0 |
| `favicon.svg` | 아이콘 |

`config.js`의 `anon` 키는 공개되어도 되는 키입니다. 접근 제한은 DB의 권한 규칙이 담당합니다. **`service_role`(Secret) 키는 저장소에 절대 넣지 않습니다.**

### DB 구조
| 이름 | 내용 |
| --- | --- |
| `profiles` 테이블 | 계정별 권한 (`admin` / `guest` / `pending`) |
| `videos` 테이블 | 영상 정보 (제목, 설명, 여행지, 날짜, 태그, 대표 여부, 길이, 파일 경로, 조회수) |
| `videos` 저장소 | 영상 파일 (비공개) |
| `thumbs` 저장소 | 썸네일 (비공개) |
| `increment_views` 함수 | 조회수 +1 (게스트도 호출 가능) |
| `admin_create_user` · `admin_set_password` · `admin_delete_user` 함수 | 계정 관리 (관리자만) |

## 처음부터 다시 설치할 때
새 Supabase 프로젝트로 옮기거나 다시 만들 때의 순서입니다.

1. [supabase.com](https://supabase.com)에서 프로젝트를 만듭니다.
2. SQL Editor에 [`supabase/setup.sql`](supabase/setup.sql) 전체를 붙여 넣고 실행합니다.
3. Authentication → Users → Add user → Create new user로 **첫 관리자 계정**을 만듭니다 (Auto Confirm User 체크).
4. SQL Editor에서 그 계정을 관리자로 지정합니다.
   ```sql
   update public.profiles set role = 'admin' where email = '내이메일';
   ```
5. API Keys 화면의 Project URL과 `anon` 키를 [`config.js`](config.js)에 넣습니다.
6. 나머지 계정은 앱의 **설정**에서 만듭니다.

Authentication → Sign In / Providers의 "Allow new users to sign up"은 꺼 두는 것을 권합니다. 켜져 있어도 새 계정은 `권한 없음` 상태라 영상을 볼 수 없습니다.

## 변경 이력
| 날짜 | 내용 |
| --- | --- |
| 2026-11-13 | 자동 재생을 맨 위 대표 영상만 하도록 변경, 카드는 마우스 올림 미리보기 (PR #5) |
| 2026-11-13 | 파일 주소에 버전을 붙여 수정 사항이 바로 반영되게 함 (PR #4) |
| 2026-11-13 | 대표 영상 소리 없이 자동 재생 (PR #3) |
| 2026-11-13 | Supabase 기반으로 전환, 계정별 권한, 앱에서 계정 관리 (PR #2) |
