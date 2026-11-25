#!/usr/bin/env node
'use strict';
/**
 * 预设融合验收：模拟「泉此方悬浮窗」的真实请求形态
 *  - 两张大预设块（每轮内容变化，模拟宏展开）
 *  - 一条巨型 assistant 消息，内含多个「（第N楼）」
 *  - 每轮 floors 递增
 * 运行：node tests/test-preset.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');
const PORT = 8802;
const STATE = path.join(os.tmpdir(), 'tp-state-' + process.pid + '.json');
const WORK = path.join(os.tmpdir(), 'tp-work-' + process.pid);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', (e) => resolve({ status: -1, body: String(e.message) }));
    req.write(data); req.end();
  });
}

function sseText(raw) {
  let out = '';
  for (const line of raw.split('\n')) {
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

// 预设块：每轮内容都变（模拟 {{getvar}} 宏展开）
function presetBefore(turn) {
  return '<task>你是最可爱的作家泉此方</task>\n' +
    '【初始化变量】轮次=' + turn + ' 状态=' + Math.random().toString(36).slice(2) + '\n' +
    '世界设定：'.repeat(600) + '\n本次随机种子=' + turn;
}
function presetAfter(turn) {
  return '[POST-HISTORY]\n' + '作者注：保持第三人称。'.repeat(200) + '\nround=' + turn;
}
function floor(n) {
  return '（第' + n + '楼）' + ('第' + n + '楼的正文内容，描写两人在厨房的互动。').repeat(120);
}
function blob(upto) {
  const parts = [];
  for (let i = 1; i <= upto; i++) parts.push(floor(i));
  return parts.join('\n\n');
}

(async () => {
  try { fs.unlinkSync(STATE); } catch {}
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

  const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
    env: {
      ...process.env, AGY_BIN: FAKE, AGY_BRIDGE_PORT: String(PORT),
      AGY_STATE_FILE: STATE, AGY_WORKSPACES: WORK,
      AGY_LOG_DIR: path.join(os.tmpdir(), 'tp-logs-' + process.pid),
      AGY_PROMPT_BUDGET: '170000', AGY_MAX_CONCURRENT: '1', AGY_SESSION_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (c) => { log += c.toString('utf8'); });
  srv.stderr.on('data', (c) => { log += c.toString('utf8'); });

  for (let i = 0; i < 60; i++) {
    await sleep(100);
    try {
      const ok = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (r) => { r.resume(); res(true); }).on('error', rej);
      });
      if (ok) break;
    } catch {}
  }

  const SYS = 'Write {{char}}\'s next reply in a fictional roleplay.';
  const keys = [];
  let reply = '';

  console.log('\n[1] 第 1 轮（预设块 v1 + 5 层）');
  const r1 = await post({ model: 'fake', stream: true, messages: [
    { role: 'system', content: SYS },
    { role: 'user', content: presetBefore(1) },
    { role: 'assistant', content: blob(5) },
    { role: 'user', content: presetAfter(1) },
    { role: 'user', content: '继续' },
  ]});
  reply = sseText(r1.body);
  console.log('    status', r1.status, '正文', reply.length, '字');
  assert.ok(reply.length > 0, '第 1 轮无正文');

  console.log('\n[2] 第 2 轮（预设块 v2 + 6 层，含上轮回复）');
  const r2 = await post({ model: 'fake', stream: true, messages: [
    { role: 'system', content: SYS },
    { role: 'user', content: presetBefore(2) },
    { role: 'assistant', content: blob(5) + '\n\n（第6楼）' + reply.trim() },
    { role: 'user', content: presetAfter(2) },
    { role: 'user', content: '继续' },
  ]});
  const reply2 = sseText(r2.body);
  console.log('    status', r2.status, '正文', reply2.length, '字');

  console.log('\n[3] 第 3 轮（预设块 v3 + 7 层）');
  const r3 = await post({ model: 'fake', stream: true, messages: [
    { role: 'system', content: SYS },
    { role: 'user', content: presetBefore(3) },
    { role: 'assistant', content: blob(5) + '\n\n（第6楼）' + reply.trim() + '\n\n（第7楼）' + reply2.trim() },
    { role: 'user', content: presetAfter(3) },
    { role: 'user', content: '继续' },
  ]});
  console.log('    status', r3.status);

  await sleep(300);
  const st = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};

  console.log('\n[4] 断言');
  await t('三轮只产生一个会话（键不受预设块变化影响）', () => {
    const n = Object.keys(st).length;
    assert.strictEqual(n, 1, '产生了 ' + n + ' 个会话：' + Object.keys(st).join(','));
  });
  await t('第 2、3 轮判定为 advance', () => {
    const adv = (log.match(/drift: 'advance'/g) || []).length;
    assert.ok(adv >= 2, 'advance 次数=' + adv + '\n日志尾部：\n' + log.slice(-1200));
  });
  await t('prompt 里包含预设块（system 被提升）', () => {
    const m = [...log.matchAll(/promptBytes: (\d+)/g)].map((x) => Number(x[1]));
    assert.ok(m.some((n) => n > 30000), 'promptBytes 都偏小：' + m.join(','));
  });
  await t('floorCount 被识别出来（>=5）', () => {
    const m = [...log.matchAll(/floorCount: (\d+)/g)].map((x) => Number(x[1]));
    assert.ok(m.some((n) => n >= 5), 'floorCount: ' + m.join(','));
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  srv.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
})();
