#!/usr/bin/env node
'use strict';
/**
 * 第三批验收：服务级（真实 HTTP，假 agy，不花额度）
 * 运行：node tests/test-server.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');
const PORT = 8801;
const STATE = path.join(os.tmpdir(), 't3-state-' + process.pid + '.json');
const WORK = path.join(os.tmpdir(), 't3-work-' + process.pid);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(body, { abortAfterMs } = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', (e) => resolve({ status: -1, error: String(e.message) }));
    req.write(data); req.end();
    if (abortAfterMs) setTimeout(() => req.destroy(), abortAfterMs);
  });
}

function parseSse(text) {
  let out = '', done = false;
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s.startsWith('data: ')) continue;
    const p = s.slice(6);
    if (p === '[DONE]') { done = true; continue; }
    try {
      const j = JSON.parse(p);
      const d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (d) out += d;
    } catch {}
  }
  return { text: out, done };
}

(async () => {
  try { fs.unlinkSync(STATE); } catch {}
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

  const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
    env: {
      ...process.env,
      AGY_BIN: FAKE,
      AGY_BRIDGE_PORT: String(PORT),
      AGY_STATE_FILE: STATE,
      AGY_WORKSPACES: WORK,
      AGY_LOG_DIR: path.join(os.tmpdir(), 't3-logs-' + process.pid),
      AGY_PROMPT_BUDGET: '60000',
      AGY_MAX_CONCURRENT: '1',
      AGY_SESSION_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let srvLog = '';
  srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
  srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

  for (let i = 0; i < 50; i++) {
    await sleep(100);
    try {
      const r = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (rr) => {
          let b = ''; rr.on('data', (c) => { b += c; }); rr.on('end', () => res(b));
        }).on('error', rej);
      });
      if (r) break;
    } catch {}
  }

  const SYS = '你是小说引擎。';
  const U1 = '开第一篇：雨夜推门。';

  console.log('\n[1] stream: false 必须返回合法 JSON');
  await t('非流式返回 chat.completion 结构', async () => {
    const r = await post({ model: 'fake', stream: false, messages: [{ role: 'system', content: SYS }, { role: 'user', content: U1 }] });
    assert.strictEqual(r.status, 200, 'HTTP ' + r.status);
    assert.ok(!r.body.startsWith('data:'), '仍返回了 SSE');
    const j = JSON.parse(r.body);
    assert.ok(j.choices && j.choices[0].message.content.length > 0, 'content 为空');
    assert.ok(!j.choices[0].message.content.includes('<ta_record>'), '归档标签泄漏');
  });

  console.log('\n[2] 首段正文之前报错 → 500 且不提交状态');
  await t('failhard 返回 5xx 且 sessions 不变', async () => {
    const before = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '';
    const r = await post({ model: 'fake', stream: true, messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'failhard 这句会失败' }] });
    assert.ok(r.status >= 400, 'HTTP ' + r.status);
    const after = fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '';
    assert.strictEqual(after, before, '状态被污染了');
  });

  console.log('\n[3] 部分输出后失败 → 不提交状态');
  await t('failmid 不推进 turns', async () => {
    const parse = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
    const before = parse(fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '{}');
    const beforeTurns = Object.values(before).reduce((n, v) => n + (v.turns || 0), 0);
    await post({ model: 'fake', stream: true, messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'failmid 这句也会失败' }] });
    await sleep(200);
    const after = parse(fs.existsSync(STATE) ? fs.readFileSync(STATE, 'utf8') : '{}');
    const afterTurns = Object.values(after).reduce((n, v) => n + (v.turns || 0), 0);
    assert.strictEqual(afterTurns, beforeTurns, '失败请求推进了 turns');
  });

  console.log('\n[4] 连续两轮 → advance（哈希 trim 对齐）');
  await t('第二轮不重建（只有一个会话目录）', async () => {
    const r1 = await post({ model: 'fake', stream: true, messages: [{ role: 'system', content: SYS }, { role: 'user', content: '第二篇：雨后。' }] });
    const a1 = parseSse(r1.body).text;
    assert.ok(a1.length > 0, '第一轮无正文');
    const r2 = await post({ model: 'fake', stream: true, messages: [
      { role: 'system', content: SYS + '世界书新增：书店有猫。' },
      { role: 'user', content: '第二篇：雨后。' },
      { role: 'assistant', content: a1.trim() },
      { role: 'user', content: '那只猫叫什么？' },
    ] });
    assert.strictEqual(r2.status, 200);
    const logs = srvLog;
    assert.ok(/drift: 'advance'/.test(logs), '第二轮未判定为 advance：\n' + logs.slice(-800));
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  srv.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
})();
