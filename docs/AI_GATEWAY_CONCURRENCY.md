# Cloudflare AI Gateway 동시 다발 요청 - 리스크 분석 보고서

> **작성일**: 2026-05-07
> **대상 프로젝트**: malgn-chatbot (LMS AI 튜터 플랫폼)
> **현재 플랜**: Cloudflare Workers **Paid**
> **주요 사용 모델**: `@cf/google/gemma-3-12b-it` (LLM), `@cf/baai/bge-m3` (Embedding)
> **AI Gateway 설정**: `malgn-chatbot`, `cache_ttl = 3600s`
> **데이터베이스**: **Aurora MySQL** (Cloudflare Hyperdrive 경유 연결 풀링)

---

## 0. 요약 (Executive Summary)

Cloudflare AI Gateway에 동시 요청이 몰릴 때 발생하는 문제는 **8개 카테고리**로 나뉘며, 본 프로젝트 환경에서 실질적 위험은 다음 3가지입니다.

| 우선순위 | 이슈 | 발생 임계점 | 영향 |
|----------|------|-------------|------|
| 🔴 1순위 | **Backend 모델 RPM 초과** (`gemma-3-12b-it` 300 RPM) | 동시 사용자 ~50명 이상 채팅 | `3040` 에러로 사용자 응답 실패 |
| 🔴 2순위 | **Cost 폭증** (Spending Limit 미설정 시) | 트래픽 비례 증가 | 청구액 무제한 폭주 가능 |
| 🟡 3순위 | **Cache Stampede** (캐시 만료 직후 동시 미스) | 동일 질문 동시 폭주 | RPM 한도 즉시 도달 |

**가장 시급한 3가지 조치**:
1. Cloudflare 대시보드에서 **Spending Limit 설정**
2. AI Gateway에 **Retry + Fallback 정책 활성화**
3. AI Gateway Analytics에서 **RPM 사용률 모니터링 시작**

---

## 1. Rate Limiting

Rate Limit는 **두 레이어**에서 별도로 작동합니다.

### 1.1 AI Gateway 레벨 (사용자 설정)

AI Gateway 대시보드에서 게이트웨이 단위로 설정하는 임계값입니다.

| 항목 | 설명 |
|------|------|
| **단위** | requests / minute (또는 hour) |
| **에러 응답** | `429 Too Many Requests` |
| **본 프로젝트 현재 설정** | 미설정 (= 무제한) |

- 게이트웨이 단위로 활성화하면 **모든 backend 호출 전에 차단** → backend RPM/Neuron 보호
- 한 번 차단되면 **현재 윈도우가 끝날 때까지 모든 요청 거부** (점진적 회복 없음)

### 1.2 Backend 모델 레벨 (Cloudflare 고정값)

Workers AI가 모델별로 부과하는 RPM 한도입니다. **Free·Paid 동일**.

| 작업 유형 | RPM | 본 프로젝트 사용 |
|-----------|-----|------------------|
| Text Generation (LLM) - 대부분 | **300 RPM** | ⭐ `gemma-3-12b-it` |
| Mistral 계열 | 400 RPM | (이전 사용) |
| Text Embeddings (BGE) | **1,500 RPM** | ⭐ `bge-m3` |
| Image Classification | 3,000 RPM | - |
| ASR / Image-to-Text | 720 RPM | - |

- 한도 초과 시 응답: **`3040 Capacity Temporarily Exceeded`** 또는 `429`
- **자동 재시도/백오프 없음** → AI Gateway의 Retry 정책 또는 클라이언트 처리 필요
- 본 프로젝트의 1차 병목: **gemma-3-12b-it 300 RPM** (분당 5회/초)

---

## 2. Workers Subrequest 한도

> 2026-02-11부로 기본 한도가 1,000 → 10,000으로 상향됨

### 2.1 한도

