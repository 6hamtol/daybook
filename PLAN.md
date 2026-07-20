# daybook — Claude Code 세션 기록/복기 도구

## Context

매일 Claude Code로 개발한 대화를 날짜·저장소별로 남겨 나중에 복기하고 싶다.
ponytail이 SessionStart hook으로 컨텍스트를 "주입"하듯, daybook은 lifecycle hook으로
대화를 "추출·저장"한다.

핵심 발견: **Claude Code는 이미 전체 대화를 저장한다.** 매 세션의 완전한 transcript가
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` 에 JSONL로 기록된다(질의·응답·도구
호출 전부). 따라서 메시지를 가로챌 필요 없이, hook에서 넘어오는 `transcript_path`를 읽어
마크다운으로 변환해 공유 폴더에 쌓기만 하면 된다. LLM 정제 없음(토큰 0).

## 결정 사항 (사용자 확정)

- **이름**: `daybook`. 출력 폴더 기본 `~/.daybook`, 환경변수 `DAYBOOK_DIR`로 override(다중 사용자 대응).
- **트리거**: `Stop` hook (+ `SessionEnd` 백업). 매 응답마다 transcript 전체를 파싱해
  각 질의 파일을 결정적 경로에 덮어쓴다 → 크래시/강제종료에도 유실 없고 항상 최신.
- **단위**: 질의(exchange) 1개 = md 파일 1개. Stop 경계가 곧 질의 경계라 1:1로 맞는다.
- **경로**:
  ```
  $DAYBOOK_DIR/<YYYY-MM-DD>/<repo>/<세션HHMM>-<sessionid8>/<질의HHMM>-<slug>.md
  ```
- **내용**: 렌더 + 긴 출력만 절단
  - 질의 텍스트 전문 / assistant 텍스트 전문
  - 도구 호출: `▸ ToolName` + 입력 전문
  - 도구 결과: 바이트 임계 초과 시 앞부분 + `…(N줄 생략)` (기계적 절단, LLM 아님)
- **전달**: **Claude Code 플러그인으로 패키징 + marketplace 배포** (ponytail과 동일 구조).
  설치 시 plugin.json이 hook을 자동 등록 → 사용자는 settings.json을 직접 손댈 필요 없음.
  단일 저장소가 marketplace 겸 플러그인(ponytail이 그렇듯 `.claude-plugin/`에 둘 다 둠).

## 아키텍처

핵심 로직은 단일 파일 `hooks/daybook.js` (순수 Node, 의존성 0). 플러그인 hook에서
`node "${CLAUDE_PLUGIN_ROOT}/hooks/daybook.js"`로 호출된다. 실행 흐름:

1. **stdin JSON 파싱** — `{ session_id, transcript_path, cwd, hook_event_name }`.
   파싱 실패/키 없음 → `exit 0` (세션 절대 블록 금지, best-effort).
2. **transcript 읽기** — `transcript_path` JSONL을 줄 단위 파싱. 없거나 비면 `exit 0`.
3. **저장소명** — `git -C <cwd> rev-parse --show-toplevel`의 basename, 실패 시 `basename(cwd)`.
4. **세션 헤더** — `sessionid8 = session_id.slice(0,8)`, 세션 시작시각 = 첫 entry timestamp(로컬).
5. **exchange 분할** — 핵심 정확성 포인트. 실제 transcript(126줄) 확인 결과, 대화가 아닌
   줄이 다수(메타 58, tool_result 18) 섞여 있어 naive 분할 시 5개 질의가 23+개로 쪼개져 섞인다.
   새 exchange는 **"실제 top-level 질의"에서만** 시작한다:
     실제 질의 = `type==='user'` **AND** `isSidechain !== true` **AND** content가 tool_result가 아닌 텍스트.
   그 질의부터 다음 실제 질의 전까지의 assistant 텍스트·tool_use·tool_result를 응답으로 묶는다.
   세 필터(분할 버그 발생원, 우선순위순):
     ① `type`이 `user`/`assistant`가 아닌 줄 전부 skip (system/attachment/last-prompt/file-history 등 메타)
     ② user 메시지 content가 `tool_result` → 새 질의 아님, 앞 exchange의 응답에 포함
     ③ `isSidechain===true` → skip. 서브에이전트(Explore/Plan/Task) 내부 turn이
        top-level 질의로 오인돼 섞이는 것 방지. Task 결과는 메인 thread의 tool_use/result로
        이미 남으므로 서브에이전트 내부 단계는 노이즈 → 버린다.
   ⚠️ 세션 간 섞임은 구조적으로 불가 — transcript_path가 현재 session_id에 1:1로 묶임.
6. **md 렌더** — exchange마다:
   - frontmatter: `session_id, date, time, repo, cwd, branch, model`
   - `## 질의` → 사용자 텍스트
   - `## 응답` → assistant 텍스트 + `▸ Tool`(입력 전문) + 결과(절단)
7. **쓰기** — `mkdir -p` 후 결정적 경로에 덮어쓰기. 매 Stop마다 전 exchange 재생성 =
   놓친 Stop 백필. 파일명 = `<질의HHMM>-<slug>.md`.

### slug 규칙
사용자 질의 앞부분(~40자): 한글 보존, ascii 소문자화, 공백·구두점 → `-`, 연속 `-` 축약,
양끝 `-` 제거, 빈 문자열이면 `query`. 같은 실행 내 경로 충돌 시 `-2` 접미사.

