'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const memoryStateByFile = new Map();

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .join('');
  }
  return content == null ? '' : String(content);
}

/**
 * Truncate a string to at most maxBytes UTF-8 bytes without splitting multi-byte characters.
 */
function truncateUtf8(str, maxBytes) {
  const s = typeof str === 'string' ? str : String(str || '');
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Take the last maxBytes UTF-8 bytes of a string without splitting multi-byte characters.
 */
function tailUtf8(str, maxBytes) {
  const s = typeof str === 'string' ? str : String(str || '');
  if (maxBytes <= 0) return '';
  const total = Buffer.byteLength(s, 'utf8');
  if (total <= maxBytes) return s;
  const buf = Buffer.from(s, 'utf8');
  let start = total - maxBytes;
  while (start < total && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start, total).toString('utf8');
}

function isSystemRole(role) {
  return role === 'system' || role === 'developer';
}

function formatMessage(msg, idx) {
  const role = (msg && msg.role) ? String(msg.role) : 'user';
  const content = textOf(msg ? msg.content : '');
  const label = role === 'user' ? 'user' : (role === 'assistant' ? 'assistant' : role);
  return typeof idx === 'number'
    ? `[#${idx} ${label}]\n${content}`
    : `[${label}]\n${content}`;
}

/**
 * sha1(role + '\0' + content).slice(0,12)
 */
function layerHash(msg) {
  const role = (msg && typeof msg === 'object' && msg.role != null) ? String(msg.role) : '';
  const content = (msg && typeof msg === 'object') ? textOf(msg.content) : String(msg || '');
  return crypto
    .createHash('sha1')
    .update(role + '\0' + content, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function extractKeyParts(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const sysText = list
    .filter((m) => m && isSystemRole(m.role))
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');
  const nonSysMsgs = list.filter((m) => m && !isSystemRole(m.role));
  const nonSys = nonSysMsgs.map((m) => textOf(m.content));

  const sys1KB = truncateUtf8(sysText, 1024);
  const first = nonSys[0] || '';
  const second = nonSys[1] || '__INIT__';

  return { sysText, sys1KB, first, second, nonSys, nonSysMsgs };
}

/**
 * primary key: sha256(system前1KB + \0 + 首条非system).slice(0,16)
 */
function chatKey(messages) {
  const { sys1KB, first } = extractKeyParts(messages);
  return crypto
    .createHash('sha256')
    .update(sys1KB + '\0' + first, 'utf8')
    .digest('hex')
    .slice(0, 16);
}

/**
 * alias key: sha256(system前1KB + \0 + 首条非system + \0 + (第二条非system || '__INIT__')).slice(0,16)
 */
function aliasKey(messages) {
  const { sys1KB, first, second } = extractKeyParts(messages);
  return crypto
    .createHash('sha256')
    .update(sys1KB + '\0' + first + '\0' + (second || '__INIT__'), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

function chatKeys(messages) {
  return {
    primary: chatKey(messages),
    alias: aliasKey(messages),
  };
}

function findBySingleKey(state, targetKey) {
  if (!state || typeof state !== 'object' || !targetKey) return null;
  if (state[targetKey] && typeof state[targetKey] === 'object') {
    return { key: targetKey, sess: state[targetKey] };
  }
  for (const [k, rec] of Object.entries(state)) {
    if (rec && typeof rec === 'object' && Array.isArray(rec.keys) && rec.keys.includes(targetKey)) {
      return { key: k, sess: rec };
    }
  }
  return null;
}

/**
 * 查询时先查 primary，再查 alias；
 * 若通过 alias 命中且记录只有 primary，则把 alias 补进记录的 keys 数组。
 */
function resolveSession(state, messages) {
  const safeState = (state && typeof state === 'object') ? state : {};
  const { sysText, sys1KB, nonSysMsgs } = extractKeyParts(messages);
  const primary = chatKey(messages);
  const alias = aliasKey(messages);

  let hit = findBySingleKey(safeState, primary);
  let hitBy = hit ? 'primary' : null;

  if (!hit) {
    hit = findBySingleKey(safeState, alias);
    if (hit) hitBy = 'alias';
  }

  // 若原 system 不足 1KB，两轮之间插入世界书使 system 变长，按已同步对话层与初始 system 片段兜底匹配同一会话
  if (!hit && nonSysMsgs.length > 0) {
    const hashes = nonSysMsgs.map(layerHash);
    for (const [k, rec] of Object.entries(safeState)) {
      if (!rec || typeof rec !== 'object' || !Array.isArray(rec.syncedHashes) || rec.syncedHashes.length === 0) {
        continue;
      }
      if (rec.syncedHashes[0] !== hashes[0]) continue;
      const twoLayerMatch = hashes.length >= 2 && rec.syncedHashes.length >= 2 && rec.syncedHashes[1] === hashes[1];
      const sysGrowMatch = typeof rec.sysHead === 'string' && rec.sysHead.length > 0 && sysText.includes(rec.sysHead);
      if (twoLayerMatch || sysGrowMatch) {
        hit = { key: k, sess: rec };
        hitBy = 'alias';
        break;
      }
    }
  }

  if (hit && hit.sess) {
    if (!Array.isArray(hit.sess.keys)) {
      hit.sess.keys = [hit.key];
    }
    if (!hit.sess.keys.includes(primary)) {
      hit.sess.keys.push(primary);
    }
    if (!hit.sess.keys.includes(alias)) {
      hit.sess.keys.push(alias);
    }
    return {
      key: hit.key,
      sess: hit.sess,
      primary,
      alias,
      keys: hit.sess.keys,
      hitBy,
      sysHead: hit.sess.sysHead || truncateUtf8(sys1KB, 64),
    };
  }

  const keys = primary === alias ? [primary] : [primary, alias];
  return {
    key: primary,
    sess: null,
    primary,
    alias,
    keys,
    hitBy: null,
    sysHead: truncateUtf8(sys1KB, 64),
  };
}

function loadState() {
  const file = config.STATE_FILE;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      memoryStateByFile.set(file, parsed);
      return parsed;
    }
  } catch {
    if (memoryStateByFile.has(file)) {
      return JSON.parse(JSON.stringify(memoryStateByFile.get(file)));
    }
  }
  return {};
}

function saveState(state) {
  const file = config.STATE_FILE;
  const safeState = (state && typeof state === 'object') ? state : {};
  memoryStateByFile.set(file, JSON.parse(JSON.stringify(safeState)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(safeState, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify(safeState, null, 2), 'utf8');
    } catch {}
  }
}

/**
 * 无 sess → deep；消息层哈希与 syncedHashes 前缀一致且只多 1 条 → advance；
 * 首个不一致下标 divIdx，深度 = syncedHashes.length - divIdx；深度<=4 且 swipeStreak<3 → shallow；否则 deep
 */
function driftOf(sess, messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!sess || typeof sess !== 'object') {
    return { kind: 'deep', divIdx: 0 };
  }
  if (('convId' in sess && !sess.convId) || sess.conversationMissing) {
    return { kind: 'deep', divIdx: 0 };
  }
  if (typeof sess.turns === 'number' && sess.turns >= config.MAX_TURNS_PER_SESSION) {
    return { kind: 'deep', divIdx: 0 };
  }
  const synced = Array.isArray(sess.syncedHashes) ? sess.syncedHashes : [];
  if (synced.length === 0) {
    return { kind: 'deep', divIdx: 0 };
  }

  const nonSys = list.filter((m) => m && !isSystemRole(m.role));
  const hashes = nonSys.map(layerHash);
  if (hashes.length === 0) {
    return { kind: 'deep', divIdx: 0 };
  }

  let divIdx = 0;
  const minLen = Math.min(synced.length, hashes.length);
  while (divIdx < minLen && synced[divIdx] === hashes[divIdx]) {
    divIdx++;
  }

  if (divIdx === synced.length && hashes.length === synced.length + 1) {
    return { kind: 'advance', divIdx };
  }

  const depth = synced.length - divIdx;
  const swipeStreak = typeof sess.swipeStreak === 'number' ? sess.swipeStreak : 0;
  if (depth <= config.MAX_DRIFT_FLOORS && swipeStreak < config.MAX_SWIPE_STREAK) {
    return { kind: 'shallow', divIdx };
  }

  return { kind: 'deep', divIdx };
}

/**
 * [SYSTEM]+[OPENING 前2层]+[TIMELINE]+[RECENT 从尾部往前装到预算]，超预算丢弃更早的 RECENT
 */
function buildBootstrap({ system = '', messages = [], timeline = '', budgetBytes = config.PROMPT_BUDGET } = {}) {
  const budget = Number(budgetBytes) > 0 ? Number(budgetBytes) : config.PROMPT_BUDGET;
  const list = Array.isArray(messages) ? messages : [];

  let sysText = typeof system === 'string' ? system : String(system || '');
  if (!sysText) {
    sysText = list
      .filter((m) => m && isSystemRole(m.role))
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
  }

  const nonSys = list.filter((m) => m && !isSystemRole(m.role));
  const openingMsgs = nonSys.slice(0, 2);
  const recentCandidates = nonSys.slice(2);

  const openingBlock = openingMsgs.map((m, i) => formatMessage(m, i)).join('\n\n');
  const timelineText = typeof timeline === 'string' ? timeline : String(timeline || '');

  let sysSection = `[SYSTEM]\n${sysText}`;
  let openingSection = `[OPENING]\n${openingBlock}`;
  let timelineSection = `[TIMELINE]\n${timelineText}`;
  const recentHeader = '[RECENT]\n';

  // Ensure fixed sections fit within budget so there is room for RECENT
  const fixedEnvelope = `${sysSection}\n\n${openingSection}\n\n${timelineSection}\n\n${recentHeader}`;
  const fixedBytes = Buffer.byteLength(fixedEnvelope, 'utf8');

  if (fixedBytes > Math.floor(budget * 0.75)) {
    const timelineCap = Math.max(0, Math.floor(budget * 0.2));
    if (Buffer.byteLength(timelineText, 'utf8') > timelineCap) {
      timelineSection = `[TIMELINE]\n${tailUtf8(timelineText, timelineCap)}`;
    }
    const openingCap = Math.max(0, Math.floor(budget * 0.15));
    if (Buffer.byteLength(openingBlock, 'utf8') > openingCap) {
      openingSection = `[OPENING]\n${truncateUtf8(openingBlock, openingCap)}`;
    }
    const sysCap = Math.max(0, Math.floor(budget * 0.35));
    if (Buffer.byteLength(sysText, 'utf8') > sysCap) {
      sysSection = `[SYSTEM]\n${truncateUtf8(sysText, sysCap)}`;
    }
  }

  const prefix = `${sysSection}\n\n${openingSection}\n\n${timelineSection}\n\n${recentHeader}`;
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');

  if (prefixBytes >= budget) {
    return truncateUtf8(prefix, budget);
  }

  let remainingBytes = budget - prefixBytes;
  const selectedRecent = [];
  const sepBytes = Buffer.byteLength('\n\n', 'utf8');

  for (let i = recentCandidates.length - 1; i >= 0; i--) {
    const floorIdx = i + 2;
    const formatted = formatMessage(recentCandidates[i], floorIdx);
    const itemBytes = Buffer.byteLength(formatted, 'utf8');
    const needed = selectedRecent.length === 0 ? itemBytes : itemBytes + sepBytes;

    if (needed <= remainingBytes) {
      selectedRecent.unshift(formatted);
      remainingBytes -= needed;
    } else {
      if (selectedRecent.length === 0 && remainingBytes > 0) {
        selectedRecent.unshift(tailUtf8(formatted, remainingBytes));
        remainingBytes = 0;
      }
      break;
    }
  }

  const out = prefix + selectedRecent.join('\n\n');
  if (Buffer.byteLength(out, 'utf8') > budget) {
    return truncateUtf8(out, budget);
  }
  return out;
}

/**
 * [TIMELINE OVERRIDE] 片段
 */
function buildOverride({ divIdx = 0, messages = [] } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const nonSys = list.filter((m) => m && !isSystemRole(m.role));
  const source = (divIdx < nonSys.length || nonSys.length === list.length) ? nonSys : list;
  const start = Math.max(0, Number(divIdx) || 0);
  const sliced = source.slice(start);
  const body = sliced.map((m, i) => formatMessage(m, start + i)).join('\n\n');

  const raw =
    `[TIMELINE OVERRIDE]\n` +
    `从第 ${start} 层起对话历史已回退或改写，请忽略此前第 ${start} 层及之后的旧内容，以如下最新记录为准继续回复：\n\n` +
    body;

  if (Buffer.byteLength(raw, 'utf8') > config.PROMPT_BUDGET) {
    const header = `[TIMELINE OVERRIDE]\n从第 ${start} 层起对话历史已回退或改写，以如下最新记录为准继续回复：\n\n`;
    const budget = Math.max(0, config.PROMPT_BUDGET - Buffer.byteLength(header, 'utf8'));
    return header + tailUtf8(body, budget);
  }
  return raw;
}

module.exports = {
  chatKey,
  aliasKey,
  chatKeys,
  resolveSession,
  loadState,
  saveState,
  driftOf,
  buildBootstrap,
  buildOverride,
  layerHash,
};
