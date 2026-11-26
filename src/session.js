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
const FLOOR_NO_HEAD_RE = /^(?:（第\s*(\d+)\s*楼）|【第\s*(\d+)\s*楼】|\(第\s*(\d+)\s*楼\))/;
const FLOOR_NO_ANY_RE = /(?:（第\s*(\d+)\s*楼）|【第\s*(\d+)\s*楼】|\(第\s*(\d+)\s*楼\))/;
const PRESET_BLOCK_MIN_BYTES = 4096;
const RECENT_FLOOR_MAX_BYTES = Number(process.env.AGY_RECENT_FLOOR_MAX_BYTES) > 0
  ? Number(process.env.AGY_RECENT_FLOOR_MAX_BYTES)
  : 400000;
/* 酒馆注入的合成提示（不是用户真的说的话，也不能当楼层） */
const NUDGE_MESSAGE_RE = /^\[(?:start a new chat|start a new group chat|example chat|new chat|continue|impersonate|regenerate)\]$/i;

function parseFloorNo(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  const m = FLOOR_NO_HEAD_RE.exec(trimmed) || FLOOR_NO_ANY_RE.exec(trimmed);
  if (!m) return null;
  const rawNum = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
  const n = Number(rawNum);
  return Number.isFinite(n) ? n : null;
}

function lastFloorNo(floors) {
  if (!Array.isArray(floors) || floors.length === 0) return 0;
  const last = floors[floors.length - 1];
  if (last && typeof last.floorNo === 'number' && Number.isFinite(last.floorNo)) {
    return last.floorNo;
  }
  const parsed = last ? parseFloorNo(textOf(last.content)) : null;
  if (parsed !== null) return parsed;
  return floors.length;
}

function divFloorNo(floors, divIdx) {
  const idx = Number(divIdx) || 0;
  if (idx <= 0) return 0;
  if (!Array.isArray(floors) || floors.length === 0) return idx;
  if (idx <= floors.length) {
    const prev = floors[idx - 1];
    if (prev && typeof prev.floorNo === 'number' && Number.isFinite(prev.floorNo)) {
      return prev.floorNo;
    }
    const parsed = prev ? parseFloorNo(textOf(prev.content)) : null;
    if (parsed !== null) return parsed;
  } else {
    const last = floors[floors.length - 1];
    if (last && typeof last.floorNo === 'number' && Number.isFinite(last.floorNo)) {
      return last.floorNo + (idx - floors.length);
    }
  }
  return idx;
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

const OVERSIZED_TEXT_SPLIT_BYTES = 155000;

/**
 * F2: 单条超大文本软切分
 * - 按最近的 \n\n 切；没有就按 \n；再没有就按句号；最后才按字节硬切（保 UTF-8 边界）。
 */
function splitOversizedText(text, maxBytes = OVERSIZED_TEXT_SPLIT_BYTES) {
  const s = typeof text === 'string' ? text : String(text || '');
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : OVERSIZED_TEXT_SPLIT_BYTES;
  if (!s || Buffer.byteLength(s, 'utf8') <= limit) {
    return [s];
  }
  const pieces = [];
  let remaining = s;
  while (Buffer.byteLength(remaining, 'utf8') > limit) {
    const candidate = truncateUtf8(remaining, limit);
    if (!candidate) break;
    const minCut = Math.min(200, Math.max(1, Math.floor(candidate.length * 0.1)));
    let cutLen = -1;
    let skipLen = 0;

    const idxPara = candidate.lastIndexOf('\n\n');
    if (idxPara >= minCut) {
      cutLen = idxPara;
      skipLen = 2;
    } else {
      const idxLine = candidate.lastIndexOf('\n');
      if (idxLine >= minCut) {
        cutLen = idxLine;
        skipLen = 1;
      } else {
        const idxCnPeriod = candidate.lastIndexOf('。');
        const idxEnPeriod = candidate.lastIndexOf('.');
        const idxPeriod = idxCnPeriod >= minCut ? idxCnPeriod : (idxEnPeriod >= minCut ? idxEnPeriod : -1);
        if (idxPeriod >= minCut) {
          cutLen = idxPeriod + 1;
          skipLen = 0;
        }
      }
    }

    if (cutLen > 0) {
      const part = candidate.slice(0, cutLen).trim();
      if (part) pieces.push(part);
      remaining = remaining.slice(cutLen + skipLen).replace(/^\n+/, '');
    } else {
      pieces.push(candidate);
      remaining = remaining.slice(candidate.length);
    }
  }
  if (remaining.length > 0) {
    pieces.push(remaining);
  }
  return pieces.length > 0 ? pieces : [s];
}

/**
 * F4: 计算本轮 postBlocks 与上一轮 lastPostText 的行级差分
 * - 新增或修改的行（<= 4KB 全带；> 4KB 截断到 4KB 并标注）拼成 [本轮动态设定更新]\n<diff>
 * - 静态规则行不重复注入；无 postBlocks 或 diff 为空返回 ''
 */
function computePostBlocksDiff(lastPostText, currentPostText, maxBytes = 4096) {
  const curr = typeof currentPostText === 'string' ? currentPostText.trim() : '';
  if (!curr) return '';
  const prev = typeof lastPostText === 'string' ? lastPostText : '';
  const prevSet = new Set(
    prev
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  );
  const changedLines = [];
  for (const rawLine of curr.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (!prevSet.has(trimmed)) {
      changedLines.push(rawLine);
    }
  }
  if (changedLines.length === 0) return '';
  let diff = changedLines.join('\n');
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : 4096;
  if (Buffer.byteLength(diff, 'utf8') > limit) {
    const note = '\n……（超出 4KB 已截断）';
    const avail = Math.max(64, limit - Buffer.byteLength(note, 'utf8'));
    diff = truncateUtf8(diff, avail) + note;
  }
  return `[本轮动态设定更新]\n${diff}`;
}

/**
 * N1: 拆分预设块与合并楼层
 * 返回 { systemBlocks, floors, postBlocks }
 * - 每个 floor 提取 （第N楼）/【第N楼】/(第N楼) 存入 floor.floorNo；末尾无编号消息按 上一个 floorNo + 1 递增。
 * - 在带编号楼层之后遇到「无编号且 ≥4KB」的 user 块，一律抽进 postBlocks（即使后面还有 <4KB 的用户输入）。
 * - F2: 单条 >155KB 的楼层文本自动通过 splitOversizedText 软切分为多个伪楼层（（第N楼续））。
 */
function splitFloors(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const systemBlocks = [];
  const floors = [];
  const postBlocks = [];

  // 仅当会话中实际存在楼层标记（如「（第N楼）」/「【第N楼】」/「(第N楼)」）时，才把无标记的超长消息归类为预设块；
  // 否则普通长消息（>4KB，约 1365 中文字）必须保留为正常楼层，防止被吞掉。
  const hasMergedFloors = list.some((m) => {
    if (!m || typeof m !== 'object' || isSystemRole(m.role)) return false;
    const text = textOf(m.content).trim();
    if (FLOOR_MARKER_HEAD_RE.test(text)) return true;
    const matches = text.match(FLOOR_MARKER_GLOBAL_RE);
    return Boolean(matches && matches.length >= 2);
  });

  let seenNumberedFloor = false;

  function appendFloorOrSplit(msg, part) {
    if (Buffer.byteLength(part, 'utf8') <= OVERSIZED_TEXT_SPLIT_BYTES) {
      floors.push(makeFloor(msg, part));
      return;
    }
    const pieces = splitOversizedText(part, OVERSIZED_TEXT_SPLIT_BYTES);
    if (pieces.length <= 1) {
      floors.push(makeFloor(msg, part));
      return;
    }
    const explicitNo = parseFloorNo(part);
    const lastKnownNo = floors.length > 0
      ? (parseFloorNo(floors[floors.length - 1].content) || floors.length)
      : 0;
    const baseNo = explicitNo !== null ? explicitNo : (lastKnownNo + 1);
    floors.push(makeFloor(msg, pieces[0]));
    for (let j = 1; j < pieces.length; j++) {
      const pieceText = /^（第\s*\d+\s*楼/.test(pieces[j])
        ? pieces[j]
        : `（第${baseNo}楼续）${pieces[j]}`;
      const pseudo = makeFloor(msg, pieceText);
      Object.defineProperty(pseudo, '_isPseudoFloor', {
        value: true,
        enumerable: false,
        configurable: true,
      });
      floors.push(pseudo);
    }
  }

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
        for (const part of parts) {
          if (parseFloorNo(part) !== null) {
            seenNumberedFloor = true;
          }
          appendFloorOrSplit(m, part);
        }
      }
      continue;
    }

    if (markerCount === 1 && FLOOR_MARKER_HEAD_RE.test(trimmed)) {
      seenNumberedFloor = true;
      appendFloorOrSplit(m, trimmed);
      continue;
    }

    const rawBytes = Buffer.byteLength(raw, 'utf8');

    if (
      seenNumberedFloor &&
      (m.role === 'user' || !m.role) &&
      markerCount === 0 &&
      rawBytes >= PRESET_BLOCK_MIN_BYTES &&
      rawBytes <= OVERSIZED_TEXT_SPLIT_BYTES
    ) {
      postBlocks.push(trimmed);
      continue;
    }

    if (
      hasMergedFloors &&
      markerCount === 0 &&
      rawBytes >= PRESET_BLOCK_MIN_BYTES &&
      rawBytes <= OVERSIZED_TEXT_SPLIT_BYTES
    ) {
      if (floors.length === 0) {
        systemBlocks.push(trimmed);
      } else {
        postBlocks.push(trimmed);
      }
      continue;
    }

    if (FLOOR_MARKER_HEAD_RE.test(trimmed)) {
      seenNumberedFloor = true;
    }
    appendFloorOrSplit(m, trimmed);
  }

  let prevFloorNo = 0;
  for (const f of floors) {
    const explicitNo = parseFloorNo(f.content);
    if (explicitNo !== null) {
      f.floorNo = explicitNo;
      prevFloorNo = explicitNo;
    } else {
      f.floorNo = prevFloorNo + 1;
      prevFloorNo = f.floorNo;
    }
  }

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