| 플랜 | 기본 | 최대 (설정 가능) |
|------|------|------------------|
| Free | 50 / invocation | 변경 불가 |
| **Paid (현재)** | **10,000 / invocation** | **10,000,000** |

`wrangler.toml`에서 환경별로 조정 가능:
```toml
[env.cloud.limits]
subrequests = 50_000
```

### 2.2 카운트 대상

| 카운트 됨 | 카운트 안 됨 |
|-----------|--------------|
| 외부 `fetch()` | Cache API |
| **Hyperdrive 쿼리 (각 1)** ← Aurora MySQL 호출 | 로컬 연산 |
| KV 작업 (get/put/delete 각 1) | 요청 body 읽기 |
| R2 작업 | |
| Vectorize 쿼리 | |
| AI binding 호출 (`env.AI.run()`) | |
| AI Gateway 호출 | |
| Service Bindings | |
| Queue 작업 | |
| 리다이렉트 체인의 각 hop | |

### 2.3 동시 연결 제한 (별도)

> "each Worker invocation can have up to **6 connections simultaneously waiting for response headers**"

- subrequest 총량과 별개의 제약
- `Promise.all()`로 7개 이상 동시 호출 시 **자동 큐잉** (에러는 아님, latency만 증가)
- response header 수신 후 슬롯 즉시 해제 (body 다운로드 중에는 카운트 안 됨)

### 2.4 본 프로젝트 영향

| 작업 | 예상 subrequest |
|------|-----------------|
| 채팅 1회 (Hyperdrive/MySQL + Vectorize + KV + AI + 저장) | ~10 |
| 세션 생성 1회 (콘텐츠 10개 기준) | ~50-60 |

→ 10,000 한도 대비 **0.1~0.6%** 수준. **현재 트래픽에서 사실상 문제 없음.**

⚠️ 단, RAG 단계의 `Promise.all()`이 **7개 이상**이 되면 6개 동시 연결 제한으로 큐잉 → latency 증가.

---

## 3. Cache Stampede

### 3.1 메커니즘

AI Gateway 캐시(현재 `cache_ttl=3600s`)는 동일 요청을 자동 캐싱합니다. 그러나 **캐시 만료 직후 동일 요청이 동시 다발로 들어오면**:

```
T=0:00  : 캐시 만료
T=0:01  : 100개 동시 요청 도착
        → 모두 캐시 미스 → 모두 backend로 전달
T=0:05  : 첫 번째 응답 도착, 캐시 채워짐
        → 그러나 이미 99개는 backend RPM 소비함
```

### 3.2 영향

- backend `gemma-3-12b-it`: 300 RPM 한도 → **100개 동시 미스로 즉시 33% 소진**
- 이후 1분간 다른 사용자 요청도 함께 RPM 한도에 부딪힘
- **Cost**: 캐시될 1개로 충분했던 요청을 100배 결제

### 3.3 본 프로젝트 위험 시나리오

- **강의 시작 직후 학습자 100명 일괄 접속** + 모두 같은 추천 질문 클릭 → 캐시 미스 동시 100건
- 캐시는 결국 채워지지만, **그 순간 backend가 마비**

### 3.4 완화

- AI Gateway는 현재 **Stale-While-Revalidate 패턴 미지원** (2026-05 기준)
- **사전 워밍(pre-warming)**: 인기 질문에 대해 사전 호출로 캐시 채우기
- **부모 세션 학습데이터를 KV에 사전 저장**: 자식 세션 N명 분이 단일 KV read로 처리 (현재 일부 적용)

---

## 4. Workers AI 계정 단위 Quota

### 4.1 Neuron 일일 한도

> Neuron = "GPU compute needed to perform your request" (GPU 연산량 정규화 단위)

