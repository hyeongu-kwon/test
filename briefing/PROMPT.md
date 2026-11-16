# 자산UP 데일리 브리핑 작성 지침

매일 아침 예약된 Claude 세션이 이 지침대로 브리핑을 만들어 저장소의 `briefing-data` 브랜치에 올립니다.
앱(자산UP 탭)은 `https://raw.githubusercontent.com/hyeongu-kwon/test/briefing-data/briefing.json`을 읽습니다.

## 지켜야 할 것
- **개인 정보는 쓰지 않습니다.** 사용자의 자산·이름·계좌 정보는 이 작업에 필요 없고, 브리핑은 모두에게 같은 공통 내용입니다.
- 웹 검색으로 확인한 사실만 쓰고 출처 URL을 남깁니다. 확인하지 못한 수치는 쓰지 않습니다.
- 전망은 근거와 함께 가능성으로 씁니다. "반드시", "확실히" 같은 표현을 쓰지 않습니다.
- 종목과 지역은 매수·매도 지시가 아니라 **검토 후보**로 쓰고, 근거·확인할 것·위험을 함께 씁니다.
- 검색 결과가 오래된 경우(예: 1주일 이상 전 기사뿐) 그 사실을 `headline` 또는 `outlook`에 밝힙니다.
- `briefing-data` 브랜치의 `briefing.json` 한 파일만 바꿉니다. 다른 브랜치, 다른 파일은 건드리지 않습니다.

## 순서
1. 저장소 준비: `hyeongu-kwon/test`가 없으면 add_repo(push 권한)로 붙이고 clone 합니다.
2. 오늘 날짜(한국 시간)를 확인합니다.
3. 웹 검색(standard)을 6~10회 합니다. 예:
   - 오늘/어제 코스피·코스닥 마감 시황, 외국인 수급
   - 미국 증시 마감(나스닥, S&P500), 주요 실적
   - 한국은행·연준 금리, 원/달러 환율
   - 주목받는 산업 테마(예: 반도체, AI, 2차전지, 조선, 방산 등 그때그때)
   - 한국 부동산: 서울·수도권 아파트 가격 동향, 대출 규제·정책, 공급(분양·입주)
4. 아래 형식으로 `briefing.json`을 씁니다(한국어, 짧고 구체적으로).
5. 검사: `node briefing/validate.mjs <파일>` (master 브랜치에 있는 스크립트). 문제가 나오면 고쳐서 다시 검사합니다.
6. `briefing-data` 브랜치에 커밋하고 push 합니다. 커밋 메시지: `briefing: YYYY-MM-DD`
   - 브랜치는 이력이 없는 별도 브랜치예요: `git fetch origin briefing-data && git worktree add ../briefing-data origin/briefing-data`처럼 따로 꺼내서 작업하세요.
7. 끝나면 날짜, 검색에 쓴 주요 출처, 검사 결과를 한 줄로 보고합니다.

## 형식
```json
{
  "day": "YYYY-MM-DD",
  "generated_at": "ISO 날짜시간",
  "headline": "오늘의 한 줄 요약",
  "market": [{"title": "", "summary": "2~3문장", "source": "https://..."}],
  "trends": [{"theme": "", "why": "", "horizon": "단기|장기"}],
  "stocks": [{"name": "", "ticker": "국내 6자리 코드 | 미국 티커(대문자)", "market": "KR|US", "thesis": "", "catalysts": "", "risks": "", "horizon": "단기|장기", "confidence": "낮음|보통|높음"}],
  "realestate": [{"area": "", "type": "아파트|오피스텔|리츠 등", "thesis": "", "risks": "", "horizon": "단기|장기"}],
  "outlook": "앞으로 1~3개월 시나리오와 확인할 지표",
  "sources": [{"title": "", "url": "https://..."}]
}
```
개수: market 3~6, trends 2~5, stocks 4~6(국내·미국 섞기), realestate 2~4, sources 3개 이상.
