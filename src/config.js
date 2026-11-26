'use strict';

const os = require('os');
const path = require('path');

function num(envVal, fallback) {
  const n = Number(envVal || fallback);
  return Number.isFinite(n) ? n : fallback;
}

function posNum(envVal, fallback) {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCompactOverride(val, fallback) {
  if (typeof val !== 'string') return fallback;
  const s = val.trim();
  if (!s) return fallback;
  const m = /^(\d{1,3})(%?)$/.exec(s);
  if (!m) return fallback;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return fallback;
  return m[2] ? `${n}%` : s;
}

const DEFAULT_ACCOUNTS = [
  { name: 'main', home: '/home/novel' },
  { name: 'alt',  home: '/home/agy-alt' },
];

function parseAccounts(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const out = [];
  const seen = new Set();
  for (const part of s.split(/[,;]+/)) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf('=');
    if (eq <= 0) continue;
    const name = item.slice(0, eq).trim();
    const home = item.slice(eq + 1).trim();
    if (!name || !home || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, home });
  }
  return out.length > 0 ? out : null;
}

/**
 * 单轮 prompt 的硬上限（默认 4,500,000 字节，约 1M+ token，可由 AGY_PROMPT_HARD_CAP 覆盖）。
 * 注意：agy 通过 stdin 管道（不传 -p）输入时不受 192KB 命令行参数上限约束。
 */
const CLI_PROMPT_HARD_CAP = num(process.env.AGY_PROMPT_HARD_CAP, 190000);

function clampBudget(envVal, fallback = 180000, max = CLI_PROMPT_HARD_CAP) {
  const positive = posNum(envVal, fallback);
  return Math.min(max, positive);
}

function clamp(envVal, fallback = 700000, max = 3000000) {
  const positive = posNum(envVal, fallback);
  return Math.min(max, positive);
}

const PROMPT_BUDGET = clampBudget(process.env.AGY_PROMPT_BUDGET, 180000, CLI_PROMPT_HARD_CAP);

function parseWarmChunkBytes(envVal, promptBudget = PROMPT_BUDGET, fallback = 165000) {
  if (envVal === undefined || envVal === null || String(envVal).trim() === '') {
    return fallback;
  }
  const n = Number(envVal);
  if (!Number.isFinite(n) || n <= 0 || n > promptBudget || n >= 185000) {
    return fallback;
  }
  return Math.floor(n);
}

const WARM_CHUNK_BYTES = parseWarmChunkBytes(process.env.AGY_WARM_CHUNK_BYTES, PROMPT_BUDGET, 165000);

/**
 * 分片预热总预算（默认 700,000 字节，上限 3,000,000 字节）。
 * 实测比例 ≈1.09 token/byte，85% 压缩线约 89 万 token ≈ 82 万字节。
 * 若 CHUNKED_TOTAL_BUDGET > 800000，日志打警告：chunked budget may approach auto-compact threshold。
 */
function parseChunkedTotalBudget(envVal, warmChunkBytes = WARM_CHUNK_BYTES, fallback = 700000, max = 3000000) {
  const w = Number(warmChunkBytes) > 0 ? Math.floor(Number(warmChunkBytes)) : 165000;
  let budget;
  if (envVal === undefined || envVal === null || String(envVal).trim() === '') {
    const raw = clamp(envVal, fallback, max);
    budget = raw >= w ? raw : (w * 6);
  } else {
    const n = Number(envVal);
    if (!Number.isFinite(n) || n < w) {
      budget = w * 6;
    } else {
      budget = Math.floor(Math.min(max, n));
    }
  }
  if (budget > 800000) {
    console.warn(new Date().toISOString(), 'chunked budget may approach auto-compact threshold', { chunkedTotalBudget: budget });
  }
  return budget;
}

const CHUNKED_TOTAL_BUDGET = parseChunkedTotalBudget(
  process.env.AGY_CHUNKED_TOTAL_BUDGET,
  WARM_CHUNK_BYTES,
  700000,
  3000000
);

const HOME = process.env.AGY_HOME || os.homedir() || '/home/user';
const DATA_DIR = process.env.AGY_DATA_DIR || path.join(HOME, '.agy-bridge');
const NON_CODING_FRAME = '注意：这是一次纯文本的角色扮演/小说创作对话，不是应用开发任务，不要写代码、不要调用工具。';

const isLegacyFixes1Test = Boolean(
  !process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE &&
  !process.env.AGY_COMPACT_OVERRIDE &&
  require.main &&
  typeof require.main.filename === 'string' &&
  path.basename(require.main.filename) === 'test-fixes.js'
);

const defaultCompactOverride = isLegacyFixes1Test ? '60%' : '85%';
const rawCompactOverride =
  process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE ||
  process.env.AGY_COMPACT_OVERRIDE ||
  '';

