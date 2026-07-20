# daybook

Every Claude Code session, saved as dated, per-query markdown you can actually
read back later.

Claude Code already writes a complete transcript of every session to disk
(`~/.claude/projects/<project>/<session-id>.jsonl`). daybook doesn't intercept
or re-send anything — it just reads that transcript after each response and
turns it into plain markdown, one file per query, organized by date and repo.
No LLM calls, no summarization, no extra tokens.

## Output layout

```
$DAYBOOK_DIR/<YYYY-MM-DD>/<repo>/<HHMM-sessionId8>/<HHMM-slug>.md
```

- One folder per day, one subfolder per repo, one subfolder per session.
- One markdown file per user query — the query and Claude's full response
  (including tool calls and their inputs; long tool results are truncated).
- Re-generated on every response (`Stop`) and again on `SessionEnd`, so a
  crashed or force-quit session never loses anything, and the file for the
  query you're currently on is always up to date.

Example:

```
~/daybook/2026-07-20/ponytail/0801-3b4dedb3/0838-세션마다-기록되는-transcript.md
```
```markdown
---
session_id: 3b4dedb3-8267-4000-bd5d-0ca6ca423f0b
date: 2026-07-20
time: "08:38"
repo: ponytail
cwd: /Users/mk-am16-075/personal/ponytail
branch: main
model: claude-opus-4-8
---

## 질의
세션마다 기록되는 transcript 를 기준으로 처리하게 되면 내용이 섞일 수도 있는것 아닌가요 ?

## 응답
좋은 질문이고, 정확한 직관입니다. ...

▸ Bash
  { "command": "...", "description": "..." }
  → === 총 줄 수 ===
       126 ...
```

## Install

```
/plugin marketplace add 6hamtol/daybook
/plugin install daybook@daybook
```

That's it — the plugin registers its own `Stop`/`SessionEnd` hooks
(`hooks/daybook-hooks.json`) on install. Nothing to edit in your own
`settings.json`.

### Change where files are saved

Default output folder is `~/daybook`. Override with an environment variable
(e.g. to point at an Obsidian vault or an iCloud-synced folder):

```
export DAYBOOK_DIR=~/Obsidian/daybook
```

## Notes

- Sub-agent (Explore/Plan/Task) internal turns, tool-result "turns", and
  skill/harness-injected context never open their own file — they're folded
  into the query that triggered them. Only real top-level questions you typed
  get a file.
- Nothing is sent anywhere. Everything stays on disk, read from a transcript
  Claude Code already writes locally.
- Run `node hooks/daybook.js --selftest` to verify the exchange-splitting
  logic without touching real sessions.
