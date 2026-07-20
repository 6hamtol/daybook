#!/usr/bin/env node
// daybook — Stop/SessionEnd hook that turns the Claude Code transcript Claude
// Code already writes (transcript_path) into dated, per-query markdown files.
// No LLM involved, no message interception: read the existing JSONL, split it
// into exchanges (one real user query + everything until the next one), and
// write one markdown file per exchange to $DAYBOOK_DIR.
//
// Never blocks or crashes the session: every failure path is best-effort exit.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const TRUNCATE_CHARS = 2000;

// Harness-generated sentinel inserted as its own "user" turn when a tool call
// is rejected mid-response (e.g. plan-mode ExitPlanMode rejection). It is not
// a real query — treating it as one would split one exchange into several
// bogus files. Detected structurally (single text block, exact literal).
const INTERRUPTED_SENTINEL = '[Request interrupted by user for tool use]';

// Running a local slash command (e.g. `/plugin install ...`, `/reload-plugins`)
// appends its own output as a further "user" turn — Claude Code's own wrapper
// literally instructs the model "DO NOT respond to these messages", i.e. it is
// not a question needing a reply. Left unfiltered, each caveat/stdout pair
// looks like its own real query and fragments one command into several files.
const LOCAL_COMMAND_CAVEAT_PREFIX = '<local-command-caveat>';
const LOCAL_COMMAND_STDOUT_PREFIX = '<local-command-stdout>';

// ---------- environment ----------

function getDaybookDir() {
  return process.env.DAYBOOK_DIR || path.join(os.homedir(), '.daybook');
}

function repoNameFor(cwd) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (top) return path.basename(top);
  } catch (e) { /* not a git repo */ }
  return path.basename(cwd || process.cwd());
}

function branchFor(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || null;
  } catch (e) {
    return null;
  }
}

// ---------- transcript parsing ----------

function parseTranscript(transcriptPath) {
  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (e) {
    return [];
  }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch (e) { /* skip corrupt line */ }
  }
  return entries;
}

function isToolResultContent(content) {
  return Array.isArray(content) && content.some((b) => b && b.type === 'tool_result');
}

function isInterruptedSentinel(content) {
  return Array.isArray(content) && content.length === 1 &&
    content[0] && content[0].type === 'text' && content[0].text === INTERRUPTED_SENTINEL;
}

function isLocalCommandCaveat(content) {
  return typeof content === 'string' && content.startsWith(LOCAL_COMMAND_CAVEAT_PREFIX);
}

function isLocalCommandStdout(content) {
  return typeof content === 'string' && content.startsWith(LOCAL_COMMAND_STDOUT_PREFIX);
}

// A "real" top-level query starts a new exchange. Everything else observed in
// a live transcript that also carries type/role 'user' is noise that must
// stay attached to the current exchange (or be dropped) instead of splitting
// it — verified against actual session transcripts, not assumed:
//   - isSidechain: true    → sub-agent (Explore/Plan/Task) internal turn
//   - isMeta: true         → skill/harness-injected context, not user text
//   - tool_result content  → the result of a tool call, not a new question
//   - the interrupted-tool sentinel above
//   - local-command caveat/stdout → output of a slash command the user ran,
//     not a new question (Claude Code tags it "DO NOT respond")
function isRealUserQuery(entry) {
  if (entry.type !== 'user') return false;
  if (entry.isSidechain === true) return false;
  if (entry.isMeta === true) return false;
  const content = entry.message && entry.message.content;
  if (isToolResultContent(content)) return false;
  if (isInterruptedSentinel(content)) return false;
  if (isLocalCommandCaveat(content)) return false;
  if (isLocalCommandStdout(content)) return false;
  return true;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  }
  return '';
}