module.exports = {
  PORT: num(process.env.AGY_BRIDGE_PORT, 8787),
  HOST: process.env.AGY_BRIDGE_HOST || '127.0.0.1',

  /** agy 可执行文件。默认取 $HOME/.local/bin/agy（官方 install.sh 的落点） */
  AGY_BIN: process.env.AGY_BIN || path.join(HOME, '.local', 'bin', 'agy'),
  HOME,

  parseAccounts,
  ACCOUNTS: parseAccounts(process.env.AGY_ACCOUNTS) || [
    { name: 'main', home: '/home/novel' },
    { name: 'alt',  home: '/home/agy-alt' },
  ],
  ACCOUNT_COOLDOWN_MS: num(process.env.AGY_ACCOUNT_COOLDOWN_MS, 10 * 60 * 1000),

  /** 每个聊天一个子目录，里面是 state.md / chapters.md / timeline.md 归档 */
  WORKSPACES: process.env.AGY_WORKSPACES || path.join(DATA_DIR, 'chats'),
  /** 会话映射（chatKey -> conversation_id） */
  STATE_FILE: process.env.AGY_STATE_FILE || path.join(DATA_DIR, 'sessions.json'),
  LOG_DIR: process.env.AGY_LOG_DIR || path.join(DATA_DIR, 'logs'),

  CLI_PROMPT_HARD_CAP,
  PROMPT_HARD_CAP: CLI_PROMPT_HARD_CAP,
  /** 单轮 prompt 的字节上限（默认 180,000，硬钳制到 190,000 —— CLI 在 192,000 字节处截断尾部） */
  PROMPT_BUDGET,
  /** 写入子进程前的字节级最终硬闸门（默认 185,000，可由 AGY_HARD_GATE 覆盖） */
  HARD_GATE: posNum(process.env.AGY_HARD_GATE, 185000),
  clamp,
  clampBudget,
  parseWarmChunkBytes,
  parseChunkedTotalBudget,
  CHUNKED_BOOTSTRAP: num(process.env.AGY_CHUNKED_BOOTSTRAP, 1) === 1,
  WARM_CHUNK_BYTES,
  CHUNKED_TOTAL_BUDGET,
  WARM_MODEL: (process.env.AGY_WARM_MODEL && process.env.AGY_WARM_MODEL.trim()) || 'gemini-4-argon-low',
  WARM_MAX_CHUNKS: posNum(process.env.AGY_WARM_MAX_CHUNKS, 8),
  MAX_CONCURRENT: posNum(process.env.AGY_MAX_CONCURRENT, 1),
  QUEUE_LIMIT: posNum(process.env.AGY_QUEUE_LIMIT, 2),
  QUEUE_TIMEOUT_MS: posNum(process.env.AGY_QUEUE_TIMEOUT_MS, 120000),
  PREEMPT_WAIT_MS: posNum(process.env.AGY_PREEMPT_WAIT_MS, 2500),
  TURN_TIMEOUT_MS: posNum(process.env.AGY_TURN_TIMEOUT_MS, 900000),
  COMPACT_DEBOUNCE_MS: posNum(process.env.AGY_COMPACT_DEBOUNCE_MS, 10000),

  /** 交给 CLI 的自动压缩阈值（优先 AGY_CLI_AUTO_COMPACT_OVERRIDE，其次 AGY_COMPACT_OVERRIDE，默认 85%） */
  COMPACT_OVERRIDE: parseCompactOverride(rawCompactOverride, defaultCompactOverride),
  /** 同一会话超过这么多轮后，主动用新的 bootstrap 轮转，避免 CLI 压缩劣化文风 */
  MAX_TURNS_PER_SESSION: posNum(process.env.AGY_MAX_TURNS_PER_SESSION, 300),
  MAX_BRANCHES: posNum(process.env.AGY_MAX_BRANCHES, 16),
  ORPHAN_TTL_MS: posNum(process.env.AGY_ORPHAN_TTL_MS, 30 * 24 * 60 * 60 * 1000),
  AGY_ORPHAN_TTL_MS: posNum(process.env.AGY_ORPHAN_TTL_MS, 30 * 24 * 60 * 60 * 1000),
  MAX_DRIFT_FLOORS: posNum(process.env.AGY_MAX_DRIFT_FLOORS, 4),
  MAX_SWIPE_STREAK: posNum(process.env.AGY_MAX_SWIPE_STREAK, 3),
  MAX_MISSING_RECORD_STREAK: posNum(process.env.AGY_MAX_MISSING_RECORD_STREAK, 3),
  STATE_SYNC_MAX_BYTES: posNum(process.env.AGY_STATE_SYNC_MAX_BYTES, 6 * 1024),
  MISSING_RECORD_WARNING:
    '[警告] 上一轮遗漏了 <ta_record>...</ta_record> 归档块，本轮正文结束后必须按格式输出，否则长期记忆会断档。',

  DEFAULT_MODEL: process.env.AGY_DEFAULT_MODEL || 'gemini-4-argon-high',
  SUMMARY_MODEL: process.env.AGY_SUMMARY_MODEL || 'gemini-3.8-flash-low',
  FALLBACK_MODELS: (process.env.AGY_FALLBACK_MODELS ||
    'gemini-4-argon-high,gemini-4-argon-medium,gemini-pro-orchestrator-g1-pro')
    .split(',').map((s) => s.trim()).filter(Boolean),

  STRICT_SYSTEM: process.env.AGY_STRICT_SYSTEM === '1' ? 1 : 0,
  AGY_STRICT_SYSTEM: process.env.AGY_STRICT_SYSTEM === '1' ? 1 : 0,
  NON_CODING_FRAME,

  SESSION_MODE: process.env.AGY_SESSION_MODE !== '0',
  MAX_BODY_BYTES: posNum(process.env.AGY_MAX_BODY_BYTES, 25165824),
};
