'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const memoryStateByFile = new Map();
let seq = 0;

const FLOOR_MARKER_GLOBAL_RE = /(?:（第\s*\d+\s*楼）|【第\s*\d+\s*楼】|\(第\s*\d+\s*楼\))/g;
const FLOOR_MARKER_SPLIT_RE = /(?=(?:（第\s*\d+\s*楼）|【第\s*\d+\s*楼】|\(第\s*\d+\s*楼\)))/;
const FLOOR_MARKER_HEAD_RE = /^(?:（第\s*\d+\s*楼）|【第\s*\d+\s*楼】|\(第\s*\d+\s*楼\))/;
const PRESET_BLOCK_MIN_BYTES = 4096;
const RECENT_FLOOR_MAX_BYTES = 40000;
/* 酒馆注入的合成提示（不是用户真的说的话，也不能当楼层） */
const NUDGE_MESSAGE_RE = /^\[(?:start a new chat|start a new group chat|example chat|new chat|continue|impersonate|regenerate)\]$/i;

if (!('content' in String.prototype)) {
  Object.defineProperty(String.prototype, 'content', {
    get() {
      return String(this);
    },
    configurable: true,
  });
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .join('');
  }
  if (content && typeof content === 'object' && typeof content.content === 'string') {
    return content.content;
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

/**
 * Keep both head and tail when a single floor or section exceeds maxBytes.
 */
function capHeadTailUtf8(str, maxBytes) {
  const s = typeof str === 'string' ? str : String(str || '');
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const marker = '\n……（内容超长，中间已省略）……\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  if (maxBytes <= markerBytes + 64) {
    return tailUtf8(s, maxBytes);
  }
  const avail = maxBytes - markerBytes;
  const headBytes = Math.floor(avail / 2);
  const tailBytes = avail - headBytes;
  return truncateUtf8(s, headBytes) + marker + tailUtf8(s, tailBytes);
}

function isSystemRole(role) {
  return role === 'system' || role === 'developer';
}

function markAsFloor(obj) {
  if (obj && typeof obj === 'object') {
    Object.defineProperty(obj, '_isFloor', { value: true, enumerable: false, configurable: true });
  }
  return obj;
}

function makeFloor(msg, content) {
  const f = {
    role: (msg && msg.role) ? String(msg.role) : 'user',
    content,
  };
  if (msg && typeof msg === 'object' && msg.name != null && String(msg.name) !== '') {
    f.name = String(msg.name);
  }
  return markAsFloor(f);
}

/**
 * N1: 拆分预设块与合并楼层
 * 返回 { systemBlocks, floors, postBlocks }
 */
function splitFloors(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemBlocks = [];
  const floors = [];
  const pendingPost = [];

  for (const m of list) {
    if (!m || typeof m !== 'object' || isSystemRole(m.role)) continue;
    const raw = textOf(m.content);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    /* 酒馆的合成提示（新聊天/示例聊天/续写/扮演）不是剧情楼层，必须剔除 */
    if (NUDGE_MESSAGE_RE.test(trimmed)) continue;

    const matches = trimmed.match(FLOOR_MARKER_GLOBAL_RE);
    const markerCount = matches ? matches.length : 0;

    if (markerCount >= 2) {
      const parts = trimmed
        .split(FLOOR_MARKER_SPLIT_RE)
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 0) {
        if (pendingPost.length > 0) {
          for (const p of pendingPost) {
            floors.push(makeFloor(p.msg, p.content));
          }
          pendingPost.length = 0;
        }
        for (const part of parts) {
          floors.push(makeFloor(m, part));
        }
      }
      continue;
    }

    if (markerCount === 0 && Buffer.byteLength(raw, 'utf8') >= PRESET_BLOCK_MIN_BYTES) {
      if (floors.length === 0) {
        systemBlocks.push(trimmed);
      } else {
        pendingPost.push({ msg: m, content: trimmed });
      }
      continue;
    }

    if (pendingPost.length > 0) {
      for (const p of pendingPost) {
        floors.push(makeFloor(p.msg, p.content));
      }
      pendingPost.length = 0;
    }
    floors.push(makeFloor(m, trimmed));
  }

  const postBlocks = pendingPost.map((p) => p.content);
  return { systemBlocks, floors, postBlocks };
}

