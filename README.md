# Year-End-Random-Matching

2027년 새해 목표를 무작위로 배정하고 참여자가 직접 설정한 닉네임으로 표시하는 단일 행사 선물 교환 웹 서비스.

현재 단계: 구현 완료, 로컬 검증 완료, 운영 배포 전.

- 배포: Cloudflare Workers + Static Assets (화면과 `/api/*` 를 같은 주소에서 제공)
- 저장: Cloudflare D1 (개발용 로컬 DB와 운영 DB 분리)
- 참여자 표시: 직접 설정한 닉네임, 매칭 후 상대 닉네임 확인
- 관리자 기능: 참석자 명단·인원 설정, 제출 현황, 매칭 운영, 종료 후 결과 공개, 데이터 삭제
- [설계 문서](docs/design.md) · [개발 요청 프롬프트](docs/claude-development-prompt.md)
- 사용 안내: [관리자](docs/admin-guide.md) · [참여자](docs/participant-guide.md)

## 구성

| 경로 | 내용 |
|---|---|
| `src/client/` | React + TypeScript 화면 (`/`, `/join`, `/access`, `/me`, `/results`, `/admin`) |
| `src/worker/` | Worker API, 인증, 매칭(`matching.ts` 계산, `matchService.ts` 원자적 저장), 매분 Cron 복구 |
| `src/shared/` | 화면·서버 공용 입력 규칙(길이·정규화·시간 변환)과 API 타입 |
| `migrations/` | D1 SQL 마이그레이션 |
| `test/` | workerd + 로컬 D1 위에서 실제 Worker 를 실행하는 자동화 테스트 |
| `scripts/` | 비밀번호 검증 값 생성, 로컬 secret 생성, 로컬 DB 초기화, 테스트 명단 |