function normalizeAccountState(raw, parentRec, isTargetBranch = true) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const p = (parentRec && typeof parentRec === 'object') ? parentRec : null;

  let activeAccount = 'main';
  if (isTargetBranch && p && typeof p.activeAccount === 'string' && p.activeAccount.trim()) {
    activeAccount = p.activeAccount.trim();
  } else if (typeof r.activeAccount === 'string' && r.activeAccount.trim()) {
    activeAccount = r.activeAccount.trim();
  } else if (p && typeof p.activeAccount === 'string' && p.activeAccount.trim()) {
    activeAccount = p.activeAccount.trim();
  }

  const rHasAccounts = Boolean(r.accounts && typeof r.accounts === 'object' && !Array.isArray(r.accounts) && Object.keys(r.accounts).length > 0);
  const pHasAccounts = Boolean(p && p.accounts && typeof p.accounts === 'object' && !Array.isArray(p.accounts) && Object.keys(p.accounts).length > 0);
  const accounts = {};

  if (pHasAccounts) {
    for (const [k, v] of Object.entries(p.accounts)) {
      if (v && typeof v === 'object') {
        accounts[k] = { convId: v.convId || null };
      } else if (typeof v === 'string') {
        accounts[k] = { convId: v };
      }
    }
  }
  if (rHasAccounts) {
    for (const [k, v] of Object.entries(r.accounts)) {
      if (v && typeof v === 'object') {
        if (!accounts[k] || v.convId != null || !isTargetBranch) {
          accounts[k] = { convId: v.convId || null };
        }
      } else if (typeof v === 'string') {
        accounts[k] = { convId: v };
      }
    }
  }

  if (!rHasAccounts && !pHasAccounts) {
    const legacyConvId = r.convId !== undefined ? r.convId : (p && p.convId !== undefined ? p.convId : null);
    accounts.main = { convId: legacyConvId || null };
  } else if (!accounts.main) {
    const legacyMain = (!rHasAccounts && r.convId && activeAccount === 'main') ? r.convId : null;
    accounts.main = { convId: legacyMain || null };
  }

  const convId = (accounts[activeAccount] && accounts[activeAccount].convId)
    ? accounts[activeAccount].convId
    : null;

  let accountCooldown = null;
  if ((p && p.accountCooldown && typeof p.accountCooldown === 'object') || (r.accountCooldown && typeof r.accountCooldown === 'object')) {
    accountCooldown = {
      ...(p && p.accountCooldown && typeof p.accountCooldown === 'object' ? p.accountCooldown : {}),
      ...(r.accountCooldown && typeof r.accountCooldown === 'object' ? r.accountCooldown : {}),
    };
  }

  return { activeAccount, accounts, convId, accountCooldown };
}

function normalizeBranch(key, b, parentRec, defaultBranchId = 'b1', isTargetBranch = true) {
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

  const { activeAccount, accounts, convId, accountCooldown } = normalizeAccountState(raw, parentRec, isTargetBranch);

  const out = {
    branchId,
    activeAccount,
    accounts,
    convId,
    hashes,
    turns: typeof raw.turns === 'number' ? raw.turns : 0,
    dir,
    model: (typeof raw.model === 'string' && raw.model.trim()) ? raw.model.trim() : config.DEFAULT_MODEL,
    lastUsedAt,
    swipeStreak: typeof raw.swipeStreak === 'number' ? raw.swipeStreak : 0,
    stateDirty: Boolean(raw.stateDirty || (isTargetBranch && parentRec && parentRec.stateDirty)),
    missingRecordStreak: typeof raw.missingRecordStreak === 'number'
      ? Math.max(
          raw.missingRecordStreak,
          (isTargetBranch && parentRec && typeof parentRec.missingRecordStreak === 'number') ? parentRec.missingRecordStreak : 0
        )
      : ((isTargetBranch && parentRec && typeof parentRec.missingRecordStreak === 'number') ? parentRec.missingRecordStreak : 0),
    keys,
  };
  if (accountCooldown && Object.keys(accountCooldown).length > 0) {
    out.accountCooldown = accountCooldown;
  }
  if (typeof raw.numberedFloorCount === 'number') {
    out.numberedFloorCount = raw.numberedFloorCount;
  }
  if (raw.conversationMissing) {
    out.conversationMissing = Boolean(raw.conversationMissing);
  }
  if (raw.hasAppendedReply) {
    out.hasAppendedReply = Boolean(raw.hasAppendedReply);
  }
  if (typeof raw.lastPostText === 'string') {
    out.lastPostText = raw.lastPostText;
  } else if (isTargetBranch && parentRec && typeof parentRec.lastPostText === 'string') {
    out.lastPostText = parentRec.lastPostText;
  }
  return out;
}

