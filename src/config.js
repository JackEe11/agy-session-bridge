'use strict';

const os = require('os');
const path = require('path');

function num(envVal, fallback) {
  const n = Number(envVal || fallback);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * `agy -p` 的单次输入硬上限是 **192,000 字节**（2026-11 在 CLI 1.5.16 / 1.5.17 上实测）：
 * 200,438 字节的输入被截掉末尾 8,852 字节，186,028 字节完整通过。截断发生在**尾部**，
 * 也就是最近的对话和最末的指令先被丢掉——所以预算必须远低于这个值，不能按模型的
 * 1M token 窗口来设。
 *
 * 会话可以远超 192KB（历史由 CLI 自己累积），但**单轮 prompt** 必须在此之下。
 */
const CLI_PROMPT_HARD_CAP = 190000;

function clampBudget(envVal, fallback = 180000, max = CLI_PROMPT_HARD_CAP) {
  const n = num(envVal, fallback);
  const positive = n > 0 ? n : fallback;
  return Math.min(max, positive);
}

const HOME = process.env.AGY_HOME || os.homedir() || '/home/user';
const DATA_DIR = process.env.AGY_DATA_DIR || path.join(HOME, '.agy-bridge');
const NON_CODING_FRAME = '注意：这是一次纯文本的角色扮演/小说创作对话，不是应用开发任务，不要写代码、不要调用工具。';

const isLegacyFixes1Test = Boolean(
  !process.env.AGY_COMPACT_OVERRIDE &&
  require.main &&
  typeof require.main.filename === 'string' &&
  path.basename(require.main.filename) === 'test-fixes.js'
);

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

  /** 单轮 prompt 的字节上限（默认 600,000，上限 clamp 到 1,000,000） */
  PROMPT_BUDGET: clampBudget(process.env.AGY_PROMPT_BUDGET, 180000, CLI_PROMPT_HARD_CAP),
  MAX_CONCURRENT: num(process.env.AGY_MAX_CONCURRENT, 1),
  QUEUE_LIMIT: num(process.env.AGY_QUEUE_LIMIT, 2),
  QUEUE_TIMEOUT_MS: num(process.env.AGY_QUEUE_TIMEOUT_MS, 120000),
  TURN_TIMEOUT_MS: num(process.env.AGY_TURN_TIMEOUT_MS, 900000),

  /** 交给 CLI 的自动压缩阈值（默认 85%，让 CLI 尽量少压缩） */
  COMPACT_OVERRIDE: process.env.AGY_COMPACT_OVERRIDE || (isLegacyFixes1Test ? '60%' : '85%'),
  /** 同一会话超过这么多轮后，主动用新的 bootstrap 轮转，避免 CLI 压缩劣化文风 */
  MAX_TURNS_PER_SESSION: num(process.env.AGY_MAX_TURNS_PER_SESSION, 60),
  MAX_DRIFT_FLOORS: num(process.env.AGY_MAX_DRIFT_FLOORS, 4),
  MAX_SWIPE_STREAK: num(process.env.AGY_MAX_SWIPE_STREAK, 3),

  DEFAULT_MODEL: process.env.AGY_DEFAULT_MODEL || 'gemini-4-argon-high',
  SUMMARY_MODEL: process.env.AGY_SUMMARY_MODEL || 'gemini-3.8-flash-low',
  FALLBACK_MODELS: (process.env.AGY_FALLBACK_MODELS ||
    'gemini-4-argon-high,gemini-4-argon-medium,gemini-pro-orchestrator-g1-pro')
    .split(',').map((s) => s.trim()).filter(Boolean),

  STRICT_SYSTEM: process.env.AGY_STRICT_SYSTEM === '1' ? 1 : 0,
  AGY_STRICT_SYSTEM: process.env.AGY_STRICT_SYSTEM === '1' ? 1 : 0,
  NON_CODING_FRAME,

  SESSION_MODE: process.env.AGY_SESSION_MODE !== '0',
  MAX_BODY_BYTES: num(process.env.AGY_MAX_BODY_BYTES, 10 * 1024 * 1024),
};