function formatRoleLabel(msg) {
  const role = (msg && msg.role) ? String(msg.role) : 'user';
  const baseRole = role === 'user' ? 'user' : (role === 'assistant' ? 'assistant' : role);
  const name = (msg && typeof msg === 'object' && msg.name != null && String(msg.name) !== '')
    ? String(msg.name)
    : '';
  return name ? `${baseRole}(${name})` : baseRole;
}

function formatMessage(msg, idx, maxBytes = 0) {
  let content = textOf(msg ? msg.content : '');
  const label = formatRoleLabel(msg);
  const header = typeof idx === 'number'
    ? `[#${idx} ${label}]\n`
    : `[${label}]\n`;
  if (maxBytes > 0) {
    const headerBytes = Buffer.byteLength(header, 'utf8');
    const contentCap = Math.max(0, maxBytes - headerBytes);
    if (Buffer.byteLength(content, 'utf8') > contentCap) {
      content = capHeadTailUtf8(content, contentCap);
    }
  }
  return header + content;
}

/**
 * 无 name 时保持旧格式 sha1(role + '\0' + content).slice(0,12)
 * 有 name 时用 sha1(role + '\0' + name + '\0' + content).slice(0,12)
 */
function layerHash(msg) {
  if (typeof msg === 'string' && /^[0-9a-f]{12}$/.test(msg)) {
    return msg;
  }
  const role = (msg && typeof msg === 'object' && msg.role != null) ? String(msg.role) : '';
  const name = (msg && typeof msg === 'object' && msg.name != null && String(msg.name) !== '')
    ? String(msg.name)
    : '';
  const content = (msg && typeof msg === 'object') ? textOf(msg.content) : String(msg || '');
  const raw = name ? `${role}\0${name}\0${content}` : `${role}\0${content}`;
  return crypto
    .createHash('sha1')
    .update(raw, 'utf8')
    .digest('hex')
    .slice(0, 12);
}

function extractKeyParts(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const stSysText = list
    .filter((m) => m && isSystemRole(m.role))
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');

  const isAlreadyFloors = list.length > 0 && list.every((m) => m && typeof m === 'object' && m._isFloor);
  const { systemBlocks, floors, postBlocks } = isAlreadyFloors
    ? { systemBlocks: [], floors: list, postBlocks: [] }
    : splitFloors(list);

  const sys1KB = stSysText.slice(0, 1024);
  /* 会话键锚定「第一层带编号的正文」（如（第0楼）…），而不是首条非 system 消息：
     酒馆会在开头插入 [Start a new chat] 之类的合成提示，且只在首轮出现，
     用它当键会导致每轮换键 + 所有聊天撞车。 */
  let anchorIdx = floors.findIndex((f) => FLOOR_MARKER_HEAD_RE.test(textOf(f && f.content).trim()));
  if (anchorIdx < 0) anchorIdx = 0;
  const anchor = floors[anchorIdx];
  const nextFloor = floors[anchorIdx + 1];
  const first = anchor ? textOf(anchor.content).slice(0, 2048) : '__EMPTY__';
  const second = nextFloor ? textOf(nextFloor.content).slice(0, 2048) : '__INIT__';

  return { sysText: stSysText, sys1KB, first, second, floors, systemBlocks, postBlocks };
}

/**
 * N2: primary key: sha256(stSysText.slice(0,1024) + '\0' + (floors[0] ? floors[0].content.slice(0,2048) : '__EMPTY__')).slice(0,16)
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
 * N2: alias key: sha256(stSysText.slice(0,1024) + '\0' + first + '\0' + second).slice(0,16)
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
 * 查询时先查 alias，再查 primary（仅当实际 floors 数 < 2 时才走 primary）；
 * 命中后可把属于本会话的另一个键补进 keys 数组，但不把一个存档的键塞进另一个已存在记录的 keys 里。
 */
