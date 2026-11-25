#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const config = require('./config');
const { runTurn } = require('./agy-runner');
const session = require('./session');
const archive = require('./archive');
const { TurnQueue } = require('./queue');

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
  const bin = process.env.AGY_BIN || config.AGY_BIN;
  execFile(
    bin,
    ['models'],
    { env: { ...process.env, HOME: config.HOME }, timeout: 60000 },
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
    const bin = process.env.AGY_BIN || config.AGY_BIN;
    let child;
    try {
      child = spawn(bin, ['-p', '/quota', '--print-timeout', '45s'], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: config.HOME, ELECTRON_RUN_AS_NODE: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      quotaCache = { at: now, text: String(e.message), parsed: [] };
      return resolve(quotaCache);
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 50000);
    child.on('close', () => {
      clearTimeout(timer);
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
  const payload = {
    id: 'chatcmpl-' + crypto.randomBytes(6).toString('hex'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish || null }],
  };
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function sendSseError(res, model, headersSent, errMsg) {
  const m = model || config.DEFAULT_MODEL;
  if (!headersSent && !res.headersSent) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    sseChunk(res, m, { role: 'assistant', content: '' }, null);
  }
  sseChunk(res, m, { content: '\n[桥接错误] ' + String(errMsg || 'unknown error') }, 'stop');
  res.write('data: [DONE]\n\n');
  res.end();
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
    if (m.role === 'user') turns.push('用户：' + t);
    else if (m.role === 'assistant') turns.push('你：' + t);
    else turns.push(m.role + '：' + t);
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

async function getStatelessSummary(key, droppedTurns) {
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
    const r = await runTurn({
      prompt: instruction + prev + fresh,
      model: SUMMARY_MODEL,
      effort: 'low',
    });
    const txt = (r.text || '').trim();
    if (!txt) return entry ? entry.summary || '' : '';
    summaries[key] = { covered: droppedTurns.length, summary: txt, at: Date.now() };
    summaryDirty = true;
    return txt;
  } catch {
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

  if (req.method === 'GET' && url === '/quota') {
    runQuota().then((q) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: q.parsed.length > 0, remaining: q.parsed, raw: q.text }, null, 2));
    });
    return;
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

  let raw = '';
  req.on('data', (c) => { raw += c.toString('utf8'); });
  req.on('end', async () => {
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (e) {
      log('bad json request:', e.message);
      return sendSseError(res, config.DEFAULT_MODEL, false, 'bad json: ' + e.message);
    }

    const model = (typeof body.model === 'string' && body.model.trim())
      ? body.model.trim()
      : config.DEFAULT_MODEL;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const effort = mapEffort(body.reasoning_effort);
    const t0 = Date.now();

    // 1. Separate system text and non-system messages
    const sysText = messages
      .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
    const nonSys = messages.filter((m) => m && m.role !== 'system' && m.role !== 'developer');
    const key = session.chatKey(messages);

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    sseChunk(res, model, { role: 'assistant', content: '' }, null);
    const keepAlive = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch {}
    }, 5000);

    try {
      // 2. SESSION_MODE == 0 -> stateless v4 behavior
      if (!isSessionMode()) {
        let built = buildStatelessPrompt(messages, '');
        if (built.meta.dropped.length) {
          const sum = await getStatelessSummary(key, built.meta.dropped);
          if (sum) built = buildStatelessPrompt(messages, sum);
        }
        const prompt = built.prompt;

        let modelUsed = model;
        let sentCount = 0;
        const r = await queue.run(key, async () => {
          let resTurn = await runTurn({
            prompt,
            model: modelUsed,
            effort,
            onDelta: (delta) => {
              sentCount += delta.length;
              sseChunk(res, modelUsed, { content: delta }, null);
            },
          });
          if (resTurn.code !== 0 && !resTurn.text && sentCount === 0) {
            const fb = pickFallback(modelUsed, resTurn.stderr);
            if (fb) {
              log('fallback(stateless)', { from: modelUsed, to: fb });
              modelUsed = fb;
              resTurn = await runTurn({
                prompt,
                model: modelUsed,
                effort,
                onDelta: (delta) => {
                  sentCount += delta.length;
                  sseChunk(res, modelUsed, { content: delta }, null);
                },
              });
            }
          }
          return resTurn;
        });

        clearInterval(keepAlive);
        if (r.code !== 0 && !r.text) {
          throw new Error(r.stderr || `agy exited with code ${r.code}`);
        }
        if (r.text && sentCount === 0) {
          sseChunk(res, modelUsed, { content: r.text }, null);
        }
        sseChunk(res, modelUsed, {}, 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
        log('turn done(stateless)', { key, ms: Date.now() - t0, chars: (r.text || '').length, modelUsed });
        return;
      }

      // 3. Session mode: chatKey / alias -> driftOf -> prompt
      const state = session.loadState();
      const resolved = session.resolveSession(state, messages);
      const sessionKey = resolved.key;
      const rawSess = resolved.sess;
      const effectiveSess = getEffectiveSession(rawSess);
      const drift = session.driftOf(effectiveSess, nonSys);

      const workspaceDir = (rawSess && rawSess.dir) ? rawSess.dir : path.join(config.WORKSPACES, sessionKey);
      const timelinePath = path.join(workspaceDir, 'timeline.md');
      try {
        fs.mkdirSync(workspaceDir, { recursive: true });
      } catch {}

      let prompt = '';
      let convIdToUse = null;
      let nextSwipeStreak = 0;

      if (drift.kind === 'advance') {
        const lastUser = [...nonSys].reverse().find((m) => m && m.role === 'user') || nonSys[nonSys.length - 1];
        prompt = lastUser ? textOf(lastUser.content) : '';
        if (Buffer.byteLength(prompt, 'utf8') > config.PROMPT_BUDGET) {
          prompt = tailUtf8(prompt, config.PROMPT_BUDGET);
        }
        convIdToUse = effectiveSess.convId;
        nextSwipeStreak = 0;
      } else if (drift.kind === 'shallow') {
        prompt = session.buildOverride({ divIdx: drift.divIdx, messages: nonSys });
        convIdToUse = effectiveSess.convId;
        nextSwipeStreak = ((effectiveSess && effectiveSess.swipeStreak) || 0) + 1;
      } else {
        const timeline = archive.readTimeline(timelinePath, Math.floor(config.PROMPT_BUDGET * 0.2));
        prompt = session.buildBootstrap({
          system: sysText,
          messages: nonSys,
          timeline,
          budgetBytes: config.PROMPT_BUDGET,
        });
        convIdToUse = null;
        nextSwipeStreak = 0;
      }

      log('turn start(session)', {
        key: sessionKey,
        drift: drift.kind,
        divIdx: drift.divIdx,
        convId: convIdToUse || 'NEW',
        model,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        floors: nonSys.length,
      });

      // 4 & 5. Run through TurnQueue and stream filtered deltas via recordFilter
      let modelUsed = model;
      let filter = archive.recordFilter();
      let rawDeltaCount = 0;

      const r = await queue.run(sessionKey, async () => {
        let resTurn = await runTurn({
          prompt,
          model: modelUsed,
          conversationId: convIdToUse,
          effort,
          addDirs: [workspaceDir],
          cwd: workspaceDir,
          timeoutMs: config.TURN_TIMEOUT_MS,
          onDelta: (delta) => {
            rawDeltaCount += delta.length;
            const safe = filter.push(delta);
            if (safe) {
              sseChunk(res, modelUsed, { content: safe }, null);
            }
          },
        });

        if (resTurn.code !== 0 && !resTurn.text && rawDeltaCount === 0) {
          const fb = pickFallback(modelUsed, resTurn.stderr);
          if (fb) {
            log('fallback(session)', { key: sessionKey, from: modelUsed, to: fb });
            modelUsed = fb;
            filter = archive.recordFilter();
            resTurn = await runTurn({
              prompt,
              model: modelUsed,
              conversationId: convIdToUse,
              effort,
              addDirs: [workspaceDir],
              cwd: workspaceDir,
              timeoutMs: config.TURN_TIMEOUT_MS,
              onDelta: (delta) => {
                rawDeltaCount += delta.length;
                const safe = filter.push(delta);
                if (safe) {
                  sseChunk(res, modelUsed, { content: safe }, null);
                }
              },
            });
          }
        }
        return resTurn;
      });

      clearInterval(keepAlive);

      if (r.code !== 0 && !r.text) {
        throw new Error(r.stderr || `agy exited with code ${r.code}`);
      }

      if (rawDeltaCount === 0 && r.text) {
        const pushed = filter.push(r.text);
        if (pushed) sseChunk(res, modelUsed, { content: pushed }, null);
      }
      const tail = filter.flush();
      if (tail) {
        sseChunk(res, modelUsed, { content: tail }, null);
      }

      sseChunk(res, modelUsed, {}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();

      // 6 & 7. Extract <ta_record>, persist timeline.md, and update session state
      const { clean, record } = archive.extractRecord(r.text || '');
      const currentFloor = nonSys.length;
      if (record !== null || drift.kind === 'shallow') {
        try {
          archive.upsertFloor(timelinePath, currentFloor, record || '');
        } catch (err) {
          log('upsertFloor error:', err.message);
        }
      }

      const syncedHashes = nonSys.map(session.layerHash);
      syncedHashes.push(session.layerHash({ role: 'assistant', content: clean }));

      const prevTurns = (drift.kind === 'deep' || !effectiveSess) ? 0 : (effectiveSess.turns || 0);
      const turns = prevTurns + 1;
      const forceDeepNext = Boolean(r.conversationMissing) || turns >= config.MAX_TURNS_PER_SESSION;

      const latestState = session.loadState();
      const prevRec = latestState[sessionKey] || rawSess || {};
      const mergedKeys = Array.from(new Set([
        ...(Array.isArray(prevRec.keys) ? prevRec.keys : []),
        ...(Array.isArray(resolved.keys) ? resolved.keys : []),
        resolved.primary,
        resolved.alias,
      ].filter(Boolean)));

      latestState[sessionKey] = {
        convId: forceDeepNext ? null : (r.conversationId || convIdToUse || null),
        model: modelUsed,
        turns,
        keys: mergedKeys,
        syncedHashes,
        swipeStreak: nextSwipeStreak,
        dir: workspaceDir,
        sysHead: prevRec.sysHead || resolved.sysHead,
        updatedAt: Date.now(),
        conversationMissing: Boolean(r.conversationMissing),
      };
      session.saveState(latestState);

      log('turn done(session)', {
        key: sessionKey,
        drift: drift.kind,
        convId: latestState[sessionKey].convId,
        turns,
        forceDeepNext,
        hasRecord: record !== null,
        ms: Date.now() - t0,
      });
    } catch (e) {
      clearInterval(keepAlive);
      log('turn error:', e.message);
      sendSseError(res, model, true, e.message);
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

module.exports = { server, queue };
