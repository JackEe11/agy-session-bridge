#!/usr/bin/env node
'use strict';
/**
 * 审计修复回归测试：验证本次修复的全部高危与中危 Bug
 * 运行：node tests/test-audit-fixes.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const session = require('../src/session');
const archive = require('../src/archive');
const config = require('../src/config');

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log('  ✅', name);
    pass++;
  } catch (e) {
    console.log('  ❌', name, '->', e.message);
    fail++;
  }
}

console.log('\n[1] 普通长消息（>4KB）不得被误判为预设块');
t('普通对话中 >4KB 用户消息保留为 floor 并判定 advance', () => {
  const turn1 = [
    { role: 'system', content: '你是角色A' },
    { role: 'assistant', content: '开场白' },
    { role: 'user', content: '你好' },
  ];
  const s1 = session.splitFloors(turn1);
  const syncedHashes = [
    ...s1.floors.map(session.layerHash),
    session.layerHash({ role: 'assistant', content: '你好呀' }),
  ];
  const sess = { convId: 'conv-1', syncedHashes, turns: 1, swipeStreak: 0 };

  const longUserMsg = '这是一段很长的角色扮演用户输入。'.repeat(100); // 4800 bytes
  const turn2 = [
    ...turn1,
    { role: 'assistant', content: '你好呀' },
    { role: 'user', content: longUserMsg },
  ];
  const s2 = session.splitFloors(turn2);
  assert.strictEqual(s2.floors.length, 4, '长消息被吞掉了');
  assert.strictEqual(s2.postBlocks.length, 0, '普通长消息不该进 postBlocks');
  const drift = session.driftOf(sess, s2.floors);
  assert.strictEqual(drift.kind, 'advance', '应判定为 advance，实际为 ' + drift.kind);
});

t('带（第N楼）合并标记的预设场景仍正常剥离 >4KB 前后预设块', () => {
  const presetBefore = '预设前段设定。'.repeat(300); // > 4KB
  const merged = '（第1楼）第一层正文\n\n（第2楼）第二层正文';
  const presetAfter = '预设后段指令。'.repeat(300); // > 4KB
  const s = session.splitFloors([
    { role: 'system', content: 'sys' },
    { role: 'user', content: presetBefore },
    { role: 'assistant', content: merged },
    { role: 'user', content: presetAfter },
  ]);
  assert.strictEqual(s.systemBlocks.length, 1);
  assert.strictEqual(s.floors.length, 2);
  assert.strictEqual(s.postBlocks.length, 1);
});

console.log('\n[2] 无 String.prototype 全局污染');
t('String.prototype 不应被挂载 content 属性', () => {
  assert.strictEqual('content' in String.prototype, false);
  assert.strictEqual(('hello').content, undefined);
});

console.log('\n[3] loadState 遇到损坏 JSON 时优先回退内存缓存并备份原文件');
t('损坏 sessions.json 时不静默清空已知会话', () => {
  const origStateFile = config.STATE_FILE;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-audit-'));
  const stateFile = path.join(tmpDir, 'sessions.json');
  try {
    config.STATE_FILE = stateFile;
    session.saveState({ abc: { convId: 'c1', turns: 2 } });
    fs.writeFileSync(stateFile, '{corrupt json', 'utf8');
    const loaded = session.loadState();
    assert.ok(loaded.abc && loaded.abc.convId === 'c1', '未能从内存缓存恢复状态');
  } finally {
    config.STATE_FILE = origStateFile;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log('\n[4] archive.upsertFloor 原子写入与 shallow 截断行为');
t('从 divIdx 截断后写入新楼层，中间作废楼层被清除', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-arch-'));
  const tl = path.join(tmpDir, 'timeline.md');
  try {
    archive.upsertFloor(tl, 1, '第1层归档');
    archive.upsertFloor(tl, 3, '第3层归档');
    archive.upsertFloor(tl, 5, '第5层旧废稿');
    archive.upsertFloor(tl, 7, '第7层旧废稿');
    archive.upsertFloor(tl, 4, '');
    archive.upsertFloor(tl, 6, '第6层新剧情');
    const content = fs.readFileSync(tl, 'utf8');
    assert.ok(content.includes('第3层归档'), '保留第3层');
    assert.ok(!content.includes('第5层旧废稿'), '旧废稿第5层未被清除');
    assert.ok(!content.includes('第7层旧废稿'), '旧废稿第7层未被清除');
    assert.ok(content.includes('第6层新剧情'), '写入第6层新剧情');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
