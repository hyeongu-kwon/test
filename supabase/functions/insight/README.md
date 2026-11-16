# AI 데일리 브리핑 함수 (insight) · 유료 대안

> **현재 앱은 이 함수를 쓰지 않아요.** 브리핑은 매일 예약된 Claude 세션이 무료로 만들어 `briefing-data` 브랜치에 올립니다([`briefing/PROMPT.md`](../../../briefing/PROMPT.md)).
> 이 함수는 Anthropic API 키(유료)로 서버에서 직접 만들고 싶을 때 쓸 수 있는 대안으로 남겨 둔 것이에요.

자산UP 탭의 **AI 데일리 브리핑(주식 · 부동산)**을 만드는 서버 함수예요.
하루에 한 번(한국 시간) Claude가 웹 검색으로 최근 뉴스를 찾아 정리하고, 결과를 `briefings` 테이블에 저장해 모든 사용자가 같이 씁니다.

- **개인 자산 정보는 이 함수로 보내지 않아요.** 브리핑은 공통 내용이고, "보유 중" 표시 같은 개인화는 앱(기기) 안에서 해요.
- 모델: Claude Opus 5.5 (`claude-opus-5-5`) + 웹 검색 도구. 안전 정책상 답변이 거절되면 다른 모델로 자동 재시도(`fallbacks: "default"`)해요.
- 하루 첫 요청이 들어오면 백그라운드에서 만들기 시작하고(보통 1~3분), 그동안에는 가장 최근 브리핑을 보여줘요. 실패하면 30분 뒤 다시 시도해요.

## 설정 방법 (한 번만)

### 1. 저장 테이블 만들기
Supabase 대시보드 → **SQL Editor** → [`supabase/insight.sql`](../../insight.sql) 내용 전체를 붙여넣고 **Run**.

### 2. Anthropic API 키 등록 (비밀 값)
1. [console.anthropic.com](https://console.anthropic.com) → **API Keys** → **Create Key**로 키를 만듭니다. 결제 수단(크레딧)이 등록돼 있어야 해요.
2. Supabase 대시보드 → **Edge Functions** → **Secrets** (또는 Project Settings → Edge Functions) → **Add new secret**
   - Name: `ANTHROPIC_API_KEY`
   - Value: 방금 만든 키
3. **키는 채팅, 코드, GitHub 어디에도 붙여넣지 마세요.** 이 화면에만 넣으면 돼요.

### 3. 함수 배포
1. Supabase 대시보드 → **Edge Functions** → **Deploy a new function** → **Via Editor**
2. 이름: **`insight`**
3. 기본 코드를 지우고 [`index.ts`](index.ts) 내용 전체를 붙여넣기 → **Deploy function**
4. **Verify JWT** 옵션은 켠 채로 두세요 (앱이 공개 키로 호출해요).

배포 후 앱의 자산UP 탭을 열면 "오늘 브리핑을 만드는 중이에요"가 나오고, 1~3분 뒤 **새로 고침**을 누르면 브리핑이 보여요.

## 비용 (대략)
하루 1회 생성 기준, 웹 검색 최대 8회와 Opus 5.5 사용으로 **하루 약 $0.3~0.6, 한 달 약 $10~20** 수준으로 예상해요.
뉴스 양에 따라 달라지니 Anthropic Console의 Usage 화면에서 실제 사용량을 확인하세요. 사용자 수와 관계없이 하루 한 번만 만들어요.

## 문제가 생기면
- 앱에 "함수가 아직 배포되지 않았어요": 3번 배포를 확인하세요.
- 계속 "만들지 못했어요": Edge Functions → `insight` → **Logs**에서 오류를 확인하세요. API 키, 크레딧 잔액, 함수 실행 시간 제한이 흔한 원인이에요.
- 함수 실행 시간 제한에 걸리면 `index.ts`의 `max_uses`(검색 횟수)를 줄이면 빨라져요.

## 주의
AI가 공개 뉴스로 만든 참고 정보예요. 투자 권유가 아니며, 전망은 틀릴 수 있어요.