| 항목 | 값 |
|------|------|
| **무료 일일 할당량** | **10,000 Neurons / day** (Free·Paid 동일) |
| 초과분 단가 (Paid) | **$0.011 per 1,000 Neurons** |
| 리셋 시각 | **매일 00:00 UTC** (한국 09:00) |
| 초과 시 (Free) | **모든 후속 요청 실패** → 24시간 락다운 |
| 초과 시 (Paid) | **자동 과금** (락다운 없음, Spending Limit 설정 시에만 차단) |

### 4.2 본 프로젝트 모델 단가

`@cf/google/gemma-3-12b-it`:

| 항목 | 단가 |
|------|------|
| Input | **$0.345 / 1M tokens** |
| Output | **$0.556 / 1M tokens** |
| Context window | 80,000 tokens (문서에 따라 128K) |
| 기본 max_tokens | 256 (조절 가능) |

> "The Price in Tokens column is equivalent to the Price in Neurons column"

### 4.3 무료 한도 환산 (10K Neuron)

10,000 Neurons ≈ **$0.11 가치**:

| 작업 유형 | 평균 토큰 | 호출당 비용 | 10K 한도 처리량 |
|-----------|----------|-------------|------------------|
| 채팅 1회 | ~3,500 | $0.0013 | **~85회** |
| 학습데이터 생성 | ~34,000 | $0.012 | **~9회** |
| 퀴즈 생성 | ~5,500 | $0.0022 | **~50회** |

→ **실서비스에서는 무료 한도 = 가벼운 데모 수준**. Paid 플랜에서는 비용으로만 의미.

---

## 5. Cost 폭증

### 5.1 청구 항목 (모두 별도 청구)

1. **Workers Request 요금** ($0.30/1M req, 10M 무료)
2. **Workers AI Neuron 요금** ($0.011/1K Neuron, 10K 무료)
3. **AI Gateway 요금** (현재 무료, 향후 변경 가능)
4. **Aurora MySQL 요금** (AWS — ACU/시간 + 스토리지 + I/O, Cloudflare 청구와 별도)
5. **Hyperdrive 요금** (Workers Paid 포함 무료, 단 캐싱은 별도 정책)
6. **KV / Vectorize / R2 요금** (각각 별도 단가)

### 5.2 본 프로젝트 비용 시뮬레이션

월 트래픽 가정:
- 학습자 100명 × 일일 50 채팅 = 5,000 채팅/일 → **150,000/월**
- 교수자 10명 × 콘텐츠 5개/월 + 세션 생성 = ~250 세션/월 (퀴즈+학습데이터 포함)

| 항목 | 월간 호출 | 월간 비용 (개략) |
|------|-----------|------------------|
| 채팅 (gemma-3-12b-it) | 150,000 | $195 |
| 세션 생성 부가 (학습+퀴즈) | ~5,000 LLM 호출 | $30 |
| Workers Request | ~500,000 | $0 (10M 무료 내) |
| Vectorize / KV | - | ~$5 |
| Aurora MySQL (Serverless v2 가정, 0.5~1 ACU 평균) | - | ~$30-60 (AWS 청구) |
| **월 합계 (예상)** | | **~$260-290** |

### 5.3 위험

- 트래픽이 **10배** 늘면 → **~$2,600-2,900 / 월** (Cloudflare + AWS 합산)
- 봇/어뷰징 트래픽 발생 시 **무제한 폭주 가능** (Spending Limit 미설정 시)
- **Aurora는 AWS 청구**라 Cloudflare Spending Limit으로 막을 수 없음 → AWS Budgets 별도 설정 필요

### 5.4 완화

- **Spending Limit 설정 필수** (대시보드 → Billing)
- **AI Gateway Caching 적극 활용** (캐시 히트는 Neuron 카운트 안 됨)
- **API Key 인증 + Rate Limit** 으로 봇 트래픽 차단

---

## 6. Latency 악화

### 6.1 메커니즘

동시 요청이 backend RPM에 부딪히면 다음 순서로 latency가 악화됩니다:

