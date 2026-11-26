#!/usr/bin/env node
'use strict';
/**
 * 分片预热（Chunked Warm-up Bootstrap）验收测试（FIX-12）
 * 运行：node tests/test-warmup.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');

const config = require(path.join(SRC, 'config.js'));
const serverMod = require(path.join(SRC, 'server.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}
async function ta(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

function httpPost(port, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', (e) => resolve({ status: -1, body: String(e.message) }));
    req.write(data);
    req.end();
  });
}

function parseSseText(raw) {
  let out = '';
  for (const line of String(raw || '').split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data: ')) continue;
    const p = s.slice(6);
    if (p === '[DONE]') continue;
    try {
      const j = JSON.parse(p);
      const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (d) out += d;
    } catch {}
  }
  return out;
}

function readFakeAgyLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function build400KBPayload(finalUserInput = 'FINAL_USER_INPUT_999：请总结ALPHA与BETA并继续剧情') {
  const sys = '你是长篇小说创作引擎，请严格保持人物性格与叙事连贯。';
  const presetPost = '[POST-INSTRUCTION]\n' + '后置写作规范：保持第三人称限知视角，细腻描写环境与心理。'.repeat(60); // > 4KB
  const floors = [];
  // 42 floors * ~9.6KB each ≈ 403KB
  for (let i = 1; i <= 42; i++) {
    const tag = i === 5 ? 'ALPHA-777' : (i === 25 ? 'BETA-888' : `MARKER-${i}`);
    const body = `第${i}楼剧情推进（${tag}）：` + '夜雨敲打着旧书店的玻璃窗，油灯微弱的光芒映在书架上。'.repeat(130);
    floors.push(`（第${i}楼）${body}`);
  }
  return {
    sys,
    presetPost,
    mergedFloors: floors.join('\n\n'),
    finalUserInput,
    messages: [
      { role: 'system', content: sys },
      { role: 'assistant', content: floors.join('\n\n') },
      { role: 'user', content: presetPost },
      { role: 'user', content: finalUserInput },
    ],
  };
}

(async () => {
  console.log('\n[1] C1 配置校验与 C2 splitBootstrapForWarmup 单元测试');
  t('WARM_CHUNK_BYTES 合法与非法值回退 165000，splitBootstrapForWarmup 边界与分片不丢历史', () => {
    assert.strictEqual(config.parseWarmChunkBytes('100000', 180000), 100000);
    assert.strictEqual(config.parseWarmChunkBytes('180000', 180000), 180000);
    assert.strictEqual(config.parseWarmChunkBytes('181000', 180000), 165000, '超过 PROMPT_BUDGET 应回退 165000');
    assert.strictEqual(config.parseWarmChunkBytes('185000', 190000), 165000, '>= 185000 应回退 165000');
    assert.strictEqual(config.parseWarmChunkBytes('-50', 180000), 165000);
    assert.strictEqual(config.parseWarmChunkBytes('invalid', 180000), 165000);

    // D1 & F5: CHUNKED_TOTAL_BUDGET 校验（默认 700000，上限 3000000，< WARM_CHUNK_BYTES 回退 WARM_CHUNK_BYTES * 6，> 800000 警告）
    assert.strictEqual(config.parseChunkedTotalBudget(undefined, 165000), 700000);
    assert.strictEqual(config.parseChunkedTotalBudget('', 165000), 700000);
    let warnMsg = '';
    const origWarn = console.warn;
    console.warn = (...args) => { warnMsg += args.join(' ') + '\n'; };
    try {
      assert.strictEqual(config.parseChunkedTotalBudget('1500000', 165000), 1500000);
      assert.ok(warnMsg.includes('chunked budget may approach auto-compact threshold'), '超 800000 应打警告日志');
      assert.strictEqual(config.parseChunkedTotalBudget('9000000', 165000), 3000000, '超过 3000000 应钳制到 3000000');
      assert.strictEqual(config.parseChunkedTotalBudget('100000', 165000), 165000 * 6, '< WARM_CHUNK_BYTES 应回退 WARM_CHUNK_BYTES * 6');
      assert.strictEqual(config.parseChunkedTotalBudget('-1', 165000), 165000 * 6);
      assert.strictEqual(config.parseChunkedTotalBudget('invalid', 165000), 165000 * 6);
    } finally {
      console.warn = origWarn;
    }

    // F1: 400KB 内容按默认 165KB 逆向装箱 -> 分片数 <= 3，每片 <= 165000，最小片 >= 20000，且呈前小后大
    const payloadF1 = build400KBPayload();
    const chunksF1 = serverMod.splitBootstrapForWarmup({
      system: payloadF1.sys,
      messages: payloadF1.messages,
      timeline: '<!-- floor: 1 -->\n开篇归档\n',
    }, { warmChunkBytes: 165000, warmMaxChunks: 8 });
    assert.ok(chunksF1.length <= 3, `F1: 400KB 内容按 165KB 逆向装箱应 <= 3 片，实际 ${chunksF1.length} 片`);
    const sizesF1 = chunksF1.map((c) => Buffer.byteLength(c, 'utf8'));
    for (let i = 0; i < sizesF1.length; i++) {
      assert.ok(sizesF1[i] <= 165000, `F1: 第 ${i + 1} 片 (${sizesF1[i]}B) 超过 165KB`);
      assert.ok(sizesF1[i] >= 20000, `F1: 第 ${i + 1} 片 (${sizesF1[i]}B) 小于 20KB`);
    }
    assert.ok(sizesF1[0] < sizesF1[sizesF1.length - 1], `F1: 分片尺寸应呈前小后大，实际 [${sizesF1.join(', ')}]`);

    // <= WARM_CHUNK_BYTES 时返回 1 片
    const smallChunks = serverMod.splitBootstrapForWarmup({
      system: 'sys',
      messages: [
        { role: 'user', content: '（第1楼）开场' },
        { role: 'assistant', content: '（第2楼）回应' },
        { role: 'user', content: '继续' },
      ],
    }, { warmChunkBytes: 100000 });
    assert.strictEqual(smallChunks.length, 1, '未超预算应只返回 1 片');

    // 400KB 拆片：每片 <= 100000，不丢 ALPHA-777 与 BETA-888，收尾片含 [POST] 与用户输入
    const payload = build400KBPayload();
    const chunks = serverMod.splitBootstrapForWarmup({
      system: payload.sys,
      messages: payload.messages,
      timeline: '<!-- floor: 1 -->\n开篇归档\n',
    }, { warmChunkBytes: 100000, warmMaxChunks: 8 });

    assert.ok(chunks.length >= 4, `400KB 按 100KB 拆片应 >= 4 片，实际 ${chunks.length}`);
    for (let i = 0; i < chunks.length; i++) {
      const b = Buffer.byteLength(chunks[i], 'utf8');
      assert.ok(b <= 100000, `第 ${i + 1} 片字节数 ${b} 超过 100000`);
    }
    const combined = chunks.join('\n\n');
    assert.ok(combined.includes('ALPHA-777'), '拆片后丢失早期楼层 ALPHA-777');
    assert.ok(combined.includes('BETA-888'), '拆片后丢失中段楼层 BETA-888');
    const lastChunk = chunks[chunks.length - 1];
    assert.ok(lastChunk.includes('[POST]'), '收尾片缺少 [POST]');
    assert.ok(lastChunk.includes(payload.finalUserInput), '收尾片缺少本轮用户输入');
  });

  console.log('\n[2] 400KB bootstrap + WARM_CHUNK_BYTES=100000 端到端分片预热');
  await ta('触发 >=4 次 agy 调用、前 N-1 次含上下文分片、末次含用户输入、正文只出现一次、convId 等于末次返回', async () => {
    const PORT = 8821;
    const STATE = path.join(os.tmpdir(), `warm-state-${process.pid}-1.json`);
    const WORK = path.join(os.tmpdir(), `warm-work-${process.pid}-1`);
    const FAKE_LOG = path.join(os.tmpdir(), `fake-agy-log-${process.pid}-1.jsonl`);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.unlinkSync(FAKE_LOG); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), `warm-logs-${process.pid}-1`),
        AGY_SESSION_MODE: '1',
        AGY_CHUNKED_BOOTSTRAP: '1',
        AGY_WARM_CHUNK_BYTES: '100000',
        AGY_WARM_MODEL: 'gemini-4-argon-low',
        FAKE_AGY_LOG: FAKE_LOG,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
    srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      const payload = build400KBPayload('USER_FINAL_QUERY_2026：请回答预热测试');
      const res = await httpPost(PORT, {
        model: 'gemini-4-argon-high',
        stream: true,
        messages: payload.messages,
      });

      assert.strictEqual(res.status, 200, `期望 HTTP 200，实际 ${res.status}: ${res.body}`);
      const replyText = parseSseText(res.body);
      const occurrences = (replyText.match(/正文一段。中文测试/g) || []).length;
      assert.strictEqual(occurrences, 1, `正文应只出现 1 次（不得泄漏预热输出），实际出现 ${occurrences} 次: ${replyText}`);

      const calls = readFakeAgyLog(FAKE_LOG).filter((c) => !c.prompt.includes('/quota'));
      assert.ok(calls.length >= 4, `期望发生 >= 4 次 agy 调用，实际 ${calls.length} 次`);

      for (let i = 0; i < calls.length - 1; i++) {
        assert.ok(
          calls[i].prompt.includes(`上下文分片 ${i + 1}/${calls.length}`),
          `第 ${i + 1} 次调用应包含 "上下文分片 ${i + 1}/${calls.length}"`
        );
        assert.strictEqual(calls[i].model, 'gemini-4-argon-low', '预热轮应使用 WARM_MODEL');
      }

      const lastCall = calls[calls.length - 1];
      assert.ok(!lastCall.prompt.includes('上下文分片'), '最后一次调用不应含预热前缀');
      assert.ok(lastCall.prompt.includes(payload.finalUserInput), '最后一次调用必须含本轮用户输入');
      assert.strictEqual(lastCall.model, 'gemini-4-argon-high', '收尾轮应使用用户请求模型');

      const allPromptsJoined = calls.map((c) => c.prompt).join('\n');
      assert.ok(allPromptsJoined.includes('ALPHA-777') && allPromptsJoined.includes('BETA-888'), '分片预热应完整保留所有历史楼层');

      const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const sessKey = Object.keys(st)[0];
      assert.ok(sessKey && st[sessKey], 'sessions.json 应有会话记录');
      assert.strictEqual(
        st[sessKey].convId,
        lastCall.returnedConversationId,
        `sessions.json 的 convId (${st[sessKey].convId}) 应等于最后一次调用返回的 conversationId (${lastCall.returnedConversationId})`
      );

      assert.ok(srvLog.includes('chunked: true'), '日志应包含 chunked: true');
      assert.ok(srvLog.includes('warmup 1/'), '日志应包含 warmup 进度');
      assert.ok(srvLog.includes('warmup final:'), '日志应包含 warmup final');
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.unlinkSync(FAKE_LOG); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log('\n[3] 预热失败自动降级单轮 bootstrap，HTTP 仍 200');
  await ta('fake-agy 在预热轮返回错误时自动降级 single-shot bootstrap 且返回 HTTP 200', async () => {
    const PORT = 8822;
    const STATE = path.join(os.tmpdir(), `warm-state-${process.pid}-2.json`);
    const WORK = path.join(os.tmpdir(), `warm-work-${process.pid}-2`);
    const FAKE_LOG = path.join(os.tmpdir(), `fake-agy-log-${process.pid}-2.jsonl`);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.unlinkSync(FAKE_LOG); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), `warm-logs-${process.pid}-2`),
        AGY_SESSION_MODE: '1',
        AGY_CHUNKED_BOOTSTRAP: '1',
        AGY_WARM_CHUNK_BYTES: '100000',
        FAKE_AGY_LOG: FAKE_LOG,
        FAKE_WARMUP_FAIL: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
    srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      const payload = build400KBPayload('FALLBACK_USER_INPUT_777');
      const res = await httpPost(PORT, {
        model: 'fake',
        stream: false,
        messages: payload.messages,
      });

      assert.strictEqual(res.status, 200, `预热失败降级后仍应返回 HTTP 200，实际 ${res.status}: ${res.body}`);
      const bodyJson = JSON.parse(res.body);
      const content = bodyJson.choices && bodyJson.choices[0] && bodyJson.choices[0].message.content;
      assert.ok(content && content.includes('正文一段。中文测试'), `降级后应正常返回正文，实际: ${content}`);
      assert.ok(srvLog.includes('warmup fallback: single-shot'), `日志应包含 "warmup fallback: single-shot"，实际:\n${srvLog}`);

      const calls = readFakeAgyLog(FAKE_LOG);
      const lastCall = calls[calls.length - 1];
      assert.ok(!lastCall.prompt.includes('上下文分片'), '降级后的单轮调用不应包含预热前缀');
      assert.ok(lastCall.prompt.includes('FALLBACK_USER_INPUT_777'), '降级后的单轮调用应保留尾部用户输入');
      assert.ok(lastCall.bytes <= 180000, `预热失败降级路径必须是 <= 180KB 的单轮，实际 ${lastCall.bytes}B`);
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.unlinkSync(FAKE_LOG); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log('\n[4] AGY_CHUNKED_BOOTSTRAP=0 时完全不预热');
  await ta('AGY_CHUNKED_BOOTSTRAP=0 时 400KB 请求直接走单轮 bootstrap（仅 1 次 agy 调用）', async () => {
    const PORT = 8823;
    const STATE = path.join(os.tmpdir(), `warm-state-${process.pid}-3.json`);
    const WORK = path.join(os.tmpdir(), `warm-work-${process.pid}-3`);
    const FAKE_LOG = path.join(os.tmpdir(), `fake-agy-log-${process.pid}-3.jsonl`);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.unlinkSync(FAKE_LOG); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), `warm-logs-${process.pid}-3`),
        AGY_SESSION_MODE: '1',
        AGY_CHUNKED_BOOTSTRAP: '0',
        AGY_WARM_CHUNK_BYTES: '100000',
        FAKE_AGY_LOG: FAKE_LOG,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
    srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      const payload = build400KBPayload('DISABLED_WARMUP_INPUT_888');
      const res = await httpPost(PORT, {
        model: 'fake',
        stream: false,
        messages: payload.messages,
      });

      assert.strictEqual(res.status, 200, `期望 HTTP 200，实际 ${res.status}`);
      const calls = readFakeAgyLog(FAKE_LOG).filter((c) => !c.prompt.includes('/quota'));
      assert.strictEqual(calls.length, 1, `AGY_CHUNKED_BOOTSTRAP=0 应只发生 1 次调用，实际 ${calls.length} 次`);
      assert.ok(!calls[0].prompt.includes('上下文分片'), '不应包含预热前缀');
      assert.ok(srvLog.includes('chunked: false'), '日志应记录 chunked: false');
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.unlinkSync(FAKE_LOG); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log('\n[5] 400KB 历史 + CHUNKED_TOTAL_BUDGET=1000000（默认 165KB 分片突破 192KB 墙）');
  await ta('400KB 历史 + CHUNKED_TOTAL_BUDGET=1000000 -> chunks >= 3、每片 <= 185000、最后一片含用户输入且总预热突破 192KB', async () => {
    const PORT = 8824;
    const STATE = path.join(os.tmpdir(), `warm-state-${process.pid}-4.json`);
    const WORK = path.join(os.tmpdir(), `warm-work-${process.pid}-4`);
    const FAKE_LOG = path.join(os.tmpdir(), `fake-agy-log-${process.pid}-4.jsonl`);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.unlinkSync(FAKE_LOG); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), `warm-logs-${process.pid}-4`),
        AGY_SESSION_MODE: '1',
        AGY_CHUNKED_BOOTSTRAP: '1',
        AGY_CHUNKED_TOTAL_BUDGET: '1000000',
        FAKE_AGY_LOG: FAKE_LOG,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
    srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      const payload = build400KBPayload('BIG_BUDGET_FINAL_INPUT_2026：确认大预算分片完整送达');
      const res = await httpPost(PORT, {
        model: 'gemini-4-argon-high',
        stream: false,
        messages: payload.messages,
      });

      assert.strictEqual(res.status, 200, `期望 HTTP 200，实际 ${res.status}: ${res.body}`);
      const calls = readFakeAgyLog(FAKE_LOG).filter((c) => !c.prompt.includes('/quota'));
      assert.ok(calls.length >= 3, `期望 chunks >= 3，实际调用 ${calls.length} 次`);

      let totalSentBytes = 0;
      for (let i = 0; i < calls.length; i++) {
        totalSentBytes += calls[i].bytes;
        assert.ok(calls[i].bytes <= 185000, `第 ${i + 1} 片字节数 ${calls[i].bytes} 超过 185000`);
      }
      assert.ok(totalSentBytes > 350000, `总发送字节数 (${totalSentBytes}B) 应突破 192KB 墙并完整保留 400KB 历史`);

      const allPrompts = calls.map((c) => c.prompt).join('\n');
      assert.ok(allPrompts.includes('ALPHA-777'), '大预算分片不应截断早期楼层 ALPHA-777');
      assert.ok(allPrompts.includes('BETA-888'), '大预算分片不应截断中段楼层 BETA-888');

      const lastCall = calls[calls.length - 1];
      assert.ok(lastCall.prompt.includes(payload.finalUserInput), 'fake-agy 收到的最后一片必须包含用户输入');
      assert.ok(lastCall.prompt.includes('[POST]'), 'fake-agy 收到的最后一片必须包含 [POST]');
      assert.ok(srvLog.includes('chunkTotalBudget: 1000000'), 'turn start 日志应包含 chunkTotalBudget: 1000000');
      assert.ok(srvLog.includes('chunkBytes:'), 'turn start 日志应包含 chunkBytes');
      assert.ok(calls.length <= 3, `F1: 400KB 内容分片数应 <= 3，实际 ${calls.length}`);
      for (let i = 0; i < calls.length; i++) {
        assert.ok(calls[i].bytes <= 165000, `F1: 第 ${i + 1} 片 (${calls[i].bytes}B) 应 <= 165KB`);
        assert.ok(calls[i].bytes >= 20000, `F1: 第 ${i + 1} 片 (${calls[i].bytes}B) 应 >= 20KB`);
      }
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.unlinkSync(FAKE_LOG); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log('\n[6] F2 单条 200KB 无标记消息软切分 -> HTTP 200 且 fake-agy 收到 >= 2 片');
  await ta('单条 200KB 无楼层标记消息不返回 500，软切分为多个伪楼层并触发 >= 2 片分片预热', async () => {
    const PORT = 8825;
    const STATE = path.join(os.tmpdir(), `warm-state-${process.pid}-5.json`);
    const WORK = path.join(os.tmpdir(), `warm-work-${process.pid}-5`);
    const FAKE_LOG = path.join(os.tmpdir(), `fake-agy-log-${process.pid}-5.jsonl`);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.unlinkSync(FAKE_LOG); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), `warm-logs-${process.pid}-5`),
        AGY_SESSION_MODE: '1',
        AGY_CHUNKED_BOOTSTRAP: '1',
        FAKE_AGY_LOG: FAKE_LOG,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      // 构造单条 ~205KB 且完全无「（第N楼）」标记的消息（带段落与句号供软切分）
      const para = '这是一段没有任何楼层标记的超长设定与剧情文本，风雪夜归人推开了木门。'.repeat(25);
      const unmarked200KB = 'UNMARKED_HEAD_101 ' + Array.from({ length: 85 }, (_, i) => `段落${i + 1}：${para}`).join('\n\n') + ' UNMARKED_TAIL_202';
      assert.ok(Buffer.byteLength(unmarked200KB, 'utf8') >= 200000, '测试文本应 >= 200KB');

      const res = await httpPost(PORT, {
        model: 'gemini-4-argon-high',
        stream: false,
        messages: [
          { role: 'system', content: '你是小说创作引擎。' },
          { role: 'user', content: unmarked200KB },
        ],
      });

      assert.strictEqual(res.status, 200, `单条 200KB 无标记消息必须返回 HTTP 200（绝不 500），实际 ${res.status}: ${res.body}`);
      const calls = readFakeAgyLog(FAKE_LOG).filter((c) => !c.prompt.includes('/quota'));
      assert.ok(calls.length >= 2, `fake-agy 应收到 >= 2 片，实际收到 ${calls.length} 片`);
      const combined = calls.map((c) => c.prompt).join('\n');
      assert.ok(combined.includes('UNMARKED_HEAD_101') && combined.includes('UNMARKED_TAIL_202'), '软切分后首尾内容均应保留');
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.unlinkSync(FAKE_LOG); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log('\n[7] F4 advance 轮 postBlocks 行级差分注入');
  await ta('advance 轮 postBlocks 变化 -> prompt 含 [本轮动态设定更新] 且只含变化行（不含静态规则行）', async () => {
    const PORT = 8826;
    const STATE = path.join(os.tmpdir(), `warm-state-${process.pid}-6.json`);
    const WORK = path.join(os.tmpdir(), `warm-work-${process.pid}-6`);
    const FAKE_LOG = path.join(os.tmpdir(), `fake-agy-log-${process.pid}-6.jsonl`);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.unlinkSync(FAKE_LOG); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), `warm-logs-${process.pid}-6`),
        AGY_SESSION_MODE: '1',
        FAKE_AGY_LOG: FAKE_LOG,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      const staticRules = Array.from({ length: 120 }, (_, i) => `STATIC_RULE_LINE_${i + 1}：保持第三人称限知视角与古典文风规范。`).join('\n');
      const postTurn1 = `[POST-PRESET]\n${staticRules}\n动态好感度：50\n动态地点：旧书店`;
      const postTurn2 = `[POST-PRESET]\n${staticRules}\n动态好感度：80\n动态地点：旧书店\n新增状态：解锁密室钥匙`;

      // 第 1 轮（deep）：全量注入 [POST] 并记录 lastPostText
      const r1 = await httpPost(PORT, {
        model: 'fake',
        stream: false,
        messages: [
          { role: 'system', content: '你是角色扮演引擎。' },
          { role: 'user', content: '（第1楼）推开书店的门。' },
          { role: 'user', content: postTurn1 },
          { role: 'user', content: '打量四周' },
        ],
      });
      assert.strictEqual(r1.status, 200);
      const reply1 = JSON.parse(r1.body).choices[0].message.content.trim();

      // 第 2 轮（advance）：postBlocks 发生变化，仅注入变化行
      const r2 = await httpPost(PORT, {
        model: 'fake',
        stream: false,
        messages: [
          { role: 'system', content: '你是角色扮演引擎。' },
          { role: 'user', content: '（第1楼）推开书店的门。' },
          { role: 'user', content: '打量四周' },
          { role: 'assistant', content: reply1 },
          { role: 'user', content: postTurn2 },
          { role: 'user', content: 'USER_ADVANCE_ACTION_2：走向书架暗门' },
        ],
      });
      assert.strictEqual(r2.status, 200);

      const calls = readFakeAgyLog(FAKE_LOG).filter((c) => !c.prompt.includes('/quota'));
      assert.strictEqual(calls.length, 2, `两轮对话应发生 2 次调用，实际 ${calls.length}`);
      const advPrompt = calls[1].prompt;
      assert.ok(advPrompt.includes('[本轮动态设定更新]'), `advance prompt 应包含 [本轮动态设定更新]，实际:\n${advPrompt}`);
      assert.ok(advPrompt.includes('动态好感度：80'), '应包含修改后的行 "动态好感度：80"');
      assert.ok(advPrompt.includes('新增状态：解锁密室钥匙'), '应包含新增的行 "新增状态：解锁密室钥匙"');
      assert.ok(!advPrompt.includes('STATIC_RULE_LINE_1'), '静态规则行不应重复注入');
      assert.ok(!advPrompt.includes('动态地点：旧书店'), '未变化的动态行不应重复注入');
      assert.ok(
        advPrompt.indexOf('[本轮动态设定更新]') < advPrompt.indexOf('USER_ADVANCE_ACTION_2'),
        '[本轮动态设定更新] 应位于用户输入之前'
      );
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.unlinkSync(FAKE_LOG); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
