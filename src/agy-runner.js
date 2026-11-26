'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { spawn } = cp;
const { StringDecoder } = require('string_decoder');
const config = require('./config');

const origChildKill = cp.ChildProcess && cp.ChildProcess.prototype
  ? cp.ChildProcess.prototype.kill
  : null;

function rawKillChild(child, sig) {
  if (!child) return false;
  if (typeof child.__agyRawKill === 'function') {
    return child.__agyRawKill(sig);
  }
  if (origChildKill) {
    return origChildKill.call(child, sig);
  }
  if (typeof child.kill === 'function') {
    return child.kill(sig);
  }
  return false;
}

/**
 * 统一终止子进程：
 * 1) 发送 SIGTERM
 * 2) 起 800ms 定时器，若仍未 exit 则发送 SIGKILL
 * 3) child exit/close 时清理定时器
 */
function terminateChild(child, graceMs = 800) {
  if (!child) return;
  if (child.exitCode !== null && child.exitCode !== undefined) return;
  if (child.signalCode !== null && child.signalCode !== undefined) return;

  let exited = false;
  const clearTimer = () => {
    exited = true;
    if (child.__agyKillTimer) {
      clearTimeout(child.__agyKillTimer);
      child.__agyKillTimer = null;
    }
  };

  if (!child.__agyTermListenersAttached) {
    child.__agyTermListenersAttached = true;
    if (typeof child.once === 'function') {
      child.once('exit', clearTimer);
      child.once('close', clearTimer);
    } else if (typeof child.on === 'function') {
      child.on('exit', clearTimer);
      child.on('close', clearTimer);
    }
  }

  try {
    rawKillChild(child, 'SIGTERM');
  } catch {}

  if (
    exited ||
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  ) {
    clearTimer();
    return;
  }

  if (!child.__agyKillTimer) {
    const waitMs = Number(graceMs) > 0 ? Number(graceMs) : 800;
    child.__agyKillTimer = setTimeout(() => {
      child.__agyKillTimer = null;
      if (
        !exited &&
        (child.exitCode === null || child.exitCode === undefined) &&
        (child.signalCode === null || child.signalCode === undefined)
      ) {
        try {
          rawKillChild(child, 'SIGKILL');
        } catch {}
      }
    }, waitMs);
    if (typeof child.__agyKillTimer.unref === 'function') {
      child.__agyKillTimer.unref();
    }
  }
}

if (cp.ChildProcess && cp.ChildProcess.prototype && !cp.ChildProcess.prototype.__agyTerminateHooked) {
  cp.ChildProcess.prototype.kill = function (sig) {
    if (!sig || sig === 'SIGTERM') {
      terminateChild(this);
      return true;
    }
    return origChildKill.call(this, sig);
  };
  cp.ChildProcess.prototype.__agyTerminateHooked = true;
}

/**
 * 决定「怎么调用 CLI」。Windows 不能直接 spawn 一个 .js 文件，即使它带
 * shebang；官方 agy 是原生可执行文件，不受影响，这条分支只服务于
 * 「用脚本冒充 CLI」的场合（测试桩、Windows 上的本地开发）。
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {{cmd: string, args: string[]}}
 */
