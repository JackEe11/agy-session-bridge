#!/usr/bin/env node
'use strict';
const assert = require('assert');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');


let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  process.env.AGY_BIN = FAKE;
  const config = require(path.join(SRC, 'config.js'));
  config.AGY_BIN = FAKE;
  const { TurnQueue } = require(path.join(SRC, 'queue.js'));
  const runner = require(path.join(SRC, 'agy-runner.js'));

  console.log('\n[A] 并发上限');
  await t('maxConcurrent=1 时 3 个不同 key 串行', async () => {
    const q = new TurnQueue({ maxConcurrent: 1, limit: 10, timeoutMs: 5000 });
    let running = 0, peak = 0;
    const job = () => async () => { running++; peak = Math.max(peak, running); await sleep(60); running--; return true; };
    await Promise.all([q.run('k1', job()), q.run('k2', job()), q.run('k3', job())]);
    assert.strictEqual(peak, 1, '峰值并发=' + peak);
  });

  console.log('\n[B] 抢占语义（真实子进程）');
  await t('同 key 第二次抢占：第一次被 SIGTERM 终止，不误调新请求 onPreempt', async () => {
    const q = new TurnQueue({ maxConcurrent: 1, limit: 5, timeoutMs: 5000 });
    let newPreemptCalled = false;
    let childKilled = false;

    const first = q.run('same', async () => {
      const cp = require('child_process');
      const child = process.platform === 'win32'
        ? cp.spawn(process.execPath, [FAKE], { env: { ...process.env } })
        : cp.spawn(FAKE, [], { env: { ...process.env } });
      child.stdin.write('slow'); child.stdin.end();
      child.on('exit', (code, sig) => { if (sig === 'SIGTERM' || code === 143) childKilled = true; });
      q.registerActiveChild && q.registerActiveChild('same', child);
      await new Promise((r) => child.on('exit', r));
      return 'first';
    }, { onPreempt: () => {} });

    await sleep(200);
    const second = q.run('same', async () => 'second', { onPreempt: () => { newPreemptCalled = true; } });
    const r = await second;
    assert.strictEqual(r, 'second', '第二次应成功');
    assert.strictEqual(newPreemptCalled, false, '不应调用新请求的 onPreempt');
    assert.ok(childKilled, '第一次的子进程应被 SIGTERM 终止');
    await first.catch(() => {});
    await sleep(400);
  });

  console.log('\n[C] UTF-8 跨块解码');
  await t('多字节字符被拆到两个 chunk 时无 \\uFFFD', async () => {
    let text = '';
    const r = await runner.runTurn({ prompt: 'hi', model: 'fake', timeoutMs: 10000, onDelta: (d) => { text += d; } });
    assert.ok(!text.includes('\ufffd'), '出现乱码：' + JSON.stringify(text));
    assert.ok(text.includes('中文测试'), '正文缺失：' + JSON.stringify(text));
  });

  console.log('\n[D] COMPACT 环境变量透传');
  await t('子进程能看到 AGY_CLI_AUTO_COMPACT_OVERRIDE', async () => {
    let text = '';
    await runner.runTurn({ prompt: 'hi', model: 'fake', timeoutMs: 10000, onDelta: (d) => { text += d; } });
    assert.ok(text.includes('COMPACT=60%'), '实际：' + JSON.stringify(text.slice(0, 160)));
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