## 로컬 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
```

```bash
npm run setup:local
```

`setup:local` 은 `.dev.vars` 에 무작위 `SESSION_SECRET` 과 로컬 관리자 비밀번호의 검증 값을 만들고, **로컬 관리자 비밀번호를 이때 한 번만 출력**합니다. 잊었다면 `npm run setup:local -- --force` 로 다시 만듭니다. `.dev.vars` 는 저장소에 올라가지 않습니다.

```bash
npm run dev
```

`dev` 는 화면 빌드 → 로컬 D1 마이그레이션 → `wrangler dev` 순으로 실행합니다.

- 참여 화면: http://localhost:8787/
- 관리자 화면: http://localhost:8787/admin

테스트 명단 6명을 넣으려면(SETUP 상태의 로컬 DB 에만 적용):

```bash
npm run db:seed:local
```

이후 `/admin` 에서 행사명·마감·예산을 저장하고 ‘참여 시작’을 누르면 `/join` 에서 등록할 수 있습니다. 참여자 쿠키는 브라우저당 하나이므로, 여러 참여자를 한 브라우저로 시험할 때는 ‘이 기기에서 나가기’ 후 다음 사람을 등록하거나 시크릿 창을 사용하세요.

로컬 DB 를 처음 상태로 되돌리기(데이터 삭제까지 시험한 뒤 다시 시작할 때):

```bash
npm run db:reset:local
```

화면을 수정하며 볼 때는 터미널 두 개에서 `npm run build:watch` 와 `npm run dev:worker` 를 실행합니다.

## 검증

```bash
npm run check
```

타입 검사, 테스트, 프로덕션 빌드를 차례로 실행합니다. 테스트(`npm test`)는 `@cloudflare/vitest-plugin` 으로 workerd 런타임과 로컬 D1 에 운영과 같은 마이그레이션을 적용한 뒤 실제 `fetch`/`scheduled` 핸들러를 호출합니다.

| 파일 | 확인 내용 |
|---|---|
| `test/matching.test.ts` | 2~99명 1:1·자기 배정 없음·단일 사이클·번호 유일성, 99명 실제 저장, 입력 규칙 |
| `test/flow.test.ts` | 관리자 설정, 등록·닉네임·목표, 확정 후 수정 차단, 마감·상태 제한, 수동 매칭, 종료·공개 |
| `test/concurrency.test.ts` | 동시 제출, 동일 이름·닉네임 동시 등록, 제출과 명단 변경 경합, batch 롤백과 Cron 복구, 열람과 재매칭 경합 |
| `test/security.test.ts` | 인증·권한, Origin/CSRF, 로그인 시도 제한, 응답 필드 제한, 코드 재발급, 삭제 후 차단 |

## 관리자 초기 설정

1. 운영자가 secret 두 개를 등록합니다(아래 ‘운영 배포’ 3단계).
2. `/admin` 에서 관리자 비밀번호로 로그인합니다.
3. 행사명, 목표 작성 마감(한국 시각), 예산 안내를 저장합니다.
4. 참석자 명단을 한 명씩 또는 줄바꿈 목록으로 추가합니다. **참석 인원은 활성 명단의 이름 수**로 계산됩니다(2~99명). 동명이인은 ‘민수 A’, ‘민수 B’처럼 구분합니다.
5. **참여 비밀번호**를 발급합니다. ‘미발급자 전원 참여 비밀번호 발급’ 또는 사람별 ‘참여 비밀번호 발급’을 누르면 사람마다 무작위 8자리가 만들어지고 **발급 직후 한 번만** 표시됩니다(‘전체 복사’ 가능). 각자에게 본인의 비밀번호만 직접 전달합니다.
6. ‘참여 시작’을 누르고 화면에 표시되는 참여 링크를 공유합니다. 참여자는 명단에서 이름을 고르고 전달받은 참여 비밀번호를 입력해야 등록됩니다.

참여 비밀번호는 등록에 한 번 쓰이면 폐기됩니다. 잃어버렸거나 등록 초기화 후 다시 등록해야 하면 ‘참여 비밀번호 재발급’으로 새로 발급합니다(이전 값은 즉시 무효). 서버에는 원문이 저장되지 않아 발급 후에는 관리자도 다시 조회할 수 없습니다. 등록 후 재접속에는 등록 때 받은 16자리 접속 코드를 사용합니다.

진행 중 운영: 미등록 이름 변경, 제외/복원, 등록 초기화, 확정 해제, 접속 코드 재발급, 마감 연장(행사 설정에서 마감 수정), 마감 후 ‘미확정자 제외 후 매칭’, 아무도 열람하지 않았을 때 재매칭, 행사 종료, 전체 결과 공개(취소 불가), 데이터 삭제, 삭제 후 새 행사 준비. 제외한 이름은 ‘삭제’로 목록에서 완전히 지울 수 있습니다.

관리자 화면에는 목표 내용·선물 번호·배정 상대가 표시되지 않으며, 공개 전에는 관리자도 전체 매칭을 볼 수 없습니다. 다만 Cloudflare 계정·D1 관리 권한자는 DB 를 직접 읽을 수 있으므로, 웹 관리자 권한과 인프라 운영자 권한은 다르다는 점을 참여자에게 안내하세요.

## 운영 배포

아래 명령은 실제 Cloudflare 계정에서 실행합니다. **아직 실행하지 않았으며 발급된 주소도 없습니다.**

1. 로그인

   ```bash
   npx wrangler login
   ```

2. 운영 D1 생성 후, 출력된 `database_id` 를 `wrangler.jsonc` 의 `env.production.d1_databases[0].database_id` 에 넣습니다(`REPLACE_WITH_PRODUCTION_D1_DATABASE_ID` 교체).

   ```bash
   npx wrangler d1 create gift-exchange-prod
   ```

3. 운영 DB 에 마이그레이션 적용

   ```bash
   npm run db:migrate:prod
   ```

4. secret 등록. 비밀번호 검증 값은 아래 도구로 만듭니다(비밀번호는 화면에 표시되지 않고 12자 이상이어야 합니다).

   ```bash
   npm run hash-password
   ```

   출력된 `pbkdf2-sha256:...` 값을 붙여 넣습니다.

   ```bash
   npx wrangler secret put ADMIN_PASSWORD_HASH --env production
   ```

   `SESSION_SECRET` 에는 32바이트 이상의 무작위 값을 넣습니다.

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   ```bash
   npx wrangler secret put SESSION_SECRET --env production
   ```

   Worker 가 아직 없어 secret 등록이 거부되면 5단계를 먼저 실행한 뒤 등록합니다. secret 이 없는 동안 API 는 503 을 반환합니다.

5. 배포 (사전 확인은 `npm run deploy:dry`)

   ```bash
   npm run deploy:prod
   ```

6. 주소 확인. `deploy:prod` 출력의 `https://gift-exchange.<계정 서브도메인>.workers.dev` 가 서비스 주소입니다.
   - 참여 링크: `<서비스 주소>/`
   - 관리자: `<서비스 주소>/admin`
   - 배포 후 Cloudflare 대시보드의 Worker → Settings → Triggers 에서 Cron `* * * * *` 이 등록됐는지 확인합니다.

