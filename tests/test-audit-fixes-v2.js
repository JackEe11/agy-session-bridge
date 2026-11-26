#!/usr/bin/env node
'use strict';
/**
 * 审计修复回归测试 v2：覆盖高危与中危 Bug 修复
 * 运行：node tests/test-audit-fixes-v2.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');

const session = require(path.join(SRC, 'session.js'));
const archive = require(path.join(SRC, 'archive.js'));
const config = require(path.join(SRC, 'config.js'));

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

(async () => {
  console.log('\n[1] buildBootstrap 计入 [STATE]/[CHAPTERS] 预算，不裁掉 [RECENT]');
  t('含 state+chapters 超预算时仍保留 [RECENT] 与最新用户消息', () => {
    const out = session.buildBootstrap({
      system: 'S'.repeat(6000),
      floors: [
        { role: 'user', content: 'U0' },
        { role: 'assistant', content: 'A0' },
        { role: 'user', content: 'U1-RECENT-MUST-KEEP' },
      ],
      state: 'T'.repeat(2000),
      chapters: 'C'.repeat(2000),
      timeline: 'L'.repeat(500),
      budgetBytes: 10000,
    });
    assert.ok(Buffer.byteLength(out, 'utf8') <= 10000, '超出预算');
    assert.ok(out.includes('[RECENT]'), '丢失 [RECENT] 段');
    assert.ok(out.includes('U1-RECENT-MUST-KEEP'), '丢失最新用户消息');
  });

  t('strict system 模式下不静默截断 [SYSTEM]', () => {
    const prevEnv = process.env.AGY_STRICT_SYSTEM;
    const prevCfg = config.STRICT_SYSTEM;
    process.env.AGY_STRICT_SYSTEM = '1';
    config.STRICT_SYSTEM = 1;
    try {
      const marker = 'SYSTEM_TAIL_MARKER_999';
      const out = session.buildBootstrap({
        system: 'S'.repeat(4500) + marker,
        floors: [
          { role: 'user', content: 'U0' },
          { role: 'assistant', content: 'A0' },
          { role: 'user', content: 'U1-LATEST' },
        ],
        state: 'T'.repeat(500),
        chapters: 'C'.repeat(2000),
        timeline: 'L'.repeat(2000),
        budgetBytes: 10000,
      });
      assert.ok(out.includes(marker), 'strict system 模式下 [SYSTEM] 被静默截断');
      assert.ok(out.includes('U1-LATEST'), '最新用户消息丢失');
    } finally {
      if (prevEnv === undefined) delete process.env.AGY_STRICT_SYSTEM;
      else process.env.AGY_STRICT_SYSTEM = prevEnv;
      config.STRICT_SYSTEM = prevCfg;
    }
  });

  console.log('\n[2] Swipe / Regenerate（hasAppendedReply）走 shallow 覆盖并累计 swipeStreak');
  t('首次重抽判定为 shallow，buildOverride 生成有效作废提示', () => {
    const u0 = { role: 'user', content: 'hello' };
    const a0 = { role: 'assistant', content: 'hi' };
    const u1 = { role: 'user', content: 'next turn' };
    const a1 = { role: 'assistant', content: 'rejected reply' };
    const branch = {
      convId: 'conv-1',
      hashes: [u0, a0, u1, a1].map(session.layerHash),
      hasAppendedReply: true,
      swipeStreak: 0,
      turns: 1,
    };
    const drift = session.driftOf(branch, [u0, a0, u1]);
    assert.strictEqual(drift.kind, 'shallow', '应判定为 shallow，实际 ' + drift.kind);
    const override = session.buildOverride({ divIdx: drift.divIdx, floors: [u0, a0, u1] });
    assert.ok(override.includes('[TIMELINE OVERRIDE]'), '缺少 override 头');
    assert.ok(override.includes('next turn'), 'override 缺少最后一条用户消息');
  });

  t('连续重抽达到 MAX_SWIPE_STREAK 后自动升级为 deep 重建', () => {
    const u0 = { role: 'user', content: 'hello' };
    const a0 = { role: 'assistant', content: 'hi' };
    const u1 = { role: 'user', content: 'next turn' };
    const a1 = { role: 'assistant', content: 'rejected reply' };
    const branch = {
      convId: 'conv-1',
      hashes: [u0, a0, u1, a1].map(session.layerHash),
      hasAppendedReply: true,
      swipeStreak: config.MAX_SWIPE_STREAK,
      turns: 1,
    };
    const drift = session.driftOf(branch, [u0, a0, u1]);
    assert.strictEqual(drift.kind, 'deep', '达到 MAX_SWIPE_STREAK 应升级为 deep，实际 ' + drift.kind);
  });

  console.log('\n[3] 分叉继承 chapters.md / state.md，回滚同步清理三层文件');
  t('copyTimelineBeforeLcp 同步按 lcp 过滤复制 chapters.md 与 state.md', () => {
    const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-p-'));
    const childDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-c-'));
    try {
      archive.upsertFloor(path.join(parentDir, 'timeline.md'), 5, '第5层事件');
      archive.upsertFloor(path.join(parentDir, 'timeline.md'), 25, '第25层未来事件');
      fs.writeFileSync(
        path.join(parentDir, 'chapters.md'),
        '<!-- floors: 1-10 -->\n第一章\n\n<!-- floors: 11-30 -->\n第二章\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(parentDir, 'state.md'),
        '<!-- floors: 1-10 -->\n早期状态\n',
        'utf8'
      );
      session.copyTimelineBeforeLcp(parentDir, childDir, 15);
      const got = archive.readLayeredState(childDir, 100000);
      assert.ok(got.timeline.includes('第5层事件'), 'timeline 应保留第5层');
      assert.ok(!got.timeline.includes('第25层未来事件'), 'timeline 不应保留第25层');
      assert.ok(got.chapters.includes('第一章'), 'chapters 应继承第一章');
      assert.ok(!got.chapters.includes('第二章'), 'chapters 不应继承超界第二章');
      assert.ok(got.state.includes('早期状态'), 'state 应继承早期状态');
    } finally {
      fs.rmSync(parentDir, { recursive: true, force: true });
      fs.rmSync(childDir, { recursive: true, force: true });
    }
  });

  t('truncateLayeredState 回滚时同步截断 timeline/chapters/state', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-'));
    try {
      archive.upsertFloor(path.join(dir, 'timeline.md'), 5, '第5层');
      archive.upsertFloor(path.join(dir, 'timeline.md'), 25, '第25层废稿');
      fs.writeFileSync(
        path.join(dir, 'chapters.md'),
        '<!-- floors: 1-10 -->\n第一章\n\n<!-- floors: 11-20 -->\n废稿章\n',
        'utf8'
      );
      fs.writeFileSync(
        path.join(dir, 'state.md'),
        '<!-- floors: 1-25 -->\n废稿状态\n',
        'utf8'
      );
      archive.truncateLayeredState(dir, 12);
      const got = archive.readLayeredState(dir, 100000);
      assert.ok(got.timeline.includes('第5层') && !got.timeline.includes('第25层废稿'));
      assert.ok(got.chapters.includes('第一章') && !got.chapters.includes('废稿章'));
      assert.strictEqual(got.state, '', '超界 state.md 应被清空');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await ta('compactLayeredState 自定义摘要器失败时保留原始 timeline，单段超 12KB 不破坏头注释', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-'));
    const tl = path.join(dir, 'timeline.md');
    try {
      for (let i = 1; i <= 40; i++) archive.upsertFloor(tl, i, `第${i}层：` + '剧情内容。'.repeat(120));
      const beforeSize = fs.statSync(tl).size;
      await archive.compactLayeredState(dir, { summarize: async () => '' });
      assert.strictEqual(fs.statSync(tl).size, beforeSize, '摘要器返回空时不应删掉原始 timeline');

      await archive.compactLayeredState(dir, { summarize: async () => '超长摘要。'.repeat(5000) });
      const ch = fs.readFileSync(path.join(dir, 'chapters.md'), 'utf8');
      assert.ok(/^<!-- floors: \d+-\d+ -->/.test(ch), '单段超 12KB 后丢失 floors 头部注释');
      assert.ok(Buffer.byteLength(ch, 'utf8') <= 12000, 'chapters.md 超出 12KB 上限');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log('\n[4] HTTP 400 非法 JSON 与分叉首轮归档落盘');
  await ta('非法 JSON 返回 400，且 fork 首轮正常写入 timeline.md', async () => {
    const PORT = 8809;
    const STATE = path.join(os.tmpdir(), 'v2-state-' + process.pid + '.json');
    const WORK = path.join(os.tmpdir(), 'v2-work-' + process.pid);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env, AGY_BIN: FAKE, AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE, AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), 'v2-logs-' + process.pid),
        AGY_PROMPT_BUDGET: '170000', AGY_MAX_CONCURRENT: '1', AGY_SESSION_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      try {
        const ok = await new Promise((res, rej) => {
          http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (r) => { r.resume(); res(true); }).on('error', rej);
        });
        if (ok) break;
      } catch {}
    }

    const postRaw = (raw) => new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1', port: PORT, path: '/v1/chat/completions', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) },
      }, (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c.toString('utf8'); });
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      });
      req.on('error', (e) => resolve({ status: -1, body: String(e.message) }));
      req.write(raw); req.end();
    });

    try {
      const bad = await postRaw('{bad json');
      assert.strictEqual(bad.status, 400, '非法 JSON 应返回 400，实际 ' + bad.status);

      const floor = (n) => '（第' + n + '楼）第' + n + '楼正文，' + '剧情推进。'.repeat(40);
      const blob = (upto) => Array.from({ length: upto }, (_, i) => floor(i + 1)).join('\n\n');
      const send = (upto, u) => postRaw(JSON.stringify({
        model: 'fake', stream: false,
        messages: [
          { role: 'system', content: 'Roleplay engine.' },
          { role: 'assistant', content: blob(upto) },
          { role: 'user', content: u },
        ],
      }));

      await send(5, '继续');
      await send(2, '开新分支');
      const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const rec = st[Object.keys(st)[0]];
      const b2 = rec.branches.find((b) => b.branchId === 'b2');
      assert.ok(b2 && b2.dir, '未创建 b2 分支');
      const tlPath = path.join(b2.dir, 'timeline.md');
      assert.ok(fs.existsSync(tlPath) && fs.readFileSync(tlPath, 'utf8').trim().length > 0, 'fork 首轮未写入 timeline.md');
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