function migrateSessionRecord(key, rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec;
  const keys = getRecordKeys(key, rec);
  const updatedAt = typeof rec.updatedAt === 'number' ? rec.updatedAt : 0;

  if (Array.isArray(rec.branches)) {
    const rawBranches = rec.branches.filter((b) => b && typeof b === 'object');
    const targetBranchId = (typeof rec.lastBranchId === 'string' && rawBranches.some((b) => b.branchId === rec.lastBranchId))
      ? rec.lastBranchId
      : (rawBranches[0] && rawBranches[0].branchId ? rawBranches[0].branchId : 'b1');
    let branches = rawBranches
      .map((b, idx) => {
        const bid = (typeof b.branchId === 'string' && b.branchId.trim()) ? b.branchId.trim() : `b${idx + 1}`;
        return normalizeBranch(key, b, { ...rec, keys }, bid, bid === targetBranchId);
      });
    if (
      branches.length === 0 &&
      ('convId' in rec || 'accounts' in rec || 'activeAccount' in rec || Array.isArray(rec.syncedHashes) || Array.isArray(rec.hashes))
    ) {
      branches = [normalizeBranch(key, { ...rec, branchId: 'b1' }, { ...rec, keys }, 'b1', true)];
    }
    const lastBranchId = (typeof rec.lastBranchId === 'string' && branches.some((b) => b.branchId === rec.lastBranchId))
      ? rec.lastBranchId
      : (branches[0] ? branches[0].branchId : 'b1');
    const activeBranch = branches.find((b) => b.branchId === lastBranchId) || branches[0];
    const topAccState = activeBranch
      ? {
          activeAccount: activeBranch.activeAccount,
          accounts: JSON.parse(JSON.stringify(activeBranch.accounts)),
          convId: activeBranch.convId,
          accountCooldown: activeBranch.accountCooldown,
        }
      : normalizeAccountState(rec, null, true);
    const out = {
      activeAccount: topAccState.activeAccount,
      accounts: topAccState.accounts,
      convId: topAccState.convId,
      branches,
      lastBranchId,
      keys,
      updatedAt,
    };
    if (topAccState.accountCooldown && Object.keys(topAccState.accountCooldown).length > 0) {
      out.accountCooldown = topAccState.accountCooldown;
    }
    if (rec.sysHead) out.sysHead = rec.sysHead;
    return out;
  }

  const hasLegacyData =
    'convId' in rec ||
    'accounts' in rec ||
    'activeAccount' in rec ||
    Array.isArray(rec.syncedHashes) ||
    Array.isArray(rec.hashes) ||
    typeof rec.turns === 'number' ||
    typeof rec.dir === 'string';

  const branches = hasLegacyData
    ? [normalizeBranch(key, { ...rec, branchId: 'b1' }, { ...rec, keys }, 'b1', true)]
    : [];
  const activeBranch = branches[0];
  const topAccState = activeBranch
    ? {
        activeAccount: activeBranch.activeAccount,
        accounts: JSON.parse(JSON.stringify(activeBranch.accounts)),
        convId: activeBranch.convId,
        accountCooldown: activeBranch.accountCooldown,
      }
    : normalizeAccountState(rec, null, true);

  const out = {
    activeAccount: topAccState.activeAccount,
    accounts: topAccState.accounts,
    convId: topAccState.convId,
    branches,
    lastBranchId: 'b1',
    keys,
    updatedAt,
  };
  if (topAccState.accountCooldown && Object.keys(topAccState.accountCooldown).length > 0) {
    out.accountCooldown = topAccState.accountCooldown;
  }
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
    if (!rec || typeof rec !== 'object') continue;
    if (!Array.isArray(rec.branches) || rec.branches.length === 0) {
      const accState = normalizeAccountState(rec, null, true);
      rec.activeAccount = accState.activeAccount;
      rec.accounts = accState.accounts;
      rec.convId = accState.convId;
      if (accState.accountCooldown && Object.keys(accState.accountCooldown).length > 0) {
        rec.accountCooldown = accState.accountCooldown;
      }
      continue;
    }
    const last = rec.branches.find((b) => b && b.branchId === rec.lastBranchId) || rec.branches[rec.branches.length - 1];
    if (!last) continue;
    const accState = normalizeAccountState(last, rec, true);
    last.activeAccount = accState.activeAccount;
    last.accounts = accState.accounts;
    last.convId = accState.convId;
    rec.activeAccount = accState.activeAccount;
    rec.accounts = JSON.parse(JSON.stringify(accState.accounts));
    rec.convId = accState.convId;
    if (accState.accountCooldown && Object.keys(accState.accountCooldown).length > 0) {
      last.accountCooldown = accState.accountCooldown;
      rec.accountCooldown = { ...accState.accountCooldown };
    }
    if (typeof last.turns === 'number') rec.turns = last.turns;
    if (Array.isArray(last.hashes)) rec.syncedHashes = last.hashes.slice();
    if (!rec.dir && last.dir) rec.dir = last.dir;
    if (!rec.model && last.model) rec.model = last.model;
    if (typeof last.swipeStreak === 'number') rec.swipeStreak = last.swipeStreak;
    if (typeof last.stateDirty === 'boolean') rec.stateDirty = last.stateDirty;
    if (typeof last.missingRecordStreak === 'number') rec.missingRecordStreak = last.missingRecordStreak;
    if (typeof last.lastPostText === 'string') rec.lastPostText = last.lastPostText;
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
    hit.sess.activeAccount = migrated.activeAccount;
    hit.sess.accounts = migrated.accounts;
    hit.sess.convId = migrated.convId;
    if (migrated.accountCooldown) hit.sess.accountCooldown = migrated.accountCooldown;
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

function getOrphanTtlMs(opts) {
  if (typeof opts === 'number' && Number.isFinite(opts) && opts > 0) {
    return opts;
  }
  if (opts && typeof opts === 'object' && Number.isFinite(Number(opts.maxAgeMs)) && Number(opts.maxAgeMs) > 0) {
    return Number(opts.maxAgeMs);
  }
  if (process.env.AGY_ORPHAN_TTL_MS !== undefined && process.env.AGY_ORPHAN_TTL_MS !== '') {
    const n = Number(process.env.AGY_ORPHAN_TTL_MS);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const cfg = Number(config.ORPHAN_TTL_MS);
  return (Number.isFinite(cfg) && cfg > 0) ? cfg : (30 * 24 * 60 * 60 * 1000);
}

/**
 * H3: 孤儿清理
 * - 删除 lastUsedAt 早于 now - maxAgeMs（默认 AGY_ORPHAN_TTL_MS = 30 天）的分支（从 branches[] 移除）
 * - 若某会话的 branches 清空 -> 整个会话记录移除
 * - 只清 sessions.json 映射，不删磁盘 .md 归档
 * - 日志：pruned orphans: <n> branches
 */
function pruneOrphans(state, opts = {}) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 0;
  const maxAgeMs = getOrphanTtlMs(opts);
  const now = (opts && typeof opts === 'object' && typeof opts.now === 'number' && Number.isFinite(opts.now))
    ? opts.now
    : Date.now();
  const cutoff = now - maxAgeMs;
  let pruned = 0;

  for (const key of Object.keys(state)) {
    const rec = state[key];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;

    if (Array.isArray(rec.branches)) {
      const hadBranches = rec.branches.length > 0;
      const kept = [];
      for (const b of rec.branches) {
        if (!b || typeof b !== 'object') continue;
        const ts = (typeof b.lastUsedAt === 'number' && b.lastUsedAt > 0)
          ? b.lastUsedAt
          : ((typeof b.updatedAt === 'number' && b.updatedAt > 0) ? b.updatedAt : 0);
        if (ts > 0 && ts < cutoff) {
          pruned++;
        } else {
          kept.push(b);
        }
      }
      rec.branches = kept;
      if (kept.length === 0) {
        delete state[key];
        continue;
      } else if (!kept.some((b) => b && b.branchId === rec.lastBranchId)) {
        const latest = kept.slice().sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0] || kept[kept.length - 1];
        rec.lastBranchId = latest.branchId;
      }
    } else {
      const ts = (typeof rec.lastUsedAt === 'number' && rec.lastUsedAt > 0)
        ? rec.lastUsedAt
        : ((typeof rec.updatedAt === 'number' && rec.updatedAt > 0) ? rec.updatedAt : 0);
      if (ts > 0 && ts < cutoff) {
        pruned++;
        delete state[key];
      }
    }
  }

  if (pruned > 0) {
    console.log(new Date().toISOString(), `pruned orphans: ${pruned} branches`);
  }
  return pruned;
}