```
정상       : p95 ~3-5s
부하 시작  : backend 큐잉 발생, p95 ~8-10s
RPM 도달   : 일부 요청 3040 에러, 클라이언트 재시도 → 추가 부하
완전 포화  : AI Gateway timeout(60s) 도달 → 사용자 체감 응답 60s+
```

### 6.2 SSE 스트리밍 특이점

- `/chat/stream` 엔드포인트는 첫 토큰까지 1-3초, 전체 완료까지 5-15초
- 응답이 시작되면 **Worker 인스턴스를 끝까지 점유** → 동시성 부담 증가

### 6.3 본 프로젝트 영향

- 학습자 50명 동시 채팅 시 **p95가 5s → 20s**로 악화 가능
- KaTeX 렌더링/마크다운 후처리는 클라이언트 측이라 무관

---

## 7. Streaming 연결 한도

### 7.1 한도

| 항목 | 한도 |
|------|------|
| Worker 동시 연결 (계정 단위) | ~1,000 |
| Worker invocation 당 동시 fetch (response header 대기) | 6 |
| SSE 연결 timeout (기본) | 100s |

### 7.2 본 프로젝트 영향

- `/chat/stream`이 동시 1,000개 열리면 **신규 요청 거부**
- 학습자 1,000명이 동시에 응답 받는 중이면 도달 가능
- 학습자가 페이지 닫지 않고 그냥 떠나면 **연결이 timeout까지 유지** → 누적 가능

### 7.3 완화

- 클라이언트 측에서 **페이지 unload 시 EventSource.close() 호출** (구현 확인 필요)
- 비활성 사용자 감지 후 서버에서 connection close

---

## 8. CPU Time 한도

### 8.1 한도

| 플랜 | CPU Time / invocation |
|------|------------------------|
| Free | 10ms (Standard) |
| **Paid (현재)** | **30s 최대** (기본 30,000ms) |

> CPU Time = 실제 연산 시간만 카운트. AI Gateway 호출 대기(wall time)는 **CPU Time 아님**.

### 8.2 본 프로젝트 영향

- 평소 CPU Time: ~50-200ms (JSON 파싱, 마크다운 처리, sanitizeResponse 등)
- 동시 요청이 많아도 CPU Time 자체는 영향 없음 (각 invocation 독립)
- ⚠️ 단, **응답 후처리가 무거워지면** (예: 매우 긴 학습 콘텐츠 32K 파싱) 단일 요청도 한도 근접 가능

---

## 8.5 Aurora MySQL + Hyperdrive 동시성 이슈

본 프로젝트는 D1이 아닌 **Aurora MySQL을 Hyperdrive 경유로 사용**합니다. 이 조합은 다음 특이점을 가집니다.

### 8.5.1 Hyperdrive의 역할

- Workers ↔ Aurora 사이의 **연결 풀러 + 쿼리 캐시**
- 매 요청마다 신규 TCP 연결 비용 제거 (콜드 스타트 100-300ms → 5-20ms)
- **read-only 쿼리 결과 캐싱** (선택적, TTL 설정 가능)

### 8.5.2 동시 다발 요청 시 병목

| 레이어 | 한도 | 영향 |
|--------|------|------|
| **Hyperdrive subrequest** | Worker 한도 (10K) 내 | 보통 문제 없음 |
| **Aurora max_connections** | 인스턴스 클래스별 (`db.r6g.large` ≈ 1,000, Serverless v2는 ACU 비례) | **동시 1,000 연결 초과 시 거부** |
| **Aurora ACU 자동 스케일** | 0.5 ~ 설정 max ACU | 부하 증가 시 자동 확장 (수십 초 지연) |
| **slow query** | 모든 환경 | 한 쿼리가 connection을 오래 점유 → 풀 고갈 |

### 8.5.3 본 프로젝트에서 주의할 패턴