### 엣지 케이스
- transcript_path 없음/깨짐 → 조용히 exit 0.
- git 아님 → basename(cwd).
- 자정 넘긴 질의 → 그 질의의 timestamp 날짜 폴더로(세션 기준 아님).
- 도구 결과 절단 임계: 기본 2000자, 초과 시 `…(N줄 생략)`.

## 플러그인 / marketplace 구조

이 저장소(`~/personal/daybook`, git 이미 init됨)가 그 자체로 marketplace 겸 플러그인:

```
daybook/
  .claude-plugin/
    plugin.json          # 플러그인 매니페스트 (hooks 참조)
    marketplace.json     # marketplace 매니페스트 (이 플러그인 1개 등록)
  hooks/
    daybook-hooks.json   # Stop + SessionEnd 등록
    daybook.js           # 전 로직 + --selftest (순수 Node)
  README.md              # 설치법 + DAYBOOK_DIR 설명 + 출력 예시
  LICENSE
  PLAN.md                # (이 문서)
```

`.claude-plugin/plugin.json`:
```json
{
  "name": "daybook",
  "version": "0.1.0",
  "description": "Save every Claude Code session as dated, per-query markdown for later review.",
  "author": { "name": "<user>" },
  "hooks": "./hooks/daybook-hooks.json"
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "$schema": "https://anthropic.com/claude-code/marketplace.schema.json",
  "name": "daybook",
  "description": "Dated per-query markdown journal of your Claude Code sessions.",
  "owner": { "name": "<user>", "url": "https://github.com/<user>" },
  "plugins": [
    { "name": "daybook", "description": "Save every session as reviewable markdown.",
      "source": "./", "category": "productivity" }
  ]
}
```

`hooks/daybook-hooks.json` (설치 시 자동 등록, `${CLAUDE_PLUGIN_ROOT}` 사용):
```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/daybook.js\"",
        "commandWindows": "if (Get-Command node -ErrorAction SilentlyContinue) { node \"$env:CLAUDE_PLUGIN_ROOT\\hooks\\daybook.js\" }",
        "timeout": 10 } ] }
    ],
    "SessionEnd": [
      { "hooks": [ { "type": "command",
        "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/daybook.js\"",
        "commandWindows": "if (Get-Command node -ErrorAction SilentlyContinue) { node \"$env:CLAUDE_PLUGIN_ROOT\\hooks\\daybook.js\" }",
        "timeout": 10 } ] }
    ]
  }
}
```

### 다른 사람이 설치하는 법 (README에 기재)
1. `/plugin marketplace add <user>/daybook`
2. `/plugin install daybook@daybook`
3. (선택) 출력 위치 변경: `export DAYBOOK_DIR=~/Obsidian/daybook`
설치 후 hook이 자동 등록되어 다음 세션부터 기록 시작. settings.json 수동 편집 불필요.

## 파일 출력 예

```
$DAYBOOK_DIR/2026-07-20/ponytail/1432-3b4dedb3/
  1432-hook-injection-설명.md
  1509-daybook-도구-설계.md
```
```markdown
---
session_id: 3b4dedb3-8267-4000-bd5d-0ca6ca423f0b
date: 2026-07-20
time: "14:32"
repo: ponytail
cwd: /Users/mk-am16-075/personal/ponytail
branch: main
---

## 질의
ponytail 은 모든 세션 시작마다 주입되어…

## 응답
정확히 짚으셨어요. …

▸ Read hooks/ponytail-activate.js
  (input) file_path: /Users/…/ponytail-activate.js
▸ Bash: git status
  → On branch main …(320줄 생략)
```

## 자체 검증 (ponytail 규칙)

`node hooks/daybook.js --selftest` — 인라인 fixture(가짜 transcript JSONL 문자열:
실제 질의 2개 + tool_result-as-user + isSidechain=true 서브에이전트 turn + system/attachment 메타)로
"exchange가 정확히 2개로 분할되는지"(섞임 방지) + slug + 절단을 `assert`. 프레임워크 없음.

## 변경/신규 파일 (모두 이 저장소 `~/personal/daybook`)

- **신규** `hooks/daybook.js` — 전 로직 + `--selftest`
- **신규** `hooks/daybook-hooks.json` — Stop/SessionEnd 등록
- **신규** `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
- **신규** `README.md`, `LICENSE`
- ⚠️ 사용자의 `~/.claude/settings.json`은 건드리지 않음 — 플러그인이 hook 자동 등록.

## 검증 (end-to-end)

1. `node hooks/daybook.js --selftest` → 모든 assert 통과.
2. 로컬 설치로 실동작: `/plugin marketplace add ~/personal/daybook` →
   `/plugin install daybook@daybook` (로컬 경로 marketplace 지원).
3. 아무 저장소에서 Claude Code에 질의 1개 → `$DAYBOOK_DIR/<오늘>/<repo>/<세션>/<HHMM>-*.md`
   생성 확인, 질의·응답·도구 호출이 담겼는지 확인.
4. 같은 세션에서 두 번째 질의 → 같은 세션 폴더에 두 번째 파일 추가 확인.
5. 큰 파일 Read 포함 질의 → 도구 결과가 절단(`…(N줄 생략)`)됐는지 확인.
6. Task/Explore 서브에이전트를 쓰는 질의 → 서브에이전트 내부 turn이 별도 파일로
   새지 않고, 메인 질의 응답 안에 Task 호출/결과만 남는지 확인(섞임 방지 실동작).
