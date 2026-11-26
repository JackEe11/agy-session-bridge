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

  // 仅当会话中实际存在合并楼层标记（如「（第N楼）」）时，才把无标记的超长消息归类为预设块；
  // 否则普通长消息（>4KB，约 1365 中文字）必须保留为正常楼层，防止被吞掉。
  const hasMergedFloors = list.some((m) => {
    if (!m || typeof m !== 'object' || isSystemRole(m.role)) return false;
    const matches = textOf(m.content).match(FLOOR_MARKER_GLOBAL_RE);
    return Boolean(matches && matches.length >= 2);
  });

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

    if (hasMergedFloors && markerCount === 0 && Buffer.byteLength(raw, 'utf8') >= PRESET_BLOCK_MIN_BYTES) {
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

function getRecordHashLists(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const lists = [];
  if (Array.isArray(rec.branches)) {
    for (const b of rec.branches) {
      if (b && typeof b === 'object') {
        const h = Array.isArray(b.hashes)
          ? b.hashes
          : (Array.isArray(b.syncedHashes) ? b.syncedHashes : []);
        if (h.length > 0) lists.push(h);
      }
    }
  }
  if (Array.isArray(rec.syncedHashes) && rec.syncedHashes.length > 0) {
    lists.push(rec.syncedHashes);
  } else if (Array.isArray(rec.hashes) && rec.hashes.length > 0) {
    lists.push(rec.hashes);
  }
  return lists;
}

function getRecordKeys(key, rec) {
  const set = new Set();
  if (key) set.add(key);
  if (rec && typeof rec === 'object') {
    if (Array.isArray(rec.keys)) {
      for (const k of rec.keys) {
        if (k) set.add(k);
      }
    }
    if (Array.isArray(rec.branches)) {
      for (const b of rec.branches) {
        if (b && Array.isArray(b.keys)) {
          for (const k of b.keys) {
            if (k) set.add(k);
          }
        }
      }
    }
  }
  return Array.from(set);
}

function normalizeBranch(key, b, parentRec, defaultBranchId = 'b1') {
  const raw = (b && typeof b === 'object') ? b : {};
  const branchId = (typeof raw.branchId === 'string' && raw.branchId.trim())
    ? raw.branchId.trim()
    : defaultBranchId;
  const hashes = Array.isArray(raw.hashes)
    ? raw.hashes.slice()
    : (Array.isArray(raw.syncedHashes) ? raw.syncedHashes.slice() : []);
  const parentKeys = (parentRec && Array.isArray(parentRec.keys) && parentRec.keys.length > 0)
    ? parentRec.keys
    : (key ? [key] : []);
  const keys = (Array.isArray(raw.keys) && raw.keys.length > 0)
    ? raw.keys.slice()
    : parentKeys.slice();
  const defaultDir = key
    ? (branchId === 'b1' ? path.join(config.WORKSPACES, key) : path.join(config.WORKSPACES, key, branchId))
    : '';
  const dir = (typeof raw.dir === 'string' && raw.dir.trim())
    ? raw.dir.trim()
    : defaultDir;
  const lastUsedAt = typeof raw.lastUsedAt === 'number'
    ? raw.lastUsedAt
    : (typeof raw.updatedAt === 'number'
      ? raw.updatedAt
      : (parentRec && typeof parentRec.updatedAt === 'number' ? parentRec.updatedAt : 0));

  const out = {
    branchId,
    convId: raw.convId !== undefined ? raw.convId : null,
    hashes,
    turns: typeof raw.turns === 'number' ? raw.turns : 0,
    dir,
    model: (typeof raw.model === 'string' && raw.model.trim()) ? raw.model.trim() : config.DEFAULT_MODEL,
    lastUsedAt,
    swipeStreak: typeof raw.swipeStreak === 'number' ? raw.swipeStreak : 0,
    keys,
  };
  if (typeof raw.numberedFloorCount === 'number') {
    out.numberedFloorCount = raw.numberedFloorCount;
  }
  if (raw.conversationMissing) {
    out.conversationMissing = Boolean(raw.conversationMissing);
  }
  if (raw.hasAppendedReply) {
    out.hasAppendedReply = Boolean(raw.hasAppendedReply);
  }
  return out;
}

function migrateSessionRecord(key, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const keys = getRecordKeys(key, rec);
  const updatedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : 0;

  if (Array.isArray(rec.branches)) {
    let branches = rec.branches
      .filter((b) => b && typeof b === 'object')
      .map((b, idx) => normalizeBranch(key, b, { ...rec, keys }, `b${idx + 1}`));
    if (
      branches.length === 0 &&
      ('convId' in rec || Array.isArray(rec.syncedHashes) || Array.isArray(rec.hashes))
    ) {
      branches = [normalizeBranch(key, { ...rec, branchId: 'b1' }, { ...rec, keys }, 'b1')];
    }
    const lastBranchId = (typeof rec.lastBranchId === 'string' && branches.some((b) => b.branchId === rec.lastBranchId))
      ? rec.lastBranchId
      : (branches[0] ? branches[0].branchId : 'b1');
    const out = {
      branches,
      lastBranchId,
      keys,
      updatedAt,
    };
    if (rec.sysHead) out.sysHead = rec.sysHead;
    return out;
  }

  const hasLegacyData =
    'convId' in rec ||
    Array.isArray(rec.syncedHashes) ||
    Array.isArray(rec.hashes) ||
    typeof rec.turns === 'number' ||
    typeof rec.dir === 'string';

  const branches = hasLegacyData
    ? [normalizeBranch(key, { ...rec, branchId: 'b1' }, { ...rec, keys }, 'b1')]
    : [];

  const out = {
    branches,
    lastBranchId: 'b1',
    keys,
    updatedAt,
  };
  if (rec.sysHead) out.sysHead = rec.sysHead;
  return out;
}

/**
 * 兼容镜像：把「最后使用分支」的关键字段回写到记录顶层。
 * 旧工具 / 旧测试仍可读 rec.convId、rec.turns、rec.syncedHashes。
 */
function applyCompatMirror(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  for (const key of Object.keys(state)) {
    const rec = state[key];
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.branches) || rec.branches.length === 0) continue;
    const last = rec.branches.find((b) => b && b.branchId === rec.lastBranchId) || rec.branches[rec.branches.length - 1];
    if (!last) continue;
    if (last.convId != null) rec.convId = last.convId;
    if (typeof last.turns === 'number') rec.turns = last.turns;
    if (Array.isArray(last.hashes)) rec.syncedHashes = last.hashes.slice();
    if (!rec.dir && last.dir) rec.dir = last.dir;
    if (!rec.model && last.model) rec.model = last.model;
    if (typeof last.swipeStreak === 'number') rec.swipeStreak = last.swipeStreak;
  }
  return state;
}

function migrateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return {};
  const out = {};
  for (const [k, rec] of Object.entries(state)) {
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      out[k] = migrateSessionRecord(k, rec);
    }
  }
  return applyCompatMirror(out);
}

function findBySingleKey(state, targetKey) {
  if (!state || typeof state !== 'object' || !targetKey) return null;
  if (state[targetKey] && typeof state[targetKey] === 'object') {
    return { key: targetKey, sess: state[targetKey] };
  }
  for (const [k, rec] of Object.entries(state)) {
    if (!rec || typeof rec !== 'object') continue;
    if (Array.isArray(rec.keys) && rec.keys.includes(targetKey)) {
      return { key: k, sess: rec };
    }
    if (
      Array.isArray(rec.branches) &&
      rec.branches.some((b) => b && Array.isArray(b.keys) && b.keys.includes(targetKey))
    ) {
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
      const recKeys = getRecordKeys(pHit.key, pHit.sess);
      const hasCommittedSecond = recKeys.some((k) => k !== primary && k !== initAlias);
      if (!hasCommittedSecond) {
        const hashes = floors.map(layerHash);
        const hashLists = getRecordHashLists(pHit.sess);
        if (
          hashLists.length === 0 ||
          hashLists.some((synced) => synced.length < 2 || (synced[0] === hashes[0] && synced[1] === hashes[1]))
        ) {
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
      if (!rec || typeof rec !== 'object') continue;
      const hashLists = getRecordHashLists(rec);
      if (hashLists.length === 0) continue;
      let matched = false;
      for (const synced of hashLists) {
        if (!Array.isArray(synced) || synced.length === 0) continue;
        if (synced[0] !== hashes[0]) continue;
        if (hashes.length >= 2 && synced.length >= 2) {
          if (synced[1] === hashes[1]) {
            hit = { key: k, sess: rec };
            hitBy = 'alias';
            matched = true;
            break;
          }
          continue;
        }
        const sysGrowMatch = hashes.length < 2 && synced.length < 2
          && typeof rec.sysHead === 'string' && rec.sysHead.length > 0 && sysText.includes(rec.sysHead);
        if (sysGrowMatch) {
          hit = { key: k, sess: rec };
          hitBy = 'primary';
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
  }

  if (hit && hit.sess) {
    const migrated = migrateSessionRecord(hit.key, hit.sess);
    hit.sess.branches = migrated.branches;
    hit.sess.lastBranchId = migrated.lastBranchId;
    hit.sess.keys = migrated.keys;
    hit.sess.updatedAt = migrated.updatedAt;
    if (migrated.sysHead) hit.sess.sysHead = migrated.sysHead;

    const pOwner = findBySingleKey(safeState, primary);
    if ((!pOwner || pOwner.sess === hit.sess) && !hit.sess.keys.includes(primary)) {
      hit.sess.keys.push(primary);
    }
    const aOwner = findBySingleKey(safeState, alias);
    if ((!aOwner || aOwner.sess === hit.sess) && !hit.sess.keys.includes(alias)) {
      hit.sess.keys.push(alias);
    }
    if (Array.isArray(hit.sess.branches)) {
      for (const b of hit.sess.branches) {
        if (!b || typeof b !== 'object') continue;
        if (!Array.isArray(b.keys)) b.keys = [];
        for (const k of hit.sess.keys) {
          if (!b.keys.includes(k)) b.keys.push(k);
        }
      }
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
      const migrated = migrateState(parsed);
      memoryStateByFile.set(file, JSON.parse(JSON.stringify(migrated)));
      return JSON.parse(JSON.stringify(migrated));
    }
    return {};
  } catch (err) {
    if (memoryStateByFile.has(file)) {
      const cached = migrateState(memoryStateByFile.get(file));
      return JSON.parse(JSON.stringify(cached));
    }
    try {
      if (fs.existsSync(file)) {
        const bak = `${file}.corrupt.${Date.now()}`;
        fs.copyFileSync(file, bak);
      }
    } catch {}
  }
  return {};
}

function saveState(state) {
  const file = config.STATE_FILE;
  const safeState = (state && typeof state === 'object' && !Array.isArray(state))
    ? migrateState(state)
    : {};

  /* 兼容镜像：顶层保留最后使用分支的关键字段。
     外部工具 / 旧版审计脚本仍可读 rec.convId、rec.turns、rec.syncedHashes；
     migrateSessionRecord 优先识别 branches，因此镜像字段不会被重复迁移。 */
  for (const key of Object.keys(safeState)) {
    const rec = safeState[key];
    if (!rec || typeof rec !== 'object' || !Array.isArray(rec.branches) || rec.branches.length === 0) continue;
    const last = rec.branches.find((b) => b && b.branchId === rec.lastBranchId) || rec.branches[rec.branches.length - 1];
    if (!last) continue;
    rec.convId = last.convId != null ? last.convId : rec.convId;
    rec.turns = typeof last.turns === 'number' ? last.turns : rec.turns;
    rec.syncedHashes = Array.isArray(last.hashes) ? last.hashes.slice() : (rec.syncedHashes || []);
    if (!rec.dir && last.dir) rec.dir = last.dir;
    if (!rec.model && last.model) rec.model = last.model;
    if (typeof last.swipeStreak === 'number') rec.swipeStreak = last.swipeStreak;
  }
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

function calcLcp(a, b) {
  const arrA = Array.isArray(a) ? a : [];
  const arrB = Array.isArray(b) ? b : [];
  const minLen = Math.min(arrA.length, arrB.length);
  let i = 0;
  while (i < minLen && arrA[i] === arrB[i]) {
    i++;
  }
  return i;
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
  let target = sess;
  if (
    !Array.isArray(sess.hashes) &&
    !Array.isArray(sess.syncedHashes) &&
    Array.isArray(sess.branches) &&
    sess.branches.length > 0
  ) {
    target = sess.branches.find((b) => b && b.branchId === sess.lastBranchId) || sess.branches[0];
  }
  const synced = Array.isArray(target.hashes)
    ? target.hashes
    : (Array.isArray(target.syncedHashes) ? target.syncedHashes : []);
  if (synced.length === 0) {
    return { kind: 'deep', divIdx: 0 };
  }

  const { floors, hashes } = normalizeFloorsForDrift(messagesOrFloors);
  if (hashes.length === 0) {
    return { kind: 'deep', divIdx: 0 };
  }

  const divIdx = calcLcp(synced, hashes);

  if (('convId' in target && !target.convId) || target.conversationMissing) {
    return { kind: 'deep', divIdx };
  }
  if (typeof target.turns === 'number' && target.turns >= config.MAX_TURNS_PER_SESSION) {
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
    floors.length > divIdx &&
    FLOOR_MARKER_HEAD_RE.test(textOf(floors[divIdx].content))
  ) {
    const currentNumbered = floors.filter((f) => FLOOR_MARKER_HEAD_RE.test(textOf(f.content))).length;
    const prevNumbered = (typeof target.numberedFloorCount === 'number' && target.numberedFloorCount > 0)
      ? target.numberedFloorCount
      : (FLOOR_MARKER_HEAD_RE.test(textOf(floors[0].content)) && (synced.length - divIdx <= 2) ? divIdx : 0);
    if (prevNumbered > 0 && divIdx >= prevNumbered && currentNumbered > prevNumbered) {
      return { kind: 'advance', divIdx };
    }
  }

  if (target.hasAppendedReply && divIdx === hashes.length && synced.length === hashes.length + 1) {
    return { kind: 'retry', divIdx };
  }

  if (divIdx === hashes.length && hashes.length < synced.length) {
    return { kind: 'deep', divIdx };
  }

  const depth = synced.length - divIdx;
  const swipeStreak = typeof target.swipeStreak === 'number' ? target.swipeStreak : 0;
  if (depth <= config.MAX_DRIFT_FLOORS && swipeStreak < config.MAX_SWIPE_STREAK) {
    return { kind: 'shallow', divIdx };
  }

  return { kind: 'deep', divIdx };
}

function copyTimelineBeforeLcp(parentDir, newDir, lcp) {
  if (!newDir) return false;
  try {
    fs.mkdirSync(newDir, { recursive: true });
    if (!parentDir) return false;
    const srcPath = path.join(parentDir, 'timeline.md');
    if (!fs.existsSync(srcPath)) return false;
    const raw = fs.readFileSync(srcPath, 'utf8');
    const re = /<!--\s*floor:\s*(\d+)\s*-->/g;
    const matches = [];
    let m;
    while ((m = re.exec(raw)) !== null) {
      matches.push({
        floor: Number(m[1]),
        start: m.index,
        bodyStart: m.index + m[0].length,
      });
    }
    const maxFloor = Number(lcp) || 0;
    const kept = [];
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const nextStart = i + 1 < matches.length ? matches[i + 1].start : raw.length;
      const body = raw.slice(cur.bodyStart, nextStart).trim();
      if (cur.floor < maxFloor) {
        kept.push(`<!-- floor: ${cur.floor} -->\n${body}`);
      }
    }
    const out = kept.length > 0 ? kept.join('\n\n') + '\n' : '';
    const dstPath = path.join(newDir, 'timeline.md');
    const tmpPath = `${dstPath}.tmp.${process.pid}.${++seq}`;
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, dstPath);
    return true;
  } catch {
    return false;
  }
}

const MAX_BRANCHES_PER_CHAT = 4;

/**
 * 分支选择算法（多分支桶 + LCP 选择）：
 * 1. 算 incomingHashes（按 splitFloors 的 floors 哈希）。
 * 2. 对每个 branch 算 lcp = 公共前缀长度，并用 driftOf 判断 kind。
 * 3. 优先选 kind 为 advance / retry 或 shallow 且 lcp 最大的分支（branchAction = 'reuse'）。
 * 4. 若无分支（首次会话）→ 新建 b1（branchAction = 'new'）；
 *    若所有已有分支都是 deep → 取 lcp 最大的作为父分支，新建 b(max+1)，dir = <WORKSPACES>/<chatKey>/<branchId>，
 *    复制父分支 timeline.md 中 floor < lcp 的条目到新分支目录，超过 4 个分支时淘汰 lastUsedAt 最旧的分支（branchAction = 'fork'）。
 * 5. 更新选中分支的 lastUsedAt 及记录的 lastBranchId。
 */
function selectBranch(sessRecord, messagesOrFloors, opts = {}) {
  const key = (typeof opts.chatKey === 'string' && opts.chatKey) ? opts.chatKey : '';
  const workspacesDir = opts.workspacesDir || config.WORKSPACES;
  const model = (typeof opts.model === 'string' && opts.model.trim()) ? opts.model.trim() : config.DEFAULT_MODEL;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const isHealthy = typeof opts.isHealthy === 'function' ? opts.isHealthy : null;
  const { floors, hashes: incomingHashes } = normalizeFloorsForDrift(messagesOrFloors);

  const migrated = (sessRecord && typeof sessRecord === 'object')
    ? migrateSessionRecord(key, sessRecord)
    : null;
  const defaultKeys = Array.isArray(opts.keys) && opts.keys.length > 0
    ? opts.keys.slice()
    : ((migrated && Array.isArray(migrated.keys) && migrated.keys.length > 0)
      ? migrated.keys.slice()
      : (key ? [key] : []));

  const existingBranches = (migrated && Array.isArray(migrated.branches))
    ? migrated.branches.filter((b) => b && ((Array.isArray(b.hashes) && b.hashes.length > 0) || b.convId))
    : [];

  if (existingBranches.length === 0) {
    const b1Dir = key ? path.join(workspacesDir, key) : '';
    const b1 = {
      branchId: 'b1',
      convId: null,
      hashes: [],
      turns: 0,
      dir: b1Dir,
      model,
      lastUsedAt: now,
      swipeStreak: 0,
      keys: defaultKeys.slice(),
    };
    const branches = [b1];
    if (sessRecord && typeof sessRecord === 'object') {
      sessRecord.branches = branches;
      sessRecord.lastBranchId = 'b1';
    }
    return {
      branch: b1,
      branches,
      branchId: 'b1',
      branchCount: 1,
      lcp: 0,
      branchAction: 'new',
      drift: { kind: 'deep', divIdx: 0 },
      parentBranch: null,
    };
  }

  const evaluated = existingBranches.map((b) => {
    const branchHashes = Array.isArray(b.hashes)
      ? b.hashes
      : (Array.isArray(b.syncedHashes) ? b.syncedHashes : []);
    const lcp = calcLcp(branchHashes, incomingHashes);
    const healthy = !isHealthy || !b.convId || isHealthy(b.convId);
    const bForDrift = {
      ...b,
      hashes: branchHashes,
      syncedHashes: branchHashes,
      convId: healthy ? b.convId : null,
    };
    const drift = driftOf(bForDrift, floors.length > 0 ? floors : incomingHashes);
    return { branch: b, lcp, drift };
  });

  const reusable = evaluated.filter(
    (e) => e.drift.kind === 'advance' || e.drift.kind === 'shallow' || e.drift.kind === 'retry'
  );

  if (reusable.length > 0) {
    reusable.sort((a, b) => {
      if (b.lcp !== a.lcp) return b.lcp - a.lcp;
      const aShallow = a.drift.kind === 'shallow' ? 1 : 0;
      const bShallow = b.drift.kind === 'shallow' ? 1 : 0;
      if (aShallow !== bShallow) return aShallow - bShallow;
      return (b.branch.lastUsedAt || 0) - (a.branch.lastUsedAt || 0);
    });
    const winner = reusable[0];
    winner.branch.lastUsedAt = now;
    if (sessRecord && typeof sessRecord === 'object') {
      sessRecord.branches = existingBranches;
      sessRecord.lastBranchId = winner.branch.branchId;
    }
    return {
      branch: winner.branch,
      branches: existingBranches,
      branchId: winner.branch.branchId,
      branchCount: existingBranches.length,
      lcp: winner.lcp,
      branchAction: 'reuse',
      drift: winner.drift,
      parentBranch: null,
    };
  }

  // 所有分支都是 deep：选 lcp 最大的作为父分支，新建 b(max+1)
  const byLcp = evaluated.slice().sort((a, b) => {
    if (b.lcp !== a.lcp) return b.lcp - a.lcp;
    return (b.branch.lastUsedAt || 0) - (a.branch.lastUsedAt || 0);
  });
  const parent = byLcp[0];

  let maxNum = 0;
  for (const b of existingBranches) {
    const m = /^b(\d+)$/i.exec(String((b && b.branchId) || ''));
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
  }
  const newBranchId = `b${maxNum + 1}`;
  const newDir = key ? path.join(workspacesDir, key, newBranchId) : '';

  copyTimelineBeforeLcp(parent.branch.dir, newDir, parent.lcp);

  const newBranch = {
    branchId: newBranchId,
    convId: null,
    hashes: [],
    turns: 0,
    dir: newDir,
    model,
    lastUsedAt: now,
    swipeStreak: 0,
    keys: defaultKeys.slice(),
  };

  const nextBranches = [...existingBranches, newBranch];
  while (nextBranches.length > MAX_BRANCHES_PER_CHAT) {
    let oldestIdx = -1;
    let oldestTime = Infinity;
    for (let i = 0; i < nextBranches.length; i++) {
      if (nextBranches[i].branchId === newBranchId) continue;
      const t = typeof nextBranches[i].lastUsedAt === 'number' ? nextBranches[i].lastUsedAt : 0;
      if (t < oldestTime) {
        oldestTime = t;
        oldestIdx = i;
      }
    }
    if (oldestIdx >= 0) {
      nextBranches.splice(oldestIdx, 1);
    } else {
      break;
    }
  }

  if (sessRecord && typeof sessRecord === 'object') {
    sessRecord.branches = nextBranches;
    sessRecord.lastBranchId = newBranchId;
  }

  return {
    branch: newBranch,
    branches: nextBranches,
    branchId: newBranchId,
    branchCount: nextBranches.length,
    lcp: parent.lcp,
    branchAction: 'fork',
    drift: { kind: 'deep', divIdx: parent.lcp },
    parentBranch: parent.branch,
  };
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
function isStrictSystem() {
  return Boolean(config.STRICT_SYSTEM || config.AGY_STRICT_SYSTEM || process.env.AGY_STRICT_SYSTEM === '1');
}

/**
 * 严格模式预算检查：[SYSTEM]+[STATE] 超过预算 60% 时抛出 system_budget_exceeded。
 * 非严格模式直接返回。
 */
function checkStrictSystemBudget({ system = '', systemBlocks = [], state = '', budgetBytes } = {}) {
  if (!isStrictSystem()) return true;
  const budget = Number(budgetBytes) > 0 ? Number(budgetBytes) : config.PROMPT_BUDGET;
  const blocks = (Array.isArray(systemBlocks) ? systemBlocks : []).map((b) => textOf(b)).filter(Boolean).join('\n\n');
  const head = [String(system || ''), blocks].filter(Boolean).join('\n\n');
  const bytes = Buffer.byteLength(head + '\n\n' + String(state || ''), 'utf8');
  const cap = Math.floor(budget * 0.6);
  if (bytes > cap) {
    throw new Error('system_budget_exceeded: [SYSTEM]+[STATE] ' + bytes + 'B > ' + cap + 'B');
  }
  return true;
}

function buildBootstrap({
  system = '',
  messages = [],
  floors: floorsOpt,
  systemBlocks: sysBlocksOpt,
  postBlocks: postBlocksOpt,
  timeline = '',
  state = '',
  chapters = '',
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

  if (config.NON_CODING_FRAME && !sysText.startsWith(config.NON_CODING_FRAME)) {
    sysText = config.NON_CODING_FRAME + '\n' + sysText;
  }

  const openingMsgs = activeFloors.slice(0, 2);
  const recentCandidates = activeFloors.slice(2);

  const openingBlock = openingMsgs
    .map((m, i) => formatMessage(m, i, RECENT_FLOOR_MAX_BYTES))
    .join('\n\n');
  const timelineText = typeof timeline === 'string' ? timeline : String(timeline || '');
  const postText = activePostBlocks.map((b) => textOf(b).trim()).filter(Boolean).join('\n\n');

  const stateText = typeof state === 'string' ? state : String(state || '');
  const chaptersText = typeof chapters === 'string' ? chapters : String(chapters || '');

  let sysSection = `[SYSTEM]\n${sysText}`;
  let openingSection = `[OPENING]\n${openingBlock}`;
  let stateSection = stateText.trim() ? `[STATE]\n${stateText.trim()}` : '';
  let chaptersSection = chaptersText.trim() ? `[CHAPTERS]\n${chaptersText.trim()}` : '';
  let timelineSection = `[TIMELINE]\n${timelineText}`;

  /* 严格模式：[SYSTEM]+[STATE] 超过预算 60% 直接失败，绝不静默砍系统提示 */
  if (isStrictSystem()) {
    const headBytes = Buffer.byteLength(`${sysSection}\n\n${stateSection}`, 'utf8');
    if (headBytes > Math.floor(budget * 0.6)) {
      throw new Error('system_budget_exceeded: [SYSTEM]+[STATE] ' + headBytes + 'B > ' + Math.floor(budget * 0.6) + 'B');
    }
  }
  let postSection = postText ? `[POST]\n${postText}` : '';
  const recentHeader = '[RECENT]\n';

  const assemblePrefix = () => {
    const sections = [sysSection, openingSection];
    if (stateSection) sections.push(stateSection);
    if (chaptersSection) sections.push(chaptersSection);
    sections.push(timelineSection);
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
  checkStrictSystemBudget,
  isStrictSystem,
  splitFloors,
  chatKey,
  aliasKey,
  chatKeys,
  resolveSession,
  loadState,
  saveState,
  driftOf,
  selectBranch,
  migrateSessionRecord,
  migrateState,
  copyTimelineBeforeLcp,
  calcLcp,
  buildBootstrap,
  buildOverride,
  layerHash,
  formatMessage,
  formatRoleLabel,
  FLOOR_MARKER_HEAD_RE,
};
