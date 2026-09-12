# Social Memory

> 상태: 코어 MVP 구현 · fixture 전용 · 실제 X/Threads 커넥터는 아직 미포함

Social Memory는 SNS에서 반응하거나 저장한 자료를 로컬에 보존하고, 이미 구독 중인 에이전트형 LLM에서 다시 찾게 하는 오픈소스 지식 브리지입니다. 코어는 수집 이력, 원문 Evidence, 검색을 소유하고 분류·요약·아이디어 합성은 연결된 LLM이 담당합니다.

## 가장 중요한 원칙

`좋아요`와 `저장하기`는 같은 행동이 아닙니다.

| 사용자 행동 | canonical kind | 플랫폼 원래 이름 예시 |
| --- | --- | --- |
| 좋아요 | `like` | `favorite`, `like` |
| 저장/북마크 | `save` | `bookmark`, `saved` |
| 리포스트 | `repost` | `repost` |
| 직접 가져오기 | `manual` | `manual` |

계정 설정 때 수집할 종류를 명시적으로 선택해야 합니다. 같은 게시물을 좋아요하고 저장했다면 Source는 하나지만 Capture는 `like`, `save` 두 개입니다. 나중에 설정에서 `save`를 빼도 이미 수집된 저장 기록은 삭제되지 않습니다.

## 지금 작동하는 범위

- Node.js 내장 SQLite 기반 로컬 라이브러리
- Source/Capture/Evidence 분리 및 중복 제거
- SHA-256 기반 로컬 파일 Evidence 보관
- 계정별 수집 종류와 종류별 독립 커서
- FTS5 본문·작성자·URL·Evidence 검색
- CLI
- 읽기 전용 MCP 도구 4개
- 네트워크를 사용하지 않는 합성 fixture 커넥터

실제 X/Threads 로그인과 수집, OCR/PDF/영상 추출, 스케줄러, 설치형 Skill, 기존 개인 DB 마이그레이션은 후속 단계입니다. fixture 성공은 실계정 수집 성공을 뜻하지 않습니다.

## 요구 사항

- macOS 우선 검증
- Node.js 22.5 이상
- 데이터용 절대경로
- 프로덕션 의존성 없음

## 로컬 첫 실행

```bash
git clone <repository-url> social-memory
cd social-memory
npm test

export SOCIAL_MEMORY_DATA_DIR="/absolute/path/to/social-memory-data"
node src/cli.mjs init --data-dir "$SOCIAL_MEMORY_DATA_DIR" --json
node src/cli.mjs connector list --json
node src/cli.mjs connector configure fixture \
  --account fictional_reader \
  --include like,save \
  --json
node src/cli.mjs sync --json
```

종류별 검색:

```bash
node src/cli.mjs search "fixture" --kind like --json
node src/cli.mjs search "fixture" --kind save --json
```

두 검색은 같은 Source를 찾을 수 있지만 Capture provenance는 서로 구별됩니다.

## CLI

```text
social-memory init --data-dir <absolute-path>
social-memory connector list [--json]
social-memory connector configure <connector> --account <identity> --include <like,save,repost> [--json]
social-memory connector status [--json]
social-memory sync [--connector <id>] [--account <local-id>] [--kind <kind>] [--limit <n>] [--json]
social-memory search <query> [--kind <kind>] [--connector <id>] [--since <ISO-date>] [--limit <n>] [--json]
social-memory source <local-id> [--json]
social-memory health [--json]
social-memory mcp
```

## 에이전트형 LLM에서 사용

MCP 클라이언트에는 이 저장소의 절대경로와 데이터 디렉터리를 사용해 아래와 같은 서버 명령을 등록합니다.

```json
{
  "command": "node",
  "args": ["/absolute/path/to/social-memory/src/cli.mjs", "mcp"],
  "env": {
    "SOCIAL_MEMORY_DATA_DIR": "/absolute/path/to/social-memory-data"
  }
}
```

노출되는 도구는 다음 네 개뿐입니다.

- `search_sources`: 문장/키워드 검색과 connector/account/kind/date 필터
- `get_source`: Source의 모든 Capture와 Evidence 확인
- `list_capture_kinds`: 표준 수집 종류 확인
- `get_health`: 로컬 DB 상태와 개수 확인

예시 요청:

- “저장한 것 중 가격 정책과 관련된 근거를 찾아줘.”
- “좋아요한 것과 북마크한 것을 나눠서 공통 아이디어를 비교해줘.”
- “최근 자료에서 웹툰 시나리오에 전용할 수 있는 패턴을 뽑되 출처를 붙여줘.”

고급 분류와 합성은 LLM이 수행합니다. Social Memory가 반환한 원문/근거와 LLM의 추론은 답변에서 구별해야 합니다.

Claude Code와 Codex 같은 로컬 에이전트 환경이 초기 대상입니다. ChatGPT가 로컬 stdio MCP 서버에 직접 연결된다고 가정하지 않습니다. 원격 브리지는 별도 보안 설계가 필요한 후속 범위입니다.

## 개인정보와 계정 보안

- 비밀번호, OTP, 쿠키, 액세스 토큰을 config나 DB에 넣지 않습니다.
- 런타임 데이터는 저장소 밖의 사용자가 고른 절대경로에 둡니다.
- 데이터 디렉터리는 `0700`, config와 DB는 `0600`으로 초기화합니다.
- MCP는 읽기 전용이며 동기화나 계정 설정 도구를 노출하지 않습니다.
- 실계정 커넥터는 나중에도 격리된 브라우저 프로필/OAuth/OS 자격 증명 저장소를 사용해야 합니다.

## 구조

```text
src/config.mjs              개인 데이터 경로와 초기화
src/schema.sql              SQLite/FTS 스키마
src/accounts.mjs            계정별 수집 종류 설정
src/ingest.mjs              Source/Capture/Evidence 수집
src/evidence-store.mjs      SHA-256 파일 저장소
src/sync.mjs                계정·종류별 동기화 격리
src/search.mjs              FTS 및 정확 필터
src/cli.mjs                 CLI 진입점
src/mcp.mjs                 읽기 전용 stdio MCP
src/connectors/fixture.mjs  오프라인 합성 커넥터
```

제품 설계는 `docs/superpowers/specs/2026-09-13-social-memory-mvp-design.md`, 실행 계획은 `docs/superpowers/plans/2026-09-13-social-memory-core.md`에 있습니다.

## 공개 전 남은 결정

라이선스는 아직 선택하지 않았습니다. 후보는 단일 AGPL-3.0 또는 AGPL 코어와 permissive connector SDK의 분리입니다. 라이선스와 기여 정책을 정하기 전에는 공개 저장소로 푸시하지 않습니다.
