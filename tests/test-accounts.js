#!/usr/bin/env node
'use strict';
/**
 * 多账号自动切换验收测试（FIX-11）
 * 运行：node tests/test-accounts.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');
const FAKE = path.join(__dirname, 'fake-agy.js');

const config = require(path.join(SRC, 'config.js'));
const session = require(path.join(SRC, 'session.js'));

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

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    }).on('error', reject);
  });
}

function httpPost(port, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c.toString('utf8'); });
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', (e) => resolve({ status: -1, body: String(e.message) }));
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('\n[1] AGY_ACCOUNTS 解析与缺省回退');
  t('parseAccounts 支持标准格式、含空格格式及缺省回退', () => {
    const parsed = config.parseAccounts(' main = /home/novel , alt = /home/agy-alt ');
    assert.deepStrictEqual(parsed, [
      { name: 'main', home: '/home/novel' },
      { name: 'alt', home: '/home/agy-alt' },
    ]);

    const single = config.parseAccounts('only=/tmp/only-home');
    assert.deepStrictEqual(single, [{ name: 'only', home: '/tmp/only-home' }]);

    assert.strictEqual(config.parseAccounts(''), null);
    assert.strictEqual(config.parseAccounts('   '), null);
    assert.strictEqual(config.parseAccounts(undefined), null);
    assert.strictEqual(config.parseAccounts('invalid-entry'), null);

    const prev = process.env.AGY_ACCOUNTS;
    delete process.env.AGY_ACCOUNTS;
    const cfgPath = require.resolve(path.join(SRC, 'config.js'));
    delete require.cache[cfgPath];
    const freshDefault = require(cfgPath);
    assert.deepStrictEqual(freshDefault.ACCOUNTS, [
      { name: 'main', home: '/home/novel' },
      { name: 'alt', home: '/home/agy-alt' },
    ]);
    assert.strictEqual(freshDefault.ACCOUNT_COOLDOWN_MS, 10 * 60 * 1000);

    process.env.AGY_ACCOUNTS = ' acc1 = /tmp/h1 , acc2 = /tmp/h2 ';
    delete require.cache[cfgPath];
    const freshCustom = require(cfgPath);
    assert.deepStrictEqual(freshCustom.ACCOUNTS, [
      { name: 'acc1', home: '/tmp/h1' },
      { name: 'acc2', home: '/tmp/h2' },
    ]);

    delete require.cache[cfgPath];
    if (prev === undefined) delete process.env.AGY_ACCOUNTS;
    else process.env.AGY_ACCOUNTS = prev;
    require(cfgPath);
  });

  console.log('\n[2] 会话记录迁移（旧格式顶层 convId -> accounts.main.convId）');
  t('旧格式仅含顶层 convId 时自动迁到 accounts.main.convId 且 activeAccount 默认为 main', () => {
    const migrated = session.migrateSessionRecord('chat1', {
      convId: 'legacy-conv-99',
      turns: 3,
      syncedHashes: ['h1', 'h2'],
    });
    assert.strictEqual(migrated.activeAccount, 'main');
    assert.ok(migrated.accounts && migrated.accounts.main, '缺少 accounts.main');
    assert.strictEqual(migrated.accounts.main.convId, 'legacy-conv-99');
    assert.strictEqual(migrated.convId, 'legacy-conv-99');
    assert.strictEqual(migrated.branches[0].accounts.main.convId, 'legacy-conv-99');

    // 切换到无 convId 的 alt 账号时，convId 应为 null 且 driftOf 判定为 deep
    const switched = session.migrateSessionRecord('chat1', {
      ...migrated,
      activeAccount: 'alt',
    });
    assert.strictEqual(switched.activeAccount, 'alt');
    assert.strictEqual(switched.convId, null);
    assert.strictEqual(switched.accounts.main.convId, 'legacy-conv-99');
    const drift = session.driftOf(switched, [{ role: 'user', content: 'hi' }]);
    assert.strictEqual(drift.kind, 'deep');
  });

  console.log('\n[3] 主账号返回 429 自动切换备用账号 & /quota 多账号返回');
  await ta('主账号 429 时同请求内切到 alt 返回 200，日志含 account switch，且保留双账号 convId', async () => {
    const PORT = 8815;
    const STATE = path.join(os.tmpdir(), 'acc-state-' + process.pid + '.json');
    const WORK = path.join(os.tmpdir(), 'acc-work-' + process.pid);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_LOG_DIR: path.join(os.tmpdir(), 'acc-logs-' + process.pid),
        AGY_ACCOUNTS: 'main=/home/novel,alt=/home/agy-alt',
        AGY_SESSION_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
    srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      // 第 1 轮：main 正常成功，记录 accounts.main.convId
      const r1 = await httpPost(PORT, {
        model: 'fake',
        stream: false,
        messages: [
          { role: 'system', content: '你是小说创作引擎。' },
          { role: 'user', content: '（第1楼）第一章开篇。' },
        ],
      });
      assert.strictEqual(r1.status, 200, '第 1 轮应返回 200');
      const st1 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const k1 = Object.keys(st1)[0];
      assert.strictEqual(st1[k1].activeAccount, 'main');
      assert.strictEqual(st1[k1].accounts.main.convId, 'fake-conv-1');

      // 第 2 轮：触发主账号 429，应自动切到 alt 并走 bootstrap 成功返回 200
      const j1 = JSON.parse(r1.body);
      const reply1 = j1.choices[0].message.content;
      const r2 = await httpPost(PORT, {
        model: 'fake',
        stream: false,
        messages: [
          { role: 'system', content: '你是小说创作引擎。' },
          { role: 'user', content: '（第1楼）第一章开篇。' },
          { role: 'assistant', content: reply1 },
          { role: 'user', content: 'quota429 第二章继续推进。' },
        ],
      });
      assert.strictEqual(r2.status, 200, '切换备用账号后应返回 HTTP 200，实际 ' + r2.status + ' ' + r2.body);
      const j2 = JSON.parse(r2.body);
      assert.ok(j2.choices && j2.choices[0].message.content.includes('中文测试'), '备用账号回复正文缺失');
      assert.ok(srvLog.includes('account switch: main -> alt (quota)'), '日志缺少 account switch:\n' + srvLog);

      const st2 = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const rec2 = st2[k1];
      assert.strictEqual(rec2.activeAccount, 'alt', 'activeAccount 应切换为 alt');
      assert.strictEqual(rec2.accounts.main.convId, 'fake-conv-1', '应保留 main 的 convId');
      assert.strictEqual(rec2.accounts.alt.convId, 'fake-conv-1', '应写入 alt 的 convId');
      assert.ok(rec2.accountCooldown && typeof rec2.accountCooldown.main === 'number', '应记录 main 的 accountCooldown');

      // 测试 /quota 返回双账号数组
      const qRes = await httpGet(PORT, '/quota');
      assert.strictEqual(qRes.status, 200);
      const qJson = JSON.parse(qRes.body);
      assert.ok(Array.isArray(qJson.accounts), '/quota 应返回 accounts 数组');
      assert.strictEqual(qJson.accounts.length, 2);
      assert.strictEqual(qJson.accounts[0].name, 'main');
      assert.strictEqual(qJson.accounts[0].weekly, '89%');
      assert.strictEqual(qJson.accounts[0].fiveHour, '100%');
      assert.ok(qJson.accounts[0].resetAt);
      assert.strictEqual(qJson.accounts[1].name, 'alt');

      // 测试所有账号均 429 时返回 429 且写明「所有账号额度耗尽」与最早重置时间
      const r3 = await httpPost(PORT, {
        model: 'fake',
        stream: false,
        messages: [
          { role: 'system', content: '你是小说创作引擎。' },
          { role: 'user', content: 'quota429_all 所有账号耗尽测试' },
        ],
      });
      assert.strictEqual(r3.status, 429, '所有账号冷却时应返回 429，实际 ' + r3.status);
      const j3 = JSON.parse(r3.body);
      assert.ok(j3.error && j3.error.message.includes('所有账号额度耗尽'), '错误信息不符: ' + r3.body);
      assert.ok(j3.error.message.includes('2026-'), '应包含最早重置时间: ' + j3.error.message);
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  await ta('/quota 在单账号配置下 accounts 数组只有一项', async () => {
    const PORT = 8816;
    const STATE = path.join(os.tmpdir(), 'acc1-state-' + process.pid + '.json');
    const WORK = path.join(os.tmpdir(), 'acc1-work-' + process.pid);
    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_ACCOUNTS: 'main=/home/novel',
        AGY_SESSION_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }
      const qRes = await httpGet(PORT, '/quota');
      assert.strictEqual(qRes.status, 200);
      const qJson = JSON.parse(qRes.body);
      assert.ok(Array.isArray(qJson.accounts));
      assert.strictEqual(qJson.accounts.length, 1);
      assert.strictEqual(qJson.accounts[0].name, 'main');
      assert.strictEqual(qJson.accounts[0].weekly, '89%');
      assert.strictEqual(qJson.accounts[0].fiveHour, '100%');
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log('\n[4] F3 429 / 503 分流（主账号 503 只降级模型不切号；主账号 429 只切号不降级模型）');
  await ta('主账号 503 + 备用可用 -> 断言没有 account switch，只有 model fallback (capacity)', async () => {
    const PORT = 8817;
    const STATE = path.join(os.tmpdir(), 'acc503-state-' + process.pid + '.json');
    const WORK = path.join(os.tmpdir(), 'acc503-work-' + process.pid);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_ACCOUNTS: 'main=/home/novel,alt=/home/agy-alt',
        AGY_SESSION_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
    srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      const r = await httpPost(PORT, {
        model: 'gemini-4-argon-high',
        stream: false,
        messages: [
          { role: 'system', content: '你是小说创作引擎。' },
          { role: 'user', content: 'cap503 主账号503容量测试' },
        ],
      });
      assert.strictEqual(r.status, 200, `503 模型降级后应返回 HTTP 200，实际 ${r.status}: ${r.body}`);
      assert.ok(!srvLog.includes('account switch'), `503 容量错误绝不能触发 account switch，实际日志:\n${srvLog}`);
      assert.ok(srvLog.includes('model fallback (capacity)'), `503 容量错误应触发 model fallback (capacity)，实际日志:\n${srvLog}`);

      const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const k = Object.keys(st)[0];
      assert.strictEqual(st[k].activeAccount, 'main', '503 后 activeAccount 必须仍为 main');
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  await ta('主账号 429 -> 断言有 account switch (quota) 且没有 model fallback', async () => {
    const PORT = 8818;
    const STATE = path.join(os.tmpdir(), 'acc429-state-' + process.pid + '.json');
    const WORK = path.join(os.tmpdir(), 'acc429-work-' + process.pid);
    try { fs.unlinkSync(STATE); } catch {}
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}

    const srv = spawn(process.execPath, [path.join(SRC, 'server.js')], {
      env: {
        ...process.env,
        AGY_BIN: FAKE,
        AGY_BRIDGE_PORT: String(PORT),
        AGY_STATE_FILE: STATE,
        AGY_WORKSPACES: WORK,
        AGY_ACCOUNTS: 'main=/home/novel,alt=/home/agy-alt',
        AGY_SESSION_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let srvLog = '';
    srv.stdout.on('data', (c) => { srvLog += c.toString('utf8'); });
    srv.stderr.on('data', (c) => { srvLog += c.toString('utf8'); });

    try {
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        try {
          const h = await httpGet(PORT, '/health');
          if (h.status === 200) break;
        } catch {}
      }

      const r = await httpPost(PORT, {
        model: 'gemini-4-argon-high',
        stream: false,
        messages: [
          { role: 'system', content: '你是小说创作引擎。' },
          { role: 'user', content: 'quota429 主账号429配额切换测试' },
        ],
      });
      assert.strictEqual(r.status, 200, `429 切换备用账号后应返回 HTTP 200，实际 ${r.status}: ${r.body}`);
      assert.ok(srvLog.includes('account switch (quota)'), `429 配额错误应触发 account switch (quota)，实际日志:\n${srvLog}`);
      assert.ok(!srvLog.includes('model fallback'), `429 配额错误不应触发 model fallback，实际日志:\n${srvLog}`);

      const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
      const k = Object.keys(st)[0];
      assert.strictEqual(st[k].activeAccount, 'alt', '429 后 activeAccount 应切到 alt');
    } finally {
      srv.kill('SIGKILL');
      try { fs.unlinkSync(STATE); } catch {}
      try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {}
    }
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