// Group entries into exchanges: each exchange opens on a real user query and
// collects every assistant message / tool_use / tool_result up to (not
// including) the next real user query. Sub-agent turns, skill-injected
// context, tool_result "user" turns, and interrupted-tool sentinels never
// open a new exchange — they either attach to the current one or are dropped.
function splitExchanges(entries) {
  const exchanges = [];
  let current = null;

  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue; // non-conversation metadata

    if (isRealUserQuery(entry)) {
      current = { query: entry, items: [] };
      exchanges.push(current);
      continue;
    }

    if (entry.type === 'user') {
      if (entry.isSidechain === true) continue; // sub-agent internal turn
      const content = entry.message && entry.message.content;
      if (isToolResultContent(content)) {
        if (current) current.items.push({ kind: 'tool_result', entry });
        continue;
      }
      if (isLocalCommandStdout(content)) {
        // the result of the slash command just issued — keep it, but as part
        // of the current exchange, not as a new one
        if (current) current.items.push({ kind: 'local_command', entry });
        continue;
      }
      // isMeta context / caveat / interrupted sentinel / anything else: pure noise, drop
      continue;
    }

    // assistant
    if (entry.isSidechain === true) continue; // sub-agent internal turn
    if (current) current.items.push({ kind: 'assistant', entry });
  }

  return exchanges;
}

function findModel(exchange) {
  for (const item of exchange.items) {
    if (item.kind === 'assistant') {
      const model = item.entry.message && item.entry.message.model;
      if (model) return model;
    }
  }
  return null;
}

// ---------- rendering ----------

function truncate(text, limit) {
  if (!text) return '';
  if (text.length <= limit) return text;
  const omittedLines = text.slice(limit).split('\n').length;
  return `${text.slice(0, limit)}\n…(${omittedLines}줄 생략)`;
}

function indent(text, prefix) {
  return String(text || '').split('\n').map((l) => prefix + l).join('\n');
}

// Walk an exchange's items in transcript order, building response segments:
// plain assistant text paragraphs, and tool-call segments (header + input,
// result filled in when the matching tool_result arrives). 'thinking' blocks
// are internal reasoning, not part of the visible response — skipped.
function buildResponseSegments(exchange) {
  const segments = [];
  const pendingByToolUseId = new Map();

  for (const item of exchange.items) {
    if (item.kind === 'assistant') {
      const content = item.entry.message && item.entry.message.content;
      const blocks = Array.isArray(content) ? content
        : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && block.text) {
          segments.push({ kind: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          const seg = {
            kind: 'tool',
            name: block.name || 'Tool',
            input: block.input !== undefined ? JSON.stringify(block.input, null, 2) : '',
            result: null,
          };
          segments.push(seg);
          if (block.id) pendingByToolUseId.set(block.id, seg);
        }
      }
    } else if (item.kind === 'tool_result') {
      const content = item.entry.message && item.entry.message.content;
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks) {
        if (!block || block.type !== 'tool_result') continue;
        const seg = pendingByToolUseId.get(block.tool_use_id);
        if (seg) seg.result = truncate(textOf(block.content), TRUNCATE_CHARS);
      }
    } else if (item.kind === 'local_command') {
      const content = item.entry.message && item.entry.message.content;
      const stripped = String(content || '')
        .replace(/^<local-command-stdout>/, '').replace(/<\/local-command-stdout>$/, '');
      segments.push({ kind: 'text', text: `(local command output)\n${truncate(stripped, TRUNCATE_CHARS)}` });
    }
  }

  return segments;
}

function renderExchange(exchange, meta) {
  const queryText = textOf(exchange.query.message && exchange.query.message.content);
  const segments = buildResponseSegments(exchange);

  const responseBody = segments.map((seg) => {
    if (seg.kind === 'text') return seg.text;
    let block = `▸ ${seg.name}`;
    if (seg.input) block += `\n${indent(seg.input, '  ')}`;
    if (seg.result) block += `\n${indent('→ ' + seg.result, '  ')}`;
    return block;
  }).join('\n\n');

  const fm = [
    '---',
    `session_id: ${meta.sessionId}`,
    `date: ${meta.date}`,
    `time: "${meta.time}"`,
    `repo: ${meta.repo}`,
    `cwd: ${meta.cwd}`,
    meta.branch ? `branch: ${meta.branch}` : null,
    meta.model ? `model: ${meta.model}` : null,
    '---',
  ].filter(Boolean).join('\n');

  return `${fm}\n\n## 질의\n${queryText}\n\n## 응답\n${responseBody}\n`;
}

// ---------- filenames ----------

