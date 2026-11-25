'use strict';

const os = require('os');
const path = require('path');

function num(envVal, fallback) {
  const n = Number(envVal || fallback);
  return Number.isFinite(n) ? n : fallback;
}

const HOME = process.env.AGY_HOME || os.homedir() || '/home/user';
const DATA_DIR = process.env.AGY_DATA_DIR || path.join(HOME, '.agy-bridge');

module.exports = {
  PORT: num(process.env.AGY_BRIDGE_PORT, 8787),
  HOST: process.env.AGY_BRIDGE_HOST || '127.0.0.1',

  /** agy 可执行文件。默认取 $HOME/.local/bin/agy（官方 install.sh 的落点） */
  AGY_BIN: process.env.AGY_BIN || path.join(HOME, '.local', 'bin', 'agy'),
  HOME,

  /** 每个聊天一个子目录，里面是 timeline.md 归档 */
  WORKSPACES: process.env.AGY_WORKSPACES || path.join(DATA_DIR, 'chats'),
  /** 会话映射（chatKey -> conversation_id） */
  STATE_FILE: process.env.AGY_STATE_FILE || path.join(DATA_DIR, 'sessions.json'),
  LOG_DIR: process.env.AGY_LOG_DIR || path.join(DATA_DIR, 'logs'),

  /** 单轮 prompt 的字节上限。agy CLI 的硬截断在 192,000 字节，这里留余量 */
  PROMPT_BUDGET: num(process.env.AGY_PROMPT_BUDGET, 170000),
  MAX_CONCURRENT: num(process.env.AGY_MAX_CONCURRENT, 1),
  QUEUE_LIMIT: num(process.env.AGY_QUEUE_LIMIT, 2),
  QUEUE_TIMEOUT_MS: num(process.env.AGY_QUEUE_TIMEOUT_MS, 120000),
  TURN_TIMEOUT_MS: num(process.env.AGY_TURN_TIMEOUT_MS, 900000),

  /** 交给 CLI 的自动压缩阈值（CLI 1.5.15+） */
  COMPACT_OVERRIDE: process.env.AGY_COMPACT_OVERRIDE || '60%',
  /** 同一会话超过这么多轮后，主动用新的 bootstrap 轮转，避免 CLI 压缩劣化文风 */
  MAX_TURNS_PER_SESSION: num(process.env.AGY_MAX_TURNS_PER_SESSION, 60),
  MAX_DRIFT_FLOORS: num(process.env.AGY_MAX_DRIFT_FLOORS, 4),
  MAX_SWIPE_STREAK: num(process.env.AGY_MAX_SWIPE_STREAK, 3),

  DEFAULT_MODEL: process.env.AGY_DEFAULT_MODEL || 'gemini-4-argon-high',
  FALLBACK_MODELS: (process.env.AGY_FALLBACK_MODELS ||
    'gemini-4-argon-high,gemini-4-argon-medium,gemini-pro-orchestrator-g1-pro')
    .split(',').map((s) => s.trim()).filter(Boolean),

  SESSION_MODE: process.env.AGY_SESSION_MODE !== '0',
};