function resolveSession(state, messages) {
  const safeState = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
  const { sysText, sys1KB, first, floors } = extractKeyParts(messages);
  const primary = chatKey(messages);
  const alias = aliasKey(messages);
  const initAlias = crypto
    .createHash('sha256')
    .update(sys1KB + '\0' + first + '\0__INIT__', 'utf8')
    .digest('hex')
    .slice(0, 16);

  let hit = findBySingleKey(safeState, alias);
  let hitBy = hit ? 'alias' : null;

  if (!hit && floors.length < 2) {
    hit = findBySingleKey(safeState, primary);
    if (hit) hitBy = 'primary';
  }

  // 若会话首轮仅 1 条 floor（当时仅登记了 primary / initAlias），第 2 轮起推进至 >=2 条 floor 时衔接同一会话
  if (!hit && floors.length >= 2) {
    const pHit = findBySingleKey(safeState, primary);
    if (pHit && pHit.sess) {
      const recKeys = Array.isArray(pHit.sess.keys) ? pHit.sess.keys : [pHit.key];
      const hasCommittedSecond = recKeys.some((k) => k !== primary && k !== initAlias);
      if (!hasCommittedSecond) {
        const hashes = floors.map(layerHash);
        const synced = Array.isArray(pHit.sess.syncedHashes) ? pHit.sess.syncedHashes : [];
        if (synced.length < 2 || (synced[0] === hashes[0] && synced[1] === hashes[1])) {
          hit = pHit;
          hitBy = 'primary';
        }
      }
    }
  }

  // 若原 system 不足 1KB，两轮之间插入世界书使 system 变长，按已同步的前两层 floor 与初始 system 片段兜底匹配同一会话
  if (!hit && floors.length > 0) {
    const hashes = floors.map(layerHash);
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
  if (primaryTaken || floors.length >= 2) {
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

function normalizeFloorsForDrift(input) {
  const list = Array.isArray(input) ? input : [];
  if (list.length === 0) {
    return { floors: [], hashes: [] };
  }
  if (typeof list[0] === 'string') {
    return { floors: [], hashes: list.slice() };
  }
  if (list.every((m) => m && typeof m === 'object' && m._isFloor)) {
    return { floors: list, hashes: list.map(layerHash) };
  }
  const { floors } = splitFloors(list);
  return { floors, hashes: floors.map(layerHash) };
}

/**
 * N3: 四态漂移判定（基于 floors 的哈希数组）：
 * - 全部哈希相等且长度相等 → { kind: 'retry', divIdx }
 * - 前缀一致且 hashes.length > synced.length → { kind: 'advance', divIdx }
 * - divIdx === hashes.length && hashes.length < synced.length（纯回滚）→ { kind: 'deep', divIdx }
 * - 首个不一致 divIdx，深度 synced.length - divIdx：
 *   depth <= MAX_DRIFT_FLOORS && swipeStreak < MAX_SWIPE_STREAK → shallow，否则 deep
 */
function driftOf(sess, messagesOrFloors) {
  if (!sess || typeof sess !== 'object') {
    return { kind: 'deep', divIdx: 0 };
  }
  const synced = Array.isArray(sess.syncedHashes) ? sess.syncedHashes : [];
  if (synced.length === 0) {
    return { kind: 'deep', divIdx: 0 };
  }

  const { floors, hashes } = normalizeFloorsForDrift(messagesOrFloors);
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

  // 预设楼层合并场景：上一轮已合并的所有「（第N楼）」均完整匹配，且本轮在 divIdx 处新增了合并后的「（第N+1楼）」
  if (
    divIdx > 0 &&
    typeof sess.numberedFloorCount === 'number' &&
    sess.numberedFloorCount > 0 &&
    divIdx >= sess.numberedFloorCount &&
    floors.length > divIdx &&
    FLOOR_MARKER_HEAD_RE.test(textOf(floors[divIdx].content))
  ) {
    const currentNumbered = floors.filter((f) => FLOOR_MARKER_HEAD_RE.test(textOf(f.content))).length;
    if (currentNumbered > sess.numberedFloorCount) {
      return { kind: 'advance', divIdx };
    }
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
 * N4 & N7:
 * - [SYSTEM] = ST 的 system 文本 + systemBlocks 全部内容（用 \n\n 连接）
 * - [OPENING] = floors[0..1]
 * - [TIMELINE] 照旧
 * - [POST] = postBlocks（放在最近的对话之前，作为后置指令）
 * - [RECENT] = 从尾部装 floors，单条上限 40KB（保头尾）
 * - N7: 若 floors.length === 0，退回旧行为：把 systemBlocks 当 system、postBlocks 当 user，不要崩
 */
function buildBootstrap({
  system = '',
  messages = [],
  floors: floorsOpt,
  systemBlocks: sysBlocksOpt,
  postBlocks: postBlocksOpt,
  timeline = '',
  budgetBytes = config.PROMPT_BUDGET,
} = {}) {
  const budget = Number(budgetBytes) > 0 ? Number(budgetBytes) : config.PROMPT_BUDGET;
  const list = Array.isArray(messages) ? messages : [];

  let stSysText = typeof system === 'string' ? system : String(system || '');
  if (!stSysText) {
    stSysText = list
      .filter((m) => m && isSystemRole(m.role))
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
  }

  let systemBlocks = [];
  let floors = [];
  let postBlocks = [];

  if (Array.isArray(floorsOpt)) {
    floors = floorsOpt;
    systemBlocks = Array.isArray(sysBlocksOpt) ? sysBlocksOpt : [];
    postBlocks = Array.isArray(postBlocksOpt) ? postBlocksOpt : [];
  } else if (
    list.length > 0 &&
    list.every((m) => m && typeof m === 'object' && m._isFloor) &&
    (Array.isArray(sysBlocksOpt) || Array.isArray(postBlocksOpt))
  ) {
    floors = list;
    systemBlocks = Array.isArray(sysBlocksOpt) ? sysBlocksOpt : [];
    postBlocks = Array.isArray(postBlocksOpt) ? postBlocksOpt : [];
  } else {
    const split = splitFloors(list);
    systemBlocks = Array.isArray(sysBlocksOpt) ? sysBlocksOpt : split.systemBlocks;
    floors = split.floors;
    postBlocks = Array.isArray(postBlocksOpt) ? postBlocksOpt : split.postBlocks;
  }

  // N7: 若 floors.length === 0（例如纯预设块请求），退回旧行为：把 systemBlocks 当 system、postBlocks 当 user
  let activeFloors = floors;
  let activePostBlocks = postBlocks;
  if (activeFloors.length === 0 && activePostBlocks.length > 0) {
    activeFloors = activePostBlocks.map((b) => makeFloor({ role: 'user' }, textOf(b)));
    activePostBlocks = [];
  }

  const sysBlockTexts = systemBlocks.map((b) => textOf(b).trim()).filter(Boolean);
  let sysText = [stSysText.trim(), ...sysBlockTexts].filter(Boolean).join('\n\n');
  if (!sysText.includes('ta_record')) {
    sysText = sysText ? (sysText + DEFAULT_ARCHIVE_INSTRUCTION) : DEFAULT_ARCHIVE_INSTRUCTION.trim();
  }

  const openingMsgs = activeFloors.slice(0, 2);
  const recentCandidates = activeFloors.slice(2);

  const openingBlock = openingMsgs
    .map((m, i) => formatMessage(m, i, RECENT_FLOOR_MAX_BYTES))
    .join('\n\n');
  const timelineText = typeof timeline === 'string' ? timeline : String(timeline || '');
  const postText = activePostBlocks.map((b) => textOf(b).trim()).filter(Boolean).join('\n\n');

  let sysSection = `[SYSTEM]\n${sysText}`;
  let openingSection = `[OPENING]\n${openingBlock}`;
  let timelineSection = `[TIMELINE]\n${timelineText}`;
  let postSection = postText ? `[POST]\n${postText}` : '';
  const recentHeader = '[RECENT]\n';

  const assemblePrefix = () => {
    const sections = [sysSection, openingSection, timelineSection];
    if (postSection) sections.push(postSection);
    return `${sections.join('\n\n')}\n\n${recentHeader}`;
  };

  // 若存在 recentCandidates，确保固定段不会挤占全部预算；若无 recentCandidates（如 N7 兜底），允许固定段填满预算
  const fixedEnvelope = assemblePrefix();
  const fixedBytes = Buffer.byteLength(fixedEnvelope, 'utf8');
  const maxFixedBytes = recentCandidates.length > 0 ? Math.floor(budget * 0.75) : budget;

  if (fixedBytes > maxFixedBytes) {
    const timelineCap = Math.max(0, Math.floor(budget * 0.2));
    if (Buffer.byteLength(timelineText, 'utf8') > timelineCap) {
      timelineSection = `[TIMELINE]\n${tailUtf8(timelineText, timelineCap)}`;
    }
    const openingCap = Math.max(0, Math.floor(budget * 0.15));
    if (Buffer.byteLength(openingBlock, 'utf8') > openingCap) {
      openingSection = `[OPENING]\n${capHeadTailUtf8(openingBlock, openingCap)}`;
    }
    if (postSection) {
      const postCap = Math.max(0, Math.floor(budget * 0.1));
      if (Buffer.byteLength(postText, 'utf8') > postCap) {
        postSection = `[POST]\n${capHeadTailUtf8(postText, postCap)}`;
      }
    }
    const otherFixedBytes = Buffer.byteLength(
      `${[openingSection, timelineSection, ...(postSection ? [postSection] : [])].join('\n\n')}\n\n${recentHeader}\n\n[SYSTEM]\n`,
      'utf8'
    );
    const sysCap = Math.max(0, maxFixedBytes - otherFixedBytes);
    if (Buffer.byteLength(sysText, 'utf8') > sysCap) {
      sysSection = `[SYSTEM]\n${capHeadTailUtf8(sysText, sysCap)}`;
    }
  }

  const prefix = assemblePrefix();
  const prefixBytes = Buffer.byteLength(prefix, 'utf8');

  if (prefixBytes >= budget) {
    return truncateUtf8(prefix, budget);
  }

  let remainingBytes = budget - prefixBytes;
  const selectedRecent = [];
  const sepBytes = Buffer.byteLength('\n\n', 'utf8');

  for (let i = recentCandidates.length - 1; i >= 0; i--) {
    const floorIdx = i + 2;
    const formatted = formatMessage(recentCandidates[i], floorIdx, RECENT_FLOOR_MAX_BYTES);
    const itemBytes = Buffer.byteLength(formatted, 'utf8');
    const needed = selectedRecent.length === 0 ? itemBytes : itemBytes + sepBytes;

    if (needed <= remainingBytes) {
      selectedRecent.unshift(formatted);
      remainingBytes -= needed;
    } else {
      if (selectedRecent.length === 0 && remainingBytes > 0) {
        selectedRecent.unshift(capHeadTailUtf8(formatted, remainingBytes));
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
 * N5: [TIMELINE OVERRIDE] 片段，基于 floors，divIdx 是 floors 的下标
 */
function buildOverride({ divIdx = 0, floors, messages = [] } = {}) {
  let source = [];
  if (Array.isArray(floors)) {
    const isAlreadyFloors = floors.length > 0 && floors.every((m) => m && typeof m === 'object' && m._isFloor);
    if (isAlreadyFloors) {
      source = floors;
    } else {
      const split = splitFloors(floors);
      source = split.floors.length > 0 ? split.floors : floors.filter((m) => m && !isSystemRole(m.role));
    }
  } else {
    const list = Array.isArray(messages) ? messages : [];
    const isAlreadyFloors = list.length > 0 && list.every((m) => m && typeof m === 'object' && m._isFloor);
    if (isAlreadyFloors) {
      source = list;
    } else {
      const split = splitFloors(list);
      source = split.floors.length > 0 ? split.floors : list.filter((m) => m && !isSystemRole(m.role));
    }
  }

  const start = Math.max(0, Number(divIdx) || 0);
  const sliced = source.slice(start);
  const body = sliced.map((m, i) => formatMessage(m, start + i, RECENT_FLOOR_MAX_BYTES)).join('\n\n');

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
  splitFloors,
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
  formatMessage,
  formatRoleLabel,
  FLOOR_MARKER_HEAD_RE,
};
