#!/usr/bin/env node
/**
 * bridge v5 验收测试 —— 由技术负责人编写，agy 的实现必须通过这些用例
 * 运行：node tests/test-core.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const archive = require(path.join(SRC, 'archive.js'));
const session = require(path.join(SRC, 'session.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}

console.log('\n[1] recordFilter：<ta_record> 流式剥离');
t('标签完整在一个 delta 内', () => {
  const f = archive.recordFilter();
  const out = f.push('正文A<ta_record>R1</ta_record>正文B') + f.flush();
  assert.strictEqual(out, '正文A正文B');
});
t('标签跨两个 delta', () => {
  const f = archive.recordFilter();
  let out = '';
  out += f.push('正文A<ta_rec');
  out += f.push('ord>R1</ta_record>正文B');
  out += f.flush();
  assert.strictEqual(out, '正文A正文B');
});
t('标签跨三个 delta 且正文分散', () => {
  const f = archive.recordFilter();
  let out = '';
  out += f.push('前');
  out += f.push('文<ta_record>RR');
  out += f.push('R</ta_record>后文');
  out += f.flush();
  assert.strictEqual(out, '前文后文');
});
t('没有记录标签时原样透传', () => {
  const f = archive.recordFilter();
  const out = f.push('普通回复，没有任何标签。') + f.flush();
  assert.strictEqual(out, '普通回复，没有任何标签。');
});
t('末尾残留半截标签必须被吞掉（不能漏给用户）', () => {
  const f = archive.recordFilter();
  const out = f.push('正文<ta_record>未闭合') + f.flush();
  assert.ok(!out.includes('<ta_record>'), '不应泄漏未闭合标签：' + out);
});

console.log('\n[2] extractRecord');
t('抽取并清洗', () => {
  const r = archive.extractRecord('正文<ta_record>R1</ta_record>');
  assert.strictEqual(r.clean, '正文');
  assert.strictEqual(r.record, 'R1');
});
t('无记录返回 null', () => {
  const r = archive.extractRecord('纯文本');
  assert.strictEqual(r.record, null);
});

console.log('\n[3] upsertFloor 幂等');
t('同层重复写不产生重复段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const p = path.join(dir, 'timeline.md');
  archive.upsertFloor(p, 1, '第一段');
  archive.upsertFloor(p, 2, '第二段');
  archive.upsertFloor(p, 2, '第二段改写');
  const txt = fs.readFileSync(p, 'utf8');
  assert.strictEqual((txt.match(/第二段/g) || []).length, 1, '第二段应只有一份');
  assert.ok(txt.includes('第二段改写'), '应保留最新版本');
  assert.strictEqual((txt.match(/<!-- floor: 2 -->/g) || []).length, 1);
});
t('回滚到旧层会截断更高楼层', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-'));
  const p = path.join(dir, 'timeline.md');
  archive.upsertFloor(p, 1, 'A');
  archive.upsertFloor(p, 2, 'B');
  archive.upsertFloor(p, 3, 'C');
  archive.upsertFloor(p, 2, 'B2');
  const txt = fs.readFileSync(p, 'utf8');
  assert.ok(!txt.includes('C'), 'floor 3 应被截断');
});

console.log('\n[4] chatKey 稳定性');
t('世界书变化不影响 chatKey', () => {
  const base = [
    { role: 'system', content: 'S'.repeat(2000) + 'WORLDINFO-1' },
    { role: 'user', content: '开场' },
    { role: 'assistant', content: '第一句回复' },
  ];
  const changed = JSON.parse(JSON.stringify(base));
  changed[0].content = 'S'.repeat(2000) + 'WORLDINFO-2-CHANGED';
  assert.strictEqual(session.chatKey(base), session.chatKey(changed));
});
t('不同开场得到不同 key', () => {
  const a = [{ role: 'system', content: 'x' }, { role: 'user', content: '开场A' }];
  const b = [{ role: 'system', content: 'x' }, { role: 'user', content: '开场B' }];
  assert.notStrictEqual(session.chatKey(a), session.chatKey(b));
});

console.log('\n[5] buildBootstrap 预算');
t('200 条 × 8KB 历史不超过预算', () => {
  const msgs = [{ role: 'system', content: 'SYS' }];
  for (let i = 0; i < 200; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: '字'.repeat(2700) });
  }
  const out = session.buildBootstrap({
    system: 'SYS'.repeat(4000),
    messages: msgs,
    timeline: 'TL'.repeat(5000),
    budgetBytes: 170000,
  });
  const bytes = Buffer.byteLength(out, 'utf8');
  assert.ok(bytes <= 170000, `超预算：${bytes}`);
  assert.ok(bytes > 80000, `装得太少，浪费预算：${bytes}`);
});

console.log('\n[6] driftOf 三态');
t('无会话 → deep', () => {
  assert.strictEqual(session.driftOf(null, [{ role: 'user', content: 'hi' }]).kind, 'deep');
});
t('只多一条 → advance', () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const sess = { syncedHashes: msgs.map(session.layerHash), swipeStreak: 0 };
  const next = msgs.concat([{ role: 'user', content: 'c' }]);
  assert.strictEqual(session.driftOf(sess, next).kind, 'advance');
});
t('改了最后一层 → shallow', () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
  const sess = { syncedHashes: msgs.map(session.layerHash), swipeStreak: 0 };
  const edited = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b-改' }];
  const d = session.driftOf(sess, edited);
  assert.strictEqual(d.kind, 'shallow');
  assert.strictEqual(d.divIdx, 1);
});
t('改到很靠前 → deep', () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  const sess = { syncedHashes: msgs.map(session.layerHash), swipeStreak: 0 };
  const edited = JSON.parse(JSON.stringify(msgs));
  edited[1].content = 'changed';
  assert.strictEqual(session.driftOf(sess, edited).kind, 'deep');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
