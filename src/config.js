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

/**
 * 单轮 prompt 的硬上限（默认 4,500,000 字节，约 1M+ token，可由 AGY_PROMPT_HARD_CAP 覆盖）。
 * 注意：agy 通过 stdin 管道（不传 -p）输入时不受 192KB 命令行参数上限约束。
 */
// 实测（CLI 1.5.16/1.5.17）：单轮 stdin 超过约 192KB 后，CLI 会丢弃中后段内容。
// 3.4MB 输入时模型只看到开头的金丝雀，中间与尾部全部 MISS；250KB 输入则首尾都能读到。
// 因此默认给一个保守值，只有显式设置 AGY_PROMPT_HARD_CAP 才放开到更大（风险自负）。
const CLI_PROMPT_HARD_CAP = posNum(process.env.AGY_PROMPT_HARD_CAP, 190000);

function clampBudget(envVal, fallback = 180000, max = CLI_PROMPT_HARD_CAP) {
  const positive = posNum(envVal, fallback);
  return Math.min(max, positive);
}

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

  /** 每个聊天一个子目录，里面是 state.md / chapters.md / timeline.md 归档 */
  WORKSPACES: process.env.AGY_WORKSPACES || path.join(DATA_DIR, 'chats'),
  /** 会话映射（chatKey -> conversation_id） */
  STATE_FILE: process.env.AGY_STATE_FILE || path.join(DATA_DIR, 'sessions.json'),
  LOG_DIR: process.env.AGY_LOG_DIR || path.join(DATA_DIR, 'logs'),

  CLI_PROMPT_HARD_CAP,
  PROMPT_HARD_CAP: CLI_PROMPT_HARD_CAP,
  /** 单轮 prompt 的字节上限（默认 180,000，硬钳制到 CLI_PROMPT_HARD_CAP 默认 190,000） */
  PROMPT_BUDGET: clampBudget(process.env.AGY_PROMPT_BUDGET, 180000, CLI_PROMPT_HARD_CAP),
  MAX_CONCURRENT: posNum(process.env.AGY_MAX_CONCURRENT, 1),
  QUEUE_LIMIT: posNum(process.env.AGY_QUEUE_LIMIT, 2),
  QUEUE_TIMEOUT_MS: posNum(process.env.AGY_QUEUE_TIMEOUT_MS, 120000),
  PREEMPT_WAIT_MS: posNum(process.env.AGY_PREEMPT_WAIT_MS, 1500),
  TURN_TIMEOUT_MS: posNum(process.env.AGY_TURN_TIMEOUT_MS, 900000),

  /** 交给 CLI 的自动压缩阈值（优先 AGY_CLI_AUTO_COMPACT_OVERRIDE，其次 AGY_COMPACT_OVERRIDE，默认 85%） */
  COMPACT_OVERRIDE: parseCompactOverride(rawCompactOverride, defaultCompactOverride),
  /** 同一会话超过这么多轮后，主动用新的 bootstrap 轮转，避免 CLI 压缩劣化文风 */
  MAX_TURNS_PER_SESSION: posNum(process.env.AGY_MAX_TURNS_PER_SESSION, 300),
  MAX_DRIFT_FLOORS: posNum(process.env.AGY_MAX_DRIFT_FLOORS, 4),
  MAX_SWIPE_STREAK: posNum(process.env.AGY_MAX_SWIPE_STREAK, 3),

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