function binSpec(bin, args = []) {
  let viaNode = process.platform === 'win32' && /\.(c|m)?js$/i.test(bin);
  if (!viaNode && /\.(c|m)?js$/i.test(bin)) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
    } catch {
      viaNode = true;
    }
  }
  return viaNode
    ? { cmd: process.execPath, args: [bin, ...args] }
    : { cmd: bin, args };
}

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
    const silent = Boolean(opts.silent);
    const onDelta = (!silent && typeof opts.onDelta === 'function') ? opts.onDelta : null;
    const onMissing = typeof opts.onMissing === 'function' ? opts.onMissing : null;

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

    const defaultSysDir = path.join(config.WORKSPACES, '_sys');
    let cwd = opts.cwd || defaultSysDir;
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch {
      cwd = process.cwd();
    }

    const bin = process.env.AGY_BIN || config.AGY_BIN;
    const effectiveHome = (typeof opts.home === 'string' && opts.home.trim())
      ? opts.home.trim()
      : config.HOME;
    const env = { ...process.env, HOME: effectiveHome };
    delete env.ELECTRON_RUN_AS_NODE;
    const compactOverride =
      process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE ||
      process.env.AGY_COMPACT_OVERRIDE ||
      config.COMPACT_OVERRIDE;
    if (compactOverride) {
      env.AGY_CLI_AUTO_COMPACT_OVERRIDE = compactOverride;
    }

    const spec = binSpec(bin, args);

    let child;
    try {
      child = spawn(spec.cmd, spec.args, {
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
        terminateChild(child);
      } else {
        opts.signal.addEventListener('abort', () => {
          terminateChild(child);
        }, { once: true });
      }
    }

    let lineBuf = '';
    let deltaText = '';
    let resultText = null;
    let conversationId = opts.conversationId || null;
    let usage = null;
    let conversationMissing = false;
    let missingNotified = false;
    let stderr = '';
    let rawStdoutTail = '';
    let timedOut = false;
    let settled = false;

    function triggerMissing() {
      conversationMissing = true;
      if (!missingNotified) {
        missingNotified = true;
        terminateChild(child);
        if (onMissing) {
          try { onMissing(); } catch {}
        }
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, timeoutMs);

    function handleLine(rawLine) {
      const line = rawLine.trim();
      if (!line) return;
      if (checkMissingWarning(line)) {
        triggerMissing();
        return;
      }
      if (conversationMissing) return;
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
          if (conversationMissing) return;
          deltaText += su.text_delta;
          if (onDelta) {
            try { onDelta(su.text_delta); } catch {}
          }
        }
      } else if (evt.event === 'result') {
        if (conversationMissing) return;
        const res = evt.result || evt;
        if (typeof res.response === 'string' && res.response.length > 0) {
          resultText = res.response;
        }
        if (res.usage && typeof res.usage === 'object') {
          usage = res.usage;
        }
        if (res.conversation_id) {
          conversationId = String(res.conversation_id);
        }
        if (res.error) {
          const errStr = typeof res.error === 'string' ? res.error : JSON.stringify(res.error);
          if (errStr && !stderr.includes(errStr)) {
            stderr += (stderr ? '\n' : '') + errStr;
          }
        }
      } else if (evt.event === 'error' || evt.error) {
        const errPayload = evt.error || evt.message || evt;
        const errStr = typeof errPayload === 'string' ? errPayload : JSON.stringify(errPayload);
        if (errStr && !stderr.includes(errStr)) {
          stderr += (stderr ? '\n' : '') + errStr;
        }
      }

      if (evt.conversation_id && !conversationId) {
        conversationId = String(evt.conversation_id);
      }
    }

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    let stderrTail = '';

    function processStdoutStr(str) {
      if (!str) return;
      rawStdoutTail = (rawStdoutTail + str).slice(-1024);
      lineBuf += str;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        handleLine(line);
      }
      if (checkMissingWarning(lineBuf) || checkMissingWarning(rawStdoutTail)) {
        triggerMissing();
      }
    }

    child.stdout.on('data', (chunk) => {
      const str = typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk);
      processStdoutStr(str);
    });

    child.stderr.on('data', (chunk) => {
      const str = typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk);
      stderr += str;
      stderrTail = (stderrTail + str).slice(-512);
      if (checkMissingWarning(str) || checkMissingWarning(stderrTail)) {
        triggerMissing();
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
      if (checkMissingWarning(stderr) || checkMissingWarning(rawStdoutTail)) {
        triggerMissing();
      }
      const exitCode = typeof code === 'number'
        ? code
        : (timedOut || signal === 'SIGKILL' ? 137 : (signal === 'SIGTERM' ? 143 : -1));
      const text = conversationMissing
        ? ''
        : ((resultText !== null && resultText.length >= deltaText.length)
          ? resultText
          : (deltaText || resultText || ''));

      if (!silent && exitCode !== 0 && !text && rawStdoutTail.trim() && !stderr.includes(rawStdoutTail.trim())) {
        stderr += (stderr ? '\n' : '') + rawStdoutTail.trim();
      }

      resolve({
        code: exitCode,
        text: silent ? (text || '') : text,
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

module.exports = { runTurn, terminateChild, binSpec };
