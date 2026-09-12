# Social Memory

> 상태: 배포 후보 개발 중 · 범용 import, 공식 X API, Aside 기반 Threads 커넥터 포함

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
- 해시 검증 백업/새 경로 복원
- 수동 성공 영수증으로 잠긴 macOS LaunchAgent 스케줄러
- Codex/Claude Code용 Skill과 MCP 설정 생성기
- 네트워크를 사용하지 않는 합성 fixture 커넥터
- 공식 X API 커넥터의 오프라인 검증 계약
- 전용 Aside 프로필을 사용하는 X 브라우저 커넥터
- 전용 Aside 프로필을 사용하는 Threads 좋아요·저장·리포스트 커넥터

X/Threads 브라우저 커넥터는 전용 프로필에서 설정한 핸들과 실제 로그인 핸들이 일치할 때만 읽습니다. 현재 개발 환경에서 두 플랫폼의 좋아요·저장·리포스트를 각각 3건씩 bounded probe했지만, 이는 다른 계정·언어·향후 DOM에서도 계속 작동한다는 보장은 아닙니다. 공식 X API 커넥터의 실계정 probe, OCR/PDF/영상 본문 추출, 기존 개인 DB 마이그레이션은 아직 남아 있습니다.

## 요구 사항

- macOS 우선 검증
- Node.js 22.16 이상
- 데이터용 절대경로
- 프로덕션 의존성 없음

## 로컬 첫 실행

```bash
git clone https://github.com/ohmyjiro/social-memory.git
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
node src/cli.mjs doctor --json
```

실데이터 JSON 가져오기:

```bash
node src/cli.mjs import \
  --file "/absolute/path/to/export.json" \
  --account my_archive \
  --include like,save \
  --json
```

입력 형식은 `schemas/capture-export-v1.schema.json`에 정의되어 있고, 실행 가능한 합성 예시는 `examples/import.v1.json`에 있습니다. Evidence 파일 경로는 export JSON이 있는 디렉터리 아래의 상대경로만 허용합니다.

## X 공식 API 커넥터

X 커넥터는 사용자 OAuth access token을 환경변수 또는 macOS Keychain에서 읽습니다. DB에는 토큰 값이 아니라 환경변수 이름이나 Keychain 항목 참조만 저장합니다. 좋아요와 북마크는 각각 X의 별도 공식 엔드포인트에서 수집됩니다.

```bash
export X_TOKEN_READER="<OAuth user access token>"

social-memory connector configure x \
  --account reader_handle \
  --include like,save \
  --credential-env X_TOKEN_READER \
  --json

social-memory sync --connector x --json
```

자동 실행에는 셸 환경변수가 안정적으로 전달되지 않으므로 macOS Keychain 참조를 사용합니다. 토큰을 먼저 Keychain에 넣은 뒤 서비스명과 계정명만 저장합니다.

```bash
security add-generic-password \
  -U -s social-memory.x -a reader_handle -w '<OAuth user access token>'

social-memory connector configure x \
  --account reader_handle \
  --include like,save \
  --keychain-service social-memory.x \
  --keychain-user reader_handle \
  --json
```

필요한 OAuth 범위에는 `tweet.read`, `users.read`, `like.read`, `bookmark.read`가 포함됩니다. X API는 현재 pay-per-use이므로 개발자 앱 승인, 권한, 사용 비용을 사용자가 별도로 확인해야 합니다. 이 저장소에서는 아직 실제 계정 호출을 완료했다고 주장하지 않습니다.

### X Aside 브라우저 대안

X 개발자 API 없이 로컬 브라우저 로그인으로 수집하려면 `x-aside`를 선택할 수 있습니다. 계정 전용 Aside 프로필이 필요하며 API 방식과 동시에 같은 계정을 구성하면 Source가 커넥터별로 중복될 수 있으므로 둘 중 하나만 선택하는 것이 좋습니다.

```bash
social-memory connector configure x-aside \
  --account reader_handle \
  --profile-ref x-reader \
  --include like,save,repost \
  --json

social-memory sync --connector x-aside --kind save --limit 3 --json
```

북마크는 Aside의 구조화된 Twitter 읽기 경로를, 좋아요와 리포스트는 제한된 UI 탐색을 사용합니다. 로그인 불일치나 필수 landmark 손실은 `account_mismatch` 또는 `connector_drift`로 실패합니다.

## Threads 격리 브라우저 커넥터

Threads의 좋아요/저장 목록을 읽는 검증된 공식 API 계약이 없어, 이 커넥터는 로컬 Aside 브라우저의 전용 프로필을 사용합니다. `--profile-ref`에는 해당 Threads 계정만 로그인된 Aside 프로필 ID를 지정합니다. 비밀번호·쿠키는 Social Memory로 복사되지 않습니다.

```bash
social-memory connector configure threads \
  --account reader_handle \
  --profile-ref threads-reader \
  --include like,save,repost \
  --json

# 처음에는 반드시 한 종류와 작은 limit로 수동 검증
social-memory sync --connector threads --kind save --limit 3 --json
social-memory connector status --json
```