function saveState(state) {
  const file = config.STATE_FILE;
  if (state && typeof state === 'object' && !Array.isArray(state)) {
    pruneOrphans(state);
  }
  const safeState = (state && typeof state === 'object' && !Array.isArray(state))
    ? migrateState(state)
    : {};

  /* 兼容镜像：顶层保留最后使用分支的关键字段。
     外部工具 / 旧版审计脚本仍可读 rec.convId、rec.turns、rec.syncedHashes；
     migrateSessionRecord 优先识别 branches，因此镜像字段不会被重复迁移。 */
  applyCompatMirror(safeState);
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

  const hasAccountsObj = Boolean(
    (target.accounts && typeof target.accounts === 'object' && !Array.isArray(target.accounts)) ||
    (sess.accounts && typeof sess.accounts === 'object' && !Array.isArray(sess.accounts))
  );
  if (hasAccountsObj) {
    const activeAcc = (typeof sess.activeAccount === 'string' && sess.activeAccount.trim())
      ? sess.activeAccount.trim()
      : ((typeof target.activeAccount === 'string' && target.activeAccount.trim()) ? target.activeAccount.trim() : 'main');
    const accMap = (target.accounts && typeof target.accounts === 'object') ? target.accounts : sess.accounts;
    const accConvId = (accMap && accMap[activeAcc] && accMap[activeAcc].convId) ? accMap[activeAcc].convId : null;
    if (!accConvId || target.conversationMissing) {
      return { kind: 'deep', divIdx };
    }
  } else if (('convId' in target && !target.convId) || target.conversationMissing) {
    return { kind: 'deep', divIdx };
  }
  if (typeof target.turns === 'number' && target.turns >= config.MAX_TURNS_PER_SESSION) {
    return { kind: 'deep', divIdx };
  }
  const maxMissingStreak = Number(config.MAX_MISSING_RECORD_STREAK) > 0 ? Number(config.MAX_MISSING_RECORD_STREAK) : 3;
  if (typeof target.missingRecordStreak === 'number' && target.missingRecordStreak >= maxMissingStreak) {
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

  // 酒馆 Swipe / Regenerate：去掉了上一轮追加的 AI 回复（长度恰好少 1），应走 shallow 覆盖并累计 swipeStreak
  if (target.hasAppendedReply && divIdx === hashes.length && synced.length === hashes.length + 1) {
    const swipeStreak = typeof target.swipeStreak === 'number' ? target.swipeStreak : 0;
    if (swipeStreak < config.MAX_SWIPE_STREAK) {
      return { kind: 'shallow', divIdx };
    }
    return { kind: 'deep', divIdx };
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

function copyFilteredArchiveFile(srcPath, dstPath, maxFloor) {
  if (!fs.existsSync(srcPath)) return false;
  const raw = fs.readFileSync(srcPath, 'utf8');
  const re = /<!--\s*(floors?):\s*(\d+)(?:\s*-\s*(\d+))?\s*-->/gi;
  const matches = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    const startFloor = Number(m[2]);
    const hasRange = m[3] !== undefined && m[3] !== '';
    const endFloor = hasRange ? Number(m[3]) : startFloor;
    const label = m[1].toLowerCase();
    const header = (hasRange || label === 'floors')
      ? `<!-- floors: ${startFloor}-${endFloor} -->`
      : `<!-- floor: ${startFloor} -->`;
    matches.push({
      endFloor,
      header,
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  let out = '';
  if (matches.length === 0) {
    out = maxFloor > 0 ? raw : '';
  } else {
    const kept = [];
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const nextStart = i + 1 < matches.length ? matches[i + 1].start : raw.length;
      const body = raw.slice(cur.bodyStart, nextStart).trim();
      if (cur.endFloor < maxFloor) {
        kept.push(`${cur.header}\n${body}`);
      }
    }
    out = kept.length > 0 ? kept.join('\n\n') + '\n' : '';
  }
  if (!out || !out.trim()) {
    return false;
  }
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const tmpPath = `${dstPath}.tmp.${process.pid}.${++seq}`;
  fs.writeFileSync(tmpPath, out, 'utf8');
  fs.renameSync(tmpPath, dstPath);
  return true;
}

function copyTimelineBeforeLcp(parentDir, newDir, lcp) {
  if (!newDir) return false;
  try {
    fs.mkdirSync(newDir, { recursive: true });
    if (!parentDir) return false;
    const maxFloor = Number(lcp) || 0;
    const parentAllPath = path.join(parentDir, 'timeline.all.md');
    const parentTlPath = path.join(parentDir, 'timeline.md');
    const copiedAll = fs.existsSync(parentAllPath)
      ? copyFilteredArchiveFile(parentAllPath, path.join(newDir, 'timeline.all.md'), maxFloor)
      : copyFilteredArchiveFile(parentTlPath, path.join(newDir, 'timeline.all.md'), maxFloor);
    let copiedTl = copyFilteredArchiveFile(parentTlPath, path.join(newDir, 'timeline.md'), maxFloor);
    const copiedCh = copyFilteredArchiveFile(path.join(parentDir, 'chapters.md'), path.join(newDir, 'chapters.md'), maxFloor);
    let copiedSt = copyFilteredArchiveFile(path.join(parentDir, 'state.md'), path.join(newDir, 'state.md'), maxFloor);
    if (!copiedSt && maxFloor > 0 && fs.existsSync(path.join(parentDir, 'state.prev.md'))) {
      copiedSt = copyFilteredArchiveFile(path.join(parentDir, 'state.prev.md'), path.join(newDir, 'state.md'), maxFloor);
    }
    if (copiedAll && !copiedTl && maxFloor > 0) {
      try {
        let maxChFloor = 0;
        const newChPath = path.join(newDir, 'chapters.md');
        if (fs.existsSync(newChPath)) {
          const chRaw = fs.readFileSync(newChPath, 'utf8');
          const chRe = /<!--\s*floors?:\s*\d+(?:\s*-\s*(\d+))?\s*-->/gi;
          let cm;
          while ((cm = chRe.exec(chRaw)) !== null) {
            const ef = Number(cm[1]);
            if (Number.isFinite(ef) && ef > maxChFloor) maxChFloor = ef;
          }
        }
        const newAllPath = path.join(newDir, 'timeline.all.md');
        if (fs.existsSync(newAllPath)) {
          const allRaw = fs.readFileSync(newAllPath, 'utf8');
          const segRe = /<!--\s*floor:\s*(\d+)\s*-->/g;
          const matches = [];
          let sm;
          while ((sm = segRe.exec(allRaw)) !== null) {
            matches.push({ floor: Number(sm[1]), start: sm.index, bodyStart: sm.index + sm[0].length });
          }
          const restored = [];
          for (let i = 0; i < matches.length; i++) {
            const cur = matches[i];
            const nextStart = i + 1 < matches.length ? matches[i + 1].start : allRaw.length;
            const body = allRaw.slice(cur.bodyStart, nextStart).trim();
            if (cur.floor > maxChFloor && cur.floor < maxFloor) {
              restored.push(`<!-- floor: ${cur.floor} -->\n${body}`);
            }
          }
          if (restored.length > 0) {
            const dstTl = path.join(newDir, 'timeline.md');
            const tmpPath = `${dstTl}.tmp.${process.pid}.${++seq}`;
            fs.writeFileSync(tmpPath, restored.join('\n\n') + '\n', 'utf8');
            fs.renameSync(tmpPath, dstTl);
            copiedTl = true;
          }
        }
      } catch {}
    }
    return copiedAll || copiedTl || copiedCh || copiedSt;
  } catch {
    return false;
  }
}

const MAX_BRANCHES_PER_CHAT = Number(config.MAX_BRANCHES) > 0 ? Number(config.MAX_BRANCHES) : 16;

function getMaxBranches(opts) {
  if (opts && Number(opts.maxBranches) > 0) return Math.floor(Number(opts.maxBranches));
  if (process.env.AGY_MAX_BRANCHES !== undefined && process.env.AGY_MAX_BRANCHES !== '') {
    const n = Number(process.env.AGY_MAX_BRANCHES);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const cfg = Number(config.MAX_BRANCHES);
  return (Number.isFinite(cfg) && cfg > 0) ? Math.floor(cfg) : 16;
}

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

  const requestedAccount = (typeof opts.activeAccount === 'string' && opts.activeAccount.trim())
    ? opts.activeAccount.trim()
    : ((migrated && typeof migrated.activeAccount === 'string' && migrated.activeAccount.trim())
      ? migrated.activeAccount.trim()
      : 'main');
  const accountHome = (typeof opts.accountHome === 'string' && opts.accountHome.trim())
    ? opts.accountHome.trim()
    : null;

  if (existingBranches.length === 0) {
    const b1Dir = key ? path.join(workspacesDir, key) : '';
    const baseAccounts = (migrated && migrated.accounts && typeof migrated.accounts === 'object')
      ? JSON.parse(JSON.stringify(migrated.accounts))
      : { [requestedAccount]: { convId: null } };
    if (!baseAccounts[requestedAccount]) {
      baseAccounts[requestedAccount] = { convId: null };
    }
    const b1 = {
      branchId: 'b1',
      activeAccount: requestedAccount,
      accounts: baseAccounts,
      convId: null,
      hashes: [],
      turns: 0,
      dir: b1Dir,
      model,
      lastUsedAt: now,
      swipeStreak: 0,
      stateDirty: false,
      missingRecordStreak: 0,
      keys: defaultKeys.slice(),
    };
    const branches = [b1];
    if (sessRecord && typeof sessRecord === 'object') {
      sessRecord.activeAccount = requestedAccount;
      sessRecord.accounts = JSON.parse(JSON.stringify(baseAccounts));
      sessRecord.convId = null;
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
    const activeAcc = requestedAccount || b.activeAccount || 'main';
    const rawConvId = (b.accounts && typeof b.accounts === 'object')
      ? ((b.accounts[activeAcc] && b.accounts[activeAcc].convId) || null)
      : (b.convId || null);
    const healthy = !isHealthy || !rawConvId || isHealthy(rawConvId, accountHome);
    const effectiveConvId = healthy ? rawConvId : null;
    const branchAccounts = (b.accounts && typeof b.accounts === 'object')
      ? JSON.parse(JSON.stringify(b.accounts))
      : { main: { convId: b.convId || null } };
    const bForDrift = {
      ...b,
      activeAccount: activeAcc,
      accounts: {
        ...branchAccounts,
        [activeAcc]: { convId: effectiveConvId },
      },
      hashes: branchHashes,
      syncedHashes: branchHashes,
      convId: effectiveConvId,
    };
    const drift = driftOf(bForDrift, floors.length > 0 ? floors : incomingHashes);
    const bForTimelineMatch = {
      ...b,
      activeAccount: activeAcc,
      accounts: {
        ...branchAccounts,
        [activeAcc]: { convId: effectiveConvId || '__timeline_match__' },
      },
      turns: 0,
      missingRecordStreak: 0,
      conversationMissing: false,
      hashes: branchHashes,
      syncedHashes: branchHashes,
      convId: effectiveConvId || '__timeline_match__',
    };
    const timelineDrift = driftOf(bForTimelineMatch, floors.length > 0 ? floors : incomingHashes);
    return { branch: b, lcp, drift, timelineDrift, activeAcc, effectiveConvId, branchAccounts };
  });

  const reusable = evaluated.filter(
    (e) =>
      e.drift.kind === 'advance' ||
      e.drift.kind === 'shallow' ||
      e.drift.kind === 'retry' ||
      e.timelineDrift.kind === 'advance' ||
      e.timelineDrift.kind === 'shallow' ||
      e.timelineDrift.kind === 'retry'
  );

  if (reusable.length > 0) {
    reusable.sort((a, b) => {
      if (b.lcp !== a.lcp) return b.lcp - a.lcp;
      const aDeep = a.drift.kind === 'deep' ? 1 : 0;
      const bDeep = b.drift.kind === 'deep' ? 1 : 0;
      if (aDeep !== bDeep) return aDeep - bDeep;
      const aShallow = a.drift.kind === 'shallow' ? 1 : 0;
      const bShallow = b.drift.kind === 'shallow' ? 1 : 0;
      if (aShallow !== bShallow) return aShallow - bShallow;
      return (b.branch.lastUsedAt || 0) - (a.branch.lastUsedAt || 0);
    });
    const winner = reusable[0];
    winner.branch.lastUsedAt = now;
    winner.branch.activeAccount = winner.activeAcc;
    winner.branch.accounts = winner.branchAccounts;
    winner.branch.convId = winner.effectiveConvId;
    if (sessRecord && typeof sessRecord === 'object') {
      sessRecord.activeAccount = winner.activeAcc;
      sessRecord.accounts = JSON.parse(JSON.stringify(winner.branchAccounts));
      sessRecord.convId = winner.effectiveConvId;
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
      timelineDrift: winner.timelineDrift,
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

  const lcpFloor = floors.length > 0 ? divFloorNo(floors, parent.lcp) : parent.lcp;
  copyTimelineBeforeLcp(parent.branch.dir, newDir, lcpFloor);

  const newAccounts = { [requestedAccount]: { convId: null } };
  const newBranch = {
    branchId: newBranchId,
    activeAccount: requestedAccount,
    accounts: newAccounts,
    convId: null,
    hashes: [],
    turns: 0,
    dir: newDir,
    model,
    lastUsedAt: now,
    swipeStreak: 0,
    stateDirty: false,
    missingRecordStreak: 0,
    keys: defaultKeys.slice(),
  };

  const maxBranches = getMaxBranches(opts);
  const nextBranches = [...existingBranches, newBranch];
  while (nextBranches.length > maxBranches) {
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
    sessRecord.activeAccount = requestedAccount;
    sessRecord.accounts = JSON.parse(JSON.stringify(newAccounts));
    sessRecord.convId = null;
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

function getHardGate(override) {
  if (Number(override) > 0) return Number(override);
  const envVal = Number(process.env.AGY_HARD_GATE);
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  return Number(config.HARD_GATE) > 0 ? Number(config.HARD_GATE) : 185000;
}

function assembleBootstrapSections({
  headSections,
  chaptersBody,
  timelineBody,
  includeEmptyTimeline,
  postSection,
  recentList,
  includeRecentHeader,
  trailingArchive = '',
}) {
  const sections = [...headSections];
  if (chaptersBody) {
    sections.push(`[CHAPTERS]\n${chaptersBody}`);
  }
  if (timelineBody || includeEmptyTimeline) {
    sections.push(`[TIMELINE]\n${timelineBody || ''}`);
  }
  if (postSection) {
    sections.push(postSection);
  }
  let out = sections.join('\n\n');
  if (includeRecentHeader || (recentList && recentList.length > 0)) {
    const recBody = Array.isArray(recentList) ? recentList.join('\n\n') : '';
    out = out ? `${out}\n\n[RECENT]\n${recBody}` : `[RECENT]\n${recBody}`;
  }
  if (trailingArchive) {
    out += trailingArchive;
  }
  return out;
}

function gateBootstrapSections({
  headSections,
  chaptersBody = '',
  timelineBody = '',
  includeEmptyTimeline = true,
  postSection = '',
  recentItems = [],
  includeRecentHeader = true,
  trailingArchive = '',
  gate,
}) {
  const limit = getHardGate(gate);
  const full = assembleBootstrapSections({
    headSections,
    chaptersBody,
    timelineBody,
    includeEmptyTimeline,
    postSection,
    recentList: recentItems,
    includeRecentHeader,
    trailingArchive,
  });
  if (Buffer.byteLength(full, 'utf8') <= limit) {
    return full;
  }

  // 1. 尾部不可妥协区（先锁）：本轮最新 1–2 个 floor + [POST] + 归档指令
  // 2. 头部不可妥协区（再锁）：[SYSTEM] + [OPENING] + [STATE]
  let tailFloors = [];
  if (recentItems.length >= 2) {
    tailFloors = recentItems.slice(-2);
    const minWith2 = assembleBootstrapSections({
      headSections,
      chaptersBody: '',
      timelineBody: '',
      includeEmptyTimeline,
      postSection,
      recentList: tailFloors,
      includeRecentHeader,
      trailingArchive,
    });
    if (Buffer.byteLength(minWith2, 'utf8') > limit) {
      tailFloors = recentItems.slice(-1);
    }
  } else if (recentItems.length === 1) {
    tailFloors = recentItems.slice(-1);
  }

  const minPrompt = assembleBootstrapSections({
    headSections,
    chaptersBody: '',
    timelineBody: '',
    includeEmptyTimeline,
    postSection,
    recentList: tailFloors,
    includeRecentHeader,
    trailingArchive,
  });
  const minBytes = Buffer.byteLength(minPrompt, 'utf8');
  if (minBytes > limit) {
    // F2: 绝不因超大单条消息导致闸门报错 500，优先对过大的 OPENING / tailFloors 做保头保尾截断以塞进 limit
    const adjustedHead = headSections.map((sec) => {
      if (typeof sec === 'string' && sec.startsWith('[OPENING]\n')) {
        const openBody = sec.slice('[OPENING]\n'.length);
        const capOpen = Math.max(256, Math.floor(limit * 0.35));
        if (Buffer.byteLength(openBody, 'utf8') > capOpen) {
          return `[OPENING]\n${capHeadTailUtf8(openBody, capOpen)}`;
        }
      }
      return sec;
    });
    const afterOpenPrompt = assembleBootstrapSections({
      headSections: adjustedHead,
      chaptersBody: '',
      timelineBody: '',
      includeEmptyTimeline,
      postSection,
      recentList: tailFloors,
      includeRecentHeader,
      trailingArchive,
    });
    if (Buffer.byteLength(afterOpenPrompt, 'utf8') <= limit) {
      return afterOpenPrompt;
    }
    const baseWithoutTail = assembleBootstrapSections({
      headSections: adjustedHead,
      chaptersBody: '',
      timelineBody: '',
      includeEmptyTimeline,
      postSection,
      recentList: [],
      includeRecentHeader,
      trailingArchive,
    });
    const availForTail = limit - Buffer.byteLength(baseWithoutTail, 'utf8');
    if (availForTail > 128 && tailFloors.length > 0) {
      const lastTail = tailFloors[tailFloors.length - 1];
      const cappedTail = [capHeadTailUtf8(lastTail, availForTail)];
      const candidate = assembleBootstrapSections({
        headSections: adjustedHead,
        chaptersBody: '',
        timelineBody: '',
        includeEmptyTimeline,
        postSection,
        recentList: cappedTail,
        includeRecentHeader,
        trailingArchive,
      });
      if (Buffer.byteLength(candidate, 'utf8') <= limit) {
        return candidate;
      }
    }
    return capHeadTailUtf8(afterOpenPrompt, limit);
  }

  // 3. 中间预算 = HARD_GATE - head - tail，从后往前装 [RECENT] 其余楼层与 [TIMELINE] / [CHAPTERS]
  const olderRecent = recentItems.slice(0, recentItems.length - tailFloors.length);
  const selectedRecent = [...tailFloors];
  for (let i = olderRecent.length - 1; i >= 0; i--) {
    const candidateList = [olderRecent[i], ...selectedRecent];
    const candidatePrompt = assembleBootstrapSections({
      headSections,
      chaptersBody: '',
      timelineBody: '',
      includeEmptyTimeline,
      postSection,
      recentList: candidateList,
      includeRecentHeader,
      trailingArchive,
    });
    if (Buffer.byteLength(candidatePrompt, 'utf8') <= limit) {
      selectedRecent.unshift(olderRecent[i]);
    } else {
      break;
    }
  }

  let finalTimeline = '';
  if (timelineBody) {
    const withFullTl = assembleBootstrapSections({
      headSections,
      chaptersBody: '',
      timelineBody,
      includeEmptyTimeline,
      postSection,
      recentList: selectedRecent,
      includeRecentHeader,
      trailingArchive,
    });
    if (Buffer.byteLength(withFullTl, 'utf8') <= limit) {
      finalTimeline = timelineBody;
    } else {
      const baseWithoutTl = assembleBootstrapSections({
        headSections,
        chaptersBody: '',
        timelineBody: '',
        includeEmptyTimeline: true,
        postSection,
        recentList: selectedRecent,
        includeRecentHeader,
        trailingArchive,
      });
      const availTl = limit - Buffer.byteLength(baseWithoutTl, 'utf8');
      if (availTl > 0) {
        finalTimeline = tailUtf8(timelineBody, availTl);
      }
    }
  }

  let finalChapters = '';
  if (chaptersBody) {
    const withFullCh = assembleBootstrapSections({
      headSections,
      chaptersBody,
      timelineBody: finalTimeline,
      includeEmptyTimeline,
      postSection,
      recentList: selectedRecent,
      includeRecentHeader,
      trailingArchive,
    });
    if (Buffer.byteLength(withFullCh, 'utf8') <= limit) {
      finalChapters = chaptersBody;
    } else {
      const baseWithDummyCh = assembleBootstrapSections({
        headSections,
        chaptersBody: 'X',
        timelineBody: finalTimeline,
        includeEmptyTimeline,
        postSection,
        recentList: selectedRecent,
        includeRecentHeader,
        trailingArchive,
      });
      const chOverhead = Buffer.byteLength(baseWithDummyCh, 'utf8') - 1;
      const availCh = limit - chOverhead;
      if (availCh > 0) {
        finalChapters = tailUtf8(chaptersBody, availCh);
      }
    }
  }

  return assembleBootstrapSections({
    headSections,
    chaptersBody: finalChapters,
    timelineBody: finalTimeline,
    includeEmptyTimeline,
    postSection,
    recentList: selectedRecent,
    includeRecentHeader,
    trailingArchive,
  });
}

function splitRecentBlocks(recentBody) {
  if (!recentBody || !recentBody.trim()) return [];
  const parts = recentBody.split(/\n\n(?=\[(?:#\d+\s+)?(?:user|assistant|system|developer)\b)/);
  return parts.filter((p) => p.length > 0);
}

/**
 * C. 185KB 硬闸门（P0-2）
 * 在把 prompt 写入子进程之前执行的字节级最终闸门（默认 HARD_GATE = 185000，可用 AGY_HARD_GATE 覆盖）。
 * 闸门只在总字节 > HARD_GATE 时生效；正常情况不改变现有输出。
 */
function enforceHardGate(input, opts = {}) {
  if (input && typeof input === 'object') {
    const gate = getHardGate(input.hardGate || input.gateBytes || opts.hardGate || opts.gateBytes);
    const built = buildBootstrap({ ...input, budgetBytes: gate });
    return enforceHardGate(built, { ...opts, hardGate: gate });
  }
  const prompt = typeof input === 'string' ? input : String(input || '');
  const gate = getHardGate(opts.hardGate || opts.gateBytes);
  if (Buffer.byteLength(prompt, 'utf8') <= gate) {
    return prompt;
  }

  const tagRe = /(?:^|\n\n)\[(SYSTEM|OPENING|STATE|CHAPTERS|TIMELINE|POST|RECENT)\]\n/g;
  const matches = [];
  let m;
  while ((m = tagRe.exec(prompt)) !== null) {
    const leadingSep = m[0].startsWith('\n\n') ? 2 : 0;
    matches.push({
      tag: m[1],
      tagStart: m.index + leadingSep,
      matchStart: m.index,
      bodyStart: m.index + m[0].length,
    });
  }

  if (matches.length > 0) {
    const headSections = [];
    let chaptersBody = '';
    let timelineBody = '';
    let includeEmptyTimeline = false;
    let postSection = '';
    let recentItems = [];
    let includeRecentHeader = false;
    let trailingArchive = '';

    if (matches[0].matchStart > 0) {
      const pre = prompt.slice(0, matches[0].matchStart).trim();
      if (pre) headSections.push(pre);
    }

    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const nextStart = i + 1 < matches.length ? matches[i + 1].matchStart : prompt.length;
      let body = prompt.slice(cur.bodyStart, nextStart);

      if (i === matches.length - 1 && cur.tag !== 'SYSTEM') {
        const archIdx = body.indexOf('\n\n[归档指令]\n');
        if (archIdx >= 0) {
          trailingArchive = body.slice(archIdx);
          body = body.slice(0, archIdx);
        }
      }

      if (cur.tag === 'SYSTEM' || cur.tag === 'OPENING' || cur.tag === 'STATE') {
        headSections.push(`[${cur.tag}]\n${body}`);
      } else if (cur.tag === 'CHAPTERS') {
        chaptersBody = body.trim();
      } else if (cur.tag === 'TIMELINE') {
        timelineBody = body;
        includeEmptyTimeline = true;
      } else if (cur.tag === 'POST') {
        postSection = `[POST]\n${body}`;
      } else if (cur.tag === 'RECENT') {
        includeRecentHeader = true;
        recentItems = splitRecentBlocks(body);
      }
    }

    return gateBootstrapSections({
      headSections,
      chaptersBody,
      timelineBody,
      includeEmptyTimeline,
      postSection,
      recentItems,
      includeRecentHeader,
      trailingArchive,
      gate,
    });
  }

  // 非 bootstrap 结构（如 [新消息] 或 [TIMELINE OVERRIDE]）：先对单条超大项做软切分，再锁定本轮最新 1-2 个 floor
  const headerMatch = /^(\[(?:新消息|TIMELINE OVERRIDE)\]\n(?:[^\n]*\n\n)?)/.exec(prompt);
  if (headerMatch) {
    const header = headerMatch[1];
    const rest = prompt.slice(header.length);
    const rawItems = splitRecentBlocks(rest);
    const items = [];
    for (const item of rawItems) {
      if (Buffer.byteLength(item, 'utf8') > OVERSIZED_TEXT_SPLIT_BYTES) {
        const hMatch = /^(\[(?:#\d+\s+)?[^\]]+\]\n)/.exec(item);
        const itemHeader = hMatch ? hMatch[1] : '';
        const itemBody = hMatch ? item.slice(itemHeader.length) : item;
        const pieces = splitOversizedText(itemBody, OVERSIZED_TEXT_SPLIT_BYTES);
        pieces.forEach((p, idx) => {
          items.push(idx === 0 ? `${itemHeader}${p}` : `${itemHeader}（第1楼续）${p}`);
        });
      } else {
        items.push(item);
      }
    }
    if (items.length === 0) {
      return capHeadTailUtf8(prompt, gate);
    }
    let tail = items.slice(-2);
    if (Buffer.byteLength(header + tail.join('\n\n'), 'utf8') > gate) {
      tail = items.slice(-1);
    }
    if (Buffer.byteLength(header + tail.join('\n\n'), 'utf8') > gate) {
      const avail = Math.max(64, gate - Buffer.byteLength(header, 'utf8'));
      return header + capHeadTailUtf8(tail[0], avail);
    }
    const older = items.slice(0, items.length - tail.length);
    const picked = [...tail];
    for (let i = older.length - 1; i >= 0; i--) {
      const candidate = header + [older[i], ...picked].join('\n\n');
      if (Buffer.byteLength(candidate, 'utf8') <= gate) {
        picked.unshift(older[i]);
      } else {
        break;
      }
    }
    return header + picked.join('\n\n');
  }

  return capHeadTailUtf8(prompt, gate);
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
  const rawBudget = Number(budgetBytes) > 0 ? Number(budgetBytes) : config.PROMPT_BUDGET;
  const budget = (process.env.AGY_HARD_GATE && rawBudget <= config.CLI_PROMPT_HARD_CAP)
    ? Math.min(rawBudget, getHardGate())
    : rawBudget;
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

  let openingCount = Math.min(2, activeFloors.length);
  if (
    openingCount === 2 &&
    (activeFloors[1]._isPseudoFloor ||
      /^（第\s*\d+\s*楼续）/.test(textOf(activeFloors[1].content).trim()) ||
      Buffer.byteLength(textOf(activeFloors[0].content), 'utf8') +
        Buffer.byteLength(textOf(activeFloors[1].content), 'utf8') > OVERSIZED_TEXT_SPLIT_BYTES)
  ) {
    openingCount = 1;
  }
  const openingMsgs = activeFloors.slice(0, openingCount);
  const recentCandidates = activeFloors.slice(openingCount);

  const openingBlock = openingMsgs
    .map((m, i) => formatMessage(m, i, RECENT_FLOOR_MAX_BYTES))
    .join('\n\n');
  const timelineText = typeof timeline === 'string' ? timeline : String(timeline || '');
  const postText = activePostBlocks.map((b) => textOf(b).trim()).filter(Boolean).join('\n\n');

  const stateText = typeof state === 'string' ? state : String(state || '');
  const chaptersText = typeof chapters === 'string' ? chapters : String(chapters || '');

  const sysSection = `[SYSTEM]\n${sysText}`;
  const openingSection = `[OPENING]\n${openingBlock}`;
  const stateSection = stateText.trim() ? `[STATE]\n${stateText.trim()}` : '';

  /* 严格模式：[SYSTEM]+[STATE] 超过预算 60% 直接失败，绝不静默砍系统提示 */
  if (isStrictSystem()) {
    const headBytes = Buffer.byteLength(`${sysSection}\n\n${stateSection}`, 'utf8');
    if (headBytes > Math.floor(budget * 0.6)) {
      throw new Error('system_budget_exceeded: [SYSTEM]+[STATE] ' + headBytes + 'B > ' + Math.floor(budget * 0.6) + 'B');
    }
  }

  const postSection = postText ? `[POST]\n${postText}` : '';
  const headSections = [sysSection, openingSection];
  if (stateSection) headSections.push(stateSection);

  const formattedRecent = recentCandidates.map((m, i) =>
    formatMessage(m, i + openingCount, RECENT_FLOOR_MAX_BYTES)
  );

  return gateBootstrapSections({
    headSections,
    chaptersBody: chaptersText.trim(),
    timelineBody: timelineText,
    includeEmptyTimeline: true,
    postSection,
    recentItems: formattedRecent,
    includeRecentHeader: true,
    gate: budget,
  });
}

/**
 * N5: [TIMELINE OVERRIDE] 片段，基于 floors，divIdx 是 floors 的下标
 */
function buildOverride({ divIdx = 0, floors, messages = [], postDiffBlock = '' } = {}) {
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
  let header;
  let formattedItems;
  if (sliced.length === 0 && source.length > 0) {
    const lastIdx = source.length - 1;
    header = `[TIMELINE OVERRIDE]\n此前第 ${start} 层的旧回复已作废，请完全忽略该旧回复，针对下面第 ${lastIdx} 层重新生成回复：\n\n`;
    formattedItems = [formatMessage(source[lastIdx], lastIdx, RECENT_FLOOR_MAX_BYTES)];
  } else {
    header = `[TIMELINE OVERRIDE]\n从第 ${start} 层起对话历史已回退或改写，请忽略此前第 ${start} 层及之后的旧内容，以如下最新记录为准继续回复：\n\n`;
    formattedItems = sliced.map((m, i) => formatMessage(m, start + i, RECENT_FLOOR_MAX_BYTES));
  }
  if (postDiffBlock && String(postDiffBlock).trim()) {
    const insertIdx = Math.max(0, formattedItems.length - 1);
    formattedItems.splice(insertIdx, 0, String(postDiffBlock).trim());
  }
  const body = formattedItems.join('\n\n');

  const raw = header + body;

  if (Buffer.byteLength(raw, 'utf8') > config.PROMPT_BUDGET) {
    const budget = Math.max(0, config.PROMPT_BUDGET - Buffer.byteLength(header, 'utf8'));
    return header + tailUtf8(body, budget);
  }
  return raw;
}

module.exports = {
  checkStrictSystemBudget,
  isStrictSystem,
  splitFloors,
  splitOversizedText,
  computePostBlocksDiff,
  parseFloorNo,
  lastFloorNo,
  divFloorNo,
  getHardGate,
  enforceHardGate,
  applyHardGate: enforceHardGate,
  chatKey,
  aliasKey,
  chatKeys,
  resolveSession,
  loadState,
  saveState,
  pruneOrphans,
  getMaxBranches,
  MAX_BRANCHES_PER_CHAT,
  driftOf,
  selectBranch,
  migrateSessionRecord,
  migrateState,
  copyFilteredArchiveFile,
  copyTimelineBeforeLcp,
  calcLcp,
  buildBootstrap,
  buildOverride,
  layerHash,
  formatMessage,
  formatRoleLabel,
  FLOOR_MARKER_HEAD_RE,
  RECENT_FLOOR_MAX_BYTES,
  OVERSIZED_TEXT_SPLIT_BYTES,
};
