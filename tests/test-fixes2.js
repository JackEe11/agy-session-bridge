#!/usr/bin/env node
'use strict';
/**
 * 第二批修复验收（会话键 + 漂移语义），纯单元，不依赖 agy
 * 运行：node tests/test-fixes2.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SRC = path.join(__dirname, '..', 'src');
process.env.AGY_STATE_FILE = path.join(os.tmpdir(), 't2-state-' + process.pid + '.json');
process.env.AGY_WORKSPACES = path.join(os.tmpdir(), 't2-chats-' + process.pid);
try { fs.unlinkSync(process.env.AGY_STATE_FILE); } catch {}

const session = require(path.join(SRC, 'session.js'));
const config = require(path.join(SRC, 'config.js'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '->', e.message); fail++; }
}

const SYS = '你是小说引擎。'.repeat(100);
const S1 = [{ role: 'system', content: SYS }, { role: 'user', content: '开场：雨夜推门。' }];
const A1 = { role: 'assistant', content: '第一段回复。' };
const S2a = [S1[0], { role: 'user', content: '开场：雨夜推门（存档A）。' }, A1];
const S2b = [S1[0], { role: 'user', content: '开场：雪夜推门（存档B）。' }, A1];

console.log('\n[S1] 同卡片同开场白、不同第二句 → 必须是两个会话');
t('两个存档解析出不同会话', () => {
  const state = {};
  const r1 = session.resolveSession(state, S2a);
  const rec1 = r1.sess || { convId: 'conv-A', syncedHashes: [], keys: [r1.key] };
  rec1.convId = 'conv-A';
  rec1.syncedHashes = S2a.filter(m => m.role !== 'system').map(session.layerHash);
  state[r1.key] = rec1;

  const r2 = session.resolveSession(state, S2b);
  assert.ok(r2.sess === null || r2.sess.convId !== 'conv-A',
    '第二个存档错误命中了第一个（convId=' + (r2.sess && r2.sess.convId) + '）');
});

console.log('\n[S2] driftOf 四态');
const base = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
const sess = { syncedHashes: base.map(session.layerHash), swipeStreak: 0 };
t('完全相同的重发 → retry（不得判 shallow）', () => {
  const d = session.driftOf(sess, base);
  assert.strictEqual(d.kind, 'retry', '实际 ' + d.kind);
});
t('追加 2 条 → advance', () => {
  const next = base.concat([{ role: 'user', content: 'c' }, { role: 'assistant', content: 'd' }]);
  assert.strictEqual(session.driftOf(sess, next).kind, 'advance');
});
t('追加 1 条 → advance', () => {
  const next = base.concat([{ role: 'user', content: 'c' }]);
  assert.strictEqual(session.driftOf(sess, next).kind, 'advance');
});
t('改最后一层 → shallow', () => {
  const edited = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b-改' }];
  assert.strictEqual(session.driftOf(sess, edited).kind, 'shallow');
});
t('纯回滚（变短）→ deep', () => {
  const shorter = [base[0]];
  assert.strictEqual(session.driftOf(sess, shorter).kind, 'deep');
});

console.log('\n[S3] loadState 不得返回同一引用');
t('两次读取互不影响', () => {
  session.saveState({ k1: { convId: 'x', syncedHashes: ['h'] } });
  const a = session.loadState();
  const b = session.loadState();
  a.k1.convId = 'MUTATED';
  assert.notStrictEqual(b.k1.convId, 'MUTATED', 'loadState 返回了共享引用');
});

console.log('\n[S4] saveState 并发写入不互相破坏');
t('连续 20 次保存后 JSON 仍可解析', () => {
  for (let i = 0; i < 20; i++) session.saveState({ ['k' + i]: { convId: 'c' + i, syncedHashes: ['h'] } });
  const parsed = JSON.parse(fs.readFileSync(process.env.AGY_STATE_FILE, 'utf8'));
  assert.ok(parsed && typeof parsed === 'object');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
