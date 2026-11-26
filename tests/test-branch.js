#!/usr/bin/env node
'use strict';
/**
 * 分支感知验收
 *  - 同聊天连续两轮 → reuse，单分支
 *  - 回退开新线 → fork，独立目录
 *  - 切回原线 → reuse，convId 与原分支一致
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');
const PORT = 8803;
const STATE = path.join(os.tmpdir(), 'tb-state-' + process.pid + '.json');
const WORK = path.join(os.tmpdir(), 'tb-work-' + process.pid);

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

function floor(n) { return '（第' + n + '楼）第' + n + '楼正文，' + '剧情推进。'.repeat(60); }
function blob(upto) {
  const a = [];
  for (let i = 1; i <= upto; i++) a.push(floor(i));
  return a.join('\n\n');
}
const SYS = 'Write the next reply in a fictional roleplay.';

(async () => {
  try { fs.unlinkSync(STATE); } catch {}
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

  const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
    env: {
      ...process.env, AGY_BIN: FAKE, AGY_BRIDGE_PORT: String(PORT),
      AGY_STATE_FILE: STATE, AGY_WORKSPACES: WORK,
      AGY_LOG_DIR: path.join(os.tmpdir(), 'tb-logs-' + process.pid),
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

  const send = (upto, user) => post({ model: 'fake', stream: true, messages: [
    { role: 'system', content: SYS },
    { role: 'assistant', content: blob(upto) },
    { role: 'user', content: user },
  ]});

  console.log('\n[1] 第 1 次（5 层）');
  await send(5, '继续');
  console.log('\n[2] 第 2 次（6 层，应 reuse）');
  await send(6, '继续');

  const st1 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const key = Object.keys(st1)[0];
  const rec1 = st1[key];
  const b1 = (rec1.branches || []).find((b) => b.branchId === 'b1') || (rec1.branches || [])[0];

  console.log('\n[3] 回退到 3 层开新线（应 fork）');
  await send(3, '换个方向');

  const st2 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const rec2 = st2[key];
  const branches = rec2.branches || [];

  console.log('\n[4] 切回原线（6 层，应 reuse b1）');
  await send(6, '继续');

  const st3 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const rec3 = st3[key];

  console.log('\n[断言]');
  await t('两轮后只有一个分支（reuse）', () => {
    assert.ok((rec1.branches || []).length === 1, '分支数=' + (rec1.branches || []).length);
    assert.ok(/branchAction: 'reuse'/.test(log), '没有 reuse 记录');
  });
  await t('回退后派生第二个分支（fork）', () => {
    assert.ok(branches.length >= 2, '分支数=' + branches.length);
    assert.ok(/branchAction: 'fork'/.test(log), '没有 fork 记录');
  });
  await t('切回原线复用原 convId', () => {
    assert.ok(b1 && b1.convId, 'b1 无 convId');
    const convIds = [...log.matchAll(/convId: '([^']{4,})'/g)].map((m) => m[1]);
    assert.ok(convIds.includes(b1.convId), '切回时未复用 b1 的 convId；记录=' + convIds.slice(-4).join(',')); 
  });
  await t('新分支有独立目录', () => {
    const dirs = (rec2.branches || []).map((b) => b.dir).filter(Boolean);
    assert.ok(new Set(dirs).size >= 2, '目录未分离：' + dirs.join(' | '));
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail) console.log('\n日志尾部：\n' + log.slice(-2500));
  srv.kill('SIGKILL');
  process.exit(fail ? 1 : 0);
})();
