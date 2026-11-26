#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const config = require('./config');
const { runTurn, terminateChild, binSpec } = require('./agy-runner');
const session = require('./session');
const archive = require('./archive');
const { TurnQueue, BusyError } = require('./queue');

const SYS_WORKSPACE = path.join(config.WORKSPACES, '_sys');
try {
  fs.mkdirSync(SYS_WORKSPACE, { recursive: true });
} catch {}

function ensureSysWorkspace() {
  const dir = path.join(config.WORKSPACES, '_sys');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

const DEFAULT_ARCHIVE_INSTRUCTION =
  '\n\n[归档指令]\n' +
  '每轮回复正文结束后，必须在最末尾单独追加一段 <ta_record>...</ta_record> 剧情归档（150-320字），' +
  '涵盖七要素：时间、地点、在场人物、关键事件、关系或状态变化、未兑现承诺或伏笔、当前场景结束状态。' +
  '正文中严禁提及该标签或归档规则。';

function ensureArchiveSystem(sysText) {
  const s = typeof sysText === 'string' ? sysText : String(sysText || '');
  if (s.includes('ta_record')) return s;
  return s ? (s + DEFAULT_ARCHIVE_INSTRUCTION) : DEFAULT_ARCHIVE_INSTRUCTION.trim();
}

const TOKEN_FILE = process.env.AGY_BRIDGE_TOKEN_FILE || path.join(config.HOME, '.agy-bridge', 'token');
const SUMMARY_FILE = process.env.AGY_SUMMARY_FILE || path.join(config.HOME, '.agy-bridge', 'summaries.json');
const SUMMARY_MODEL = process.env.AGY_SUMMARY_MODEL || config.SUMMARY_MODEL || 'gemini-3.8-flash-low';
const SUMMARY_REFRESH_STEP = Number(process.env.AGY_SUMMARY_STEP || 4);
const SUMMARY_MAX_INPUT = 80000;

let MODELS = config.FALLBACK_MODELS.slice();
let MODEL_NAMES = {};
let AUTH_TOKEN = '';
try {
  AUTH_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {}

const queue = new TurnQueue({
  maxConcurrent: config.MAX_CONCURRENT,
  limit: config.QUEUE_LIMIT,
  timeoutMs: config.QUEUE_TIMEOUT_MS,
});

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function isSessionMode() {
  if (process.env.AGY_SESSION_MODE === '0') return false;
  return Boolean(config.SESSION_MODE);
}

let seedSeq = 0;

function trySeedTimeline(workspaceDir, floors) {
  try {
    if (!workspaceDir || !Array.isArray(floors) || floors.length === 0 || !floors[0]) {
      return false;
    }
    const timelinePath = path.join(workspaceDir, 'timeline.md');
    try {
      const st = fs.statSync(timelinePath);
      if (st.isFile() && st.size > 0) return false;
    } catch {}

    const firstContent = textOf(floors[0].content != null ? floors[0].content : floors[0]);
    const firstTrimmed = firstContent.trim();
    if (!firstTrimmed) return false;

    const candidateSeedsDirs = [
      path.join(path.dirname(workspaceDir), '_seeds'),
      path.join(path.dirname(path.dirname(workspaceDir)), '_seeds'),
      path.join(config.WORKSPACES, '_seeds'),
    ];
    const seedsDir = candidateSeedsDirs.find((d) => {
      try { return fs.existsSync(d); } catch { return false; }
    });
    if (!seedsDir) return false;

    const entries = fs.readdirSync(seedsDir).sort();
    for (const file of entries) {
      if (!file.endsWith('.sig')) continue;
      const hash = file.slice(0, -4);
      if (!hash) continue;
      try {
        const sigPath = path.join(seedsDir, file);
        const sigText = fs.readFileSync(sigPath, 'utf8');
        const sigPrefix = sigText.trim().slice(0, 40);
        if (!sigPrefix) continue;

        if (firstTrimmed.startsWith(sigPrefix) || firstContent.includes(sigPrefix)) {
          const mdPath = path.join(seedsDir, `${hash}.md`);
          const mdBuf = fs.readFileSync(mdPath);
          if (!mdBuf || mdBuf.length === 0) continue;
          fs.mkdirSync(workspaceDir, { recursive: true });
          const tmpPath = `${timelinePath}.tmp.${process.pid}.${++seedSeq}`;
          fs.writeFileSync(tmpPath, mdBuf);
          fs.renameSync(tmpPath, timelinePath);
          const timelineAllPath = path.join(workspaceDir, 'timeline.all.md');
          const tmpAllPath = `${timelineAllPath}.tmp.${process.pid}.${++seedSeq}`;
          fs.writeFileSync(tmpAllPath, mdBuf);
          fs.renameSync(tmpAllPath, timelineAllPath);
          log(`timeline seeded: ${hash}`);
          return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .join('');
  }
  return content == null ? '' : String(content);
}

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

function isChunkedBootstrapEnabled() {
  if (process.env.AGY_CHUNKED_BOOTSTRAP !== undefined && process.env.AGY_CHUNKED_BOOTSTRAP !== '') {
    const n = Number(process.env.AGY_CHUNKED_BOOTSTRAP);
    if (Number.isFinite(n)) return n === 1;
  }
  return Boolean(config.CHUNKED_BOOTSTRAP);
}

function getWarmChunkBytes(override) {
  const budget = Number(config.PROMPT_BUDGET) > 0 ? Number(config.PROMPT_BUDGET) : 180000;
  if (override !== undefined && override !== null && override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0 && n <= budget && n < 185000) {
      return Math.floor(n);
    }
    return 165000;
  }
  if (process.env.AGY_WARM_CHUNK_BYTES !== undefined && process.env.AGY_WARM_CHUNK_BYTES !== '') {
    return typeof config.parseWarmChunkBytes === 'function'
      ? config.parseWarmChunkBytes(process.env.AGY_WARM_CHUNK_BYTES, budget, 165000)
      : 165000;
  }
  const cfg = Number(config.WARM_CHUNK_BYTES);
  if (Number.isFinite(cfg) && cfg > 0 && cfg <= budget && cfg < 185000) {
    return Math.floor(cfg);
  }
  return 165000;
}

function getWarmMaxChunks(override) {
  if (override !== undefined && override !== null && override !== '') {
    const n = Number(override);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  if (process.env.AGY_WARM_MAX_CHUNKS !== undefined && process.env.AGY_WARM_MAX_CHUNKS !== '') {
    const n = Number(process.env.AGY_WARM_MAX_CHUNKS);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  const cfg = Number(config.WARM_MAX_CHUNKS);
  return (Number.isFinite(cfg) && cfg >= 1) ? Math.floor(cfg) : 8;
}

function getChunkedTotalBudget(override, warmChunkBytesOverride) {
  const warmChunkBytes = getWarmChunkBytes(warmChunkBytesOverride);
  let budget;
  if (override !== undefined && override !== null && override !== '') {
    budget = typeof config.parseChunkedTotalBudget === 'function'
      ? config.parseChunkedTotalBudget(override, warmChunkBytes, 700000, 3000000)
      : 700000;
  } else if (process.env.AGY_CHUNKED_TOTAL_BUDGET !== undefined && process.env.AGY_CHUNKED_TOTAL_BUDGET !== '') {
    budget = typeof config.parseChunkedTotalBudget === 'function'
      ? config.parseChunkedTotalBudget(process.env.AGY_CHUNKED_TOTAL_BUDGET, warmChunkBytes, 700000, 3000000)
      : 700000;
  } else {
    const cfg = Number(config.CHUNKED_TOTAL_BUDGET);
    budget = (Number.isFinite(cfg) && cfg >= warmChunkBytes)
      ? Math.floor(Math.min(3000000, cfg))
      : (warmChunkBytes * 6);
    if (budget > 800000) {
      log('WARN: chunked budget may approach auto-compact threshold', { chunkedTotalBudget: budget });
    }
  }
  return budget;
}

function getWarmModel() {
  if (typeof process.env.AGY_WARM_MODEL === 'string' && process.env.AGY_WARM_MODEL.trim()) {
    return process.env.AGY_WARM_MODEL.trim();
  }
  return (typeof config.WARM_MODEL === 'string' && config.WARM_MODEL.trim())
    ? config.WARM_MODEL.trim()
    : 'gemini-4-argon-low';
}

function splitOversizedText(text, maxBytes = 155000) {
  return session.splitOversizedText(text, maxBytes);
}

function expandOversizedFloorItems(items, maxBytes = 155000, startFloorNo = 1) {
  const list = Array.isArray(items) ? items : [];
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : 155000;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const item = typeof list[i] === 'string' ? list[i] : String(list[i] || '');
    if (Buffer.byteLength(item, 'utf8') <= limit) {
      out.push(item);
      continue;
    }
    const headerMatch = /^(\[(?:#\d+\s+)?[^\]]+\]\n)/.exec(item);
    const header = headerMatch ? headerMatch[1] : '';
    const body = headerMatch ? item.slice(header.length) : item;
    const headerBytes = Buffer.byteLength(header, 'utf8');
    const pieceMax = Math.max(64, Math.min(155000, limit - headerBytes - 32));
    const pieces = splitOversizedText(body, pieceMax);
    if (pieces.length <= 1) {
      out.push(item);
      continue;
    }
    const parsedNo = session.parseFloorNo(body);
    const baseNo = parsedNo !== null ? parsedNo : (startFloorNo + i);
    for (let j = 0; j < pieces.length; j++) {
      if (j === 0) {
        out.push(`${header}${pieces[j]}`);
      } else {
        const contBody = /^（第\s*\d+\s*楼/.test(pieces[j])
          ? pieces[j]
          : `（第${baseNo}楼续）${pieces[j]}`;
        out.push(`${header}${contBody}`);
      }
    }
  }
  return out;
}

function splitRecentBlocksFromText(recentBody) {
  if (!recentBody || !String(recentBody).trim()) return [];
  const s = String(recentBody);
  const byHeader = s.split(/\n\n(?=\[(?:#\d+\s+)?(?:user|assistant|system|developer)\b)/);
  if (byHeader.length > 1) {
    return byHeader.filter((p) => p.length > 0);
  }
  const byFloorMarker = s.split(/\n\n(?=(?:（第\s*\d+\s*楼）|【第\s*\d+\s*楼】|\(第\s*\d+\s*楼\)))/);
  return byFloorMarker.filter((p) => p.length > 0);
}

function capSingleFloorItem(floorStr, maxBytes) {
  const s = typeof floorStr === 'string' ? floorStr : String(floorStr || '');
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const headerMatch = /^(\[(?:#\d+\s+)?[^\]]+\]\n)/.exec(s);
  if (headerMatch) {
    const header = headerMatch[1];
    const headerBytes = Buffer.byteLength(header, 'utf8');
    if (maxBytes > headerBytes + 32) {
      return header + capHeadTailUtf8(s.slice(header.length), maxBytes - headerBytes);
    }
  }
  return capHeadTailUtf8(s, maxBytes);
}

function parsePromptIntoBootstrapSections(promptStr) {
  const prompt = typeof promptStr === 'string' ? promptStr : String(promptStr || '');
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

  let sysSection = '';
  let openingSection = '';
  let openingFloors = [];
  let stateSection = '';
  let chaptersSection = '';
  let timelineSection = '';
  let includeEmptyTimeline = false;
  let postSection = '';
  let recentItems = [];
  let includeRecentHeader = false;
  let trailingArchive = '';

  if (matches.length === 0) {
    return {
      sysSection: '',
      openingSection: '',
      openingFloors: [],
      stateSection: '',
      chaptersSection: '',
      timelineSection: '',
      includeEmptyTimeline: false,
      postSection: '',
      recentItems: splitRecentBlocksFromText(prompt),
      includeRecentHeader: true,
      trailingArchive: '',
    };
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

    if (cur.tag === 'SYSTEM') {
      sysSection = `[SYSTEM]\n${body}`;
    } else if (cur.tag === 'OPENING') {
      openingSection = `[OPENING]\n${body}`;
      openingFloors = splitRecentBlocksFromText(body);
    } else if (cur.tag === 'STATE') {
      stateSection = body.trim() ? `[STATE]\n${body.trim()}` : '';
    } else if (cur.tag === 'CHAPTERS') {
      chaptersSection = body.trim() ? `[CHAPTERS]\n${body.trim()}` : '';
    } else if (cur.tag === 'TIMELINE') {
      timelineSection = `[TIMELINE]\n${body}`;
      includeEmptyTimeline = true;
    } else if (cur.tag === 'POST') {
      postSection = body.trim() ? `[POST]\n${body}` : '';
    } else if (cur.tag === 'RECENT') {
      includeRecentHeader = true;
      recentItems = splitRecentBlocksFromText(body);
    }
  }

  return {
    sysSection,
    openingSection,
    openingFloors,
    stateSection,
    chaptersSection,
    timelineSection,
    includeEmptyTimeline,
    postSection,
    recentItems,
    includeRecentHeader,
    trailingArchive,
  };
}

function buildBootstrapSections(input = {}) {
  if (typeof input === 'string') {
    return parsePromptIntoBootstrapSections(input);
  }
  if (Array.isArray(input)) {
    return parsePromptIntoBootstrapSections(input.map((x) => textOf(x)).join('\n\n'));
  }
  if (!input || typeof input !== 'object') {
    return parsePromptIntoBootstrapSections('');
  }

  if (
    typeof input.sysSection === 'string' &&
    typeof input.openingSection === 'string' &&
    Array.isArray(input.recentItems)
  ) {
    return {
      sysSection: input.sysSection,
      openingSection: input.openingSection,
      openingFloors: Array.isArray(input.openingFloors)
        ? input.openingFloors
        : splitRecentBlocksFromText(input.openingSection.replace(/^\[OPENING\]\n?/, '')),
      stateSection: input.stateSection || '',
      chaptersSection: input.chaptersSection || '',
      timelineSection: input.timelineSection !== undefined ? input.timelineSection : '[TIMELINE]\n',
      includeEmptyTimeline: input.includeEmptyTimeline !== false,
      postSection: input.postSection || '',
      recentItems: input.recentItems.slice(),
      includeRecentHeader: input.includeRecentHeader !== false,
      trailingArchive: input.trailingArchive || '',
    };
  }

  // Support pre-constructed sections object: { system, opening, state, chapters, timeline, post, recent }
  const hasDirectPrebuilt =
    input.opening !== undefined ||
    input.recent !== undefined ||
    input.recentFloors !== undefined ||
    input.post !== undefined ||
    Array.isArray(input.headSections);

  if (hasDirectPrebuilt && !Array.isArray(input.messages) && !Array.isArray(input.floors)) {
    if (Array.isArray(input.headSections)) {
      const joinedHead = input.headSections.join('\n\n');
      const parsedHead = parsePromptIntoBootstrapSections(joinedHead);
      const chBody = (input.chaptersBody || input.chapters || '').trim();
      const tlBody = input.timelineBody !== undefined ? input.timelineBody : (input.timeline || '');
      const rawPost = input.postSection || input.post || '';
      const postSec = rawPost
        ? (String(rawPost).startsWith('[POST]\n') ? String(rawPost) : `[POST]\n${String(rawPost)}`)
        : '';
      const rawRec = input.recentItems || input.recentList || input.recentFloors || input.recent || [];
      const recItems = Array.isArray(rawRec)
        ? rawRec.map((r, idx) => (typeof r === 'string' ? r : session.formatMessage(r, idx + 2, session.RECENT_FLOOR_MAX_BYTES)))
        : splitRecentBlocksFromText(String(rawRec));
      return {
        sysSection: parsedHead.sysSection,
        openingSection: parsedHead.openingSection,
        openingFloors: parsedHead.openingFloors,
        stateSection: parsedHead.stateSection,
        chaptersSection: chBody ? (chBody.startsWith('[CHAPTERS]\n') ? chBody : `[CHAPTERS]\n${chBody}`) : '',
        timelineSection: String(tlBody).startsWith('[TIMELINE]\n') ? String(tlBody) : `[TIMELINE]\n${tlBody}`,
        includeEmptyTimeline: input.includeEmptyTimeline !== false,
        postSection: postSec,
        recentItems: recItems,
        includeRecentHeader: input.includeRecentHeader !== false,
        trailingArchive: input.trailingArchive || '',
      };
    }

    const wrapTag = (tag, val, allowEmpty = false) => {
      const s = typeof val === 'string' ? val : textOf(val);
      if (!s.trim() && !allowEmpty) return '';
      if (s.startsWith(`[${tag}]\n`)) return s;
      return `[${tag}]\n${s}`;
    };

    const sysSec = wrapTag('SYSTEM', input.system || '', false);
    let openFloors = [];
    let openSec = '';
    if (Array.isArray(input.opening)) {
      openFloors = input.opening.map((m, i) =>
        typeof m === 'string' ? m : session.formatMessage(m, i, session.RECENT_FLOOR_MAX_BYTES)
      );
      openSec = `[OPENING]\n${openFloors.join('\n\n')}`;
    } else if (input.opening !== undefined) {
      openSec = wrapTag('OPENING', input.opening, true);
      openFloors = splitRecentBlocksFromText(openSec.replace(/^\[OPENING\]\n?/, ''));
    }

    const stSec = wrapTag('STATE', (input.state || '').trim(), false);
    const chSec = wrapTag('CHAPTERS', (input.chapters || '').trim(), false);
    const tlSec = wrapTag('TIMELINE', input.timeline !== undefined ? input.timeline : '', true);
    const pSec = wrapTag('POST', input.post !== undefined ? input.post : (input.postSection || ''), false);

    const rawRecent = input.recent !== undefined
      ? input.recent
      : (input.recentFloors !== undefined ? input.recentFloors : (input.recentItems || []));
    let recItems = [];
    if (Array.isArray(rawRecent)) {
      recItems = rawRecent.map((m, i) =>
        typeof m === 'string' ? m : session.formatMessage(m, i + 2, session.RECENT_FLOOR_MAX_BYTES)
      );
    } else if (typeof rawRecent === 'string') {
      const stripped = rawRecent.replace(/^\[RECENT\]\n?/, '');
      recItems = splitRecentBlocksFromText(stripped);
    }

    return {
      sysSection: sysSec,
      openingSection: openSec,
      openingFloors: openFloors,
      stateSection: stSec,
      chaptersSection: chSec,
      timelineSection: tlSec,
      includeEmptyTimeline: true,
      postSection: pSec,
      recentItems: recItems,
      includeRecentHeader: true,
      trailingArchive: input.trailingArchive || '',
    };
  }

  // Standard buildBootstrap input shape: { system, messages, floors, systemBlocks, postBlocks, state, chapters, timeline }
  const list = Array.isArray(input.messages) ? input.messages : [];
  let stSysText = typeof input.system === 'string' ? input.system : String(input.system || '');
  if (!stSysText) {
    stSysText = list
      .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
  }

  let systemBlocks = [];
  let floors = [];
  let postBlocks = [];
  if (Array.isArray(input.floors)) {
    floors = input.floors;
    systemBlocks = Array.isArray(input.systemBlocks) ? input.systemBlocks : [];
    postBlocks = Array.isArray(input.postBlocks) ? input.postBlocks : [];
  } else {
    const split = session.splitFloors(list);
    systemBlocks = Array.isArray(input.systemBlocks) ? input.systemBlocks : split.systemBlocks;
    floors = split.floors;
    postBlocks = Array.isArray(input.postBlocks) ? input.postBlocks : split.postBlocks;
  }

  let activeFloors = floors;
  let activePostBlocks = postBlocks;
  if (activeFloors.length === 0 && activePostBlocks.length > 0) {
    activeFloors = activePostBlocks.map((b, idx) => ({ role: 'user', content: textOf(b), floorNo: idx + 1 }));
    activePostBlocks = [];
  }

  const sysBlockTexts = systemBlocks.map((b) => textOf(b).trim()).filter(Boolean);
  let sysText = [stSysText.trim(), ...sysBlockTexts].filter(Boolean).join('\n\n');
  sysText = ensureArchiveSystem(sysText);
  if (config.NON_CODING_FRAME && !sysText.startsWith(config.NON_CODING_FRAME)) {
    sysText = config.NON_CODING_FRAME + '\n' + sysText;
  }

  const openingMsgs = activeFloors.slice(0, 2);
  const recentCandidates = activeFloors.slice(2);

  const openingFloors = openingMsgs.map((m, i) =>
    typeof m === 'string' ? m : session.formatMessage(m, i, session.RECENT_FLOOR_MAX_BYTES)
  );
  const openingBlock = openingFloors.join('\n\n');
  const stateText = typeof input.state === 'string' ? input.state.trim() : String(input.state || '').trim();
  const chaptersText = typeof input.chapters === 'string' ? input.chapters.trim() : String(input.chapters || '').trim();
  const timelineText = typeof input.timeline === 'string' ? input.timeline : String(input.timeline || '');
  const postText = activePostBlocks.map((b) => textOf(b).trim()).filter(Boolean).join('\n\n');

  const defaultBudget = isChunkedBootstrapEnabled()
    ? getChunkedTotalBudget()
    : (Number(config.PROMPT_BUDGET) > 0 ? Number(config.PROMPT_BUDGET) : 180000);
  const budgetBytes = Number(input.budgetBytes) > 0 ? Number(input.budgetBytes) : defaultBudget;

  const built = session.buildBootstrap({
    system: stSysText,
    systemBlocks,
    floors: activeFloors,
    postBlocks: activePostBlocks,
    messages: list,
    state: stateText,
    chapters: chaptersText,
    timeline: timelineText,
    budgetBytes,
  });
  return parsePromptIntoBootstrapSections(built);
}

/**
 * D3: 逐片硬闸门校验
 * 确保单个预热分片或收尾片不超过 maxBytes（超出则对该片内的楼层做保头保尾截断，收尾片优先锁住 [POST] 与最新楼层）。
 */
function enforceChunkGate(chunkStr, maxBytes, isFinal = false) {
  const s = typeof chunkStr === 'string' ? chunkStr : String(chunkStr || '');
  const limit = Number(maxBytes) > 0 ? Math.floor(Number(maxBytes)) : getWarmChunkBytes();
  if (Buffer.byteLength(s, 'utf8') <= limit) {
    return s;
  }

  const parsed = parsePromptIntoBootstrapSections(s);
  const {
    sysSection,
    openingSection,
    stateSection,
    chaptersSection,
    timelineSection,
    includeEmptyTimeline,
    postSection,
    includeRecentHeader,
    trailingArchive,
  } = parsed;
  const recentItems = expandOversizedFloorItems(parsed.recentItems, 155000);

  const fixedParts = [];
  if (sysSection) fixedParts.push(sysSection);
  if (openingSection) fixedParts.push(openingSection);
  if (stateSection) fixedParts.push(stateSection);
  if (chaptersSection) fixedParts.push(chaptersSection);
  if (timelineSection || includeEmptyTimeline) fixedParts.push(timelineSection || '[TIMELINE]\n');

  const arch = trailingArchive || '';
  const postPart = postSection || (isFinal ? '[POST]\n' : '');

  if (recentItems.length > 0 || includeRecentHeader) {
    const baseParts = [...fixedParts];
    if (postPart) baseParts.push(postPart);
    const prefix = baseParts.length > 0 ? `${baseParts.join('\n\n')}\n\n[RECENT]\n` : '[RECENT]\n';
    const overhead = Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(arch, 'utf8');

    if (overhead < limit - 64 && recentItems.length > 0) {
      const availForRecent = limit - overhead;
      if (isFinal) {
        // 收尾片：优先从尾部保留最新楼层，必要时对单层做保头保尾截断
        const picked = [];
        let used = 0;
        for (let i = recentItems.length - 1; i >= 0; i--) {
          const item = recentItems[i];
          const itemBytes = Buffer.byteLength(item, 'utf8');
          const sep = picked.length > 0 ? 2 : 0;
          if (used + sep + itemBytes <= availForRecent) {
            picked.unshift(item);
            used += sep + itemBytes;
          } else if (picked.length === 0) {
            picked.unshift(capSingleFloorItem(item, availForRecent));
            break;
          } else {
            break;
          }
        }
        const candidate = `${prefix}${picked.join('\n\n')}${arch}`;
        if (Buffer.byteLength(candidate, 'utf8') <= limit) {
          return candidate;
        }
      } else {
        // 预热片：对该片内的各楼层按比例做保头保尾截断，不丢楼层
        const sepTotal = Math.max(0, (recentItems.length - 1) * 2);
        const perFloorCap = Math.max(64, Math.floor((availForRecent - sepTotal) / recentItems.length));
        const cappedList = recentItems.map((item) => capSingleFloorItem(item, perFloorCap));
        const candidate = `${prefix}${cappedList.join('\n\n')}${arch}`;
        if (Buffer.byteLength(candidate, 'utf8') <= limit) {
          return candidate;
        }
      }
    }
  }

  return capHeadTailUtf8(s, limit);
}

/**
 * F1 & F2: 逆向装箱分片算法 splitBootstrapForWarmup(sections, opts)
 * 1. 先对单条 >155KB 的无标记超大文本做 splitOversizedText(text, 155000) 软切分为多个伪楼层；
 * 2. 若总字节 <= WARM_CHUNK_BYTES → 返回 [整段]（1 片，不预热）；
 * 3. 从尾部倒着装：
 *    - 先构造收尾片（必须含 [POST] + 最新 1–2 层 + 用户输入），装到 WARM_CHUNK_BYTES 的 95%（≈157KB）为止；
 *    - 再往前一片一片装，每片装到 WARM_CHUNK_BYTES（165KB）；
 *    - 剩下的头部（[SYSTEM] + 早期楼层）作为第 1 片；
 *    - 任何一片都不允许小于 20KB（若某片过小，并入相邻片或从相邻片借楼层，除非会超限）。
 */
function splitBootstrapForWarmup(sections, opts = {}) {
  const chunkBytes = getWarmChunkBytes(opts && opts.warmChunkBytes);
  const maxChunks = getWarmMaxChunks(opts && opts.warmMaxChunks);
  const parsed = buildBootstrapSections(sections);

  const {
    sysSection,
    stateSection,
    chaptersSection,
    timelineSection,
    includeEmptyTimeline,
    postSection,
    includeRecentHeader,
    trailingArchive,
  } = parsed;

  let openingSection = parsed.openingSection;
  let openingFloors = expandOversizedFloorItems(parsed.openingFloors, 155000, 1);
  let recentItems = expandOversizedFloorItems(parsed.recentItems, 155000, openingFloors.length + 1);

  if (openingFloors.length > 1) {
    const joinedOpening = `[OPENING]\n${openingFloors.join('\n\n')}`;
    const hasPseudoOpening = openingFloors.slice(1).some((f) => /（第\s*\d+\s*楼续）/.test(f));
    if (hasPseudoOpening || Buffer.byteLength(joinedOpening, 'utf8') > 155000) {
      const movedToRecent = openingFloors.slice(1);
      openingFloors = [openingFloors[0]];
      openingSection = `[OPENING]\n${openingFloors[0]}`;
      recentItems = [...movedToRecent, ...recentItems];
    } else {
      openingSection = joinedOpening;
    }
  } else if (openingFloors.length === 1) {
    openingSection = `[OPENING]\n${openingFloors[0]}`;
  }

  const fullParts = [];
  if (sysSection) fullParts.push(sysSection);
  if (openingSection) fullParts.push(openingSection);
  if (stateSection) fullParts.push(stateSection);
  if (chaptersSection) fullParts.push(chaptersSection);
  if (timelineSection || includeEmptyTimeline) fullParts.push(timelineSection || '[TIMELINE]\n');
  if (postSection) fullParts.push(postSection);
  if (includeRecentHeader || recentItems.length > 0) {
    fullParts.push(`[RECENT]\n${recentItems.join('\n\n')}`);
  }
  const fullPrompt = fullParts.join('\n\n') + (trailingArchive || '');
  const totalBytes = Buffer.byteLength(fullPrompt, 'utf8');

  if (totalBytes <= chunkBytes) {
    return [fullPrompt];
  }

  // Reserve space for the warmup instruction prefix so both raw chunk and prefixed prompt are <= WARM_CHUNK_BYTES
  const warmPackLimit = chunkBytes > 512 ? (chunkBytes - 160) : chunkBytes;
  const recentHeaderBytes = Buffer.byteLength('[RECENT]\n', 'utf8');
  const singleFloorMax = Math.max(64, warmPackLimit - recentHeaderBytes);
  const softSplitMax = Math.min(155000, singleFloorMax);

  const expandedRecent = expandOversizedFloorItems(recentItems, softSplitMax, openingFloors.length + 1);
  const expandedOpening = expandOversizedFloorItems(openingFloors, softSplitMax, 1);

  const cappedRecent = expandedRecent.map((item) => capSingleFloorItem(item, singleFloorMax));
  const cappedOpeningFloors = expandedOpening.map((item) => capSingleFloorItem(item, singleFloorMax));

  let finalPost = postSection || '[POST]\n';
  const maxPostBytes = Math.max(64, Math.floor(chunkBytes * 0.5));
  if (Buffer.byteLength(finalPost, 'utf8') > maxPostBytes) {
    const rawPostBody = finalPost.replace(/^\[POST\]\n?/, '');
    finalPost = `[POST]\n${capHeadTailUtf8(rawPostBody, Math.max(32, maxPostBytes - 8))}`;
  }

  let tailRecent = [];
  let earlierRecent = [];
  let minTailFloors = 1;

  if (cappedRecent.length >= 2) {
    let pickedK = 1;
    const maxK = Math.min(2, cappedRecent.length);
    for (let k = maxK; k >= 1; k--) {
      const candidateTail = cappedRecent.slice(cappedRecent.length - k);
      const candidateFinal = `${finalPost}\n\n[RECENT]\n${candidateTail.join('\n\n')}${trailingArchive || ''}`;
      if (Buffer.byteLength(candidateFinal, 'utf8') <= chunkBytes) {
        pickedK = k;
        break;
      }
    }
    minTailFloors = pickedK;
    tailRecent = cappedRecent.slice(cappedRecent.length - pickedK);
    earlierRecent = cappedRecent.slice(0, cappedRecent.length - pickedK);
  } else if (cappedRecent.length === 1) {
    earlierRecent = [];
    if (cappedOpeningFloors.length >= 2) {
      const candidate2 = [cappedOpeningFloors[cappedOpeningFloors.length - 1], cappedRecent[0]];
      const candidateFinal2 = `${finalPost}\n\n[RECENT]\n${candidate2.join('\n\n')}${trailingArchive || ''}`;
      tailRecent = Buffer.byteLength(candidateFinal2, 'utf8') <= chunkBytes ? candidate2 : [cappedRecent[0]];
    } else {
      tailRecent = [cappedRecent[0]];
    }
    minTailFloors = 1;
  } else {
    earlierRecent = [];
    if (cappedOpeningFloors.length >= 2) {
      const candidate2 = cappedOpeningFloors.slice(-2);
      const candidateFinal2 = `${finalPost}\n\n[RECENT]\n${candidate2.join('\n\n')}${trailingArchive || ''}`;
      tailRecent = Buffer.byteLength(candidateFinal2, 'utf8') <= chunkBytes
        ? candidate2
        : cappedOpeningFloors.slice(-1);
    } else if (cappedOpeningFloors.length === 1) {
      tailRecent = [cappedOpeningFloors[0]];
    }
    minTailFloors = 1;
  }

  function splitFixedSectionUnits(tag, rawSection) {
    if (!rawSection) return [];
    if (Buffer.byteLength(rawSection, 'utf8') <= warmPackLimit) return [rawSection];
    const tagHeader = `[${tag}]\n`;
    const tagHeaderBytes = Buffer.byteLength(tagHeader, 'utf8');
    const unitBodyMax = Math.max(64, warmPackLimit - tagHeaderBytes);

    if (tag === 'OPENING' && cappedOpeningFloors.length > 1) {
      return cappedOpeningFloors.map((f) => `${tagHeader}${capSingleFloorItem(f, unitBodyMax)}`);
    }

    const body = rawSection.startsWith(tagHeader) ? rawSection.slice(tagHeader.length) : rawSection;
    if (tag === 'TIMELINE' || tag === 'CHAPTERS' || tag === 'SYSTEM') {
      const segRe = /(?=(?:<!--\s*floors?:\s*\d+(?:\s*-\s*\d+)?\s*-->))/i;
      const parts = body.split(segRe).map((s) => s.trim()).filter(Boolean);
      const blocks = parts.length > 1 ? parts : splitOversizedText(body, Math.min(155000, unitBodyMax));
      if (blocks.length > 1) {
        const units = [];
        let cur = '';
        for (const rawBlock of blocks) {
          const blk = Buffer.byteLength(rawBlock, 'utf8') > unitBodyMax
            ? capHeadTailUtf8(rawBlock, unitBodyMax)
            : rawBlock;
          const cand = cur ? `${cur}\n\n${blk}` : blk;
          if (Buffer.byteLength(tagHeader + cand, 'utf8') <= warmPackLimit) {
            cur = cand;
          } else {
            if (cur) units.push(tagHeader + cur);
            cur = blk;
          }
        }
        if (cur) units.push(tagHeader + cur);
        if (units.length > 0) return units;
      }
    }

    return [`${tagHeader}${capHeadTailUtf8(body, unitBodyMax)}`];
  }

  const fixedUnits = [
    ...splitFixedSectionUnits('SYSTEM', sysSection),
    ...splitFixedSectionUnits('OPENING', openingSection),
    ...splitFixedSectionUnits('STATE', stateSection),
    ...splitFixedSectionUnits('CHAPTERS', chaptersSection),
    ...splitFixedSectionUnits('TIMELINE', timelineSection || (includeEmptyTimeline ? '[TIMELINE]\n' : '')),
  ];

  // F1-1: 先构造收尾片（含 [POST] + 最新 1-2 层 + 用户输入），从尾部倒着装到 WARM_CHUNK_BYTES 的 95%（≈157KB）为止
  const finalTargetBytes = Math.floor(chunkBytes * 0.95);
  const minChunkBytes = Math.min(20000, Math.floor(chunkBytes * 0.5));

  const formatFinalFromTail = (tailArr) =>
    `${finalPost}\n\n[RECENT]\n${tailArr.join('\n\n')}${trailingArchive || ''}`;

  while (earlierRecent.length > 0) {
    const curFinalBytes = Buffer.byteLength(formatFinalFromTail(tailRecent), 'utf8');
    if (curFinalBytes >= finalTargetBytes) break;

    const candidateFloor = earlierRecent[earlierRecent.length - 1];
    const nextTail = [candidateFloor, ...tailRecent];
    const nextFinalBytes = Buffer.byteLength(formatFinalFromTail(nextTail), 'utf8');
    if (nextFinalBytes <= finalTargetBytes || (curFinalBytes < minChunkBytes && nextFinalBytes <= chunkBytes)) {
      tailRecent.unshift(earlierRecent.pop());
    } else {
      break;
    }
  }

  const formatWarmupSlice = (slice) => {
    if (!slice || slice.length === 0) return '';
    const fixed = [];
    const recent = [];
    for (const item of slice) {
      if (item.kind === 'recent') recent.push(item.text);
      else fixed.push(item.text);
    }
    const parts = [...fixed];
    if (recent.length > 0) {
      parts.push(`[RECENT]\n${recent.join('\n\n')}`);
    }
    return parts.join('\n\n');
  };

  const sliceByteLen = (slice) => Buffer.byteLength(formatWarmupSlice(slice), 'utf8');

  // F1-2 & F1-3: 再从后往前一片一片装，每片装到 warmPackLimit（<= 165KB），剩下的头部（[SYSTEM] + 早期楼层）作为第 1 片
  const warmupItems = [
    ...fixedUnits.map((text) => ({ kind: 'fixed', text })),
    ...earlierRecent.map((text) => ({ kind: 'recent', text })),
  ];

  const warmupSlices = [];
  let endIdx = warmupItems.length;
  while (endIdx > 0) {
    let startIdx = endIdx - 1;
    while (startIdx > 0) {
      const candidateSlice = warmupItems.slice(startIdx - 1, endIdx);
      if (sliceByteLen(candidateSlice) <= warmPackLimit) {
        startIdx--;
      } else {
        break;
      }
    }
    warmupSlices.unshift(warmupItems.slice(startIdx, endIdx));
    endIdx = startIdx;
  }

  // F1-4: 任何一片都不允许小于 20KB（若某片过小，并入相邻片；若并入会超限则从相邻片借楼层使其 >= 20KB）
  let changed = true;
  let guard = 0;
  while (changed && guard < 30) {
    changed = false;
    guard++;
    for (let i = 0; i < warmupSlices.length; i++) {
      const curBytes = sliceByteLen(warmupSlices[i]);
      if (curBytes >= minChunkBytes) continue;

      // 优先尝试与相邻预热片合并（不超限则直接并入）
      if (i + 1 < warmupSlices.length) {
        const mergedNext = [...warmupSlices[i], ...warmupSlices[i + 1]];
        if (sliceByteLen(mergedNext) <= warmPackLimit) {
          warmupSlices.splice(i, 2, mergedNext);
          changed = true;
          break;
        }
      }
      if (i - 1 >= 0) {
        const mergedPrev = [...warmupSlices[i - 1], ...warmupSlices[i]];
        if (sliceByteLen(mergedPrev) <= warmPackLimit) {
          warmupSlices.splice(i - 1, 2, mergedPrev);
          changed = true;
          break;
        }
      }

      // 若合并会超限，从相邻预热片借出边界单元使当前片 >= 20KB（同时保证相邻片仍 >= 20KB）
      if (i + 1 < warmupSlices.length) {
        while (sliceByteLen(warmupSlices[i]) < minChunkBytes && warmupSlices[i + 1].length > 1) {
          const nextItem = warmupSlices[i + 1][0];
          const candCur = [...warmupSlices[i], nextItem];
          const candNext = warmupSlices[i + 1].slice(1);
          if (sliceByteLen(candCur) <= warmPackLimit && sliceByteLen(candNext) >= minChunkBytes) {
            warmupSlices[i].push(warmupSlices[i + 1].shift());
            changed = true;
          } else {
            break;
          }
        }
        if (changed) break;
      }
      if (i - 1 >= 0) {
        while (sliceByteLen(warmupSlices[i]) < minChunkBytes && warmupSlices[i - 1].length > 1) {
          const prevItem = warmupSlices[i - 1][warmupSlices[i - 1].length - 1];
          const candCur = [prevItem, ...warmupSlices[i]];
          const candPrev = warmupSlices[i - 1].slice(0, -1);
          if (sliceByteLen(candCur) <= warmPackLimit && sliceByteLen(candPrev) >= minChunkBytes) {
            warmupSlices[i].unshift(warmupSlices[i - 1].pop());
            changed = true;
          } else {
            break;
          }
        }
        if (changed) break;
      }
    }
  }

  // 若仅剩 1 个预热片且仍 < 20KB，尝试从收尾片头部退回若干楼层给第 1 片（保证收尾片仍保留最新 1-2 层且 >= 20KB）
  if (warmupSlices.length === 1 && sliceByteLen(warmupSlices[0]) < minChunkBytes) {
    while (sliceByteLen(warmupSlices[0]) < minChunkBytes && tailRecent.length > minTailFloors) {
      const borrowFloor = tailRecent[0];
      const candWarm = [...warmupSlices[0], { kind: 'recent', text: borrowFloor }];
      const candTail = tailRecent.slice(1);
      const candFinalBytes = Buffer.byteLength(formatFinalFromTail(candTail), 'utf8');
      if (sliceByteLen(candWarm) <= warmPackLimit && candFinalBytes >= minChunkBytes) {
        warmupSlices[0].push({ kind: 'recent', text: tailRecent.shift() });
      } else {
        break;
      }
    }
  }

  // 若收尾片本身 < 20KB 且最后一片预热片尾部有 recent 楼层可借，向收尾片补足到 >= 20KB
  if (warmupSlices.length > 0 && Buffer.byteLength(formatFinalFromTail(tailRecent), 'utf8') < minChunkBytes) {
    const lastWarm = warmupSlices[warmupSlices.length - 1];
    while (
      Buffer.byteLength(formatFinalFromTail(tailRecent), 'utf8') < minChunkBytes &&
      lastWarm.length > 1 &&
      lastWarm[lastWarm.length - 1].kind === 'recent'
    ) {
      const candidateItem = lastWarm[lastWarm.length - 1];
      const candTail = [candidateItem.text, ...tailRecent];
      const candFinalBytes = Buffer.byteLength(formatFinalFromTail(candTail), 'utf8');
      const candWarmSlice = lastWarm.slice(0, -1);
      if (candFinalBytes <= chunkBytes && sliceByteLen(candWarmSlice) >= minChunkBytes) {
        tailRecent.unshift(lastWarm.pop().text);
      } else {
        break;
      }
    }
  }

  let finalChunk = formatFinalFromTail(tailRecent);
  if (Buffer.byteLength(finalChunk, 'utf8') > chunkBytes) {
    finalChunk = enforceChunkGate(finalChunk, chunkBytes, true);
  }

  const warmupChunks = warmupSlices
    .map((slice) => formatWarmupSlice(slice))
    .filter(Boolean)
    .map((chunkStr) => enforceChunkGate(chunkStr, warmPackLimit, false));

  let allChunks = [...warmupChunks, finalChunk];
  if (allChunks.length > maxChunks) {
    const mergedHardCap = Math.min(184999, session.getHardGate());
    if (maxChunks <= 1) {
      allChunks = [enforceChunkGate(allChunks.join('\n\n'), mergedHardCap, true)];
    } else {
      const headChunks = allChunks.slice(0, maxChunks - 1);
      const tailToMerge = allChunks.slice(maxChunks - 1);
      const mergedTail = enforceChunkGate(tailToMerge.join('\n\n'), mergedHardCap, true);
      allChunks = [...headChunks, mergedTail];
    }
  }

  return allChunks;
}

/* ---- Dynamic models list (10-minute cache) ---- */
let modelsCacheAt = 0;
let modelsInFlight = false;

function refreshModels() {
  const now = Date.now();
  if (modelsInFlight) return;
  if (queue && ((queue.running && queue.running.size > 0) || queue.size > 0 || queue._reserved > 0)) return;
  if (now - modelsCacheAt < 10 * 60 * 1000 && MODELS.length > 0 && modelsCacheAt > 0) {
    return;
  }
  modelsInFlight = true;
  let activeChild = null;
  queue.run('__refreshModels', (ctx) => new Promise((resolve) => {
    if (ctx && ctx.aborted) return resolve();
    const spec = binSpec(process.env.AGY_BIN || config.AGY_BIN, ['models']);
    const modelEnv = { ...process.env, HOME: config.HOME };
    delete modelEnv.ELECTRON_RUN_AS_NODE;
    activeChild = execFile(
      spec.cmd,
      spec.args,
      { cwd: ensureSysWorkspace(), env: modelEnv, timeout: 60000 },
      (err, stdout) => {
        if (err) {
          log('refreshModels failed:', String(err.message).slice(0, 120));
          return resolve();
        }
        const ids = [];
        const names = {};
        for (const line of String(stdout).split('\n')) {
          const m = line.match(/^([a-z0-9][a-z0-9.\-]+)\t(.+)$/);
          if (m) {
            ids.push(m[1]);
            names[m[1]] = m[2].trim();
          }
        }
        if (ids.length) {
          MODELS = ids;
          MODEL_NAMES = names;
          modelsCacheAt = Date.now();
          log('models refreshed:', ids.length);
        }
        resolve();
      }
    );
    if (ctx && typeof ctx.register === 'function' && activeChild) {
      ctx.register(activeChild);
    }
  }), {
    priority: 'low',
    onPreempt: () => {
      if (activeChild) terminateChild(activeChild);
    },
  }).catch(() => {}).finally(() => {
    modelsInFlight = false;
  });
}
refreshModels();
setInterval(refreshModels, 10 * 60 * 1000).unref();

/* ---- Background compact debounce timers ---- */
const compactTimers = new Map();

function cancelCompactTimers() {
  for (const timer of compactTimers.values()) {
    clearTimeout(timer);
  }
  compactTimers.clear();
}

/* ---- Account management & cooldowns ---- */
const accountCooldowns = new Map();
const QUOTA_ERR_RE = /RESOURCE_EXHAUSTED|\b429\b|quota|Individual quota reached/i;

function getConfiguredAccounts() {
  if (typeof process.env.AGY_ACCOUNTS === 'string' && process.env.AGY_ACCOUNTS.trim()) {
    const parsed = typeof config.parseAccounts === 'function'
      ? config.parseAccounts(process.env.AGY_ACCOUNTS)
      : null;
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  }
  if (Array.isArray(config.ACCOUNTS) && config.ACCOUNTS.length > 0) {
    return config.ACCOUNTS;
  }
  return [
    { name: 'main', home: '/home/novel' },
    { name: 'alt',  home: '/home/agy-alt' },
  ];
}

function getCooldownDurationMs() {
  if (process.env.AGY_ACCOUNT_COOLDOWN_MS !== undefined && process.env.AGY_ACCOUNT_COOLDOWN_MS !== '') {
    const n = Number(process.env.AGY_ACCOUNT_COOLDOWN_MS);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const cfg = Number(config.ACCOUNT_COOLDOWN_MS);
  return Number.isFinite(cfg) && cfg >= 0 ? cfg : 10 * 60 * 1000;
}

function getAccountCooldownInfo(name, now = Date.now()) {
  if (!name || !accountCooldowns.has(name)) return null;
  const raw = accountCooldowns.get(name);
  const duration = getCooldownDurationMs();
  let at = 0;
  let until = 0;
  let resetAt = null;
  if (typeof raw === 'number') {
    if (raw > now) {
      at = raw - duration;
      until = raw;
    } else {
      at = raw;
      until = raw + duration;
    }
  } else if (raw && typeof raw === 'object') {
    at = typeof raw.at === 'number' ? raw.at : now;
    until = typeof raw.until === 'number' ? raw.until : (at + duration);
    resetAt = raw.resetAt || null;
  }
  if (now >= until) {
    accountCooldowns.delete(name);
    return null;
  }
  return { at, until, resetAt: resetAt || new Date(until).toISOString() };
}

function isAccountCoolingDown(name, now = Date.now()) {
  return Boolean(getAccountCooldownInfo(name, now));
}

function extractResetTimeFromText(text) {
  const s = String(text || '');
  if (!s) return null;
  const iso = /\b(20\d\d-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)?)\b/.exec(s);
  if (iso) return iso[1];
  const afterRe = /(?:resets?\s+(?:at|in)|try\s+again\s+(?:at|in|after)|retry\s+after)[:\s]+([^\n.,;]+)/i.exec(s);
  if (afterRe) return afterRe[1].trim();
  return null;
}

function markAccountCooldown(name, errText = '', now = Date.now()) {
  const duration = getCooldownDurationMs();
  const until = now + duration;
  const parsedReset = extractResetTimeFromText(errText);
  const resetAt = parsedReset || new Date(until).toISOString();
  accountCooldowns.set(name, { at: now, until, resetAt });
  return { at: now, until, resetAt };
}

function buildAllAccountsExhaustedMessage(accounts, now = Date.now()) {
  const list = Array.isArray(accounts) && accounts.length > 0 ? accounts : getConfiguredAccounts();
  let earliestUntil = Infinity;
  let earliestResetAt = null;
  for (const acc of list) {
    const info = getAccountCooldownInfo(acc && acc.name, now);
    if (info && info.until < earliestUntil) {
      earliestUntil = info.until;
      earliestResetAt = info.resetAt || new Date(info.until).toISOString();
    }
  }
  if (earliestResetAt) {
    return `所有账号额度耗尽（最早重置时间：${earliestResetAt}）`;
  }
  return '所有账号额度耗尽';
}

function isQuotaError(errText, exitCode = null) {
  if (exitCode === 429) return true;
  const s = String(errText || '');
  return QUOTA_ERR_RE.test(s);
}

/* ---- Quota inquiry (60-second cache) ---- */
let quotaCache = { at: 0, text: '', parsed: [], accounts: [], accountsKey: '' };
let quotaInFlight = null;

function parseAccountQuotaOutput(accName, out) {
  const text = String(out || '');
  const parsed = [];
  for (const line of text.split('\n')) {
    const parts = line.split('\t').map((s) => s.trim());
    if (parts.length >= 3 && /%$/.test(parts[2])) {
      parsed.push({
        pool: parts[0],
        kind: parts[1],
        remaining: parts[2],
        resets_at: parts[3] || null,
      });
    }
  }

  let weekly = null;
  let fiveHour = null;
  let resetAt = null;

  for (const item of parsed) {
    const kindStr = `${item.pool || ''} ${item.kind || ''}`;
    if (weekly === null && (/week/i.test(kindStr) || kindStr.includes('周'))) {
      weekly = item.remaining;
      if (item.resets_at && !resetAt) resetAt = item.resets_at;
    } else if (fiveHour === null && (/5\s*h|five[-_\s]*hour|hour|5小时/i.test(kindStr))) {
      fiveHour = item.remaining;
      if (item.resets_at) resetAt = item.resets_at;
    }
  }

  if (weekly === null && parsed[0]) {
    weekly = parsed[0].remaining;
  }
  if (fiveHour === null && parsed[1]) {
    fiveHour = parsed[1].remaining;
  }
  if (!resetAt) {
    const withReset = parsed.find((p) => p && p.resets_at);
    if (withReset) resetAt = withReset.resets_at;
  }

  if (weekly === null) {
    const m = /(?:weekly|周)\s*[:=]?\s*(\d{1,3}%)/i.exec(text);
    if (m) weekly = m[1];
  }
  if (fiveHour === null) {
    const m = /(?:5\s*h|5-hour|fiveHour|five_hour)\s*[:=]?\s*(\d{1,3}%)/i.exec(text);
    if (m) fiveHour = m[1];
  }
  if (!resetAt) {
    resetAt = extractResetTimeFromText(text);
  }

  return {
    parsed,
    summary: {
      name: accName,
      weekly,
      fiveHour,
      resetAt: resetAt || null,
    },
  };
}

function runSingleAccountQuota(acc) {
  let quotaChild = null;
  const accName = (acc && acc.name) ? String(acc.name) : 'main';
  const accHome = (acc && acc.home) ? String(acc.home) : config.HOME;
  return queue.run(`__quota:${accName}`, (ctx) => new Promise((resolve) => {
    if (ctx && ctx.aborted) {
      return resolve({
        name: accName,
        text: 'quota aborted',
        parsed: [],
        summary: { name: accName, weekly: null, fiveHour: null, resetAt: null },
      });
    }
    const spec = binSpec(process.env.AGY_BIN || config.AGY_BIN, ['-p', '/quota', '--print-timeout', '45s']);
    const quotaEnv = { ...process.env, HOME: accHome };
    delete quotaEnv.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: ensureSysWorkspace(),
        env: quotaEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({
        name: accName,
        text: String(e.message),
        parsed: [],
        summary: { name: accName, weekly: null, fiveHour: null, resetAt: null },
      });
    }
    quotaChild = child;
    if (ctx && typeof ctx.register === 'function') {
      ctx.register(child);
    }
    const outChunks = [];
    const errChunks = [];
    child.stdout.on('data', (c) => {
      outChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
    });
    child.stderr.on('data', (c) => {
      errChunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
    });
    const timer = setTimeout(() => {
      terminateChild(child);
    }, 50000);
    child.on('close', () => {
      clearTimeout(timer);
      const out = Buffer.concat(outChunks).toString('utf8');
      const err = Buffer.concat(errChunks).toString('utf8');
      const { parsed, summary } = parseAccountQuotaOutput(accName, out || err);
      resolve({
        name: accName,
        text: (out || err).trim(),
        parsed,
        summary,
      });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        name: accName,
        text: String(e.message),
        parsed: [],
        summary: { name: accName, weekly: null, fiveHour: null, resetAt: null },
      });
    });
  }), {
    priority: 'low',
    onPreempt: () => {
      if (quotaChild) terminateChild(quotaChild);
    },
  }).then((res) => res || {
    name: accName,
    text: 'quota preempted',
    parsed: [],
    summary: { name: accName, weekly: null, fiveHour: null, resetAt: null },
  }).catch((e) => ({
    name: accName,
    text: String(e && e.message ? e.message : e),
    parsed: [],
    summary: { name: accName, weekly: null, fiveHour: null, resetAt: null },
  }));
}

function runQuota() {
  const now = Date.now();
  const configured = getConfiguredAccounts();
  const accountsKey = configured.map((a) => `${a.name}=${a.home}`).join(',');
  if (
    now - quotaCache.at < 60000 &&
    quotaCache.accountsKey === accountsKey &&
    quotaCache.parsed.length > 0 &&
    quotaCache.accounts.length === configured.length
  ) {
    return Promise.resolve(quotaCache);
  }
  if (quotaInFlight) return quotaInFlight;
  quotaInFlight = (async () => {
    const accountResults = [];
    for (const acc of configured) {
      const r = await runSingleAccountQuota(acc);
      accountResults.push(r);
    }
    const primary = accountResults[0] || { text: '', parsed: [] };
    const accounts = accountResults.map((r) => r.summary);
    const rawTexts = accountResults.map((r) => `[${r.name}]\n${r.text}`).join('\n\n').trim();
    const resObj = {
      at: primary.parsed.length > 0 ? Date.now() : 0,
      text: primary.text || rawTexts,
      parsed: primary.parsed,
      accounts,
      accountsKey,
    };
    if (primary.parsed.length > 0) {
      quotaCache = resObj;
    }
    return resObj;
  })().finally(() => {
    quotaInFlight = null;
  });
  return quotaInFlight;
}

/* ---- Effort & fallback helpers (F3: 429 vs 503 separation) ---- */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const RETRYABLE_ERR = /\b503\b|UNAVAILABLE|capacity|overloaded|high traffic/i;

function mapEffort(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  if (EFFORTS.includes(s)) return s;
  if (s === 'minimal') return 'low';
  if (s === 'medium' || s === 'med') return 'medium';
  return '';
}

function isCapacityError(errText, exitCode = null) {
  if (isQuotaError(errText, exitCode)) return false;
  if (exitCode === 503) return true;
  const msg = String(errText || '');
  return RETRYABLE_ERR.test(msg);
}

function pickFallback(model, errText, tried = null) {
  const msg = String(errText || '');
  if (isQuotaError(msg)) return '';
  if (!RETRYABLE_ERR.test(msg)) return '';
  return (config.FALLBACK_MODELS || []).find((m) => m !== model && (!tried || !tried.has(m))) || '';
}

function sseChunk(res, model, delta, finish) {
  if (res.writableEnded || res.destroyed) return;
  const payload = {
    id: 'chatcmpl-' + crypto.randomBytes(6).toString('hex'),
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish || null }],
  };
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function createOutputter(res, { stream = true, model = config.DEFAULT_MODEL } = {}) {
  const isStream = stream !== false && stream !== 'false';
  let currentModel = model || config.DEFAULT_MODEL;
  let headersSent = false;
  let finished = false;
  let content = '';

  function ensureSseHeaders() {
    if (!isStream || headersSent || res.headersSent || res.writableEnded || res.destroyed) return;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    headersSent = true;
    sseChunk(res, currentModel, { role: 'assistant', content: '' }, null);
  }

  return {
    isStream,
    get headersSent() {
      return headersSent || res.headersSent;
    },
    get content() {
      return content;
    },
    setModel(m) {
      if (m) currentModel = m;
    },
    start() {
      if (isStream) {
        ensureSseHeaders();
      }
    },
    reset() {
      if (!headersSent && !res.headersSent) {
        content = '';
      }
    },
    delta(text) {
      if (!text || finished || res.writableEnded || res.destroyed) return;
      const str = String(text);
      if (!str) return;
      content += str;
      if (isStream) {
        ensureSseHeaders();
        sseChunk(res, currentModel, { content: str }, null);
      }
    },
    finish(usage) {
      if (finished || res.writableEnded || res.destroyed) return;
      finished = true;
      if (isStream) {
        ensureSseHeaders();
        sseChunk(res, currentModel, {}, 'stop');
        if (!res.writableEnded && !res.destroyed) {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } else {
        const payload = {
          id: 'chatcmpl-' + crypto.randomBytes(6).toString('hex'),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: currentModel,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content },
              finish_reason: 'stop',
            },
          ],
          usage: (usage && typeof usage === 'object')
            ? usage
            : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };
        if (!res.headersSent) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          headersSent = true;
        }
        res.end(JSON.stringify(payload));
      }
    },
    error(msg, statusCode = 500) {
      if (finished || res.writableEnded || res.destroyed) return;
      finished = true;
      const errText = String(msg || 'unknown error');
      if (!headersSent && !res.headersSent) {
        const code = (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) ? statusCode : 500;
        const headers = { 'content-type': 'application/json; charset=utf-8' };
        if (code === 429) {
          headers['Retry-After'] = '3';
        }
        res.writeHead(code, headers);
        headersSent = true;
        res.end(JSON.stringify({ error: { message: errText } }));
        return;
      }
      if (isStream && !res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}

/* ---- H1: :stateless channel & heuristic sniffing ---- */
const AUX_STATELESS_RE = /generate a title|summarize|translate|write a summary|翻译|总结|概括|生成标题/i;

function parseModelForStateless(rawModel) {
  const s = (typeof rawModel === 'string' && rawModel.trim())
    ? rawModel.trim()
    : config.DEFAULT_MODEL;
  if (/:stateless$/i.test(s)) {
    const stripped = s.replace(/:stateless$/i, '').trim() || config.DEFAULT_MODEL;
    return { model: stripped, isStatelessSuffix: true };
  }
  return { model: s, isStatelessSuffix: false };
}

function isHeuristicStatelessRequest(body, messages, parsedParts = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const sysText = typeof parsedParts.sysText === 'string'
    ? parsedParts.sysText
    : list
        .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
        .map((m) => textOf(m.content))
        .filter(Boolean)
        .join('\n\n');
  const systemBlocks = Array.isArray(parsedParts.systemBlocks) ? parsedParts.systemBlocks : [];
  const postBlocks = Array.isArray(parsedParts.postBlocks) ? parsedParts.postBlocks : [];
  const floors = Array.isArray(parsedParts.floors) ? parsedParts.floors : null;

  const nonSysMsgs = list.filter((m) => m && m.role !== 'system' && m.role !== 'developer');
  const nonSysCount = nonSysMsgs.length;
  const floorCount = floors ? floors.length : nonSysCount;

  const rawSysBytes = Buffer.byteLength(sysText, 'utf8');
  const presetBytes = [...systemBlocks, ...postBlocks].reduce(
    (acc, b) => acc + Buffer.byteLength(textOf(b), 'utf8'),
    0
  );
  // 若请求未含（第N楼）标记，>= 4KB 的大预设块会留在 nonSysMsgs 中，必须计入以防误伤正常 RP
  const unmarkedPresetBytes = nonSysMsgs.reduce((acc, m) => {
    const b = Buffer.byteLength(textOf(m && m.content), 'utf8');
    return b >= 4096 ? acc + b : acc;
  }, 0);
  const effectiveSysBytes = rawSysBytes + presetBytes + unmarkedPresetBytes;

  // 条件 1：只含 1-2 条非 system 消息且 system < 2KB，且内容匹配辅助指令正则
  if (
    nonSysCount >= 1 &&
    nonSysCount <= 2 &&
    floorCount <= 2 &&
    effectiveSysBytes < 2048
  ) {
    const combinedContent = [sysText, ...nonSysMsgs.map((m) => textOf(m.content))].filter(Boolean).join('\n');
    if (AUX_STATELESS_RE.test(combinedContent)) {
      return true;
    }
  }

  // 条件 2：或 max_tokens <= 16 且非 system 消息 <= 1（同样排除含 >=4KB 预设块的 RP 请求）
  const rawMaxTokens = body && body.max_tokens !== undefined && body.max_tokens !== null && body.max_tokens !== ''
    ? Number(body.max_tokens)
    : NaN;
  if (
    Number.isFinite(rawMaxTokens) &&
    rawMaxTokens > 0 &&
    rawMaxTokens <= 16 &&
    nonSysCount <= 1 &&
    floorCount <= 1 &&
    (presetBytes + unmarkedPresetBytes) < 4096 &&
    rawSysBytes < 4096
  ) {
    return true;
  }

  return false;
}

/**
 * H1.1: 单发无状态 prompt 构造
 * - 不注入 <ta_record> 归档指令
 * - 只发 [SYSTEM] + 最近 6 层 + 当前输入（<= PROMPT_BUDGET）
 */
function buildStatelessChannelPrompt(input = {}) {
  const isArr = Array.isArray(input);
  const messages = isArr ? input : (Array.isArray(input.messages) ? input.messages : []);
  const rawBudget = (!isArr && Number(input.budgetBytes) > 0) ? Number(input.budgetBytes) : config.PROMPT_BUDGET;
  const budget = (process.env.AGY_HARD_GATE && rawBudget <= config.CLI_PROMPT_HARD_CAP)
    ? Math.min(rawBudget, session.getHardGate())
    : rawBudget;

  let sysText = (!isArr && typeof input.sysText === 'string')
    ? input.sysText
    : ((!isArr && typeof input.system === 'string') ? input.system : '');
  if (!sysText && messages.length > 0) {
    sysText = messages
      .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
  }

  let systemBlocks = (!isArr && Array.isArray(input.systemBlocks)) ? input.systemBlocks : null;
  let floors = (!isArr && Array.isArray(input.floors)) ? input.floors : null;
  let postBlocks = (!isArr && Array.isArray(input.postBlocks)) ? input.postBlocks : null;

  if (!floors || !systemBlocks || !postBlocks) {
    const split = session.splitFloors(messages);
    if (!systemBlocks) systemBlocks = split.systemBlocks;
    if (!floors) floors = split.floors;
    if (!postBlocks) postBlocks = split.postBlocks;
  }

  let activeFloors = floors;
  let activePostBlocks = postBlocks;
  if (activeFloors.length === 0 && activePostBlocks.length > 0) {
    activeFloors = activePostBlocks.map((b, idx) => ({ role: 'user', content: textOf(b), floorNo: idx + 1 }));
    activePostBlocks = [];
  }
  if (activeFloors.length === 0 && messages.length > 0) {
    activeFloors = messages
      .filter((m) => m && m.role !== 'system' && m.role !== 'developer')
      .map((m, idx) => ({
        role: m.role || 'user',
        ...(m.name != null ? { name: m.name } : {}),
        content: textOf(m.content),
        floorNo: idx + 1,
      }));
  }

  const sysBlockTexts = systemBlocks.map((b) => textOf(b).trim()).filter(Boolean);
  const fullSys = [String(sysText || '').trim(), ...sysBlockTexts].filter(Boolean).join('\n\n');
  const sysSection = `[SYSTEM]\n${fullSys}`;

  if (session.isStrictSystem() && Buffer.byteLength(sysSection, 'utf8') > Math.floor(budget * 0.6)) {
    throw new Error('system_budget_exceeded: [SYSTEM] ' + Buffer.byteLength(sysSection, 'utf8') + 'B > ' + Math.floor(budget * 0.6) + 'B');
  }

  // 最近 6 层 + 当前输入（最多 7 条 floor）
  const tailWindow = activeFloors.length <= 7
    ? activeFloors.slice()
    : [...activeFloors.slice(0, -1).slice(-6), activeFloors[activeFloors.length - 1]];
  const startOffset = Math.max(0, activeFloors.length - tailWindow.length);
  const formattedFloors = tailWindow.map((m, i) => {
    const idx = (m && typeof m.floorNo === 'number') ? m.floorNo : (startOffset + i + 1);
    return session.formatMessage(m, idx, session.RECENT_FLOOR_MAX_BYTES);
  });

  const postText = activePostBlocks.map((b) => textOf(b).trim()).filter(Boolean).join('\n\n');
  const postSection = postText ? `[POST]\n${postText}` : '';

  const assemble = (sysSec, pSec, floorItems) => {
    const sections = [sysSec];
    if (pSec) sections.push(pSec);
    sections.push(`[RECENT]\n${floorItems.join('\n\n')}`);
    return sections.join('\n\n');
  };

  const fullPrompt = assemble(sysSection, postSection, formattedFloors);
  if (Buffer.byteLength(fullPrompt, 'utf8') <= budget) {
    return fullPrompt;
  }

  // 预算裁剪：优先锁定当前输入与 [SYSTEM]，再从后往前装最近 6 层
  const currentInputItem = formattedFloors.length > 0 ? formattedFloors[formattedFloors.length - 1] : '';
  const historyItems = formattedFloors.length > 1 ? formattedFloors.slice(0, -1) : [];
  const picked = currentInputItem ? [currentInputItem] : [];

  for (let i = historyItems.length - 1; i >= 0; i--) {
    const cand = [historyItems[i], ...picked];
    if (Buffer.byteLength(assemble(sysSection, postSection, cand), 'utf8') <= budget) {
      picked.unshift(historyItems[i]);
    } else {
      break;
    }
  }

  let candidate = assemble(sysSection, postSection, picked);
  if (Buffer.byteLength(candidate, 'utf8') <= budget) {
    return candidate;
  }

  // 若丢掉 postSection 后可放进预算
  if (postSection) {
    candidate = assemble(sysSection, '', picked);
    if (Buffer.byteLength(candidate, 'utf8') <= budget) {
      return candidate;
    }
  }

  // 若仍超预算，对 [SYSTEM] 与当前输入做保头保尾截断
  const sysCap = Math.max(256, Math.floor(budget * 0.45));
  const cappedSysSection = Buffer.byteLength(sysSection, 'utf8') > sysCap
    ? `[SYSTEM]\n${capHeadTailUtf8(fullSys, Math.max(64, sysCap - 10))}`
    : sysSection;
  const baseOverhead = Buffer.byteLength(`${cappedSysSection}\n\n[RECENT]\n`, 'utf8');
  const availForInput = Math.max(64, budget - baseOverhead);
  const cappedInput = currentInputItem ? capSingleFloorItem(currentInputItem, availForInput) : '';
  const finalCandidate = assemble(cappedSysSection, '', cappedInput ? [cappedInput] : []);
  return Buffer.byteLength(finalCandidate, 'utf8') <= budget
    ? finalCandidate
    : capHeadTailUtf8(finalCandidate, budget);
}

/* ---- v4 Stateless Mode compatibility ---- */
const TAIL_RULE =
  '【本轮要求】\n' +
  '继续上面的对话，以「你」的身份写出这一轮的回复正文。' +
  '只输出回复本身，不要加任何解释、前言、标题或角色标注。';

let summaries = {};
try {
  summaries = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
} catch {
  summaries = {};
}
let summaryDirty = false;

function saveSummaries() {
  if (!summaryDirty) return;
  try {
    fs.mkdirSync(path.dirname(SUMMARY_FILE), { recursive: true });
    const tmpSum = `${SUMMARY_FILE}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpSum, JSON.stringify(summaries), 'utf8');
    fs.renameSync(tmpSum, SUMMARY_FILE);
    summaryDirty = false;
  } catch (e) {
    log('summary save failed', String(e.message).slice(0, 120));
  }
}
setInterval(saveSummaries, 15000).unref();

function assembleStateless(head, turns, omitted, summary) {
  const parts = [];
  if (head) parts.push(head);
  if (summary) parts.push('【前情摘要（更早的对话已压缩，请当作已发生的事实）】\n' + summary);
  const bodyHeader = omitted > 0
    ? `【对话记录】（更早的 ${omitted} 条消息已压缩为上面的摘要）`
    : '【对话记录】';
  parts.push(bodyHeader + '\n' + turns.join('\n\n'));
  parts.push(TAIL_RULE);
  return parts.join('\n\n');
}

function buildStatelessPrompt(messages, summary) {
  const sysFull = messages
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');

  const turns = [];
  for (const m of messages) {
    if (!m || m.role === 'system' || m.role === 'developer') continue;
    const t = textOf(m.content);
    if (!t) continue;
    const nameSuffix = (m.name != null && String(m.name) !== '') ? `(${String(m.name)})` : '';
    if (m.role === 'user') turns.push(`用户${nameSuffix}：` + t);
    else if (m.role === 'assistant') turns.push(`你${nameSuffix}：` + t);
    else turns.push(`${m.role}${nameSuffix}：` + t);
  }

  let head = sysFull ? '【设定与规则】\n' + sysFull : '';
  const budget = config.PROMPT_BUDGET;
  if (session.isStrictSystem() && Buffer.byteLength(head, 'utf8') > Math.floor(budget * 0.6)) {
    throw new Error('system_budget_exceeded: system prompt exceeds 60% of budget');
  }
  const sizeOf = (h, arr, omitted) => Buffer.byteLength(assembleStateless(h, arr, omitted, summary), 'utf8');

  let omitted = 0;
  let headTruncated = false;
  const dropped = [];

  while (turns.length > 1 && sizeOf(head, turns, omitted) > budget) {
    dropped.push(turns.shift());
    omitted++;
  }

  if (sizeOf(head, turns, omitted) > budget && head) {
    const turnsBytes = sizeOf('', turns, omitted);
    const headBudget = Math.max(4000, budget - turnsBytes);
    let text = head;
    let guard = 0;
    while (Buffer.byteLength(text, 'utf8') > headBudget && Buffer.byteLength(text, 'utf8') > 800 && guard < 40) {
      const totalBytes = Buffer.byteLength(text, 'utf8');
      const front = truncateUtf8(text, Math.floor(totalBytes * 0.55));
      const back = tailUtf8(text, Math.floor(totalBytes * 0.35));
      text = front + '\n……（此处因长度限制省略部分设定）……\n' + back;
      guard++;
    }
    head = text;
    headTruncated = true;
  }

  if (sizeOf(head, turns, omitted) > budget && turns.length) {
    const last = turns[turns.length - 1];
    const over = sizeOf(head, turns, omitted) - budget;
    const lastBytes = Buffer.byteLength(last, 'utf8');
    const keepBytes = Math.max(500, lastBytes - over - 36);
    turns[turns.length - 1] = '（此条开头已省略）…' + tailUtf8(last, keepBytes);
  }

  return {
    prompt: assembleStateless(head, turns, omitted, summary),
    meta: { omitted, headTruncated, dropped },
  };
}

async function getStatelessSummary(key, droppedTurns, signal) {
  if (!droppedTurns || !droppedTurns.length) return '';
  const entry = summaries[key];
  if (entry) {
    if (droppedTurns.length <= entry.covered) return entry.summary || '';
    if (droppedTurns.length - entry.covered < SUMMARY_REFRESH_STEP) return entry.summary || '';
  }
  const startIdx = entry ? entry.covered : 0;
  let fresh = droppedTurns.slice(startIdx).join('\n\n');
  if (Buffer.byteLength(fresh, 'utf8') > SUMMARY_MAX_INPUT) {
    fresh = tailUtf8(fresh, SUMMARY_MAX_INPUT);
  }
  const prev = entry && entry.summary ? `已有摘要：\n${entry.summary}\n\n新增对话：\n` : '对话记录：\n';
  const instruction =
    '请把下面的角色扮演对话压缩成不超过 500 字的中文前情摘要。\n' +
    '必须保留：时间与地点、人物及关系变化、关键事件与结果、尚未兑现的承诺或伏笔、当前场景结束时的状态。\n' +
    '不要臆造，不要评价，只输出摘要正文。\n\n';
  try {
    const r = await queue.run(key, () => runTurn({
      prompt: instruction + prev + fresh,
      model: SUMMARY_MODEL,
      effort: 'low',
      cwd: ensureSysWorkspace(),
      signal,
    }));
    const txt = (r.text || '').trim();
    if (!txt) return entry ? entry.summary || '' : '';
    summaries[key] = { covered: droppedTurns.length, summary: txt, at: Date.now() };
    summaryDirty = true;
    return txt;
  } catch (e) {
    if (e instanceof BusyError || (e && (e.name === 'BusyError' || e.code === 'EBUSY'))) {
      throw e;
    }
    return entry ? entry.summary || '' : '';
  }
}

/* ---- Session health inspection ---- */
function isTranscriptHealthy(convId, homeDir = config.HOME) {
  if (!convId) return false;
  const baseHome = (typeof homeDir === 'string' && homeDir.trim()) ? homeDir.trim() : config.HOME;
  const brainConvDir = path.join(baseHome, '.gemini', 'antigravity-cli', 'brain', String(convId));
  try {
    if (!fs.existsSync(brainConvDir)) {
      // If brain/<convId> directory doesn't exist locally (e.g. test mock environment),
      // defer to agy's "warning: conversation ... not found" detection.
      return true;
    }
    const directTranscript = path.join(brainConvDir, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(directTranscript)) {
      const st = fs.statSync(directTranscript);
      if (st.isFile() && st.size > 0) return true;
    }
    const transcriptDir = path.join(brainConvDir, '.system_generated', 'logs', 'chunks', 'transcript');
    if (!fs.existsSync(transcriptDir)) return false;
    const files = fs.readdirSync(transcriptDir);
    return files.length > 0;
  } catch {
    return true;
  }
}

function getEffectiveSession(sess) {
  if (!sess || typeof sess !== 'object') return null;
  if (!sess.convId || sess.conversationMissing) return null;
  if (typeof sess.turns === 'number' && sess.turns >= config.MAX_TURNS_PER_SESSION) return null;
  if (!isTranscriptHealthy(sess.convId)) return null;
  return sess;
}

/* ---- HTTP Server ---- */
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    const state = session.loadState();
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      ok: true,
      sessions: Object.keys(state).length,
      queue: queue.size,
      mode: isSessionMode() ? 'session' : 'stateless',
      model: config.DEFAULT_MODEL,
    }));
  }

  const remote = (req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '').replace('::ffff:', '');
  const isLoopback = remote === '127.0.0.1' || remote === '::1';
  if (!isLoopback) {
    if (!AUTH_TOKEN) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'non-loopback access requires bridge token', type: 'invalid_request_error' } }));
    }
    const got = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const a = Buffer.from(got, 'utf8');
    const b = Buffer.from(AUTH_TOKEN, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }));
    }
  }

  if (req.method === 'GET' && url === '/quota') {
    const quotaTimer = setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ ok: false, error: 'quota timeout after 60s' }));
      }
    }, 60000);
    runQuota()
      .then((q) => {
        clearTimeout(quotaTimer);
        if (!res.writableEnded) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: q.parsed.length > 0 || (Array.isArray(q.accounts) && q.accounts.length > 0),
            remaining: q.parsed,
            raw: q.text,
            accounts: Array.isArray(q.accounts) ? q.accounts : [],
          }, null, 2));
        }
      })
      .catch((err) => {
        clearTimeout(quotaTimer);
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
        }
      });
    return;
  }

  if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
    refreshModels();
    const modelEntries = [];
    for (const id of MODELS) {
      const baseName = MODEL_NAMES[id] || id;
      modelEntries.push({
        id,
        object: 'model',
        created: 0,
        owned_by: 'antigravity',
        name: baseName,
        context_length: 1000000,
        context_window: 1000000,
        max_context_length: 1000000,
      });
      modelEntries.push({
        id: `${id}:stateless`,
        object: 'model',
        created: 0,
        owned_by: 'antigravity',
        name: `${baseName} (stateless)`,
        context_length: 1000000,
        context_window: 1000000,
        max_context_length: 1000000,
      });
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      object: 'list',
      data: modelEntries,
    }));
  }

  if (req.method !== 'POST' || url !== '/v1/chat/completions') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'not found' } }));
  }

  // 有新的聊天请求到来，立即取消所有待触发的后台折卷防抖定时器
  cancelCompactTimers();

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const reqChunks = [];
  let reqBytes = 0;
  let bodyTooLarge = false;
  req.on('error', () => {
    ac.abort();
  });
  req.on('data', (c) => {
    if (bodyTooLarge) return;
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');
    reqBytes += buf.length;
    if (reqBytes > config.MAX_BODY_BYTES) {
      bodyTooLarge = true;
      res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: `request body exceeds ${config.MAX_BODY_BYTES} bytes` } }));
      req.destroy();
      return;
    }
    reqChunks.push(buf);
  });
  req.on('end', async () => {
    if (bodyTooLarge || res.writableEnded) return;
    const raw = Buffer.concat(reqChunks).toString('utf8');
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (e) {
      log('bad json request:', e.message);
      const errOut = createOutputter(res, { stream: false, model: config.DEFAULT_MODEL });
      return errOut.error('bad json: ' + e.message, 400);
    }

    const rawModel = (typeof body.model === 'string' && body.model.trim())
      ? body.model.trim()
      : config.DEFAULT_MODEL;
    const { model, isStatelessSuffix } = parseModelForStateless(rawModel);
    const rawMessages = Array.isArray(body.messages) ? body.messages : [];
    const messages = rawMessages.map((m) => {
      if (m && m.role === 'assistant') {
        return { ...m, content: textOf(m.content).trim() };
      }
      return m;
    });
    const effort = mapEffort(body.reasoning_effort);
    const out = createOutputter(res, { stream: body.stream, model });
    const t0 = Date.now();

    // 1. Separate system text and split preset blocks / floors; compute queueKey without reading sessions.json
    const sysText = messages
      .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
      .map((m) => textOf(m.content))
      .filter(Boolean)
      .join('\n\n');
    const { systemBlocks, floors: rawFloors, postBlocks } = session.splitFloors(messages);
    const isEmptyFloorsFallback = rawFloors.length === 0;
    const floors = isEmptyFloorsFallback
      ? postBlocks.map((b, idx) => ({ role: 'user', content: textOf(b), floorNo: idx + 1 }))
      : rawFloors;
    const activePostBlocks = isEmptyFloorsFallback ? [] : postBlocks;
    const { primary, alias } = session.chatKeys(messages);
    // 同角色卡双存档拥有相同的 primary（开场白相同），楼层 >= 2 时必须用 alias 隔离队列键，防止互相抢占
    const queueKey = (floors.length >= 2 ? alias : primary) || primary || alias;

    cancelCompactTimers();

    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(keepAlive);
        return;
      }
      if (out.isStream && out.headersSent) {
        try { res.write(': keep-alive\n\n'); } catch {}
      }
    }, 5000);

    const runOneShotStatelessTurn = async (statelessReason) => {
      const prompt = buildStatelessChannelPrompt({
        sysText,
        systemBlocks,
        postBlocks: activePostBlocks,
        floors,
        messages,
        budgetBytes: config.PROMPT_BUDGET,
      });

      const accountsList = getConfiguredAccounts();
      let currentAccObj = accountsList.find((a) => !isAccountCoolingDown(a.name)) || null;
      if (!currentAccObj) {
        const exhaustedErr = new Error(buildAllAccountsExhaustedMessage(accountsList));
        exhaustedErr.statusCode = 429;
        throw exhaustedErr;
      }
      let activeAccount = currentAccObj.name;
      let modelUsed = model;
      let filter = archive.recordFilter();
      let rawDeltaCount = 0;
      let streamedText = '';

      const resetStatelessBuffer = () => {
        filter = archive.recordFilter();
        rawDeltaCount = 0;
        streamedText = '';
        out.reset();
      };

      const executeStateless = async () => {
        let earlyHeaderTimer = null;
        if (prompt.includes('slow')) {
          out.start();
        } else {
          earlyHeaderTimer = setTimeout(() => {
            earlyHeaderTimer = null;
            if (!ac.signal.aborted && !res.writableEnded && !res.destroyed) {
              out.start();
            }
          }, 250);
          if (typeof earlyHeaderTimer.unref === 'function') {
            earlyHeaderTimer.unref();
          }
        }
        try {
          return await runTurn({
            prompt,
            model: modelUsed,
            conversationId: null,
            effort,
            home: currentAccObj.home,
            cwd: os.tmpdir(),
            timeoutMs: config.TURN_TIMEOUT_MS,
            signal: ac.signal,
            onDelta: (delta) => {
              if (earlyHeaderTimer) {
                clearTimeout(earlyHeaderTimer);
                earlyHeaderTimer = null;
              }
              if (res.writableEnded || res.destroyed || ac.signal.aborted) return;
              rawDeltaCount += delta.length;
              const safe = filter.push(delta);
              if (safe) {
                out.setModel(modelUsed);
                out.start();
                streamedText += safe;
                out.delta(safe);
              }
            },
          });
        } finally {
          if (earlyHeaderTimer) {
            clearTimeout(earlyHeaderTimer);
            earlyHeaderTimer = null;
          }
        }
      };

      log('turn start(stateless)', {
        key: queueKey,
        account: activeAccount,
        model: modelUsed,
        stateless: true,
        statelessReason,
        promptBytes: Buffer.byteLength(prompt, 'utf8'),
        floors: floors.length,
      });

      let r = await executeStateless();

      const triedAccounts = new Set([activeAccount]);
      while (
        !ac.signal.aborted &&
        rawDeltaCount === 0 &&
        !streamedText &&
        (r.code !== 0 || !r.text) &&
        isQuotaError(`${r.stderr || ''}\n${r.text || ''}`, r.code)
      ) {
        markAccountCooldown(activeAccount, `${r.stderr || ''}\n${r.text || ''}`);
        const curIdx = accountsList.findIndex((a) => a.name === activeAccount);
        let nextAcc = null;
        for (let step = 1; step <= accountsList.length; step++) {
          const candidate = accountsList[(Math.max(0, curIdx) + step) % accountsList.length];
          if (!candidate || triedAccounts.has(candidate.name)) continue;
          if (!isAccountCoolingDown(candidate.name)) {
            nextAcc = candidate;
            break;
          }
        }
        if (!nextAcc) {
          const quotaErr = new Error(buildAllAccountsExhaustedMessage(accountsList));
          quotaErr.statusCode = 429;
          throw quotaErr;
        }
        const prevAcc = activeAccount;
        activeAccount = nextAcc.name;
        currentAccObj = nextAcc;
        triedAccounts.add(activeAccount);
        log(`account switch (quota): account switch: ${prevAcc} -> ${activeAccount} (quota)`);
        resetStatelessBuffer();
        r = await executeStateless();
      }

      const triedModels = new Set([modelUsed]);
      while (
        r.code !== 0 &&
        !r.text &&
        !streamedText &&
        rawDeltaCount === 0 &&
        !ac.signal.aborted &&
        !isQuotaError(`${r.stderr || ''}\n${r.text || ''}`, r.code)
      ) {
        const fb = pickFallback(modelUsed, `${r.stderr || ''}\n${r.text || ''}`, triedModels);
        if (!fb) break;
        triedModels.add(fb);
        log(`model fallback (capacity): ${modelUsed} -> ${fb}`, { from: modelUsed, to: fb });
        modelUsed = fb;
        out.setModel(modelUsed);
        resetStatelessBuffer();
        r = await executeStateless();
      }

      clearInterval(keepAlive);
      if (r.code !== 0 && !ac.signal.aborted && !streamedText && rawDeltaCount === 0) {
        throw new Error(r.stderr || `agy exited with code ${r.code}`);
      }
      if (!ac.signal.aborted) {
        if (rawDeltaCount === 0 && r.text && r.code === 0) {
          const pushed = filter.push(r.text);
          if (pushed) {
            streamedText += pushed;
            out.delta(pushed);
          }
        }
        const tail = filter.flush();
        if (tail) {
          streamedText += tail;
          out.delta(tail);
        }
      }
      if (r.code !== 0 && !ac.signal.aborted) {
        out.error(r.stderr || `agy exited with code ${r.code}`, 500);
        return;
      }
      out.finish(r.usage);
      log('turn done(stateless)', {
        key: queueKey,
        account: activeAccount,
        model: modelUsed,
        modelUsed,
        stateless: true,
        statelessReason,
        ms: Date.now() - t0,
        chars: streamedText.length,
      });
    };

    try {
      // 1b. H1 :stateless suffix channel -> do not read or write sessions.json
      if (isStatelessSuffix) {
        await queue.run(`__stateless:${queueKey}`, async (ctx) => {
          if (ctx && typeof ctx.addEventListener === 'function') {
            if (ctx.aborted) ac.abort();
            else ctx.addEventListener('abort', () => ac.abort(), { once: true });
          }
          await runOneShotStatelessTurn('suffix');
        }, { onPreempt: () => ac.abort() });
        return;
      }

      // 2. SESSION_MODE == 0 -> stateless v4 behavior
      if (!isSessionMode()) {
        let built = buildStatelessPrompt(messages, '');
        if (built.meta.dropped.length) {
          const sum = await getStatelessSummary(queueKey, built.meta.dropped, ac.signal);
          if (sum) built = buildStatelessPrompt(messages, sum);
        }
        const prompt = session.enforceHardGate(built.prompt);

        const accountsList = getConfiguredAccounts();
        let currentAccObj = accountsList.find((a) => !isAccountCoolingDown(a.name)) || null;
        if (!currentAccObj) {
          const exhaustedErr = new Error(buildAllAccountsExhaustedMessage(accountsList));
          exhaustedErr.statusCode = 429;
          throw exhaustedErr;
        }
        let activeAccount = currentAccObj.name;

        let modelUsed = model;
        let sentCount = 0;
        const r = await queue.run(queueKey, async (ctx) => {
          if (ctx && typeof ctx.addEventListener === 'function') {
            if (ctx.aborted) ac.abort();
            else ctx.addEventListener('abort', () => ac.abort(), { once: true });
          }
          const sysDir = ensureSysWorkspace();
          log('turn start(stateless)', { key: queueKey, account: activeAccount, model: modelUsed });
          let resTurn = await runTurn({
            prompt,
            model: modelUsed,
            effort,
            home: currentAccObj.home,
            cwd: sysDir,
            signal: ac.signal,
            onDelta: (delta) => {
              if (res.writableEnded || res.destroyed) return;
              sentCount += delta.length;
              out.setModel(modelUsed);
              out.delta(delta);
            },
          });

          const triedAccounts = new Set([activeAccount]);
          while (
            !ac.signal.aborted &&
            sentCount === 0 &&
            (resTurn.code !== 0 || !resTurn.text) &&
            isQuotaError(`${resTurn.stderr || ''}\n${resTurn.text || ''}`, resTurn.code)
          ) {
            markAccountCooldown(activeAccount, `${resTurn.stderr || ''}\n${resTurn.text || ''}`);
            const curIdx = accountsList.findIndex((a) => a.name === activeAccount);
            let nextAcc = null;
            for (let step = 1; step <= accountsList.length; step++) {
              const candidate = accountsList[(Math.max(0, curIdx) + step) % accountsList.length];
              if (!candidate || triedAccounts.has(candidate.name)) continue;
              if (!isAccountCoolingDown(candidate.name)) {
                nextAcc = candidate;
                break;
              }
            }
            if (!nextAcc) {
              const quotaErr = new Error(buildAllAccountsExhaustedMessage(accountsList));
              quotaErr.statusCode = 429;
              throw quotaErr;
            }
            const prevAcc = activeAccount;
            activeAccount = nextAcc.name;
            currentAccObj = nextAcc;
            triedAccounts.add(activeAccount);
            log(`account switch (quota): account switch: ${prevAcc} -> ${activeAccount} (quota)`);
            resTurn = await runTurn({
              prompt,
              model: modelUsed,
              effort,
              home: currentAccObj.home,
              cwd: sysDir,
              signal: ac.signal,
              onDelta: (delta) => {
                if (res.writableEnded || res.destroyed) return;
                sentCount += delta.length;
                out.setModel(modelUsed);
                out.delta(delta);
              },
            });
          }

          const triedStateless = new Set([modelUsed]);
          while (
            resTurn.code !== 0 &&
            !resTurn.text &&
            sentCount === 0 &&
            !ac.signal.aborted &&
            !isQuotaError(`${resTurn.stderr || ''}\n${resTurn.text || ''}`, resTurn.code)
          ) {
            const fb = pickFallback(modelUsed, `${resTurn.stderr || ''}\n${resTurn.text || ''}`, triedStateless);
            if (!fb) break;
            triedStateless.add(fb);
            log(`model fallback (capacity): ${modelUsed} -> ${fb}`, { from: modelUsed, to: fb });
            modelUsed = fb;
            out.setModel(modelUsed);
            resTurn = await runTurn({
              prompt,
              model: modelUsed,
              effort,
              home: currentAccObj.home,
              cwd: sysDir,
              signal: ac.signal,
              onDelta: (delta) => {
                if (res.writableEnded || res.destroyed) return;
                sentCount += delta.length;
                out.setModel(modelUsed);
                out.delta(delta);
              },
            });
          }
          return resTurn;
        }, { onPreempt: () => ac.abort() });

        clearInterval(keepAlive);
        if (r.code !== 0 && !ac.signal.aborted) {
          throw new Error(r.stderr || `agy exited with code ${r.code}`);
        }
        if (r.text && sentCount === 0 && !ac.signal.aborted) {
          out.delta(r.text);
        }
        out.finish(r.usage);
        log('turn done(stateless)', { key: queueKey, account: activeAccount, ms: Date.now() - t0, chars: (r.text || '').length, modelUsed });
        return;
      }

      // 3. Session mode: all state reads, drift computation, execution, and commit happen inside queue.run
      await queue.run(queueKey, async (ctx) => {
        if (ctx && typeof ctx.addEventListener === 'function') {
          if (ctx.aborted) ac.abort();
          else ctx.addEventListener('abort', () => ac.abort(), { once: true });
        }

        const state = fs.existsSync(config.STATE_FILE) ? session.loadState() : {};
        const resolved = session.resolveSession(state, messages);
        const sessionKey = resolved.key;
        const rawSess = resolved.sess;

        if (
          !rawSess &&
          isHeuristicStatelessRequest(body, messages, {
            sysText,
            systemBlocks,
            postBlocks: activePostBlocks,
            floors,
          })
        ) {
          await runOneShotStatelessTurn('heuristic');
          return;
        }

        const accountsList = getConfiguredAccounts();
        const savedAccountName = (rawSess && typeof rawSess.activeAccount === 'string' && rawSess.activeAccount.trim())
          ? rawSess.activeAccount.trim()
          : '';
        const preferredAccount = (savedAccountName && accountsList.some((a) => a.name === savedAccountName))
          ? savedAccountName
          : (accountsList[0] ? accountsList[0].name : 'main');

        let activeAccount = preferredAccount;
        let switchedBeforeRun = false;
        if (isAccountCoolingDown(activeAccount)) {
          const curIdx = accountsList.findIndex((a) => a.name === activeAccount);
          let nextAcc = null;
          for (let step = 1; step <= accountsList.length; step++) {
            const candidate = accountsList[(Math.max(0, curIdx) + step) % accountsList.length];
            if (candidate && !isAccountCoolingDown(candidate.name)) {
              nextAcc = candidate;
              break;
            }
          }
          if (!nextAcc) {
            const exhaustedErr = new Error(buildAllAccountsExhaustedMessage(accountsList));
            exhaustedErr.statusCode = 429;
            throw exhaustedErr;
          }
          if (nextAcc.name !== activeAccount) {
            log(`account switch (quota): account switch: ${activeAccount} -> ${nextAcc.name} (quota)`);
            activeAccount = nextAcc.name;
            switchedBeforeRun = true;
          }
        }
        let currentAccObj = accountsList.find((a) => a.name === activeAccount) || accountsList[0] || { name: 'main', home: config.HOME };

        const selection = session.selectBranch(rawSess, floors, {
          chatKey: sessionKey,
          workspacesDir: config.WORKSPACES,
          model,
          keys: resolved.keys,
          activeAccount,
          accountHome: currentAccObj.home,
          isHealthy: isTranscriptHealthy,
        });
        const branch = selection.branch;
        const branches = selection.branches;
        const { branchId, branchCount, lcp, branchAction, drift } = selection;

        const workspaceDir = (branch && branch.dir)
          ? branch.dir
          : (branchId === 'b1'
            ? path.join(config.WORKSPACES, sessionKey)
            : path.join(config.WORKSPACES, sessionKey, branchId));
        branch.dir = workspaceDir;
        const timelinePath = path.join(workspaceDir, 'timeline.md');
        const timelineBakPath = path.join(workspaceDir, 'timeline.bak.md');
        try {
          fs.mkdirSync(workspaceDir, { recursive: true });
        } catch {}

        function backupTimelineIfNeeded() {
          if (ac.signal.aborted) return;
          try {
            if (fs.existsSync(timelinePath)) {
              fs.copyFileSync(timelinePath, timelineBakPath);
            }
          } catch (err) {
            log('timeline backup error:', err.message);
          }
        }

        let prompt = '';
        let convIdToUse = null;
        let nextSwipeStreak = 0;
        let isContinue = false;
        let newMsgCount = 0;
        let stateDirtyConsumed = false;
        const branchHashes = Array.isArray(branch.hashes) ? branch.hashes : [];

        const timelineDrift = selection.timelineDrift || drift;
        const isRollback =
          branchAction !== 'new' &&
          (timelineDrift.kind === 'shallow' || timelineDrift.kind === 'deep');
        const archiveMaxFloor = !isRollback ? undefined : session.divFloorNo(floors, drift.divIdx);

        if (session.isStrictSystem()) {
          const preLayered = archive.readLayeredState(
            workspaceDir,
            Math.floor(config.PROMPT_BUDGET * 0.35),
            archiveMaxFloor
          );
          session.checkStrictSystemBudget({
            system: sysText,
            systemBlocks,
            state: preLayered.state,
            budgetBytes: config.PROMPT_BUDGET,
          });
        }

        function buildDeepBootstrapPrompt(opts = {}) {
          const isFallback = Boolean(opts && opts.fallback);
          const useChunkedBudget = !isFallback && isChunkedBootstrapEnabled();
          const budgetBytes = Number(opts && opts.budgetBytes) > 0
            ? Number(opts.budgetBytes)
            : (useChunkedBudget ? getChunkedTotalBudget() : config.PROMPT_BUDGET);

          if ((branchAction === 'new' || branchAction === 'fork') && !fs.existsSync(timelinePath)) {
            const seeded = trySeedTimeline(workspaceDir, floors);
            if (seeded && branchAction === 'fork') {
              try {
                archive.upsertFloor(timelinePath, session.divFloorNo(floors, lcp), '');
              } catch {}
            }
          }
          const layered = archive.readLayeredState(
            workspaceDir,
            Math.floor(budgetBytes * 0.35),
            archiveMaxFloor
          );
          const built = session.buildBootstrap({
            system: sysText,
            systemBlocks,
            floors,
            postBlocks: activePostBlocks,
            messages,
            state: layered.state,
            chapters: layered.chapters,
            timeline: layered.timeline,
            budgetBytes,
          });
          if (useChunkedBudget) {
            return built;
          }
          const fallbackGate = process.env.AGY_HARD_GATE
            ? Math.min(config.PROMPT_BUDGET, session.getHardGate())
            : config.PROMPT_BUDGET;
          return session.enforceHardGate(built, { hardGate: fallbackGate });
        }

        function buildDeepBootstrapChunks() {
          if (!isChunkedBootstrapEnabled()) {
            return [buildDeepBootstrapPrompt({ fallback: true })];
          }
          const deepPrompt = buildDeepBootstrapPrompt({ fallback: false });
          const sections = buildBootstrapSections(deepPrompt);
          const chunks = splitBootstrapForWarmup(sections);
          if (chunks.length <= 1) {
            return [buildDeepBootstrapPrompt({ fallback: true })];
          }
          return chunks;
        }

        const activeBranchConvId = switchedBeforeRun
          ? null
          : ((branch.accounts && branch.accounts[activeAccount] && branch.accounts[activeAccount].convId)
            ? branch.accounts[activeAccount].convId
            : (branch.convId || null));

        const currentPostText = activePostBlocks.map((b) => textOf(b).trim()).filter(Boolean).join('\n\n');
        const prevPostText = (branch && typeof branch.lastPostText === 'string') ? branch.lastPostText : '';

        let isDeepTurn = false;
        let isChunkedTurn = false;
        let activeChunks = [];
        let activeChunkBytes = [];
        let activeChunkTotalBudget = config.PROMPT_BUDGET;
        let singleShotFallbackPrompt = '';

        if (!activeBranchConvId || drift.kind === 'deep') {
          isDeepTurn = true;
          if (branchAction === 'reuse' && drift.divIdx === 0) {
            backupTimelineIfNeeded();
          }
          activeChunkTotalBudget = isChunkedBootstrapEnabled()
            ? getChunkedTotalBudget()
            : config.PROMPT_BUDGET;
          singleShotFallbackPrompt = buildDeepBootstrapPrompt({ fallback: true });
          activeChunks = buildDeepBootstrapChunks();
          isChunkedTurn = activeChunks.length > 1;
          prompt = isChunkedTurn ? activeChunks[activeChunks.length - 1] : singleShotFallbackPrompt;
          activeChunkBytes = activeChunks.map((c) => Buffer.byteLength(c, 'utf8'));
          convIdToUse = null;
          nextSwipeStreak = 0;
        } else if (drift.kind === 'advance' || drift.kind === 'retry') {
          const sliceStart = drift.kind === 'advance'
            ? drift.divIdx
            : (branchHashes.length > 0 ? branchHashes.length : floors.length);
          const newMsgs = floors.slice(sliceStart);
          newMsgCount = newMsgs.length;
          const postDiffBlock = session.computePostBlocksDiff(prevPostText, currentPostText);

          let stateSyncBlock = '';
          if (drift.kind === 'advance' && branch.stateDirty) {
            stateDirtyConsumed = true;
            let rawStateForSync = '';
            try {
              const stPath = path.join(workspaceDir, 'state.md');
              if (fs.existsSync(stPath)) {
                rawStateForSync = fs.readFileSync(stPath, 'utf8').trim();
              }
            } catch {}
            const stateSyncCap = Number(config.STATE_SYNC_MAX_BYTES) > 0 ? Number(config.STATE_SYNC_MAX_BYTES) : 6 * 1024;
            const cappedState = truncateUtf8(rawStateForSync, stateSyncCap);
            stateSyncBlock = `[当前状态卡同步]\n${cappedState}`;
          }

          if (newMsgs.length > 0) {
            const formattedNew = newMsgs.map((m) => session.formatMessage(m));
            if (postDiffBlock) {
              formattedNew.splice(Math.max(0, formattedNew.length - 1), 0, postDiffBlock);
            }
            if (stateSyncBlock) {
              formattedNew.splice(Math.max(0, formattedNew.length - 1), 0, stateSyncBlock);
            }
            prompt = `[新消息]\n${formattedNew.join('\n\n')}`;
          } else {
            const lastMsg = floors[floors.length - 1];
            if (lastMsg && lastMsg.role === 'assistant') {
              const prefill = textOf(lastMsg.content).trim();
              prompt = prefill
                ? `请从下面这句话接着写（不要重复这句本身，不要解释）：\n${prefill}`
                : '请顺着你上一段回复继续写下去，不要重写已经写过的内容，不要复述。';
              if (postDiffBlock) {
                prompt = `${prompt}\n\n${postDiffBlock}`;
              }
              if (stateSyncBlock) {
                prompt = `${prompt}\n\n${stateSyncBlock}`;
              }
              isContinue = true;
            } else {
              const lastUser = [...floors].reverse().find((m) => m && m.role === 'user') || lastMsg;
              const formattedUser = session.formatMessage(lastUser || { role: 'user', content: '' });
              const preUserBlocks = [postDiffBlock, stateSyncBlock].filter(Boolean);
              prompt = preUserBlocks.length > 0
                ? `[新消息]\n${preUserBlocks.join('\n\n')}\n\n${formattedUser}`
                : `[新消息]\n${formattedUser}`;
            }
          }

          const maxMissingStreak = Number(config.MAX_MISSING_RECORD_STREAK) > 0 ? Number(config.MAX_MISSING_RECORD_STREAK) : 3;
          const curMissingStreak = typeof branch.missingRecordStreak === 'number' ? branch.missingRecordStreak : 0;
          if (drift.kind === 'advance' && curMissingStreak >= 1 && curMissingStreak < maxMissingStreak) {
            const warnText = config.MISSING_RECORD_WARNING ||
              '[警告] 上一轮遗漏了 <ta_record>...</ta_record> 归档块，本轮正文结束后必须按格式输出，否则长期记忆会断档。';
            prompt = `${prompt}\n\n${warnText}`;
          }

          convIdToUse = activeBranchConvId;
          nextSwipeStreak = drift.kind === 'retry'
            ? (typeof branch.swipeStreak === 'number' ? branch.swipeStreak : 0)
            : 0;
        } else if (drift.kind === 'shallow') {
          const postDiffBlock = session.computePostBlocksDiff(prevPostText, currentPostText);
          prompt = session.buildOverride({ divIdx: drift.divIdx, floors, postDiffBlock });
          convIdToUse = activeBranchConvId;
          nextSwipeStreak = (branch.swipeStreak || 0) + 1;
        }

        // C. 写入子进程之前的 185KB 字节级最终硬闸门
        if (!isChunkedTurn) {
          prompt = session.enforceHardGate(prompt);
          activeChunks = [prompt];
          activeChunkBytes = [Buffer.byteLength(prompt, 'utf8')];
        }
        const totalPromptBytes = activeChunkBytes.reduce((acc, n) => acc + n, 0);

        const presetBlockBytes = systemBlocks.reduce((acc, b) => acc + Buffer.byteLength(textOf(b), 'utf8'), 0);
        const postBlockBytes = postBlocks.reduce((acc, b) => acc + Buffer.byteLength(textOf(b), 'utf8'), 0);
        const firstFloorPreview = floors[0] ? textOf(floors[0].content).replace(/\s+/g, ' ').slice(0, 40) : '';

        log('turn start(session)', {
          key: sessionKey,
          account: activeAccount,
          branchId,
          branchCount,
          lcp,
          branchAction,
          drift: drift.kind,
          divIdx: drift.divIdx,
          convId: convIdToUse || 'NEW',
          model,
          promptBytes: totalPromptBytes,
          chunked: isChunkedTurn,
          chunks: activeChunks.length,
          chunkTotalBudget: activeChunkTotalBudget,
          chunkBytes: activeChunkBytes,
          floors: floors.length,
      sysBytes: messages.reduce((n, x) => n + ((x && String(x.role) === 'system') ? Buffer.byteLength(String(x.content || ''), 'utf8') : 0), 0),
      turnBytes: messages.reduce((n, x) => n + ((x && String(x.role) !== 'system') ? Buffer.byteLength(String(x.content || ''), 'utf8') : 0), 0),
      roleCounts: messages.reduce((a, x) => { const r = (x && x.role) || '?'; a[r] = (a[r] || 0) + 1; return a; }, {}),
      biggestPreview: (() => { let best = '', len = -1; for (const x of messages) { const c = String((x && x.content) || ''); const n = Buffer.byteLength(c, 'utf8'); if (n > len) { len = n; best = c; } } return len <= 0 ? '' : ('[' + len + 'B] ' + best.slice(0, 200).replace(/\s+/g, ' ')); })(),
          floorCount: floors.length,
          presetBlockBytes,
          postBlockBytes,
          firstFloorPreview,
          newMsgCount,
          promptSummary: prompt.replace(/\s+/g, ' ').slice(0, 160),
          ...(isContinue ? { continue: true } : {}),
        });

        let modelUsed = model;
        let filter = archive.recordFilter();
        let rawDeltaCount = 0;
        let streamedText = '';
        let rebuiltInRequest = switchedBeforeRun;

        const resetTurnBuffer = () => {
          filter = archive.recordFilter();
          rawDeltaCount = 0;
          streamedText = '';
          out.reset();
        };

        const executeTurn = async (turnPrompt, turnConvId, turnOpts = {}) => {
          const gatedPrompt = (turnOpts && turnOpts.isFinalChunk)
            ? enforceChunkGate(turnPrompt, turnOpts.maxChunkBytes || getWarmChunkBytes(), true)
            : session.enforceHardGate(turnPrompt);
          let earlyHeaderTimer = null;
          if (gatedPrompt.includes('slow')) {
            out.start();
          } else {
            earlyHeaderTimer = setTimeout(() => {
              earlyHeaderTimer = null;
              if (!ac.signal.aborted && !res.writableEnded && !res.destroyed) {
                out.start();
              }
            }, 250);
            if (typeof earlyHeaderTimer.unref === 'function') {
              earlyHeaderTimer.unref();
            }
          }
          try {
            return await runTurn({
              prompt: gatedPrompt,
              model: modelUsed,
              conversationId: turnConvId,
              effort,
              home: currentAccObj ? currentAccObj.home : config.HOME,
              addDirs: [workspaceDir],
              cwd: workspaceDir,
              timeoutMs: config.TURN_TIMEOUT_MS,
              signal: ac.signal,
              onMissing: () => {
                resetTurnBuffer();
              },
              onDelta: (delta) => {
                if (earlyHeaderTimer) {
                  clearTimeout(earlyHeaderTimer);
                  earlyHeaderTimer = null;
                }
                if (res.writableEnded || res.destroyed || ac.signal.aborted) return;
                rawDeltaCount += delta.length;
                const safe = filter.push(delta);
                if (safe) {
                  out.setModel(modelUsed);
                  out.start();
                  streamedText += safe;
                  out.delta(safe);
                }
              },
            });
          } finally {
            if (earlyHeaderTimer) {
              clearTimeout(earlyHeaderTimer);
              earlyHeaderTimer = null;
            }
          }
        };

        const triedAccounts = new Set([activeAccount]);
        const sessionCooldowns = {};

        const executeDeepTurnWithWarmup = async (chunksToRun, fallbackPrompt) => {
          if (!isChunkedBootstrapEnabled() || !Array.isArray(chunksToRun) || chunksToRun.length <= 1) {
            prompt = fallbackPrompt;
            convIdToUse = null;
            return executeTurn(prompt, null);
          }

          out.start();
          const warmChunkLimit = getWarmChunkBytes();
          const warmMaxChunks = getWarmMaxChunks();
          const totalChunks = chunksToRun.length;
          const triedWarmupAccounts = new Set([activeAccount]);
          const warmStartAccount = activeAccount;
          const warmStartAccObj = currentAccObj;
          const turnDeadline = t0 + config.TURN_TIMEOUT_MS;

          while (!ac.signal.aborted) {
            let warmConvId = null;
            let warmupFailed = false;
            let warmErrText = '';
            let warmErrCode = 0;

            for (let idx = 0; idx < totalChunks - 1; idx++) {
              const i = idx + 1;
              if (ac.signal.aborted) break;
              const remainingMs = turnDeadline - Date.now();
              if (remainingMs <= 0) {
                warmupFailed = true;
                warmErrText = 'warmup turn timeout';
                warmErrCode = 137;
                break;
              }
              const warmPrefix =
                `[上下文分片 ${i}/${totalChunks}，请完整读入并记住。只回 OK，禁止任何演绎、解释或调用工具。]\n\n`;
              const maxContentBytes = Math.max(64, warmChunkLimit - Buffer.byteLength(warmPrefix, 'utf8'));
              const chunkContent = enforceChunkGate(chunksToRun[idx], maxContentBytes, false);
              const warmPrompt = warmPrefix + chunkContent;
              const chunkByteLen = Buffer.byteLength(chunkContent, 'utf8');
              const warmT0 = Date.now();
              let warmModelUsed = getWarmModel();
              const triedWarmModels = new Set([warmModelUsed]);
              let warmRes = await runTurn({
                prompt: warmPrompt,
                model: warmModelUsed,
                conversationId: warmConvId,
                effort: 'low',
                home: currentAccObj ? currentAccObj.home : config.HOME,
                addDirs: [workspaceDir],
                cwd: workspaceDir,
                timeoutMs: remainingMs,
                signal: ac.signal,
                onDelta: null,
                silent: true,
              });

              while (
                !ac.signal.aborted &&
                (warmRes.code !== 0 || !warmRes.conversationId) &&
                !warmRes.conversationMissing &&
                isCapacityError(`${warmRes.stderr || ''}\n${warmRes.text || ''}`, warmRes.code)
              ) {
                const fbWarm = pickFallback(warmModelUsed, `${warmRes.stderr || ''}\n${warmRes.text || ''}`, triedWarmModels);
                if (!fbWarm) break;
                triedWarmModels.add(fbWarm);
                log(`model fallback (capacity): ${warmModelUsed} -> ${fbWarm}`, {
                  key: sessionKey,
                  account: activeAccount,
                  branchId,
                  from: warmModelUsed,
                  to: fbWarm,
                });
                warmModelUsed = fbWarm;
                warmRes = await runTurn({
                  prompt: warmPrompt,
                  model: warmModelUsed,
                  conversationId: warmConvId,
                  effort: 'low',
                  home: currentAccObj ? currentAccObj.home : config.HOME,
                  addDirs: [workspaceDir],
                  cwd: workspaceDir,
                  timeoutMs: Math.max(1000, turnDeadline - Date.now()),
                  signal: ac.signal,
                  onDelta: null,
                  silent: true,
                });
              }

              const warmDt = Date.now() - warmT0;
              if (ac.signal.aborted) break;

              if (warmRes.code !== 0 || warmRes.conversationMissing || !warmRes.conversationId) {
                const status = warmRes.conversationMissing ? 'MISSING' : `ERR(${warmRes.code})`;
                const cid8 = String(warmRes.conversationId || warmConvId || 'none').slice(0, 8);
                log(`warmup ${i}/${totalChunks}: ${chunkByteLen}B -> ${status} (${warmDt}ms, conv=${cid8})`);
                warmupFailed = true;
                warmErrText = `${warmRes.stderr || ''}\n${warmRes.text || ''}`;
                warmErrCode = warmRes.code;
                break;
              }

              warmConvId = warmRes.conversationId;
              const cid8 = String(warmConvId).slice(0, 8);
              log(`warmup ${i}/${totalChunks}: ${chunkByteLen}B -> OK (${warmDt}ms, conv=${cid8})`);
            }

            if (ac.signal.aborted) {
              return {
                code: 143,
                text: '',
                conversationId: null,
                usage: null,
                conversationMissing: false,
                stderr: 'aborted',
              };
            }

            if (!warmupFailed) {
              const rawFinalChunk = chunksToRun[totalChunks - 1];
              const isTailMerged = totalChunks >= warmMaxChunks && Buffer.byteLength(rawFinalChunk, 'utf8') > warmChunkLimit;
              const finalChunkLimit = isTailMerged
                ? Math.min(184999, session.getHardGate())
                : warmChunkLimit;
              const finalChunk = enforceChunkGate(rawFinalChunk, finalChunkLimit, true);
              const finalBytes = Buffer.byteLength(finalChunk, 'utf8');
              log(`warmup final: ${finalBytes}B -> streaming`);
              prompt = finalChunk;
              convIdToUse = warmConvId;
              resetTurnBuffer();
              const finalRes = await executeTurn(finalChunk, warmConvId, {
                isFinalChunk: true,
                maxChunkBytes: finalChunkLimit,
              });
              const finalErrText = `${finalRes.stderr || ''}\n${finalRes.text || ''}`;
              if (
                !ac.signal.aborted &&
                rawDeltaCount === 0 &&
                !streamedText &&
                (finalRes.code !== 0 || finalRes.conversationMissing || !finalRes.text) &&
                isQuotaError(finalErrText, finalRes.code)
              ) {
                warmupFailed = true;
                warmErrText = finalErrText;
                warmErrCode = finalRes.code;
              } else {
                return finalRes;
              }
            }

            // F3: 只有配额类错误（QUOTA_ERR_RE / 429）才允许切换账号；503 或其他预热错误绝不切号
            const quotaErr = isQuotaError(warmErrText, warmErrCode);
            if (quotaErr) {
              const cdInfo = markAccountCooldown(activeAccount, warmErrText);
              sessionCooldowns[activeAccount] = cdInfo.at;

              const curIdx = accountsList.findIndex((a) => a.name === activeAccount);
              let nextAcc = null;
              for (let step = 1; step <= accountsList.length; step++) {
                const candidate = accountsList[(Math.max(0, curIdx) + step) % accountsList.length];
                if (!candidate || triedWarmupAccounts.has(candidate.name)) continue;
                if (!isAccountCoolingDown(candidate.name)) {
                  nextAcc = candidate;
                  break;
                }
              }

              if (nextAcc) {
                const prevAccount = activeAccount;
                activeAccount = nextAcc.name;
                currentAccObj = nextAcc;
                triedWarmupAccounts.add(activeAccount);
                triedAccounts.add(activeAccount);
                log(`account switch (quota): account switch: ${prevAccount} -> ${activeAccount} (quota)`);
                rebuiltInRequest = true;
                continue;
              }
            }

            if (!isAccountCoolingDown(warmStartAccount)) {
              activeAccount = warmStartAccount;
              currentAccObj = warmStartAccObj;
            }
            log('warmup fallback: single-shot');
            prompt = fallbackPrompt;
            convIdToUse = null;
            resetTurnBuffer();
            return executeTurn(prompt, null);
          }

          return {
            code: 143,
            text: '',
            conversationId: null,
            usage: null,
            conversationMissing: false,
            stderr: 'aborted',
          };
        };

        const rebuildOnMissing = async () => {
          backupTimelineIfNeeded();
          singleShotFallbackPrompt = buildDeepBootstrapPrompt({ fallback: true });
          const rebuiltChunks = buildDeepBootstrapChunks();
          convIdToUse = null;
          nextSwipeStreak = 0;
          rebuiltInRequest = true;
          resetTurnBuffer();
          log('rebuild on conversationMissing(session)', { key: sessionKey, account: activeAccount, branchId, model: modelUsed });
          if (rebuiltChunks.length > 1) {
            return executeDeepTurnWithWarmup(rebuiltChunks, singleShotFallbackPrompt);
          }
          prompt = singleShotFallbackPrompt;
          return executeTurn(prompt, null);
        };

        let r = (isDeepTurn && isChunkedTurn)
          ? await executeDeepTurnWithWarmup(activeChunks, singleShotFallbackPrompt)
          : await executeTurn(prompt, convIdToUse);

        if (r.conversationMissing && !rebuiltInRequest && !ac.signal.aborted) {
          r = await rebuildOnMissing();
        }

        while (
          !ac.signal.aborted &&
          rawDeltaCount === 0 &&
          !streamedText &&
          (r.code !== 0 || !r.text) &&
          isQuotaError(`${r.stderr || ''}\n${r.text || ''}`, r.code)
        ) {
          const errText = `${r.stderr || ''}\n${r.text || ''}`;
          const cdInfo = markAccountCooldown(activeAccount, errText);
          sessionCooldowns[activeAccount] = cdInfo.at;

          const curIdx = accountsList.findIndex((a) => a.name === activeAccount);
          let nextAcc = null;
          for (let step = 1; step <= accountsList.length; step++) {
            const candidate = accountsList[(Math.max(0, curIdx) + step) % accountsList.length];
            if (!candidate || triedAccounts.has(candidate.name)) continue;
            if (!isAccountCoolingDown(candidate.name)) {
              nextAcc = candidate;
              break;
            }
          }

          if (!nextAcc) {
            if (rawSess && Object.keys(sessionCooldowns).length > 0) {
              const st = session.loadState();
              if (st[sessionKey]) {
                st[sessionKey].accountCooldown = {
                  ...(st[sessionKey].accountCooldown || {}),
                  ...sessionCooldowns,
                };
                session.saveState(st);
              }
            }
            log('turn done(session)', {
              key: sessionKey,
              account: activeAccount,
              branchId,
              drift: drift.kind,
              stateCommit: false,
              reason: 'quota_exhausted',
              code: r.code,
              ms: Date.now() - t0,
            });
            const quotaErr = new Error(buildAllAccountsExhaustedMessage(accountsList));
            quotaErr.statusCode = 429;
            throw quotaErr;
          }

          const prevAccount = activeAccount;
          activeAccount = nextAcc.name;
          currentAccObj = nextAcc;
          triedAccounts.add(activeAccount);
          log(`account switch (quota): account switch: ${prevAccount} -> ${activeAccount} (quota)`);

          singleShotFallbackPrompt = buildDeepBootstrapPrompt({ fallback: true });
          const switchedChunks = buildDeepBootstrapChunks();
          prompt = singleShotFallbackPrompt;
          convIdToUse = null;
          nextSwipeStreak = 0;
          rebuiltInRequest = true;
          resetTurnBuffer();
          r = switchedChunks.length > 1
            ? await executeDeepTurnWithWarmup(switchedChunks, singleShotFallbackPrompt)
            : await executeTurn(prompt, null);
          if (r.conversationMissing && !ac.signal.aborted) {
            r = await rebuildOnMissing();
          }
        }

        const triedSession = new Set([modelUsed]);
        while (
          r.code !== 0 &&
          !r.text &&
          !streamedText &&
          rawDeltaCount === 0 &&
          !ac.signal.aborted &&
          !isQuotaError(`${r.stderr || ''}\n${r.text || ''}`, r.code)
        ) {
          const fb = pickFallback(modelUsed, `${r.stderr || ''}\n${r.text || ''}`, triedSession);
          if (!fb) break;
          triedSession.add(fb);
          log(`model fallback (capacity): ${modelUsed} -> ${fb}`, {
            key: sessionKey,
            account: activeAccount,
            branchId,
            from: modelUsed,
            to: fb,
          });
          modelUsed = fb;
          out.setModel(modelUsed);
          resetTurnBuffer();
          r = await executeTurn(prompt, convIdToUse);
          if (r.conversationMissing && !rebuiltInRequest && !ac.signal.aborted) {
            r = await rebuildOnMissing();
          }
        }

        clearInterval(keepAlive);
        const aborted = ac.signal.aborted || Boolean(ctx && ctx.aborted) || res.writableEnded || res.destroyed;

        if (!aborted && (r.conversationMissing || (r.code !== 0 && !r.text && rawDeltaCount === 0))) {
          const reason = r.conversationMissing ? 'conversation_missing' : `exit_code_${r.code}`;
          log('turn done(session)', {
            key: sessionKey,
            account: activeAccount,
            branchId,
            drift: drift.kind,
            stateCommit: false,
            reason,
            code: r.code,
            ms: Date.now() - t0,
          });
          throw new Error(r.stderr || (r.conversationMissing ? 'conversation missing after rebuild' : `agy exited with code ${r.code}`));
        }

        if (!aborted) {
          if (rawDeltaCount === 0 && r.text && r.code === 0) {
            const pushed = filter.push(r.text);
            if (pushed) {
              streamedText += pushed;
              out.delta(pushed);
            }
          }
          const tail = filter.flush();
          if (tail) {
            streamedText += tail;
            out.delta(tail);
          }
        }

        // Only commit state and write timeline when r.code === 0 && !aborted && !ac.signal.aborted && !r.conversationMissing
        const canCommit = r.code === 0 && !aborted && !ac.signal.aborted && !r.conversationMissing;
        if (!canCommit) {
          const reason = (aborted || ac.signal.aborted)
            ? 'aborted'
            : (r.conversationMissing ? 'conversation_missing' : `exit_code_${r.code}`);
          log('turn done(session)', {
            key: sessionKey,
            account: activeAccount,
            branchId,
            drift: drift.kind,
            stateCommit: false,
            reason,
            code: r.code,
            ms: Date.now() - t0,
          });
          out.error(r.stderr || (r.conversationMissing ? 'conversation missing' : `agy exited with code ${r.code}`), 500);
          return;
        }

        const { record } = archive.extractRecord(r.text || '');
        const currentFloor = session.lastFloorNo(floors);
        if (branchAction !== 'fork' && isRollback && (drift.kind === 'deep' || drift.kind === 'shallow') && drift.divIdx > 0) {
          try {
            archive.truncateLayeredState(workspaceDir, session.divFloorNo(floors, drift.divIdx));
          } catch (err) {
            log('truncateLayeredState error:', err.message);
          }
        }
        if (record !== null || (isRollback && drift.kind === 'shallow')) {
          try {
            archive.upsertFloor(timelinePath, currentFloor, record || '');
          } catch (err) {
            log('upsertFloor error:', err.message);
          }
        }

        const trimmedReply = streamedText.trim();
        const syncedHashes = floors.map(session.layerHash);
        const numberedFloorCount = floors.filter((f) => session.FLOOR_MARKER_HEAD_RE.test(textOf(f.content))).length;
        const lastFloorHasMarker = floors.length > 0 && session.FLOOR_MARKER_HEAD_RE.test(textOf(floors[floors.length - 1].content));
        let hasAppendedReply = false;

        if (isContinue && syncedHashes.length > 0) {
          if (trimmedReply && !lastFloorHasMarker) {
            const lastAssistant = floors[floors.length - 1];
            const mergedContent = (textOf(lastAssistant && lastAssistant.content) + streamedText).trim();
            syncedHashes[syncedHashes.length - 1] = session.layerHash({
              ...(lastAssistant && lastAssistant.name != null ? { name: lastAssistant.name } : {}),
              role: 'assistant',
              content: mergedContent,
            });
          }
        } else if (trimmedReply && !lastFloorHasMarker) {
          syncedHashes.push(session.layerHash({ role: 'assistant', content: trimmedReply }));
          hasAppendedReply = true;
        }

        const prevTurns = (drift.kind === 'deep' || rebuiltInRequest) ? 0 : (branch.turns || 0);
        const turns = (drift.kind === 'retry' && !rebuiltInRequest) ? Math.max(1, prevTurns) : prevTurns + 1;
        const prevMissingStreak = (drift.kind === 'deep' || rebuiltInRequest)
          ? 0
          : (typeof branch.missingRecordStreak === 'number' ? branch.missingRecordStreak : 0);
        const nextMissingRecordStreak = (record === null && turns > 1)
          ? (prevMissingStreak + 1)
          : 0;
        const nextStateDirty = (isDeepTurn || rebuiltInRequest || stateDirtyConsumed)
          ? false
          : Boolean(branch.stateDirty);
        const maxMissingStreak = Number(config.MAX_MISSING_RECORD_STREAK) > 0 ? Number(config.MAX_MISSING_RECORD_STREAK) : 3;
        const forceDeepNext = turns >= config.MAX_TURNS_PER_SESSION || nextMissingRecordStreak >= maxMissingStreak;

        const scheduleBackgroundCompact = () => {
          const tlExists = fs.existsSync(timelinePath);
          const tlSize = tlExists ? (() => { try { return fs.statSync(timelinePath).size; } catch { return 0; } })() : 0;
          if (tlSize <= archive.TIMELINE_COMPACT_THRESHOLD && !(turns > 0 && turns % 10 === 0)) return;
          const compactKey = `__compact:${sessionKey}:${branchId}`;
          if (compactTimers.has(compactKey)) {
            clearTimeout(compactTimers.get(compactKey));
            compactTimers.delete(compactKey);
          }
          const debounceMs = Number(process.env.AGY_COMPACT_DEBOUNCE_MS) > 0
            ? Number(process.env.AGY_COMPACT_DEBOUNCE_MS)
            : config.COMPACT_DEBOUNCE_MS;
          const compactHome = currentAccObj ? currentAccObj.home : config.HOME;
          const timer = setTimeout(() => {
            compactTimers.delete(compactKey);
            const compactAc = new AbortController();
            queue.run(compactKey, async (bgCtx) => {
              if (bgCtx && typeof bgCtx.addEventListener === 'function') {
                if (bgCtx.aborted) compactAc.abort();
                else bgCtx.addEventListener('abort', () => compactAc.abort(), { once: true });
              }
              if (compactAc.signal.aborted) return;
              const summarizeWithModel = async (inputText, meta = {}) => {
                if (compactAc.signal.aborted || (bgCtx && bgCtx.aborted)) return '';
                const sumPrompt = meta.kind === 'state'
                  ? `${config.NON_CODING_FRAME}\n` +
                    `请根据以下旧状态卡、幕级摘要与近期归档重写常驻状态卡（严格 ≤ ${Math.round(archive.STATE_MAX_BYTES / 1024)}KB）。\n` +
                    '只输出当前仍然有效的状态（人物关系/持有物/位置/未兑现承诺/未回收伏笔），不要过程叙述。只输出状态卡正文：\n\n' +
                    inputText
                  : `${config.NON_CODING_FRAME}\n` +
                    `请将以下第 ${meta.startFloor || 1}-${meta.endFloor || 20} 层剧情归档合并压缩为一段幕级摘要（不超过 500 字），` +
                    '保留关键事件、关系与状态变化、未回收伏笔，只输出摘要正文：\n\n' +
                    inputText;
                let sumModel = SUMMARY_MODEL;
                const tried = new Set([sumModel]);
                let sumRes = await runTurn({
                  prompt: sumPrompt,
                  model: sumModel,
                  effort: 'low',
                  home: compactHome,
                  cwd: ensureSysWorkspace(),
                  signal: compactAc.signal,
                });
                while (sumRes.code !== 0 && !sumRes.text && !compactAc.signal.aborted && !(bgCtx && bgCtx.aborted)) {
                  const fb = pickFallback(sumModel, sumRes.stderr, tried);
                  if (!fb) break;
                  tried.add(fb);
                  sumModel = fb;
                  sumRes = await runTurn({
                    prompt: sumPrompt,
                    model: sumModel,
                    effort: 'low',
                    home: compactHome,
                    cwd: ensureSysWorkspace(),
                    signal: compactAc.signal,
                  });
                }
                if (compactAc.signal.aborted || (bgCtx && bgCtx.aborted) || sumRes.code !== 0 || !sumRes.text) return '';
                return archive.extractRecord(sumRes.text || '').clean.trim();
              };
              const compactRes = await archive.compactLayeredState(workspaceDir, {
                turns,
                summarize: summarizeWithModel,
              });
              if (compactRes && compactRes.stateUpdated && !compactAc.signal.aborted) {
                const st = session.loadState();
                const rec = st[sessionKey];
                if (rec && typeof rec === 'object') {
                  rec.stateDirty = true;
                  if (Array.isArray(rec.branches)) {
                    const targetB = rec.branches.find((b) => b && b.branchId === branchId);
                    if (targetB) targetB.stateDirty = true;
                  }
                  session.saveState(st);
                }
              }
            }, {
              priority: 'low',
              onPreempt: () => compactAc.abort(),
            }).catch((err) => {
              log('compactLayeredState error:', err && err.message ? err.message : err);
            });
          }, debounceMs);
          if (typeof timer.unref === 'function') timer.unref();
          compactTimers.set(compactKey, timer);
        };

        const postTurnAlias = (floors.length === 1 && trimmedReply)
          ? session.aliasKey([{ role: 'system', content: sysText }, floors[0], { role: 'assistant', content: trimmedReply }])
          : null;
        const latestState = session.loadState();
        const prevRec = latestState[sessionKey] || rawSess || {};
        const candidateKeys = Array.from(new Set([
          ...(Array.isArray(prevRec.keys) ? prevRec.keys : []),
          ...(Array.isArray(branch.keys) ? branch.keys : []),
          ...(Array.isArray(resolved.keys) ? resolved.keys : []),
          postTurnAlias,
        ].filter(Boolean)));
        const mergedKeys = candidateKeys.filter((k) => {
          if (latestState[k] && k !== sessionKey) return false;
          for (const [otherKey, otherRec] of Object.entries(latestState)) {
            if (otherKey === sessionKey) continue;
            if (otherRec && Array.isArray(otherRec.keys) && otherRec.keys.includes(k)) {
              return false;
            }
          }
          return true;
        });

        const now = Date.now();
        const committedConvId = forceDeepNext ? null : (r.conversationId || convIdToUse || null);

        const nextAccounts = {};
        if (prevRec && prevRec.accounts && typeof prevRec.accounts === 'object') {
          for (const [accName, accObj] of Object.entries(prevRec.accounts)) {
            if (accObj && typeof accObj === 'object') {
              nextAccounts[accName] = { convId: accObj.convId != null ? accObj.convId : null };
            }
          }
        }
        if (branch && branch.accounts && typeof branch.accounts === 'object') {
          for (const [accName, accObj] of Object.entries(branch.accounts)) {
            if (accObj && typeof accObj === 'object') {
              if (!nextAccounts[accName] || accObj.convId != null) {
                nextAccounts[accName] = { convId: accObj.convId != null ? accObj.convId : null };
              }
            }
          }
        }
        nextAccounts[activeAccount] = { convId: committedConvId };

        const mergedCooldowns = {
          ...(prevRec && prevRec.accountCooldown && typeof prevRec.accountCooldown === 'object' ? prevRec.accountCooldown : {}),
          ...(branch && branch.accountCooldown && typeof branch.accountCooldown === 'object' ? branch.accountCooldown : {}),
          ...sessionCooldowns,
        };

        const updatedBranch = {
          branchId,
          activeAccount,
          accounts: nextAccounts,
          convId: committedConvId,
          hashes: syncedHashes,
          turns,
          dir: workspaceDir,
          model: modelUsed,
          lastUsedAt: now,
          swipeStreak: nextSwipeStreak,
          stateDirty: nextStateDirty,
          missingRecordStreak: nextMissingRecordStreak,
          keys: mergedKeys,
          lastPostText: currentPostText,
          ...(Object.keys(mergedCooldowns).length > 0 ? { accountCooldown: mergedCooldowns } : {}),
          ...(numberedFloorCount > 0 ? { numberedFloorCount } : {}),
          ...(hasAppendedReply ? { hasAppendedReply: true } : {}),
        };
        const finalBranches = branches.map((b) => (b.branchId === branchId ? updatedBranch : b));

        latestState[sessionKey] = {
          activeAccount,
          accounts: JSON.parse(JSON.stringify(nextAccounts)),
          convId: committedConvId,
          ...(Object.keys(mergedCooldowns).length > 0 ? { accountCooldown: mergedCooldowns } : {}),
          branches: finalBranches,
          lastBranchId: branchId,
          keys: mergedKeys,
          stateDirty: nextStateDirty,
          missingRecordStreak: nextMissingRecordStreak,
          lastPostText: currentPostText,
          ...(prevRec.sysHead || resolved.sysHead ? { sysHead: prevRec.sysHead || resolved.sysHead } : {}),
          updatedAt: now,
        };
        session.saveState(latestState);
        out.finish(r.usage);
        scheduleBackgroundCompact();

        log('turn done(session)', {
          key: sessionKey,
          account: activeAccount,
          branchId,
          branchAction,
          drift: drift.kind,
          convId: committedConvId,
          turns,
          forceDeepNext,
          hasRecord: record !== null,
          ...(isContinue ? { continue: true } : {}),
          ms: Date.now() - t0,
        });
      }, { onPreempt: () => ac.abort() });
    } catch (e) {
      clearInterval(keepAlive);
      log('turn error:', e.message);
      const isBusy = e instanceof BusyError || Boolean(e && (e.name === 'BusyError' || e.code === 'EBUSY'));
      const statusCode = (e && Number.isInteger(e.statusCode)) ? e.statusCode : (isBusy ? 429 : 500);
      out.error(e.message, statusCode);
    }
  });
});

if (require.main === module) {
  server.on('error', (err) => {
    console.error(`[fatal] listen failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  });

  server.listen(config.PORT, config.HOST, () => {
    log(`agy-bridge v5 listening on http://${config.HOST}:${config.PORT} (mode=${isSessionMode() ? 'session' : 'stateless'})`);
  });
} else {
  server.on('error', () => {});
}

module.exports = {
  server,
  queue,
  trySeedTimeline,
  enforceHardGate: session.enforceHardGate,
  enforceChunkGate,
  splitOversizedText,
  computePostBlocksDiff: session.computePostBlocksDiff,
  splitBootstrapForWarmup,
  buildBootstrapSections,
  refreshModels,
  compactTimers,
  cancelCompactTimers,
  accountCooldowns,
  isQuotaError,
  isCapacityError,
  pickFallback,
  getConfiguredAccounts,
  parseModelForStateless,
  isHeuristicStatelessRequest,
  buildStatelessChannelPrompt,
  pruneOrphans: session.pruneOrphans,
};