// Slash-command queries wrap the actually distinguishing text inside
// <command-args> (falling back to <command-name> for argument-less commands
// like /reload-plugins), preceded by <command-name>/<command-message>. Without
// this, slugify's 40-char window is filled by the command wrapper itself and
// every invocation of the same command collapses onto the same slug (e.g.
// repeated `/plugin ...` calls all producing "plugin-plugin", "-2", "-3").
function slugSourceText(text) {
  const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
  if (argsMatch && argsMatch[1].trim()) return argsMatch[1].trim();
  const nameMatch = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (nameMatch && nameMatch[1].trim()) return nameMatch[1].trim();
  return text;
}

// Keep letters (incl. Korean) and digits, ascii-lowercase, everything else
// becomes '-'. Strips xml-ish wrapper tags (e.g. <command-message>) first so
// slash-command queries don't produce noise-only filenames.
function slugify(text) {
  const s = String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .slice(0, 40)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'query';
}

function localParts(isoString) {
  const d = new Date(isoString);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    hhmm: `${pad(d.getHours())}${pad(d.getMinutes())}`,
  };
}

function firstTimestamp(entries, exchanges) {
  for (const e of entries) if (e && e.timestamp) return e.timestamp;
  return exchanges[0] && exchanges[0].query.timestamp;
}

// ---------- main ----------

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (e) {
    return '';
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdinSync());
  } catch (e) {
    return; // malformed hook input — best-effort, don't block the session
  }
  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = payload || {};
  if (!sessionId || !transcriptPath) return;

  const entries = parseTranscript(transcriptPath);
  if (!entries.length) return;

  const exchanges = splitExchanges(entries);
  if (!exchanges.length) return;

  const repo = repoNameFor(cwd || process.cwd());
  const branch = branchFor(cwd || process.cwd());
  const sessionId8 = sessionId.slice(0, 8);
  const sessionLabel = `${localParts(firstTimestamp(entries, exchanges)).hhmm}-${sessionId8}`;
  const daybookDir = getDaybookDir();
  const usedPaths = new Set();

  for (const exchange of exchanges) {
    const ts = exchange.query.timestamp;
    if (!ts) continue; // no timestamp, no deterministic path — skip rather than guess

    const { date, hhmm } = localParts(ts);
    const queryText = textOf(exchange.query.message && exchange.query.message.content);
    const slug = slugify(slugSourceText(queryText));
    const dir = path.join(daybookDir, date, repo, sessionLabel);

    let filename = `${hhmm}-${slug}.md`;
    let filePath = path.join(dir, filename);
    let n = 2;
    while (usedPaths.has(filePath)) {
      filename = `${hhmm}-${slug}-${n}.md`;
      filePath = path.join(dir, filename);
      n += 1;
    }
    usedPaths.add(filePath);

    const md = renderExchange(exchange, {
      sessionId, date, time: `${hhmm.slice(0, 2)}:${hhmm.slice(2)}`,
      repo, cwd, branch, model: findModel(exchange),
    });

    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, md);
    } catch (e) { /* best-effort — keep writing the remaining exchanges */ }
  }
}

