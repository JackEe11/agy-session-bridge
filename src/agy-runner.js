'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const config = require('./config');

function checkMissingWarning(str) {
  if (!str) return false;
  const s = String(str).toLowerCase();
  return s.includes('warning: conversation "') && s.includes('not found');
}

/**
 * @param {{
 *   prompt: string,
 *   model: string,
 *   conversationId?: string|null,
 *   effort?: string,
 *   addDirs?: string[],
 *   cwd?: string,
 *   timeoutMs?: number,
 *   onDelta?: (s: string) => void,
 *   onSpawn?: (child: import('child_process').ChildProcess) => void
 * }} opts
 * @returns {Promise<{
 *   code: number,
 *   text: string,
 *   conversationId: string|null,
 *   usage: object|null,
 *   conversationMissing: boolean,
 *   stderr: string
 * }>}
 */
function runTurn(opts = {}) {
  return new Promise((resolve) => {
    const prompt = typeof opts.prompt === 'string' ? opts.prompt : String(opts.prompt || '');
    const model = (typeof opts.model === 'string' && opts.model.trim())
      ? opts.model.trim()
      : config.DEFAULT_MODEL;
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : config.TURN_TIMEOUT_MS;
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    const onDelta = typeof opts.onDelta === 'function' ? opts.onDelta : null;

    // 刻意不传 -p：当前依靠管道 stdin 隐式进入 print 模式，保持现状以兼容长 prompt 管道输入
    const args = [
      '--output-format', 'stream-json',
      '--print-timeout', `${timeoutSec}s`,
      '--model', model,
    ];

    if (opts.conversationId) {
      args.push('--conversation', String(opts.conversationId));
    }

    if (Array.isArray(opts.addDirs)) {
      for (const dir of opts.addDirs) {
        if (dir) args.push('--add-dir', String(dir));
      }
    }

    if (opts.effort) {
      args.push('--effort', String(opts.effort));
    }

    let cwd = opts.cwd || process.cwd();
    if (opts.cwd) {
      try {
        fs.mkdirSync(opts.cwd, { recursive: true });
      } catch {
        cwd = process.cwd();
      }
    }

    const bin = process.env.AGY_BIN || config.AGY_BIN;
    const env = { ...process.env, HOME: config.HOME, ELECTRON_RUN_AS_NODE: '' };
    if (config.COMPACT_OVERRIDE) {
      env.AGY_CLI_AUTO_COMPACT_OVERRIDE = config.COMPACT_OVERRIDE;
    }

    // Windows 不能直接 spawn 一个 .js 文件，即使它带 shebang。
    // 官方 agy 是原生可执行文件，不受影响；这条分支只服务于「用脚本冒充 CLI」
    // 的场合（测试桩、Windows 上的本地开发）。
    const viaNode = process.platform === 'win32' && /\.(c|m)?js$/i.test(bin);
    const spawnCmd = viaNode ? process.execPath : bin;
    const spawnArgs = viaNode ? [bin, ...args] : args;

    let child;
    try {
      child = spawn(spawnCmd, spawnArgs, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({
        code: -1,
        text: '',
        conversationId: opts.conversationId || null,
        usage: null,
        conversationMissing: false,
        stderr: String(err && err.message ? err.message : err),
      });
    }

    if (typeof opts.onSpawn === 'function') {
      try { opts.onSpawn(child); } catch {}
    }
    if (typeof globalThis.__agyRegisterChild === 'function') {
      try { globalThis.__agyRegisterChild(child); } catch {}
    }
    if (opts.signal) {
      if (opts.signal.aborted) {
        try { child.kill('SIGTERM'); } catch {}
      } else {
        opts.signal.addEventListener('abort', () => {
          try { child.kill('SIGTERM'); } catch {}
        }, { once: true });
      }
    }

    let lineBuf = '';
    let deltaText = '';
    let resultText = null;
    let conversationId = opts.conversationId || null;
    let usage = null;
    let conversationMissing = false;
    let stderr = '';
    let rawStdout = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    function handleLine(rawLine) {
      const line = rawLine.trim();
      if (!line) return;
      if (checkMissingWarning(line)) {
        conversationMissing = true;
      }
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (!evt || typeof evt !== 'object') return;

      if (evt.event === 'init') {
        const cid = evt.conversation_id || (evt.init && evt.init.conversation_id) || evt.conversationId;
        if (cid) conversationId = String(cid);
      } else if (evt.event === 'step_update') {
        const su = evt.step_update || evt;
        if (su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta.length > 0) {
          deltaText += su.text_delta;
          if (onDelta) {
            try { onDelta(su.text_delta); } catch {}
          }
        }
      } else if (evt.event === 'result') {
        const res = evt.result || evt;
        if (typeof res.response === 'string' && res.response.length > 0) {
          resultText = res.response;
        }
        if (res.usage && typeof res.usage === 'object') {
          usage = res.usage;
        }
        if (res.conversation_id && !conversationId) {
          conversationId = String(res.conversation_id);
        }
      }

      if (evt.conversation_id && !conversationId) {
        conversationId = String(evt.conversation_id);
      }
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    function processStdoutStr(str) {
      if (!str) return;
      rawStdout += str;
      if (checkMissingWarning(str)) {
        conversationMissing = true;
      }
      lineBuf += str;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
    }

    child.stdout.on('data', (chunk) => {
      const str = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk);
      processStdoutStr(str);
    });

    child.stderr.on('data', (chunk) => {
      const str = typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk);
      stderr += str;
      if (checkMissingWarning(str) || checkMissingWarning(stderr)) {
        conversationMissing = true;
      }
    });

    child.stdin.on('error', () => {});
    try {
      child.stdin.write(Buffer.from(prompt, 'utf8'));
      child.stdin.end();
    } catch {}

    function finish(code, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const remOut = stdoutDecoder.end();
      if (remOut) {
        processStdoutStr(remOut);
      }
      const remErr = stderrDecoder.end();
      if (remErr) {
        stderr += remErr;
      }
      if (lineBuf.trim()) {
        handleLine(lineBuf);
        lineBuf = '';
      }
      if (checkMissingWarning(stderr) || checkMissingWarning(rawStdout)) {
        conversationMissing = true;
      }
      const exitCode = typeof code === 'number'
        ? code
        : (timedOut || signal === 'SIGKILL' ? 137 : (signal === 'SIGTERM' ? 143 : -1));
      const text = (resultText !== null && resultText.length >= deltaText.length)
        ? resultText
        : (deltaText || resultText || '');

      resolve({
        code: exitCode,
        text,
        conversationId: conversationId || null,
        usage: usage || null,
        conversationMissing,
        stderr,
      });
    }

    child.on('error', (err) => {
      stderr += (stderr ? '\n' : '') + String(err && err.message ? err.message : err);
      finish(-1, null);
    });

    child.on('close', (code, signal) => {
      finish(code, signal);
    });
  });
}

module.exports = { runTurn };
