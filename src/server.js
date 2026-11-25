#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const config = require('./config');
const { runTurn, terminateChild, binSpec } = require('./agy-runner');
const session = require('./session');
const archive = require('./archive');
const { TurnQueue, BusyError } = require('./queue');

const SYS_WORKSPACE = path.join(config.WORKSPACES, '_sys');
try {
  fs.mkdirSync(SYS_WORKSPACE, { recursive: true });
} catch {}

function ensureSysWorkspace() {
  const dir = path.join(config.WORKSPACES, '_sys');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

const DEFAULT_ARCHIVE_INSTRUCTION =
  '\n\n[归档指令]\n' +
  '每轮回复正文结束后，必须在最末尾单独追加一段 <ta_record>...</ta_record> 剧情归档（150-320字），' +
  '涵盖七要素：时间、地点、在场人物、关键事件、关系或状态变化、未兑现承诺或伏笔、当前场景结束状态。' +
  '正文中严禁提及该标签或归档规则。';

function ensureArchiveSystem(sysText) {
  const s = typeof sysText === 'string' ? sysText : String(sysText || '');
  if (s.includes('ta_record')) return s;
  return s ? (s + DEFAULT_ARCHIVE_INSTRUCTION) : DEFAULT_ARCHIVE_INSTRUCTION.trim();
}

const TOKEN_FILE = process.env.AGY_BRIDGE_TOKEN_FILE || path.join(config.HOME, '.agy-bridge', 'token');
const SUMMARY_FILE = process.env.AGY_SUMMARY_FILE || path.join(config.HOME, '.agy-bridge', 'summaries.json');
const SUMMARY_MODEL = process.env.AGY_SUMMARY_MODEL || 'gemini-3.8-flash-low';
const SUMMARY_REFRESH_STEP = Number(process.env.AGY_SUMMARY_STEP || 4);
const SUMMARY_MAX_INPUT = 80000;

let MODELS = config.FALLBACK_MODELS.slice();
let MODEL_NAMES = {};
let AUTH_TOKEN = '';
try {
  AUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {}

const queue = new TurnQueue({
  maxConcurrent: config.MAX_CONCURRENT,
  limit: config.QUEUE_LIMIT,
  timeoutMs: config.QUEUE_TIMEOUT_MS,
});

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isSessionMode() {
  if (process.env.AGY_SESSION_MODE === '0') return false;
  return Boolean(config.SESSION_MODE);
}

let seedSeq = 0;

function trySeedTimeline(workspaceDir, floors) {
  try {
    if (!workspaceDir || !Array.isArray(floors) || floors.length === 0 || !floors[0]) {
      return false;
    }
    const timelinePath = path.join(workspaceDir, 'timeline.md');
    try {
      const st = fs.statSync(timelinePath);
      if (st.isFile() && st.size > 0) return false;
    } catch {}

    const firstContent = textOf(floors[0].content != null ? floors[0].content : floors[0]);
    const firstTrimmed = firstContent.trim();
    if (!firstTrimmed) return false;

    let seedsDir = path.join(config.WORKSPACES, '_seeds');
    const parentSeedsDir = path.join(path.dirname(workspaceDir), '_seeds');
    if (parentSeedsDir !== seedsDir && fs.existsSync(parentSeedsDir)) {
      seedsDir = parentSeedsDir;
    }
    if (!fs.existsSync(seedsDir)) return false;

    const entries = fs.readdirSync(seedsDir).sort();
    for (const file of entries) {
      if (!file.endsWith('.sig')) continue;
      const hash = file.slice(0, -4);
      if (!hash) continue;
      try {
        const sigPath = path.join(seedsDir, file);
        const sigText = fs.readFileSync(sigPath, 'utf8');
        const sigPrefix = sigText.trim().slice(0, 40);
        if (!sigPrefix) continue;

        if (firstTrimmed.startsWith(sigPrefix) || firstContent.includes(sigPrefix)) {
          const mdPath = path.join(seedsDir, `${hash}.md`);
          const mdBuf = fs.readFileSync(mdPath);
          if (!mdBuf || mdBuf.length === 0) continue;
          fs.mkdirSync(workspaceDir, { recursive: true });
          const tmpPath = `${timelinePath}.tmp.${process.pid}.${++seedSeq}`;
          fs.writeFileSync(tmpPath, mdBuf);
          fs.renameSync(tmpPath, timelinePath);
          log(`timeline seeded: ${hash}`);
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .join('');
  }
  return content == null ? '' : String(content);
}

function truncateUtf8(str, maxBytes) {
  const s = typeof str === 'string' ? str : String(str || '');
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

function tailUtf8(str, maxBytes) {
  const s = typeof str === 'string' ? str : String(str || '');
  if (maxBytes <= 0) return '';
  const total = Buffer.byteLength(s, 'utf8');
  if (total <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  let start = total - maxBytes;
  while (start < total && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start, total).toString('utf8');
}

/* ---- Dynamic models list (10-minute cache) ---- */
let modelsCacheAt = 0;

function refreshModels() {
  const now = Date.now();
  if (now - modelsCacheAt < 10 * 60 * 1000 && MODELS.length > 0 && modelsCacheAt > 0) {
    return;
  }
  const spec = binSpec(process.env.AGY_BIN || config.AGY_BIN, ['models']);
  execFile(
    spec.cmd,
    spec.args,
    { cwd: ensureSysWorkspace(), env: { ...process.env, HOME: config.HOME }, timeout: 60000 },
    (err, stdout) => {
      if (err) {
        log('refreshModels failed:', String(err.message).slice(0, 120));
        return;
      }
      const ids = [];
      const names = {};
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/^([a-z0-9][a-z0-9.\-]+)\t(.+)$/);
        if (m) {
          ids.push(m[1]);
          names[m[1]] = m[2].trim();
        }
      }
      if (ids.length) {
        MODELS = ids;
        MODEL_NAMES = names;
        modelsCacheAt = Date.now();
        log('models refreshed:', ids.length);
      }
    }
  );
}
refreshModels();
setInterval(refreshModels, 10 * 60 * 1000).unref();

/* ---- Quota inquiry (60-second cache) ---- */
let quotaCache = { at: 0, text: '', parsed: [] };

function runQuota() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (now - quotaCache.at < 60000 && quotaCache.text) {
      return resolve(quotaCache);
    }
    const spec = binSpec(process.env.AGY_BIN || config.AGY_BIN, ['-p', '/quota', '--print-timeout', '45s']);
    let child;
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: ensureSysWorkspace(),
        env: { ...process.env, HOME: config.HOME, ELECTRON_RUN_AS_NODE: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      quotaCache = { at: now, text: String(e.message), parsed: [] };
      return resolve(quotaCache);
    }
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (c) => {
      outChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
    });
    child.stderr.on('data', (c) => {
      errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
    });
    const timer = setTimeout(() => {
      terminateChild(child);
    }, 50000);
    child.on('close', () => {
      clearTimeout(timer);
      const out = Buffer.concat(outChunks).toString('utf8');
      const err = Buffer.concat(errChunks).toString('utf8');
      const parsed = [];
      for (const line of out.split('\n')) {
        const parts = line.split('\t').map((s) => s.trim());
        if (parts.length >= 3 && /%$/.test(parts[2])) {
          parsed.push({
            pool: parts[0],
            kind: parts[1],
            remaining: parts[2],
            resets_at: parts[3] || null,
          });
        }
      }
      quotaCache = { at: now, text: (out || err).trim(), parsed };
      resolve(quotaCache);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      quotaCache = { at: now, text: String(e.message), parsed: [] };
      resolve(quotaCache);
    });
  });
}

/* ---- Effort & fallback helpers ---- */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const RETRYABLE_ERR = /503|UNAVAILABLE|capacity|overloaded|high traffic|RESOURCE_EXHAUSTED|\b429\b/i;

function mapEffort(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  if (EFFORTS.includes(s)) return s;
  if (s === 'minimal') return 'low';
  if (s === 'medium' || s === 'med') return 'medium';
  return '';
}

function pickFallback(model, errText) {
  const msg = String(errText || '');
  if (!RETRYABLE_ERR.test(msg)) return '';
  return (config.FALLBACK_MODELS || []).find((m) => m !== model) || '';
}

function sseChunk(res, model, delta, finish) {
  if (res.writableEnded || res.destroyed) return;
  const payload = {
    id: 'chatcmpl-' + crypto.randomBytes(6).toString('hex'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish || null }],
  };
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function createOutputter(res, { stream = true, model = config.DEFAULT_MODEL } = {}) {
  const isStream = stream !== false && stream !== 'false';
  let currentModel = model || config.DEFAULT_MODEL;
  let headersSent = false;
  let finished = false;
  let content = '';

  function ensureSseHeaders() {
    if (!isStream || headersSent || res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    headersSent = true;
    sseChunk(res, currentModel, { role: 'assistant', content: '' }, null);
  }

  return {
    isStream,
    get headersSent() {
      return headersSent || res.headersSent;
    },
    get content() {
      return content;
    },
    setModel(m) {
      if (m) currentModel = m;
    },
    start() {
      if (isStream) {
        ensureSseHeaders();
      }
    },
    reset() {
      if (!headersSent && !res.headersSent) {
        content = '';
      }
    },
    delta(text) {
      if (!text || finished || res.writableEnded || res.destroyed) return;
      const str = String(text);
      if (!str) return;
      content += str;
      if (isStream) {
        ensureSseHeaders();
        sseChunk(res, currentModel, { content: str }, null);
      }
    },
    finish(usage) {
      if (finished || res.writableEnded || res.destroyed) return;
      finished = true;
      if (isStream) {
        ensureSseHeaders();
        sseChunk(res, currentModel, {}, 'stop');
        if (!res.writableEnded && !res.destroyed) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } else {
        const payload = {
          id: 'chatcmpl-' + crypto.randomBytes(6).toString('hex'),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: currentModel,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: (usage && typeof usage === 'object')
            ? usage
            : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          headersSent = true;
        }
        res.end(JSON.stringify(payload));
      }
    },
    error(msg, statusCode = 500) {
      if (finished || res.writableEnded || res.destroyed) return;
      finished = true;
      const errText = String(msg || 'unknown error');
      if (!headersSent && !res.headersSent) {
        const code = statusCode === 429 ? 429 : 500;
        const headers = { 'content-type': 'application/json; charset=utf-8' };
        if (code === 429) {
          headers['Retry-After'] = '3';
        }
        res.writeHead(code, headers);
        headersSent = true;
        res.end(JSON.stringify({ error: { message: errText } }));
        return;
      }
      if (isStream && !res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}

/* ---- v4 Stateless Mode compatibility ---- */
const TAIL_RULE =
  '【本轮要求】\n' +
  '继续上面的对话，以「你」的身份写出这一轮的回复正文。' +
  '只输出回复本身，不要加任何解释、前言、标题或角色标注。';

let summaries = {};
try {
  summaries = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
} catch {
  summaries = {};
}
let summaryDirty = false;

function saveSummaries() {
  if (!summaryDirty) return;
  try {
    fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summaries));
    summaryDirty = false;
  } catch (e) {
    log('summary save failed', String(e.message).slice(0, 120));
  }
}
setInterval(saveSummaries, 15000).unref();

function assembleStateless(head, turns, omitted, summary) {
  const parts = [];
  if (head) parts.push(head);
  if (summary) parts.push('【前情摘要（更早的对话已压缩，请当作已发生的事实）】\n' + summary);
  const bodyHeader = omitted > 0
    ? `【对话记录】（更早的 ${omitted} 条消息已压缩为上面的摘要）`
    : '【对话记录】';
  parts.push(bodyHeader + '\n' + turns.join('\n\n'));
  parts.push(TAIL_RULE);
  return parts.join('\n\n');
}

function buildStatelessPrompt(messages, summary) {
  const sysFull = messages
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');

  const turns = [];
  for (const m of messages) {
    if (!m || m.role === 'system' || m.role === 'developer') continue;
    const t = textOf(m.content);
    if (!t) continue;
    const nameSuffix = (m.name != null && String(m.name) !== '') ? `(${String(m.name)})` : '';
    if (m.role === 'user') turns.push(`用户${nameSuffix}：` + t);
    else if (m.role === 'assistant') turns.push(`你${nameSuffix}：` + t);
    else turns.push(`${m.role}${nameSuffix}：` + t);
  }

  let head = sysFull ? '【设定与规则】\n' + sysFull : '';
  const budget = config.PROMPT_BUDGET;
  const sizeOf = (h, arr, omitted) => Buffer.byteLength(assembleStateless(h, arr, omitted, summary), 'utf8');

  let omitted = 0;
  let headTruncated = false;
  const dropped = [];

  while (turns.length > 1 && sizeOf(head, turns, omitted) > budget) {
    dropped.push(turns.shift());
    omitted++;
  }

  if (sizeOf(head, turns, omitted) > budget && head) {
    const turnsBytes = sizeOf('', turns, omitted);
    const headBudget = Math.max(4000, budget - turnsBytes);
    let text = head;
    let guard = 0;
    while (Buffer.byteLength(text, 'utf8') > headBudget && Buffer.byteLength(text, 'utf8') > 800 && guard < 40) {
      const totalBytes = Buffer.byteLength(text, 'utf8');
      const front = truncateUtf8(text, Math.floor(totalBytes * 0.55));
      const back = tailUtf8(text, Math.floor(totalBytes * 0.35));
      text = front + '\n……（此处因长度限制省略部分设定）……\n' + back;
      guard++;
    }
    head = text;
    headTruncated = true;
  }

  if (sizeOf(head, turns, omitted) > budget && turns.length) {
    const last = turns[turns.length - 1];
    const over = sizeOf(head, turns, omitted) - budget;
    const lastBytes = Buffer.byteLength(last, 'utf8');
    const keepBytes = Math.max(500, lastBytes - over - 36);
    turns[turns.length - 1] = '（此条开头已省略）…' + tailUtf8(last, keepBytes);
  }

  return {
    prompt: assembleStateless(head, turns, omitted, summary),
    meta: { omitted, headTruncated, dropped },
  };
}

async function getStatelessSummary(key, droppedTurns, signal) {
  if (!droppedTurns || !droppedTurns.length) return '';
  const entry = summaries[key];
  if (entry) {
    if (droppedTurns.length <= entry.covered) return entry.summary || '';
    if (droppedTurns.length - entry.covered < SUMMARY_REFRESH_STEP) return entry.summary || '';
  }
  const startIdx = entry ? entry.covered : 0;
  let fresh = droppedTurns.slice(startIdx).join('\n\n');
  if (Buffer.byteLength(fresh, 'utf8') > SUMMARY_MAX_INPUT) {
    fresh = tailUtf8(fresh, SUMMARY_MAX_INPUT);
  }
  const prev = entry && entry.summary ? `已有摘要：\n${entry.summary}\n\n新增对话：\n` : '对话记录：\n';
  const instruction =
    '请把下面的角色扮演对话压缩成不超过 500 字的中文前情摘要。\n' +
    '必须保留：时间与地点、人物及关系变化、关键事件与结果、尚未兑现的承诺或伏笔、当前场景结束时的状态。\n' +
    '不要臆造，不要评价，只输出摘要正文。\n\n';
  try {
    const r = await queue.run(key, () => runTurn({
      prompt: instruction + prev + fresh,
      model: SUMMARY_MODEL,
      effort: 'low',
      cwd: ensureSysWorkspace(),
      signal,
    }));
    const txt = (r.text || '').trim();
    if (!txt) return entry ? entry.summary || '' : '';
    summaries[key] = { covered: droppedTurns.length, summary: txt, at: Date.now() };
    summaryDirty = true;
    return txt;
  } catch (e) {
    if (e instanceof BusyError || (e && (e.name === 'BusyError' || e.code === 'EBUSY'))) {
      throw e;
    }
    return entry ? entry.summary || '' : '';
  }
}

/* ---- Session health inspection ---- */
function isTranscriptHealthy(convId) {
  if (!convId) return false;
  const brainConvDir = path.join(config.HOME, '.gemini', 'antigravity-cli', 'brain', String(convId));
  try {
    if (!fs.existsSync(brainConvDir)) {
      // If brain/<convId> directory doesn't exist locally (e.g. test mock environment),
      // defer to agy's "warning: conversation ... not found" detection.
      return true;
    }
    const transcriptDir = path.join(brainConvDir, '.system_generated', 'logs', 'chunks', 'transcript');
    if (!fs.existsSync(transcriptDir)) return false;
    const files = fs.readdirSync(transcriptDir);
    return files.length > 0;
  } catch {
    return true;
  }
}

function getEffectiveSession(sess) {
  if (!sess || typeof sess !== 'object') return null;
  if (!sess.convId || sess.conversationMissing) return null;
  if (typeof sess.turns === 'number' && sess.turns >= config.MAX_TURNS_PER_SESSION) return null;
  if (!isTranscriptHealthy(sess.convId)) return null;
  return sess;
}

/* ---- HTTP Server ---- */
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    const state = session.loadState();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      sessions: Object.keys(state).length,
      queue: queue.size,
      mode: isSessionMode() ? 'session' : 'stateless',
      model: config.DEFAULT_MODEL,
    }));
  }

  const remote = (req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '').replace('::ffff:', '');
  const isLoopback = !remote || remote === '127.0.0.1' || remote === '::1';
  if (AUTH_TOKEN && !isLoopback) {
    const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    if (got !== AUTH_TOKEN) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }));
    }
  }

  if (req.method === 'GET' && url === '/quota') {
    const quotaTimer = setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ ok: false, error: 'quota timeout after 60s' }));
      }
    }, 60000);
    runQuota()
      .then((q) => {
        clearTimeout(quotaTimer);
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: q.parsed.length > 0, remaining: q.parsed, raw: q.text }, null, 2));
        }
      })
      .catch((err) => {
        clearTimeout(quotaTimer);
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
        }
      });
    return;
  }

  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    refreshModels();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      object: 'list',
      data: MODELS.map((id) => ({
        id,
        object: 'model',
        created: 0,
        owned_by: 'antigravity',
        name: MODEL_NAMES[id] || id,
      })),
    }));
  }

  if (req.method !== 'POST' || url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'not found' } }));
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const reqChunks = [];
  req.on('data', (c) => {
    reqChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
  });
  req.on('end', async () => {
    const raw = Buffer.concat(reqChunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (e) {
      log('bad json request:', e.message);
      const errOut = createOutputter(res, { stream: false, model: config.DEFAULT_MODEL });
      return errOut.error('bad json: ' + e.message, 500);
    }

    const model = (typeof body.model === 'string' && body.model.trim())
      ? body.model.trim()
      : config.DEFAULT_MODEL;
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages.map((m) => {
      if (m && m.role === 'assistant') {
        return { ...m, content: textOf(m.content).trim() };
      }
      return m;
    });
    const effort = mapEffort(body.reasoning_effort);
    const out = createOutputter(res, { stream: body.stream, model });
    const t0 = Date.now();

    // 1. Separate system text and split preset blocks / floors; compute queueKey without reading sessions.json
    const sysText = messages
      .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
    const { systemBlocks, floors: rawFloors, postBlocks } = session.splitFloors(messages);
    const isEmptyFloorsFallback = rawFloors.length === 0;
    const floors = isEmptyFloorsFallback
      ? postBlocks.map((b) => ({ role: 'user', content: textOf(b) }))
      : rawFloors;
    const activePostBlocks = isEmptyFloorsFallback ? [] : postBlocks;
    const { primary, alias } = session.chatKeys(messages);
    const queueKey = alias || primary;

    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      if (out.isStream && out.headersSent) {
        try { res.write(': keep-alive\n\n'); } catch {}
      }
    }, 5000);

    try {
      // 2. SESSION_MODE == 0 -> stateless v4 behavior
      if (!isSessionMode()) {
        let built = buildStatelessPrompt(messages, '');
        if (built.meta.dropped.length) {
          const sum = await getStatelessSummary(queueKey, built.meta.dropped, ac.signal);
          if (sum) built = buildStatelessPrompt(messages, sum);
        }
        const prompt = built.prompt;

        let modelUsed = model;
        let sentCount = 0;
        const r = await queue.run(queueKey, async (ctx) => {
          if (ctx && typeof ctx.addEventListener === 'function') {
            if (ctx.aborted) ac.abort();
            else ctx.addEventListener('abort', () => ac.abort(), { once: true });
          }
          const sysDir = ensureSysWorkspace();
          let resTurn = await runTurn({
            prompt,
            model: modelUsed,
            effort,
            cwd: sysDir,
            signal: ac.signal,
            onDelta: (delta) => {
              if (res.writableEnded || res.destroyed) return;
              sentCount += delta.length;
              out.setModel(modelUsed);
              out.delta(delta);
            },
          });
          if (resTurn.code !== 0 && !resTurn.text && sentCount === 0 && !ac.signal.aborted) {
            const fb = pickFallback(modelUsed, resTurn.stderr);
            if (fb) {
              log('fallback(stateless)', { from: modelUsed, to: fb });
              modelUsed = fb;
              out.setModel(modelUsed);
              resTurn = await runTurn({
                prompt,
                model: modelUsed,
                effort,
                cwd: sysDir,
                signal: ac.signal,
                onDelta: (delta) => {
                  if (res.writableEnded || res.destroyed) return;
                  sentCount += delta.length;
                  out.setModel(modelUsed);
                  out.delta(delta);
                },
              });
            }
          }
          return resTurn;
        }, { onPreempt: () => ac.abort() });

        clearInterval(keepAlive);
        if (r.code !== 0 && !ac.signal.aborted) {
          throw new Error(r.stderr || `agy exited with code ${r.code}`);
        }
        if (r.text && sentCount === 0 && !ac.signal.aborted) {
          out.delta(r.text);
        }
        out.finish(r.usage);
        log('turn done(stateless)', { key: queueKey, ms: Date.now() - t0, chars: (r.text || '').length, modelUsed });
        return;
      }

      // 3. Session mode: all state reads, drift computation, execution, and commit happen inside queue.run
      await queue.run(queueKey, async (ctx) => {
        if (ctx && typeof ctx.addEventListener === 'function') {
          if (ctx.aborted) ac.abort();
          else ctx.addEventListener('abort', () => ac.abort(), { once: true });
        }

        const state = session.loadState();
        const resolved = session.resolveSession(state, messages);
        const sessionKey = resolved.key;
        const rawSess = resolved.sess;
        const effectiveSess = getEffectiveSession(rawSess);
        const sessForDrift = rawSess
          ? { ...rawSess, convId: effectiveSess ? effectiveSess.convId : null }
          : null;
        const drift = session.driftOf(sessForDrift, floors);

        const workspaceDir = (rawSess && rawSess.dir) ? rawSess.dir : path.join(config.WORKSPACES, sessionKey);
        const timelinePath = path.join(workspaceDir, 'timeline.md');
        const timelineBakPath = path.join(workspaceDir, 'timeline.bak.md');
        try {
          fs.mkdirSync(workspaceDir, { recursive: true });
        } catch {}

        function backupTimelineIfNeeded() {
          if (ac.signal.aborted) return;
          try {
            if (fs.existsSync(timelinePath)) {
              fs.copyFileSync(timelinePath, timelineBakPath);
            }
          } catch (err) {
            log('timeline backup error:', err.message);
          }
        }

        let prompt = '';
        let convIdToUse = null;
        let nextSwipeStreak = 0;
        let isContinue = false;
        let newMsgCount = 0;

        if (drift.kind === 'advance' || drift.kind === 'retry') {
          const sliceStart = drift.kind === 'advance'
            ? drift.divIdx
            : ((effectiveSess && Array.isArray(effectiveSess.syncedHashes)) ? effectiveSess.syncedHashes.length : floors.length);
          const newMsgs = floors.slice(sliceStart);
          newMsgCount = newMsgs.length;

          if (newMsgs.length > 0) {
            const bodyText = newMsgs
              .map((m) => session.formatMessage(m))
              .join('\n\n');
            prompt = `[新消息]\n${bodyText}`;
            if (Buffer.byteLength(prompt, 'utf8') > config.PROMPT_BUDGET) {
              prompt = tailUtf8(prompt, config.PROMPT_BUDGET);
            }
          } else {
            const lastMsg = floors[floors.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              const prefill = textOf(lastMsg.content).trim();
              prompt = prefill
                ? `请从下面这句话接着写（不要重复这句本身，不要解释）：\n${prefill}`
                : '请顺着你上一段回复继续写下去，不要重写已经写过的内容，不要复述。';
              isContinue = true;
            } else {
              const lastUser = [...floors].reverse().find((m) => m && m.role === 'user') || lastMsg;
              prompt = `[新消息]\n${session.formatMessage(lastUser || { role: 'user', content: '' })}`;
              if (Buffer.byteLength(prompt, 'utf8') > config.PROMPT_BUDGET) {
                prompt = tailUtf8(prompt, config.PROMPT_BUDGET);
              }
            }
          }
          convIdToUse = effectiveSess.convId;
          nextSwipeStreak = drift.kind === 'retry'
            ? ((effectiveSess && typeof effectiveSess.swipeStreak === 'number') ? effectiveSess.swipeStreak : 0)
            : 0;
        } else if (drift.kind === 'shallow') {
          prompt = session.buildOverride({ divIdx: drift.divIdx, floors });
          convIdToUse = effectiveSess.convId;
          nextSwipeStreak = ((effectiveSess && effectiveSess.swipeStreak) || 0) + 1;
        } else {
          if (drift.divIdx === 0) {
            backupTimelineIfNeeded();
          }
          trySeedTimeline(workspaceDir, floors);
          const timeline = archive.readTimeline(
            timelinePath,
            Math.floor(config.PROMPT_BUDGET * 0.2),
            drift.divIdx > 0 ? drift.divIdx : undefined
          );
          prompt = session.buildBootstrap({
            system: sysText,
            systemBlocks,
            floors,
            postBlocks: activePostBlocks,
            messages,
            timeline,
            budgetBytes: config.PROMPT_BUDGET,
          });
          convIdToUse = null;
          nextSwipeStreak = 0;
        }

        const presetBlockBytes = systemBlocks.reduce((acc, b) => acc + Buffer.byteLength(textOf(b), 'utf8'), 0);
        const postBlockBytes = postBlocks.reduce((acc, b) => acc + Buffer.byteLength(textOf(b), 'utf8'), 0);
        const firstFloorPreview = floors[0] ? textOf(floors[0].content).replace(/\s+/g, ' ').slice(0, 40) : '';

        log('turn start(session)', {
          key: sessionKey,
          drift: drift.kind,
          divIdx: drift.divIdx,
          convId: convIdToUse || 'NEW',
          model,
          promptBytes: Buffer.byteLength(prompt, 'utf8'),
          floors: floors.length,
          floorCount: floors.length,
          presetBlockBytes,
          postBlockBytes,
          firstFloorPreview,
          newMsgCount,
          promptSummary: prompt.replace(/\s+/g, ' ').slice(0, 160),
          ...(isContinue ? { continue: true } : {}),
        });

        let modelUsed = model;
        let filter = archive.recordFilter();
        let rawDeltaCount = 0;
        let streamedText = '';
        let rebuiltInRequest = false;

        const resetTurnBuffer = () => {
          filter = archive.recordFilter();
          rawDeltaCount = 0;
          streamedText = '';
          out.reset();
        };

        const executeTurn = (turnPrompt, turnConvId) => runTurn({
          prompt: turnPrompt,
          model: modelUsed,
          conversationId: turnConvId,
          effort,
          addDirs: [workspaceDir],
          cwd: workspaceDir,
          timeoutMs: config.TURN_TIMEOUT_MS,
          signal: ac.signal,
          onMissing: () => {
            resetTurnBuffer();
          },
          onDelta: (delta) => {
            if (res.writableEnded || res.destroyed || ac.signal.aborted) return;
            rawDeltaCount += delta.length;
            out.setModel(modelUsed);
            out.start();
            const safe = filter.push(delta);
            if (safe) {
              streamedText += safe;
              out.delta(safe);
            }
          },
        });

        let r = await executeTurn(prompt, convIdToUse);

        if (r.conversationMissing && !ac.signal.aborted) {
          backupTimelineIfNeeded();
          trySeedTimeline(workspaceDir, floors);
          const timeline = archive.readTimeline(
            timelinePath,
            Math.floor(config.PROMPT_BUDGET * 0.2),
            drift.divIdx > 0 ? drift.divIdx : undefined
          );
          prompt = session.buildBootstrap({
            system: sysText,
            systemBlocks,
            floors,
            postBlocks: activePostBlocks,
            messages,
            timeline,
            budgetBytes: config.PROMPT_BUDGET,
          });
          convIdToUse = null;
          nextSwipeStreak = 0;
          rebuiltInRequest = true;
          resetTurnBuffer();
          log('rebuild on conversationMissing(session)', { key: sessionKey, model: modelUsed });
          r = await executeTurn(prompt, null);
        }

        if (r.code !== 0 && !r.text && rawDeltaCount === 0 && !ac.signal.aborted) {
          const fb = pickFallback(modelUsed, r.stderr);
          if (fb) {
            log('fallback(session)', { key: sessionKey, from: modelUsed, to: fb });
            modelUsed = fb;
            out.setModel(modelUsed);
            resetTurnBuffer();
            r = await executeTurn(prompt, convIdToUse);
          }
        }

        clearInterval(keepAlive);
        const aborted = ac.signal.aborted || Boolean(ctx && ctx.aborted) || res.writableEnded || res.destroyed;

        if (!aborted && (r.conversationMissing || (r.code !== 0 && !r.text && rawDeltaCount === 0))) {
          const reason = r.conversationMissing ? 'conversation_missing' : `exit_code_${r.code}`;
          log('turn done(session)', {
            key: sessionKey,
            drift: drift.kind,
            stateCommit: false,
            reason,
            code: r.code,
            ms: Date.now() - t0,
          });
          throw new Error(r.stderr || (r.conversationMissing ? 'conversation missing after rebuild' : `agy exited with code ${r.code}`));
        }

        if (!aborted) {
          if (rawDeltaCount === 0 && r.text && r.code === 0) {
            const pushed = filter.push(r.text);
            if (pushed) {
              streamedText += pushed;
              out.delta(pushed);
            }
          }
          const tail = filter.flush();
          if (tail) {
            streamedText += tail;
            out.delta(tail);
          }
        }

        // Only commit state and write timeline when r.code === 0 && !aborted && !ac.signal.aborted && !r.conversationMissing
        const canCommit = r.code === 0 && !aborted && !ac.signal.aborted && !r.conversationMissing;
        if (!canCommit) {
          const reason = (aborted || ac.signal.aborted)
            ? 'aborted'
            : (r.conversationMissing ? 'conversation_missing' : `exit_code_${r.code}`);
          log('turn done(session)', {
            key: sessionKey,
            drift: drift.kind,
            stateCommit: false,
            reason,
            code: r.code,
            ms: Date.now() - t0,
          });
          out.error(r.stderr || (r.conversationMissing ? 'conversation missing' : `agy exited with code ${r.code}`), 500);
          return;
        }

        const { record } = archive.extractRecord(r.text || '');
        const currentFloor = floors.length;
        if (drift.kind === 'deep' && drift.divIdx > 0) {
          try {
            archive.upsertFloor(timelinePath, drift.divIdx, '');
          } catch (err) {
            log('upsertFloor error:', err.message);
          }
        }
        if (record !== null || drift.kind === 'shallow') {
          try {
            archive.upsertFloor(timelinePath, currentFloor, record || '');
          } catch (err) {
            log('upsertFloor error:', err.message);
          }
        }

        const trimmedReply = streamedText.trim();
        const syncedHashes = floors.map(session.layerHash);
        const numberedFloorCount = floors.filter((f) => session.FLOOR_MARKER_HEAD_RE.test(textOf(f.content))).length;
        const lastFloorHasMarker = floors.length > 0 && session.FLOOR_MARKER_HEAD_RE.test(textOf(floors[floors.length - 1].content));

        if (isContinue && syncedHashes.length > 0) {
          if (trimmedReply && !lastFloorHasMarker) {
            const lastAssistant = floors[floors.length - 1];
            const mergedContent = (textOf(lastAssistant && lastAssistant.content) + streamedText).trim();
            syncedHashes[syncedHashes.length - 1] = session.layerHash({
              ...(lastAssistant && lastAssistant.name != null ? { name: lastAssistant.name } : {}),
              role: 'assistant',
              content: mergedContent,
            });
          }
        } else if (trimmedReply && !lastFloorHasMarker) {
          syncedHashes.push(session.layerHash({ role: 'assistant', content: trimmedReply }));
        }

        const prevTurns = (drift.kind === 'deep' || rebuiltInRequest || !effectiveSess) ? 0 : (effectiveSess.turns || 0);
        const turns = (drift.kind === 'retry' && !rebuiltInRequest) ? Math.max(1, prevTurns) : prevTurns + 1;
        const forceDeepNext = turns >= config.MAX_TURNS_PER_SESSION;

        const postTurnAlias = (floors.length === 1 && trimmedReply)
          ? session.aliasKey([{ role: 'system', content: sysText }, floors[0], { role: 'assistant', content: trimmedReply }])
          : null;
        const latestState = session.loadState();
        const prevRec = latestState[sessionKey] || rawSess || {};
        const candidateKeys = Array.from(new Set([
          ...(Array.isArray(prevRec.keys) ? prevRec.keys : []),
          ...(Array.isArray(resolved.keys) ? resolved.keys : []),
          postTurnAlias,
        ].filter(Boolean)));
        const mergedKeys = candidateKeys.filter((k) => {
          if (latestState[k] && k !== sessionKey) return false;
          for (const [otherKey, otherRec] of Object.entries(latestState)) {
            if (otherKey === sessionKey) continue;
            if (otherRec && Array.isArray(otherRec.keys) && otherRec.keys.includes(k)) {
              return false;
            }
          }
          return true;
        });

        latestState[sessionKey] = {
          convId: forceDeepNext ? null : (r.conversationId || convIdToUse || null),
          model: modelUsed,
          turns,
          keys: mergedKeys,
          syncedHashes,
          numberedFloorCount,
          swipeStreak: nextSwipeStreak,
          dir: workspaceDir,
          sysHead: prevRec.sysHead || resolved.sysHead,
          updatedAt: Date.now(),
          conversationMissing: false,
        };
        session.saveState(latestState);
        out.finish(r.usage);

        log('turn done(session)', {
          key: sessionKey,
          drift: drift.kind,
          convId: latestState[sessionKey].convId,
          turns,
          forceDeepNext,
          hasRecord: record !== null,
          ...(isContinue ? { continue: true } : {}),
          ms: Date.now() - t0,
        });
      }, { onPreempt: () => ac.abort() });
    } catch (e) {
      clearInterval(keepAlive);
      log('turn error:', e.message);
      const isBusy = e instanceof BusyError || Boolean(e && (e.name === 'BusyError' || e.code === 'EBUSY'));
      out.error(e.message, isBusy ? 429 : 500);
    }
  });
});

server.on('error', (err) => {
  console.error(`[fatal] listen failed: ${err && err.message ? err.message : err}`);
  process.exit(1);
});

server.listen(config.PORT, config.HOST, () => {
  log(`agy-bridge v5 listening on http://${config.HOST}:${config.PORT} (mode=${isSessionMode() ? 'session' : 'stateless'})`);
});

if (require.main !== module) {
  server.unref();
}

module.exports = { server, queue, trySeedTimeline };
