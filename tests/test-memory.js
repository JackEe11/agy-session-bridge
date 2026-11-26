#!/usr/bin/env node
'use strict';
/**
 * 第八批验收：分级记忆 + 1M 预算 + 去编程化 framing + strict system
 * 运行：node tests/test-memory.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');

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

const archive = require(path.join(SRC, 'archive.js'));
const session = require(path.join(SRC, 'session.js'));
const config = require(path.join(SRC, 'config.js'));

(async () => {
  console.log('\n[M1] readLayeredState 分层读取与楼层过滤');
  t('三层文件存在且按 maxFloor 过滤', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
    fs.writeFileSync(path.join(dir, 'state.md'), '# 状态\n当前在厨房。\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'chapters.md'),
      '<!-- floors: 1-20 -->\n第一章：初遇。\n\n<!-- floors: 21-40 -->\n第二章：雪夜。\n', 'utf8');
    archive.upsertFloor(path.join(dir, 'timeline.md'), 5, '第五层：海边');
    archive.upsertFloor(path.join(dir, 'timeline.md'), 45, '第四十五层：未来剧情');

    const got = archive.readLayeredState(dir, 100000, 30);
    assert.ok(got.state.includes('厨房'), 'state 缺失');
    assert.ok(got.chapters.includes('第一章'), '第一章应保留');
    assert.ok(!got.chapters.includes('第二章'), 'maxFloor=30 时第二章（21-40）应被过滤');
    assert.ok(got.timeline.includes('海边'), '近层明细缺失');
    assert.ok(!got.timeline.includes('未来剧情'), '超过 maxFloor 的楼层应被过滤');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[M1] 超 24KB 自动折卷');
  await ta('timeline 超限后产出 chapters.md（用 fake 摘要）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem2-'));
    const tl = path.join(dir, 'timeline.md');
    for (let i = 1; i <= 60; i++) archive.upsertFloor(tl, i, '第' + i + '层：' + '剧情描写。'.repeat(120));
    assert.ok(fs.statSync(tl).size > 24 * 1024, 'timeline 未超过 24KB');

    const fake = async (text) => '摘要：' + String(text).slice(0, 40);
    const fn = archive.compactLayeredState || archive.rollupTimeline || archive.compactTimeline;
    assert.ok(typeof fn === 'function', '没有 compactLayeredState/rollupTimeline');
    await fn(dir, { summarize: fake });

    assert.ok(fs.existsSync(path.join(dir, 'chapters.md')), 'chapters.md 未生成');
    const chapters = fs.readFileSync(path.join(dir, 'chapters.md'), 'utf8');
    assert.ok(/<!-- floors: \d+-\d+ -->/.test(chapters), 'chapters 缺少楼层区间注释');
    assert.ok(fs.statSync(tl).size < 1024 * 1024, 'timeline 未收缩');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log('\n[M3] 去编程化 framing');
  t('bootstrap 的 [SYSTEM] 里包含 NON_CODING_FRAME', () => {
    const frame = config.NON_CODING_FRAME;
    assert.ok(frame && frame.length > 5, 'config 缺少 NON_CODING_FRAME');
    const out = session.buildBootstrap({
      system: '你是小说引擎。',
      messages: [{ role: 'user', content: '（第1楼）正文' }, { role: 'assistant', content: '回复' }],
      timeline: '',
      budgetBytes: 200000,
    });
    assert.ok(out.includes(frame), 'buildBootstrap 未注入 frame');
  });

  console.log('\n[M2] 预算与 strict system');
  await ta('AGY_STRICT_SYSTEM=1 且 system 超预算 → 500 system_budget_exceeded', async () => {
    const PORT = 8804;
    const STATE = path.join(os.tmpdir(), 'mem-state-' + process.pid + '.json');
    const WORK = path.join(os.tmpdir(), 'mem-work-' + process.pid);
    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env, AGY_BIN: FAKE, AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE, AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), 'mem-logs-' + process.pid),
        AGY_PROMPT_BUDGET: '10000', AGY_STRICT_SYSTEM: '1',
        AGY_MAX_CONCURRENT: '1', AGY_SESSION_MODE: '1',
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
    const body = JSON.stringify({
      model: 'fake', stream: false,
      messages: [
        { role: 'system', content: '巨大系统提示。'.repeat(1200) },
        { role: 'user', content: '继续' },
      ],
    });
    const res = await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c.toString('utf8'); });
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', (e) => resolve({ status: -1, body: String(e.message) }));
      req.write(body); req.end();
    });
    srv.kill('SIGKILL');
    assert.strictEqual(res.status, 500, 'HTTP ' + res.status + ' body=' + res.body.slice(0, 200));
    assert.ok(res.body.includes('system_budget_exceeded'), 'body=' + res.body.slice(0, 200));
  });

  console.log('\n[M2] 预算策略（FINDINGS.md：CLI 在 192,000 字节处截断尾部）');
  t('PROMPT_BUDGET 默认 == 180000（< 硬顶 190000）', () => {
    const n = Number(config.PROMPT_BUDGET);
    assert.strictEqual(n, 180000, 'PROMPT_BUDGET=' + n);
  });
  t('PROMPT_BUDGET 即使传入 99999999 也会被钳制到 190000', () => {
    const prev = process.env.AGY_PROMPT_BUDGET;
    process.env.AGY_PROMPT_BUDGET = '99999999';
    const p = require.resolve(path.join(SRC, 'config.js'));
    delete require.cache[p];
    const fresh = require(p);
    const n = Number(fresh.PROMPT_BUDGET);
    delete require.cache[p];
    if (prev === undefined) delete process.env.AGY_PROMPT_BUDGET;
    else process.env.AGY_PROMPT_BUDGET = prev;
    require(p);
    assert.strictEqual(n, 190000, '未钳制: ' + n);
  });
  t('COMPACT_OVERRIDE 默认 >= 80%', () => {
    assert.ok(parseInt(String(config.COMPACT_OVERRIDE), 10) >= 80, 'COMPACT_OVERRIDE=' + config.COMPACT_OVERRIDE);
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
