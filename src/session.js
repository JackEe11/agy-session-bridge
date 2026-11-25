'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const memoryStateByFile = new Map();
let seq = 0;

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
 * 查询时先查 alias，再查 primary（仅当实际非 system 消息数 < 2 时才走 primary）；
 * 命中后可把属于本会话的另一个键补进 keys 数组，但不把一个存档的键塞进另一个已存在记录的 keys 里。
 */
function resolveSession(state, messages) {
  const safeState = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
  const { sysText, sys1KB, first, nonSysMsgs } = extractKeyParts(messages);
  const primary = chatKey(messages);
  const alias = aliasKey(messages);
  const initAlias = crypto
    .createHash('sha256')
    .update(sys1KB + '\0' + first + '\0__INIT__', 'utf8')
    .digest('hex')
    .slice(0, 16);

  let hit = findBySingleKey(safeState, alias);
  let hitBy = hit ? 'alias' : null;

  if (!hit && nonSysMsgs.length < 2) {
    hit = findBySingleKey(safeState, primary);
    if (hit) hitBy = 'primary';
  }

  // 若会话首轮仅 1 条非 system 消息（当时仅登记了 primary / initAlias），第 2 轮起推进至 >=2 条消息时衔接同一会话
  if (!hit && nonSysMsgs.length >= 2) {
    const pHit = findBySingleKey(safeState, primary);
    if (pHit && pHit.sess) {
      const recKeys = Array.isArray(pHit.sess.keys) ? pHit.sess.keys : [pHit.key];
      const hasCommittedSecond = recKeys.some((k) => k !== primary && k !== initAlias);
      if (!hasCommittedSecond) {
        const hashes = nonSysMsgs.map(layerHash);
        const synced = Array.isArray(pHit.sess.syncedHashes) ? pHit.sess.syncedHashes : [];
        if (synced.length < 2 || (synced[0] === hashes[0] && synced[1] === hashes[1])) {
          hit = pHit;
          hitBy = 'primary';
        }
      }
    }
  }

  // 若原 system 不足 1KB，两轮之间插入世界书使 system 变长，按已同步的前两层对话层与初始 system 片段兜底匹配同一会话
  if (!hit && nonSysMsgs.length > 0) {
    const hashes = nonSysMsgs.map(layerHash);
    for (const [k, rec] of Object.entries(safeState)) {
      if (!rec || typeof rec !== 'object' || !Array.isArray(rec.syncedHashes) || rec.syncedHashes.length === 0) {
        continue;
      }
      if (rec.syncedHashes[0] !== hashes[0]) continue;
      if (hashes.length >= 2 && rec.syncedHashes.length >= 2) {
        if (rec.syncedHashes[1] === hashes[1]) {
          hit = { key: k, sess: rec };
          hitBy = 'alias';
          break;
        }
        continue;
      }
      const sysGrowMatch = hashes.length < 2 && rec.syncedHashes.length < 2
        && typeof rec.sysHead === 'string' && rec.sysHead.length > 0 && sysText.includes(rec.sysHead);
      if (sysGrowMatch) {
        hit = { key: k, sess: rec };
        hitBy = 'primary';
        break;
      }
    }
  }

  if (hit && hit.sess) {
    if (!Array.isArray(hit.sess.keys)) {
      hit.sess.keys = [hit.key];
    }
    const pOwner = findBySingleKey(safeState, primary);
    if ((!pOwner || pOwner.sess === hit.sess) && !hit.sess.keys.includes(primary)) {
      hit.sess.keys.push(primary);
    }
    const aOwner = findBySingleKey(safeState, alias);
    if ((!aOwner || aOwner.sess === hit.sess) && !hit.sess.keys.includes(alias)) {
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

  const primaryTaken = Boolean(findBySingleKey(safeState, primary));
  if (primaryTaken || nonSysMsgs.length >= 2) {
    const keys = primaryTaken ? [alias] : (primary === alias ? [alias] : [alias, primary]);
    return {
      key: alias,
      sess: null,
      primary,
      alias,
      keys,
      hitBy: null,
      sysHead: truncateUtf8(sys1KB, 64),
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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      memoryStateByFile.set(file, JSON.parse(JSON.stringify(parsed)));
      return JSON.parse(JSON.stringify(parsed));
    }
    return {};
  } catch {
    if (!fs.existsSync(file) && memoryStateByFile.has(file)) {
      return JSON.parse(JSON.stringify(memoryStateByFile.get(file)));
    }
  }
  return {};
}

function saveState(state) {
  const file = config.STATE_FILE;
  const safeState = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
  memoryStateByFile.set(file, JSON.parse(JSON.stringify(safeState)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${++seq}`;
    fs.writeFileSync(tmp, JSON.stringify(safeState, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.writeFileSync(file, JSON.stringify(safeState, null, 2), 'utf8');
    } catch {}
  }
}

/**
 * 四态漂移判定：
 * - 全部哈希相等且长度相等 → { kind: 'retry', divIdx }
 * - 前缀一致且 hashes.length > synced.length → { kind: 'advance', divIdx }
 * - divIdx === hashes.length && hashes.length < synced.length（纯回滚）→ { kind: 'deep', divIdx }
 * - 首个不一致 divIdx，深度 synced.length - divIdx：
 *   depth <= MAX_DRIFT_FLOORS && swipeStreak < MAX_SWIPE_STREAK → shallow，否则 deep
 */
function driftOf(sess, messages) {
  const list = Array.isArray(messages) ? messages : [];
  if (!sess || typeof sess !== 'object') {
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

  if (('convId' in sess && !sess.convId) || sess.conversationMissing) {
    return { kind: 'deep', divIdx };
  }
  if (typeof sess.turns === 'number' && sess.turns >= config.MAX_TURNS_PER_SESSION) {
    return { kind: 'deep', divIdx };
  }

  if (divIdx === synced.length && hashes.length === synced.length) {
    return { kind: 'retry', divIdx };
  }

  if (divIdx === synced.length && hashes.length > synced.length) {
    return { kind: 'advance', divIdx };
  }

  if (divIdx === hashes.length && hashes.length < synced.length) {
    return { kind: 'deep', divIdx };
  }

  const depth = synced.length - divIdx;
  const swipeStreak = typeof sess.swipeStreak === 'number' ? sess.swipeStreak : 0;
  if (depth <= config.MAX_DRIFT_FLOORS && swipeStreak < config.MAX_SWIPE_STREAK) {
    return { kind: 'shallow', divIdx };
  }

  return { kind: 'deep', divIdx };
}

const DEFAULT_ARCHIVE_INSTRUCTION =
  '\n\n[归档指令]\n' +
  '每轮回复正文结束后，必须在最末尾单独追加一段 <ta_record>...</ta_record> 剧情归档（150-320字），' +
  '涵盖七要素：时间、地点、在场人物、关键事件、关系或状态变化、未兑现承诺或伏笔、当前场景结束状态。' +
  '正文中严禁提及该标签或归档规则。';

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
  if (!sysText.includes('ta_record')) {
    sysText = sysText ? (sysText + DEFAULT_ARCHIVE_INSTRUCTION) : DEFAULT_ARCHIVE_INSTRUCTION.trim();
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