1. **세션 생성 시 다중 INSERT** (`TB_SESSION` + `TB_SESSION_CONTENT` × N)
   - 트랜잭션으로 묶이면 connection을 더 오래 점유
   - 학습자 100명 동시 접속 시 connection pool 압박

2. **`status = 1` 필터링이 인덱스 안 타면 풀 스캔**
   - `(parent_id, course_user_id)`, `(session_id, created_at)` 등 인덱스 필수
   - slow query 한 건이 동시 처리량 급감 유발

3. **Hyperdrive 쿼리 캐시는 read-only만**
   - INSERT/UPDATE/DELETE는 캐시 무효
   - 캐시 hit 비율은 GET 위주 엔드포인트에서만 의미 있음

### 8.5.4 모니터링 항목

- **AWS RDS CloudWatch**: `DatabaseConnections`, `CPUUtilization`, `ServerlessDatabaseCapacity` (ACU)
- **Cloudflare Hyperdrive Analytics**: 쿼리 latency, cache hit rate
- **slow query log**: Aurora Performance Insights에서 활성화

### 8.5.5 완화

| 방안 | 효과 |
|------|------|
| Aurora Serverless v2의 **min/max ACU 적절히 설정** | 부하 시 자동 스케일 |
| 자주 조회되는 read 쿼리에 **Hyperdrive caching 활성화** | DB 부하 감소 |
| 빈번한 SELECT의 **인덱스 추가/검증** | slow query 예방 |
| AWS RDS Proxy 추가 도입 검토 (Hyperdrive와 중복일 수 있어 선택) | 연결 풀 강화 |

---

## 9. 시나리오별 영향 분석 (malgn-chatbot)

### 시나리오 A: 강의 시작 직후 학습자 100명 일괄 접속

| 단계 | 발생 이슈 |
|------|-----------|
| 1. 100명이 자식 세션 동시 생성 | Aurora MySQL INSERT 폭주 (Hyperdrive 풀이 과부하 시 connection 대기) |
| 2. 학습데이터/퀴즈 조회 | 부모 세션이 캐시되어 있으면 KV에서 즉시 응답 ✅ |
| 3. 100명이 동시에 첫 채팅 | **gemma-3-12b-it 300 RPM 한도 즉시 도달** 🔴 |
| 4. 사용자 체감 | 일부 "용량 초과" 에러, 나머지 latency 20s+ |

**대응**: AI Gateway Retry 정책으로 자동 백오프 + 단계적 진입 안내 UI

### 시나리오 B: 교수자가 콘텐츠 10개 등록 후 세션 생성

| 단계 | 호출 수 |
|------|---------|
| 학습데이터 생성 (1차) | 1 |
| 답변 보강 (2차) | 1 |
| 4지선다 퀴즈 생성 (10개 콘텐츠) | 10 |
| 4지선다 검증 | 10 |
| OX 퀴즈 생성 | 10 |
| OX 검증 | 10 |
| **합계** | **42 LLM 호출** |

- `waitUntil()`로 백그라운드 처리 → 사용자 응답 지연 없음 ✅
- 단, **교수자 5명이 동시에 작업**하면 **210회/분 → gemma 300 RPM 70% 소진** ⚠️
- 그동안 학습자 채팅이 함께 들어오면 RPM 초과 위험

**대응**: 퀴즈 생성을 **콘텐츠 등록 시점**으로 이동 (현재는 세션 생성 시) → 부하 분산

### 시나리오 C: 동일 질문 1,000명 동시 (Cache Stampede)

| 단계 | 발생 이슈 |
|------|-----------|
| 1. 1,000명이 같은 추천 질문 클릭 | 모두 동일한 prompt + context |
| 2. 캐시 미스 (또는 만료 직후) | 1,000개 모두 backend로 전달 |
| 3. backend 도달 | **gemma 300 RPM 3.3배 초과** → 700개 `3040` 에러 |
| 4. 비용 | 1개로 충분했던 요청을 1,000개 결제 ($1.3) |