동기화 전마다 프로필 화면의 실제 로그인 핸들을 읽어 설정 핸들과 대조합니다. 불일치하면 모든 선택 화면을 읽기 전에 `account_mismatch`로 중단합니다. 화면의 필수 랜드마크가 사라지면 성공한 빈 수집으로 처리하지 않고 `connector_drift`로 실패하며, 해당 종류의 커서는 전진하지 않습니다.

## 백업, 복원, 자동 실행

백업은 실행 중인 SQLite 연결에서 일관성 있는 snapshot을 만들고 DB와 Evidence 객체의 SHA-256을 manifest에 기록합니다. 복원은 모든 해시를 확인한 뒤 기존 경로를 덮어쓰지 않고 새 데이터 경로에만 생성합니다.

```bash
social-memory backup create --output "/absolute/path/to/backup-2026-09-13" --json
social-memory backup restore \
  --from "/absolute/path/to/backup-2026-09-13" \
  --data-dir "/absolute/path/to/restored-library" \
  --json
social-memory upgrade --json
```

스케줄러는 현재 선택된 모든 계정×종류 조합이 같은 인증 계정으로 수동 동기화에 성공한 뒤에만 설치됩니다. X 계정은 Keychain 방식이어야 합니다.

```bash
social-memory schedule readiness --json
social-memory schedule install --interval-minutes 1440 --json
social-memory schedule status --json
social-memory schedule uninstall --json
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
social-memory doctor [--json]
social-memory upgrade [--json]
social-memory backup create --output <absolute-directory> [--json]
social-memory backup restore --from <absolute-directory> --data-dir <absolute-path> [--json]
social-memory import --file <absolute-json> --account <identity> --include <like,save,repost> [--json]
social-memory connector list [--json]
social-memory connector configure <connector> --account <identity> --include <like,save,repost> [--profile-ref <id>] [--credential-env <name> | --keychain-service <name> --keychain-user <name>] [--json]
social-memory connector status [--json]
social-memory schedule readiness [--json]
social-memory schedule install --interval-minutes <n> [--json]
social-memory schedule status [--json]
social-memory schedule uninstall [--json]
social-memory agent scaffold --client codex|claude --output <absolute-directory> [--json]
social-memory sync [--connector <id>] [--account <local-id>] [--kind <kind>] [--limit <n>] [--json]
social-memory search <query> [--kind <kind>] [--connector <id>] [--since <ISO-date>] [--limit <n>] [--json]
social-memory source <local-id> [--json]
social-memory health [--json]
social-memory mcp
```

## 에이전트형 LLM에서 사용

설치할 Skill과 현재 절대경로가 반영된 MCP 설정을 한 번에 생성할 수 있습니다.

```bash
social-memory agent scaffold \
  --client codex \
  --output "/absolute/path/to/codex-social-memory-setup" \
  --json
```

생성 디렉터리의 `INSTALL.md`를 따라 Skill을 복사하고 MCP 설정을 기존 설정에 병합합니다. Claude Code는 `--client claude`를 사용합니다.

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

## 릴리스

`v*` 태그를 푸시하면 GitHub Actions가 테스트와 엄격한 릴리스 검사를 다시 실행한 후 npm tarball과 `SHA256SUMS`를 GitHub Release에 첨부합니다. `UNLICENSED` 상태에서는 태그 릴리스가 차단됩니다. npm 레지스트리 게시는 GitHub Release와 분리된 후속 단계입니다.

## 개인정보와 계정 보안

- 비밀번호, OTP, 쿠키, 액세스 토큰을 config나 DB에 넣지 않습니다.
- 런타임 데이터는 저장소 밖의 사용자가 고른 절대경로에 둡니다.
- 데이터 디렉터리는 `0700`, config와 DB는 `0600`으로 초기화합니다.
- MCP는 읽기 전용이며 동기화나 계정 설정 도구를 노출하지 않습니다.
- Threads는 계정별 격리 Aside 프로필을, X는 OAuth 환경변수 참조를 사용합니다.

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
src/backup.mjs              해시 검증 백업과 새 경로 복원
src/scheduler.mjs           영수증 게이트와 LaunchAgent 관리
src/agent-scaffold.mjs      Codex/Claude Code Skill·MCP 설정 생성
src/connectors/fixture.mjs  오프라인 합성 커넥터
src/connectors/x.mjs        X 공식 API 커넥터
src/connectors/x-aside.mjs  X 격리 브라우저 커넥터
src/connectors/threads.mjs  Threads 격리 브라우저 커넥터
```

제품 설계는 `docs/superpowers/specs/2026-09-13-social-memory-mvp-design.md`, 실행 계획은 `docs/superpowers/plans/2026-09-13-social-memory-core.md`에 있습니다.

## 공개 전 남은 결정

라이선스는 아직 선택하지 않았습니다. 후보는 단일 AGPL-3.0 또는 AGPL 코어와 permissive connector SDK의 분리입니다. 라이선스와 기여 정책을 정하기 전에는 공개 저장소로 푸시하지 않습니다.