코드를 수정해 다시 배포할 때는 `migrations/` 에 새 파일이 있으면 `npm run db:migrate:prod` 를 **먼저** 실행한 뒤 `npm run deploy:prod` 를 실행합니다.

운영 secret 과 로컬 `.dev.vars` 는 서로 다른 값을 사용하고, 운영 비밀번호를 저장소·채팅에 남기지 않습니다.

## 종료 후 데이터 삭제

- 기한: 결과를 공개했다면 공개일, 공개하지 않았다면 종료일로부터 **7일 이내**. 관리자 화면에 기한이 표시됩니다(자동 삭제는 하지 않습니다).
- 방법: `/admin` → 행사 종료(CLOSED) 상태에서 ‘데이터 삭제’ → 행사명을 그대로 입력해 확인.
- 삭제 범위: 배정, 선물 번호, 참여자(닉네임·목표·접속 코드 해시), 명단, 참여자 세션, 로그인 시도 기록, 행사명·예산·마감. 행사는 `DELETED` 상태가 되어 이후 등록·조회·재매칭·공개·복구 매칭이 모두 거부됩니다.
- 삭제 후 **D1 Time Travel 로 과거 시점을 복원하지 마세요.** 앱에서 지운 데이터도 플랫폼 복구 이력에는 보관 기간(무료 플랜 7일) 동안 남습니다.
- 삭제한 데이터는 되돌릴 수 없습니다. 다음 행사는 삭제 후 `/admin` 의 ‘새 행사 준비’로 엽니다. 빈 상태의 ‘준비 중’ 단계에서 행사명·마감·명단을 다시 설정하며, 이전 행사의 접속 코드·세션·닉네임은 이어지지 않습니다. 참여 링크와 관리자 비밀번호는 그대로입니다. (한 번에 하나의 행사만 진행할 수 있고, 이전 행사를 삭제해야 다음 행사를 열 수 있습니다.)

## 구현 메모와 제약

- **교환 방식 해석**: 원문 기획서(`gift-exchange-plan (1).md`)가 저장소에 없어, 선물 번호는 “참여자마다 하나씩 받고, 산타가 받는 분의 번호를 선물에 적으며, 받는 사람은 자기 번호가 적힌 선물을 찾아가는” 방식으로 구현했습니다. 원문과 다르면 `src/client/components.tsx` 의 `ExchangeGuide` 문구를 고치면 됩니다.
- **관리자 변경과 `revision`**: 명단 추가·변경·제외, 초기화, 확정 해제, 참여 시작, 수동 매칭은 관리자 화면이 본 `revision` 과 현재 값이 같을 때만 반영됩니다. 그 사이 누군가 등록·제출했다면 409 로 거부되고 화면이 새 현황을 보여 줍니다.
- **비밀번호 검증 비용**: PBKDF2-SHA256 100,000회(Workers 런타임 상한)를 사용합니다. 무료 플랜의 CPU 한도에서 실제로 통과하는지는 계정에 배포해야 측정할 수 있어 **검증하지 못했습니다.** 배포 후 `/admin` 로그인이 오류(1102)로 실패하면 `npm run hash-password -- --iterations=50000` 처럼 반복 횟수를 낮춘 값으로 secret 을 다시 등록하고, 비밀번호는 무작위 20자 이상으로 정하세요.
- **로그인 시도 제한**: 참여 비밀번호와 접속 코드는 각각 IP 당 10분에 10회 실패 시 10분, 관리자 로그인은 IP 당 10분에 5회 실패 시 15분(전체 100회 실패 시 5분) 차단합니다. IP 는 secret 기반 해시로만 저장합니다. 값은 `src/worker/auth.ts` 의 `RATE_RULES` 에 있습니다.
- **D1 무료 한도**: 요청당 쿼리 50개·문장당 바인딩 100개 제한 안에서 동작하도록 번호·배정은 JSON 입력 집합 SQL 로 저장합니다(99명 저장 테스트 포함).
- **로컬에서 검증하지 못한 항목**: 실제 Cloudflare 환경의 Cron 실행 주기(테스트는 `scheduled` 핸들러를 직접 호출), 운영 D1 의 지연·재시도 동작, 위의 PBKDF2 CPU 비용, 재배포 전후 결과 유지(D1 에 영구 저장되므로 유지되지만 실제 재배포로 확인하지는 않음).