**대응**: 인기 질문 사전 워밍 + AI Gateway Retry로 점진적 처리

---

## 10. 권장 완화 방안 (우선순위별)

### 🔴 즉시 적용 (1주 내)

| # | 방안 | 위치 | 효과 |
|---|------|------|------|
| 1 | **Spending Limit 설정** | Cloudflare 대시보드 → Billing | 비용 폭주 차단 |
| 2 | **AI Gateway Retry 정책** (3회, exponential backoff) | AI Gateway 설정 | RPM 초과 자동 복구 |
| 3 | **AI Gateway Real-time Logs 모니터링** | Analytics 탭 | 임계점 조기 감지 |

### 🟡 단기 적용 (1개월 내)

| # | 방안 | 위치 | 효과 |
|---|------|------|------|
| 4 | **퀴즈 생성을 콘텐츠 등록 시점으로 이동** | `contentService.js`, `quizService.js` | 세션 생성 시 부하 분산 |
| 5 | **AI Gateway Fallback 모델 설정** | AI Gateway 설정 | 1차 모델 RPM 초과 시 다른 모델로 |
| 6 | **Spending Limit 알림 webhook** | 대시보드 | 한도 80% 도달 시 알림 |
| 7 | **인기 질문 사전 워밍 스크립트** | `scripts/warm-cache.js` (신규) | Cache stampede 방지 |

### 🟢 중장기 적용 (3개월 내)

| # | 방안 | 위치 | 효과 |
|---|------|------|------|
| 8 | **퀴즈/학습데이터 생성을 Cloudflare Queue로 분산** | `wrangler.toml`, 신규 consumer Worker | 1분 폭주를 N분에 분산 |
| 9 | **부모 세션 학습데이터 KV 사전 저장 강화** | `learningService.js`, `chatService.js` | 자식 세션 N명을 단일 KV read로 |
| 10 | **API Key 인증 + 사용자별 Rate Limit** | `middleware/auth.js`, `middleware/rateLimit.js` (신규) | 봇/어뷰징 차단 |
| 11 | **OpenTelemetry / Sentry 통합** | `src/observability/` (신규) | 정밀 latency 분석 |

---

## 11. 모니터링 체크리스트

다음 메트릭을 **AI Gateway Analytics**에서 정기 확인:

- [ ] **Requests / min** (gemma-3-12b-it) — 임계: 240 RPM (80% 한도)
- [ ] **Cache Hit Rate** — 목표: 30%+ (현재 측정 필요)
- [ ] **Error Rate** (3040, 429, 5xx) — 임계: 1%
- [ ] **p95 Latency** — 임계: 8s
- [ ] **Daily Neuron Usage** — 임계: Spending Limit 80%
- [ ] **Fallback 발동 횟수** (설정 후)

---

## 갱신 이력

| 일자 | 변경 내용 |
|------|-----------|
| 2026-05-07 | 최초 작성 — Cloudflare AI Gateway/Workers AI/Workers 동시성 리스크 8개 카테고리 통합 분석 |
| 2026-05-07 | DB를 D1에서 **Aurora MySQL (Hyperdrive 경유)** 로 정정. 8.5절 신설 (Aurora+Hyperdrive 동시성 이슈), 비용 시뮬레이션에 AWS Aurora 청구 추가 |

---

## Sources

- [Workers AI Pricing · Cloudflare docs](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Workers AI Limits · Cloudflare docs](https://developers.cloudflare.com/workers-ai/platform/limits/)
- [Workers Platform Limits · Cloudflare docs](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers no longer limited to 1000 subrequests · Changelog (2026-02-11)](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/)
- [Gemma-3-12b-it Model · Cloudflare docs](https://developers.cloudflare.com/workers-ai/models/gemma-3-12b-it/)
- [AI Gateway · Cloudflare docs](https://developers.cloudflare.com/ai-gateway/)