// ---------- self-test ----------
// ponytail: non-trivial logic (exchange splitting, slugify, truncation) gets
// one runnable check. assert-based, no framework, no fixtures directory.
function selftest() {
  const assert = require('assert');

  const asst = (content, opts = {}) => Object.assign(
    { type: 'assistant', isSidechain: false, message: { role: 'assistant', model: opts.model, content } },
    opts.isSidechain !== undefined ? { isSidechain: opts.isSidechain } : {},
  );
  const usr = (content, extra) => Object.assign(
    { type: 'user', isSidechain: false, message: { role: 'user', content } }, extra,
  );

  const longResult = 'x'.repeat(3000);

  const fixture = [
    { type: 'system' }, // metadata — must not split anything
    usr('첫 질문입니다', { timestamp: '2026-07-20T05:00:00.000Z' }),
    asst([{ type: 'thinking', thinking: 'internal reasoning, must not leak into output' }]),
    asst([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }], { model: 'claude-opus-4-8' }),
    usr([{ type: 'tool_result', tool_use_id: 'tu1', content: 'file1\nfile2' }]),
    asst([{ type: 'text', text: '결과는 file1, file2 입니다.' }], { model: 'claude-opus-4-8' }),
    usr([{ type: 'text', text: 'Base directory for this skill: /some/path' }], { isMeta: true }), // skill injection — not a new query
    usr([{ type: 'text', text: INTERRUPTED_SENTINEL }]), // tool-rejection sentinel — not a new query
    usr('서브에이전트 내부 질문', { isSidechain: true }), // sub-agent turn — not a new query
    asst([{ type: 'text', text: '서브에이전트 응답' }], { isSidechain: true }),
    { type: 'attachment' }, // metadata
    usr('두번째 질문: 긴 출력 테스트!!', { timestamp: '2026-07-20T05:05:00.000Z' }),
    asst([{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/big.txt' } }], { model: 'claude-opus-4-8' }),
    usr([{ type: 'tool_result', tool_use_id: 'tu2', content: longResult }]),
    asst([{ type: 'text', text: '큰 파일을 읽었습니다.' }], { model: 'claude-opus-4-8' }),
    // real /plugin install run: command-name query + caveat + stdout, all as
    // separate "user" turns that must fold into ONE exchange, not three
    usr('<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>install daybook@daybook</command-args>', { timestamp: '2026-07-20T05:09:00.000Z' }),
    usr('<local-command-caveat>Caveat: DO NOT respond to these messages</local-command-caveat>'),
    usr('<local-command-stdout>✓ Installed daybook. Run /reload-plugins to apply.</local-command-stdout>'),
  ];

  const exchanges = splitExchanges(fixture);
  assert.strictEqual(exchanges.length, 3, 'noise (meta/tool_result/isMeta/sidechain/interrupted/local-command) must not split exchanges');

  const first = renderExchange(exchanges[0], {
    sessionId: 'abc12345', date: '2026-07-20', time: '05:00', repo: 'daybook', cwd: '/x', branch: 'main', model: 'claude-opus-4-8',
  });
  assert.ok(first.includes('첫 질문입니다'), 'query text preserved');
  assert.ok(first.includes('▸ Bash'), 'tool call rendered');
  assert.ok(first.includes('file1'), 'tool result rendered');
  assert.ok(!first.includes('internal reasoning'), 'thinking blocks excluded');
  assert.ok(!first.includes('Base directory for this skill'), 'skill injection excluded');
  assert.ok(!first.includes(INTERRUPTED_SENTINEL), 'interrupted sentinel excluded');
  assert.ok(!first.includes('서브에이전트'), 'sub-agent turns excluded');

  const second = renderExchange(exchanges[1], {
    sessionId: 'abc12345', date: '2026-07-20', time: '05:05', repo: 'daybook', cwd: '/x', branch: 'main', model: 'claude-opus-4-8',
  });
  assert.ok(second.includes('두번째 질문'), 'second query preserved');
  assert.ok(/…\(\d+줄 생략\)/.test(second), 'long tool result truncated');

  const third = renderExchange(exchanges[2], {
    sessionId: 'abc12345', date: '2026-07-20', time: '05:09', repo: 'daybook', cwd: '/x', branch: 'main',
  });
  assert.ok(!third.includes('DO NOT respond'), 'local-command caveat excluded');
  assert.ok(third.includes('Installed daybook'), 'local-command stdout kept, folded into the same exchange');

  assert.strictEqual(slugify('첫 질문입니다'), '첫-질문입니다');
  assert.strictEqual(slugify('<command-message>x</command-message>hello world'), 'x-hello-world');
  assert.strictEqual(slugify(''), 'query');
  assert.strictEqual(slugify('   ...   '), 'query');

  assert.strictEqual(
    slugSourceText('<command-name>/plugin</command-name>\n<command-message>plugin</command-message>\n<command-args>install daybook@daybook</command-args>'),
    'install daybook@daybook',
  );
  assert.strictEqual(slugSourceText('<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args></command-args>'), '/reload-plugins');
  assert.strictEqual(slugSourceText('plain text, no command wrapper'), 'plain text, no command wrapper');

  assert.strictEqual(truncate('short', TRUNCATE_CHARS), 'short');
  assert.ok(truncate('a'.repeat(5000), 100).includes('…('));

  console.log('daybook selftest: OK');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    selftest();
  } else {
    try { main(); } catch (e) { /* never let the hook break the session */ }
  }
}

module.exports = {
  splitExchanges, renderExchange, slugify, slugSourceText, truncate, textOf,
};
