#!/usr/bin/env node
'use strict';
/**
 * 第四批验收：数据一致性 + 安全
 * 运行：node tests/test-fixes4.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');
process.env.AGY_BIN = FAKE;
process.env.AGY_STATE_FILE = path.join(os.tmpdir(), 't4-state-' + process.pid + '.json');
process.env.AGY_WORKSPACES = path.join(os.tmpdir(), 't4-work-' + process.pid);

const archive = require(path.join(SRC, 'archive.js'));
const session = require(path.join(SRC, 'session.js'));
const runner = require(path.join(SRC, 'agy-runner.js'));

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}

(async () => {
  console.log('\n[A1] readTimeline 按楼层过滤');
  await t('maxFloor=3 时不返回 floor>=3 的内容', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl4-'));
    const p = path.join(dir, 'timeline.md');
    archive.upsertFloor(p, 1, '第一层事件');
    archive.upsertFloor(p, 2, '第二层事件');
    archive.upsertFloor(p, 3, '第三层未来剧透');
    archive.upsertFloor(p, 5, '第五层未来剧透');
    const txt = archive.readTimeline(p, 100000, 3);
    assert.ok(txt.includes('第一层事件'), '丢了应保留的内容');
    assert.ok(!txt.includes('第三层未来剧透'), '泄漏了 floor=3');
    assert.ok(!txt.includes('第五层未来剧透'), '泄漏了 floor=5');
  });
  await t('不传 maxFloor 时保持旧行为（全量）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl4b-'));
    const p = path.join(dir, 'timeline.md');
    archive.upsertFloor(p, 1, 'A');
    archive.upsertFloor(p, 9, 'B');
    const txt = archive.readTimeline(p, 100000);
    assert.ok(txt.includes('A') && txt.includes('B'));
  });

  console.log('\n[A3] <ta_record> 三种形态剥离');
  for (const [label, input, expect] of [
    ['普通', '正文<ta_record>R</ta_record>尾巴', '正文尾巴'],
    ['代码围栏', '正文\n```xml\n<ta_record>R</ta_record>\n```\n尾巴', '正文尾巴'],
    ['带空格', '正文<ta_record >R</ta_record >尾巴', '正文尾巴'],
  ]) {
    await t(label, () => {
      const f = archive.recordFilter();
      const out = (f.push(input) + f.flush()).replace(/\s+$/g, '').trim();
      assert.ok(!out.includes('ta_record'), '标签残留：' + out);
      assert.ok(out.startsWith('正文'), '正文丢失：' + out);
    });
  }

  console.log('\n[A4] layerHash 带 name / 向后兼容');
  await t('带 name 的两条消息哈希不同', () => {
    const a = session.layerHash({ role: 'user', name: 'Alice', content: '你好' });
    const b = session.layerHash({ role: 'user', name: 'Bob', content: '你好' });
    assert.notStrictEqual(a, b);
  });
  await t('不带 name 与旧算法一致', () => {
    const crypto = require('crypto');
    const legacy = crypto.createHash('sha1').update('user' + '\0' + '你好', 'utf8').digest('hex').slice(0, 12);
    assert.strictEqual(session.layerHash({ role: 'user', content: '你好' }), legacy);
  });

  console.log('\n[A2] SIGTERM 无效时 3 秒后 SIGKILL');
  await t('ignoreterm 模式被强制终止', async () => {
    const t0 = Date.now();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    let err = null;
    try {
      await runner.runTurn({ prompt: 'ignoreterm', model: 'fake', timeoutMs: 20000, signal: ac.signal });
    } catch (e) { err = e; }
    const dt = Date.now() - t0;
    // 应当很快返回（abort），且不等待子进程自然结束（800ms）
    assert.ok(dt < 1500, '未被及时终止，耗时 ' + dt + 'ms');
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
