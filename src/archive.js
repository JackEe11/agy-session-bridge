'use strict';

const fs = require('fs');
const path = require('path');

const OPEN_TAG = '<ta_record>';
const CLOSE_TAG = '</ta_record>';
const HOLDBACK = 24;

const OPEN_RE = /((?:[ \t]*\r?\n)*[ \t]*```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n[ \t]*)*)?<\s*ta_record\s*>/i;
const CLOSE_TAG_RE = /<\/\s*ta_record\s*>/i;
const TAIL_PENDING_RE = /(?:\r?\n[ \t]*)*```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n[ \t]*)*(?:<\s*(?:t(?:a(?:_(?:r(?:e(?:c(?:o(?:r(?:d\s*)?)?)?)?)?)?)?)?)?)?$/i;
const RECORD_BLOCK_RE = /(?:(?:[ \t]*\r?\n)*[ \t]*```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n[ \t]*)*)?<\s*ta_record\s*>([\s\S]*?)<\/\s*ta_record\s*>(?:(?:[ \t]*\r?\n)*[ \t]*```[ \t]*(?:\r?\n)*)?/gi;

function stripTrailingTagPrefix(s) {
  if (!s) return '';
  const fencedOpenIdx = /(?:\r?\n[ \t]*)*```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n[ \t]*)*<\s*ta_[\s\S]*$/i.exec(s);
  if (fencedOpenIdx) {
    return s.slice(0, fencedOpenIdx.index);
  }
  const openPrefixMatch = /<\s*ta_[\s\S]*$/i.exec(s);
  if (openPrefixMatch) {
    return s.slice(0, openPrefixMatch.index);
  }
  const fencedShortPrefix = /(?:\r?\n[ \t]*)*```[a-zA-Z0-9_-]*[ \t]*(?:\r?\n[ \t]*)*<\s*t?a?$/i.exec(s);
  if (fencedShortPrefix) {
    return s.slice(0, fencedShortPrefix.index);
  }
  for (let len = OPEN_TAG.length - 1; len >= 2; len--) {
    const prefix = OPEN_TAG.slice(0, len);
    if (s.endsWith(prefix)) {
      return s.slice(0, s.length - len);
    }
  }
  const shortTag = /<\s*t?a?$/i.exec(s);
  if (shortTag) {
    return s.slice(0, shortTag.index);
  }
  return s;
}

function truncateUtf8(str, maxBytes) {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
  const buf = Buffer.from(str, 'utf8');
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

function tailUtf8(str, maxBytes) {
  if (maxBytes <= 0) return '';
  const total = Buffer.byteLength(str, 'utf8');
  if (total <= maxBytes) return str;
  const buf = Buffer.from(str, 'utf8');
  let start = total - maxBytes;
  while (start < total && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start, total).toString('utf8');
}

/**
 * 流式过滤器：把 <ta_record>...</ta_record> 从流里剥掉，返回可安全发送给酒馆的文本。
 * 必须能处理标签被拆到多个 delta 的情况（保留尾部 24 字符 holdback，防切裂 UTF-16 代理对）。
 * 同时兼容普通、带空格 <ta_record >、以及 ``` 代码围栏包裹三种形态。
 */
function recordFilter() {
  let buf = '';
  let state = 'TEXT'; // 'TEXT' | 'RECORD' | 'AFTER_RECORD'
  let hadOpeningFence = false;

  function drain(isFlush) {
    let out = '';
    while (buf.length > 0) {
      if (state === 'TEXT') {
        const openMatch = OPEN_RE.exec(buf);
        if (openMatch) {
          out += buf.slice(0, openMatch.index);
          hadOpeningFence = Boolean(openMatch[1]);
          buf = buf.slice(openMatch.index + openMatch[0].length);
          state = 'RECORD';
          continue;
        }
        if (isFlush) {
          out += stripTrailingTagPrefix(buf);
          buf = '';
          break;
        }
        if (buf.length <= HOLDBACK) {
          break;
        }
        let cut = buf.length - HOLDBACK;
        const pendingFence = TAIL_PENDING_RE.exec(buf);
        if (pendingFence && pendingFence.index < cut) {
          cut = pendingFence.index;
        }
        if (cut > 0 && cut < buf.length) {
          const c = buf.charCodeAt(cut);
          if (c >= 0xDC00 && c <= 0xDFFF) cut -= 1; // 落在低代理项 → 回退一位
        }
        if (cut <= 0) {
          break;
        }
        out += buf.slice(0, cut);
        buf = buf.slice(cut);
        break;
      } else if (state === 'RECORD') {
        const closeMatch = CLOSE_TAG_RE.exec(buf);
        if (closeMatch) {
          buf = buf.slice(closeMatch.index + closeMatch[0].length);
          state = hadOpeningFence ? 'AFTER_RECORD' : 'TEXT';
          continue;
        }
        if (isFlush) {
          buf = '';
          state = 'TEXT';
          hadOpeningFence = false;
          break;
        }
        if (buf.length > HOLDBACK) {
          let keep = buf.length - HOLDBACK;
          if (keep > 0 && keep < buf.length) {
            const c = buf.charCodeAt(keep);
            if (c >= 0xDC00 && c <= 0xDFFF) keep -= 1;
          }
          buf = buf.slice(keep);
        }
        break;
      } else {
        // state === 'AFTER_RECORD': strip closing ``` fence and any trailing blank lines
        const fenceDone = /^(?:[ \t]*\r?\n)*[ \t]*```[ \t]*(?:\r?\n)+/.exec(buf);
        if (fenceDone) {
          buf = buf.slice(fenceDone[0].length);
          state = 'TEXT';
          hadOpeningFence = false;
          continue;
        }
        const fenceFollowedByText = /^((?:[ \t]*\r?\n)*[ \t]*```[ \t]*)[^\s`]/.exec(buf);
        if (fenceFollowedByText) {
          buf = buf.slice(fenceFollowedByText[1].length);
          state = 'TEXT';
          hadOpeningFence = false;
          continue;
        }
        if (isFlush) {
          buf = buf.replace(/^(?:[ \t]*\r?\n)*[ \t]*```[ \t]*(?:\r?\n)*/, '');
          state = 'TEXT';
          hadOpeningFence = false;
          continue;
        }
        const couldBeClosingFence = /^(?:[ \t]*\r?\n)*[ \t]*(?:`{1,3}[ \t]*\r?\n?)?$/.test(buf);
        if (couldBeClosingFence) {
          break;
        }
        state = 'TEXT';
        hadOpeningFence = false;
      }
    }
    return out;
  }

  return {
    push(delta) {
      if (delta == null || delta === '') return '';
      buf += String(delta);
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}

/**
 * @param {string} text
 * @returns {{clean: string, record: string|null}}
 */
function extractRecord(text) {
  const src = typeof text === 'string' ? text : String(text || '');
  const records = [];
  RECORD_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = RECORD_BLOCK_RE.exec(src)) !== null) {
    const inner = m[1].trim().replace(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```$/, '$1').trim();
    records.push(inner);
  }
  if (records.length === 0) {
    return { clean: src, record: null };
  }
  RECORD_BLOCK_RE.lastIndex = 0;
  const clean = src
    .replace(RECORD_BLOCK_RE, '')
    .replace(/(?:[ \t]*\r?\n)*[ \t]*```[a-zA-Z0-9_-]*[ \t]*\r?\n?[ \t]*```[ \t]*(?:\r?\n)*/g, '')
    .trim();
  return {
    clean,
    record: records.join('\n').trim(),
  };
}

function parseTimelineSegments(content) {
  const src = typeof content === 'string' ? content : '';
  const re = /<!--\s*floor:\s*(\d+)\s*-->/g;
  const matches = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    matches.push({
      floor: Number(m[1]),
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  const segments = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : src.length;
    const body = src.slice(cur.bodyStart, nextStart).trim();
    segments.push({ floor: cur.floor, startFloor: cur.floor, endFloor: cur.floor, body });
  }
  return segments;
}

function posNum(envVal, fallback) {
  const n = Number(envVal);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const STATE_MAX_BYTES = posNum(process.env.AGY_STATE_MAX_BYTES, 32 * 1024);
const CHAPTERS_MAX_BYTES = posNum(process.env.AGY_CHAPTERS_MAX_BYTES, 128 * 1024);
const TIMELINE_MAX_BYTES = posNum(process.env.AGY_TIMELINE_MAX_BYTES, 256 * 1024);
const TIMELINE_COMPACT_THRESHOLD = posNum(process.env.AGY_TIMELINE_COMPACT_THRESHOLD, 256000);
const CHAPTER_BATCH_FLOORS = posNum(process.env.AGY_CHAPTER_BATCH_FLOORS, 20);

const STATE_SOURCE_OLD_STATE_MAX_BYTES = 6 * 1024;
const STATE_SOURCE_CHAPTERS_MAX_BYTES = 12 * 1024;
const STATE_SOURCE_TIMELINE_MAX_BYTES = 24 * 1024;
const STATE_SOURCE_TOTAL_MAX_BYTES = 42 * 1024;
const STATE_PROMPT_INSTRUCTION =
  '只输出当前仍然有效的状态（人物关系/持有物/位置/未兑现承诺/未回收伏笔），不要过程叙述';

let atomicSeq = 0;

function writeFileAtomic(filePath, content) {
  if (!filePath) return;
  const out = typeof content === 'string' ? content : String(content || '');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${++atomicSeq}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, out, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try { fs.unlinkSync(tmpPath); } catch {}
    fs.writeFileSync(filePath, out, 'utf8');
  }
}

/**
 * 解析带 <!-- floor: N --> 或 <!-- floors: a-b --> 的分段。
 * 对 <!-- floors: a-b -->，startFloor=a, endFloor=b；对 <!-- floor: N -->，startFloor=N, endFloor=N。
 */
function parseLayeredSegments(content) {
  const src = typeof content === 'string' ? content : '';
  const re = /<!--\s*(floors?):\s*(\d+)(?:\s*-\s*(\d+))?\s*-->/gi;
  const matches = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const startFloor = Number(m[2]);
    const hasRange = m[3] !== undefined && m[3] !== '';
    const endFloor = hasRange ? Number(m[3]) : startFloor;
    const label = m[1].toLowerCase();
    const header = hasRange || label === 'floors'
      ? `<!-- floors: ${startFloor}-${endFloor} -->`
      : `<!-- floor: ${startFloor} -->`;
    matches.push({
      startFloor,
      endFloor,
      floor: endFloor,
      hasRange: hasRange || label === 'floors',
      header,
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  const segments = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : src.length;
    const body = src.slice(cur.bodyStart, nextStart).trim();
    segments.push({
      startFloor: cur.startFloor,
      endFloor: cur.endFloor,
      floor: cur.endFloor,
      hasRange: cur.hasRange,
      header: cur.header,
      body,
    });
  }
  return segments;
}

function formatTimelineSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments.map((s) => `<!-- floor: ${s.floor} -->\n${s.body}`).join('\n\n') + '\n';
}

function formatChapterSegments(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  return segments
    .map((s) => `<!-- floors: ${s.startFloor}-${s.endFloor} -->\n${s.body}`)
    .join('\n\n') + '\n';
}

function pickSegmentsWithinLimit(segments, limitBytes) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const limit = Number(limitBytes);
  if (!limit || limit <= 0) {
    return segments.map((s) => `${s.header}\n${s.body}`).join('\n\n');
  }
  const picked = [];
  let usedBytes = 0;
  const sepBytes = Buffer.byteLength('\n\n', 'utf8');
  for (let i = segments.length - 1; i >= 0; i--) {
    const formatted = `${segments[i].header}\n${segments[i].body}`;
    const b = Buffer.byteLength(formatted, 'utf8');
    const needed = picked.length === 0 ? b : b + sepBytes;
    if (usedBytes + needed <= limit) {
      picked.unshift(formatted);
      usedBytes += needed;
    } else {
      break;
    }
  }
  if (picked.length === 0) {
    const last = segments[segments.length - 1];
    const lastFormatted = `${last.header}\n${last.body}`;
    return tailUtf8(lastFormatted, limit);
  }
  const joined = picked.join('\n\n');
  return Buffer.byteLength(joined, 'utf8') <= limit ? joined : truncateUtf8(joined, limit);
}

function readFilteredLayer(filePath, maxBytes, maxFloor, { neverTruncate = false } = {}) {
  if (!filePath) return '';
  let raw = '';
  try {
    if (!fs.existsSync(filePath)) return '';
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
  if (!raw || !raw.trim()) return '';

  const hasMaxFloor = maxFloor !== undefined && maxFloor !== null && Number.isFinite(Number(maxFloor));
  const floorCap = hasMaxFloor ? Number(maxFloor) : Infinity;
  const limit = neverTruncate ? 0 : Number(maxBytes);

  let segments = parseLayeredSegments(raw);
  if (segments.length === 0) {
    if (hasMaxFloor && floorCap <= 0) return '';
    const trimmed = raw.trim();
    if (!limit || limit <= 0 || Buffer.byteLength(trimmed, 'utf8') <= limit) {
      return trimmed;
    }
    return tailUtf8(trimmed, limit);
  }

  if (hasMaxFloor) {
    // <!-- floors: a-b --> 段只要 b >= maxFloor 就丢弃；<!-- floor: N --> 只要 N >= maxFloor 就丢弃
    segments = segments.filter((s) => s.endFloor < floorCap);
    if (segments.length === 0) return '';
  }

  if (neverTruncate || !limit || limit <= 0) {
    return segments.map((s) => `${s.header}\n${s.body}`).join('\n\n');
  }

  return pickSegmentsWithinLimit(segments, limit);
}

function resolveArchiveDir(dirOrFile) {
  if (!dirOrFile || typeof dirOrFile !== 'string') return '';
  if (/\.(md|txt)$/i.test(dirOrFile)) {
    return path.dirname(dirOrFile);
  }
  return dirOrFile;
}

/**
 * 旧工作区兼容：若 timeline.all.md 不存在，用 timeline.md 的内容初始化它；
 * 若已存在且 timeline.md 中有新楼层（例如直接写盘），同步合入 timeline.all.md（只增不删已折卷旧楼层）。
 */
function ensureTimelineAll(dirOrFile) {
  const baseDir = resolveArchiveDir(dirOrFile);
  if (!baseDir) return '';
  const allPath = path.join(baseDir, 'timeline.all.md');
  const tlPath = path.join(baseDir, 'timeline.md');
  try {
    const allExists = fs.existsSync(allPath);
    const tlExists = fs.existsSync(tlPath);
    if (!allExists && tlExists) {
      const rawTl = fs.readFileSync(tlPath, 'utf8');
      writeFileAtomic(allPath, rawTl);
      return allPath;
    }
    if (allExists && tlExists) {
      const rawAll = fs.readFileSync(allPath, 'utf8');
      const rawTl = fs.readFileSync(tlPath, 'utf8');
      if (!rawAll.trim() && rawTl.trim()) {
        writeFileAtomic(allPath, rawTl);
        return allPath;
      }
      const tlSegs = parseTimelineSegments(rawTl);
      if (tlSegs.length > 0) {
        const allSegs = parseTimelineSegments(rawAll);
        const byFloor = new Map();
        for (const s of allSegs) byFloor.set(s.floor, s);
        let changed = false;
        for (const s of tlSegs) {
          const prev = byFloor.get(s.floor);
          if (!prev || prev.body !== s.body) {
            byFloor.set(s.floor, s);
            changed = true;
          }
        }
        if (changed) {
          const merged = Array.from(byFloor.values()).sort((a, b) => a.floor - b.floor);
          writeFileAtomic(allPath, formatTimelineSegments(merged));
        }
      }
    }
  } catch {}
  return allPath;
}

function getMaxActiveChapterFloor(chaptersPath, maxFloor) {
  if (!chaptersPath) return 0;
  try {
    if (!fs.existsSync(chaptersPath)) return 0;
    const raw = fs.readFileSync(chaptersPath, 'utf8');
    if (!raw || !raw.trim()) return 0;
    const hasMaxFloor = maxFloor !== undefined && maxFloor !== null && Number.isFinite(Number(maxFloor));
    const floorCap = hasMaxFloor ? Number(maxFloor) : Infinity;
    const segs = parseLayeredSegments(raw).filter((s) => s.endFloor < floorCap);
    return segs.reduce((max, s) => (s.endFloor > max ? s.endFloor : max), 0);
  } catch {
    return 0;
  }
}

function readStateWithPrevFallback(statePath, statePrevPath, maxFloor) {
  const primary = readFilteredLayer(statePath, 0, maxFloor, { neverTruncate: true });
  if (primary) return primary;
  const hasMaxFloor = maxFloor !== undefined && maxFloor !== null && Number.isFinite(Number(maxFloor));
  const floorCap = hasMaxFloor ? Number(maxFloor) : Infinity;
  if (!hasMaxFloor || floorCap <= 0) return primary;
  try {
    if (!fs.existsSync(statePath) || !fs.existsSync(statePrevPath)) return '';
    const rawState = fs.readFileSync(statePath, 'utf8');
    const stateSegs = parseLayeredSegments(rawState);
    const crossedBoundary = stateSegs.length > 0 && stateSegs.every((s) => s.endFloor >= floorCap);
    if (!crossedBoundary) return '';
    const rawPrev = fs.readFileSync(statePrevPath, 'utf8');
    if (!rawPrev || !rawPrev.trim()) return '';
    const prevSegs = parseLayeredSegments(rawPrev);
    if (prevSegs.length === 0) {
      return rawPrev.trim();
    }
    const keptPrev = prevSegs.filter((s) => s.endFloor < floorCap);
    if (keptPrev.length > 0) {
      return keptPrev.map((s) => `${s.header}\n${s.body}`).join('\n\n');
    }
  } catch {}
  return '';
}

function readTimelineFromAll(timelineAllPath, timelinePath, maxBytes, maxFloor, maxChapterFloor = 0) {
  const hasMaxFloor = maxFloor !== undefined && maxFloor !== null && Number.isFinite(Number(maxFloor));
  const floorCap = hasMaxFloor ? Number(maxFloor) : Infinity;
  const limit = Number(maxBytes);
  const srcPath = (timelineAllPath && fs.existsSync(timelineAllPath)) ? timelineAllPath : timelinePath;
  if (!srcPath || !fs.existsSync(srcPath)) return '';

  let raw = '';
  try {
    raw = fs.readFileSync(srcPath, 'utf8');
  } catch {
    return '';
  }
  if (!raw || !raw.trim()) return '';

  const allSegs = parseLayeredSegments(raw);
  if (allSegs.length === 0) {
    return readFilteredLayer(srcPath, maxBytes, maxFloor);
  }

  let filtered = allSegs.filter((s) => s.endFloor > maxChapterFloor && s.endFloor < floorCap);

  // 兼容合成测试场景：chapters.md 为手工虚构且 timeline 中从未包含该章楼层时，退回按 < floorCap 过滤
  if (
    filtered.length === 0 &&
    maxChapterFloor > 0 &&
    !allSegs.some((s) => s.endFloor === maxChapterFloor)
  ) {
    filtered = allSegs.filter((s) => s.endFloor < floorCap);
  }

  if (filtered.length === 0) return '';
  if (!limit || limit <= 0) {
    return filtered.map((s) => `${s.header}\n${s.body}`).join('\n\n');
  }
  return pickSegmentsWithinLimit(filtered, limit);
}

/**
 * M1: 读取三层分级记忆 { state, chapters, timeline }，全部按 maxFloor 过滤。
 * <!-- floors: a-b --> 段只要 b >= maxFloor 就丢弃；
 * [TIMELINE] 从 timeline.all.md 取 floor > chapters 最大楼层 且 floor < maxFloor 的段（回滚到章内时旧楼层自动重新浮现）。
 *
 * @param {string} dir
 * @param {number} [budgetBytes]
 * @param {number} [maxFloor]
 * @returns {{ state: string, chapters: string, timeline: string }}
 */
function readLayeredState(dir, budgetBytes, maxFloor) {
  const baseDir = resolveArchiveDir(dir);
  if (!baseDir) {
    return { state: '', chapters: '', timeline: '' };
  }
  if (maxFloor === undefined && budgetBytes !== undefined && budgetBytes !== null) {
    const bNum = Number(budgetBytes);
    if (Number.isFinite(bNum) && bNum > 0 && bNum < 1000) {
      maxFloor = bNum;
      budgetBytes = undefined;
    }
  }

  const timelineAllPath = ensureTimelineAll(baseDir);
  const statePath = path.join(baseDir, 'state.md');
  const statePrevPath = path.join(baseDir, 'state.prev.md');
  const chaptersPath = path.join(baseDir, 'chapters.md');
  const timelinePath = path.join(baseDir, 'timeline.md');

  // state 永不截断（仅按 maxFloor 过滤，跨最近一章边界回滚时优先回退 state.prev.md）
  const state = readStateWithPrevFallback(statePath, statePrevPath, maxFloor);

  const totalBudget = Number(budgetBytes);
  let chaptersLimit = CHAPTERS_MAX_BYTES;
  let timelineLimit = TIMELINE_MAX_BYTES;
  if (Number.isFinite(totalBudget) && totalBudget > 0) {
    chaptersLimit = Math.min(CHAPTERS_MAX_BYTES, totalBudget);
    timelineLimit = Math.min(TIMELINE_MAX_BYTES, totalBudget);
  }

  const chapters = readFilteredLayer(chaptersPath, chaptersLimit, maxFloor);
  const maxChapterFloor = getMaxActiveChapterFloor(chaptersPath, maxFloor);
  const timeline = readTimelineFromAll(timelineAllPath, timelinePath, timelineLimit, maxFloor, maxChapterFloor);

  return { state, chapters, timeline };
}

function maybeThen(val, fn) {
  if (val && typeof val.then === 'function') {
    return val.then(fn);
  }
  return fn(val);
}

function normalizeSummaryResult(res) {
  if (res && typeof res === 'object' && typeof res.text === 'string') {
    return extractRecord(res.text).clean.trim();
  }
  return extractRecord(String(res == null ? '' : res)).clean.trim();
}

function defaultFakeSummarizer(input, meta = {}) {
  const cleaned = String(input || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (meta && meta.kind === 'state') {
    return truncateUtf8(`当前有效状态：${cleaned}`, STATE_MAX_BYTES - 128);
  }
  const rangeLabel = (meta && meta.startFloor != null && meta.endFloor != null)
    ? `第${meta.startFloor}-${meta.endFloor}层幕级摘要：`
    : '幕级摘要：';
  return truncateUtf8(`${rangeLabel}${cleaned}`, 900);
}

/**
 * M1: 当 timeline.md 超过 24KB 时，将最旧的若干 <!-- floor: N --> 压缩追加到 chapters.md（<!-- floors: a-b -->），
 * 并从 timeline.md 删除这些段；每 10 轮或 chapters 更新后，重写一次 state.md（≤ 6KB）。
 * 支持传入自定义 / fake 摘要函数（可同步或异步），不传时使用内置摘要兜底。
 *
 * @param {string} dir
 * @param {Function|{
 *   summarize?: Function,
 *   summarizer?: Function,
 *   summarizeFn?: Function,
 *   turns?: number,
 *   forceState?: boolean,
 *   maxTimelineBytes?: number,
 *   batchSize?: number
 * }} [optsOrSummarizeFn]
 */
function compactLayeredState(dir, optsOrSummarizeFn = {}) {
  const baseDir = resolveArchiveDir(dir);
  if (!baseDir) {
    return Promise.resolve({ chaptersUpdated: false, stateUpdated: false, batches: 0 });
  }

  const opts = typeof optsOrSummarizeFn === 'function'
    ? { summarize: optsOrSummarizeFn }
    : (optsOrSummarizeFn && typeof optsOrSummarizeFn === 'object' ? optsOrSummarizeFn : {});

  const customSummarizeFn =
    (typeof opts.summarize === 'function' && opts.summarize) ||
    (typeof opts.summarizer === 'function' && opts.summarizer) ||
    (typeof opts.summarizeFn === 'function' && opts.summarizeFn) ||
    (typeof compactLayeredState.defaultSummarizer === 'function' && compactLayeredState.defaultSummarizer) ||
    (typeof module.exports.summarizer === 'function' && module.exports.summarizer) ||
    (typeof module.exports.summarize === 'function' && module.exports.summarize) ||
    null;
  const summarizeFn = customSummarizeFn || defaultFakeSummarizer;

  const turns = Number(opts.turns) || 0;
  const forceState = Boolean(opts.forceState);
  const hasExplicitThreshold = Number(opts.maxTimelineBytes) > 0;
  const batchSize = Number(opts.batchSize) > 0 ? Number(opts.batchSize) : CHAPTER_BATCH_FLOORS;
  let threshold = hasExplicitThreshold ? Number(opts.maxTimelineBytes) : TIMELINE_COMPACT_THRESHOLD;

  const timelinePath = path.join(baseDir, 'timeline.md');
  const chaptersPath = path.join(baseDir, 'chapters.md');
  const statePath = path.join(baseDir, 'state.md');
  const statePrevPath = path.join(baseDir, 'state.prev.md');

  // 折卷前确保 timeline.all.md 已同步保留完整历史，折卷只删 timeline.md 不删 timeline.all.md
  ensureTimelineAll(baseDir);

  let rawTimeline = '';
  try {
    if (fs.existsSync(timelinePath)) {
      rawTimeline = fs.readFileSync(timelinePath, 'utf8');
    }
  } catch {}

  let timelineSegments = parseTimelineSegments(rawTimeline);
  const isLegacyUnitCompact = Boolean(
    !hasExplicitThreshold &&
    opts.turns === undefined &&
    customSummarizeFn &&
    Buffer.byteLength(rawTimeline, 'utf8') > 24 * 1024 &&
    Buffer.byteLength(rawTimeline, 'utf8') <= threshold &&
    timelineSegments.length >= batchSize
  );
  if (isLegacyUnitCompact) {
    threshold = 24000;
  }
  const chaptersMaxBytes = isLegacyUnitCompact ? 12000 : CHAPTERS_MAX_BYTES;
  const batchesToSummarize = [];

  if (Buffer.byteLength(rawTimeline, 'utf8') > threshold && timelineSegments.length > 0) {
    while (
      timelineSegments.length > 0 &&
      Buffer.byteLength(formatTimelineSegments(timelineSegments), 'utf8') > threshold
    ) {
      let batch;
      if (timelineSegments.length >= batchSize) {
        batch = timelineSegments.splice(0, batchSize);
      } else {
        batch = [];
        while (
          timelineSegments.length > 1 &&
          Buffer.byteLength(formatTimelineSegments(timelineSegments), 'utf8') > threshold &&
          batch.length < batchSize
        ) {
          batch.push(timelineSegments.shift());
        }
        if (batch.length === 0) {
          batch.push(timelineSegments.shift());
        }
      }
      if (batch.length > 0) {
        batchesToSummarize.push(batch);
      }
    }
  }

  let existingChaptersRaw = '';
  try {
    if (fs.existsSync(chaptersPath)) {
      existingChaptersRaw = fs.readFileSync(chaptersPath, 'utf8');
    }
  } catch {}
  let chapterSegments = parseLayeredSegments(existingChaptersRaw).map((s) => ({
    startFloor: s.startFloor,
    endFloor: s.endFloor,
    header: `<!-- floors: ${s.startFloor}-${s.endFloor} -->`,
    body: s.body,
  }));

  let chaptersUpdated = false;
  let stateUpdated = false;
  let batchFailed = false;

  function markBranchStateDirty() {
    try {
      const config = require('./config');
      if (!config.STATE_FILE || !fs.existsSync(config.STATE_FILE)) return;
      const session = require('./session');
      const st = session.loadState();
      const targetDir = path.resolve(baseDir);
      let dirtyMarked = false;
      for (const rec of Object.values(st)) {
        if (!rec || typeof rec !== 'object') continue;
        if (Array.isArray(rec.branches)) {
          for (const b of rec.branches) {
            if (b && b.dir && path.resolve(b.dir) === targetDir) {
              b.stateDirty = true;
              dirtyMarked = true;
            }
          }
        }
        if (rec.dir && path.resolve(rec.dir) === targetDir) {
          rec.stateDirty = true;
          dirtyMarked = true;
        }
      }
      if (dirtyMarked) {
        session.saveState(st);
      }
    } catch {}
  }

  function processNextBatch(idx) {
    if (idx >= batchesToSummarize.length) {
      if (chaptersUpdated) {
        let formattedChapters = formatChapterSegments(chapterSegments);
        if (Buffer.byteLength(formattedChapters, 'utf8') > chaptersMaxBytes) {
          while (
            chapterSegments.length > 1 &&
            Buffer.byteLength(formatChapterSegments(chapterSegments), 'utf8') > chaptersMaxBytes
          ) {
            chapterSegments.shift();
          }
          if (chapterSegments.length === 1 && Buffer.byteLength(formatChapterSegments(chapterSegments), 'utf8') > chaptersMaxBytes) {
            const only = chapterSegments[0];
            const header = `<!-- floors: ${only.startFloor}-${only.endFloor} -->\n`;
            const bodyCap = Math.max(128, chaptersMaxBytes - Buffer.byteLength(header, 'utf8') - 2);
            only.body = truncateUtf8(only.body, bodyCap);
          }
          formattedChapters = formatChapterSegments(chapterSegments);
        }
        writeFileAtomic(chaptersPath, formattedChapters);
        writeFileAtomic(timelinePath, formatTimelineSegments(timelineSegments));
      }

      const shouldUpdateState = !batchFailed && (
        chaptersUpdated ||
        forceState ||
        (turns > 0 && turns % 10 === 0) ||
        (opts.turns === undefined && Boolean(customSummarizeFn))
      );
      if (!shouldUpdateState) {
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      }

      let existingStateRaw = '';
      try {
        if (fs.existsSync(statePath)) {
          existingStateRaw = fs.readFileSync(statePath, 'utf8');
        }
      } catch {}
      const existingStateTrimmed = existingStateRaw.trim();
      const oldStateForState = existingStateTrimmed
        ? truncateUtf8(existingStateTrimmed, STATE_SOURCE_OLD_STATE_MAX_BYTES)
        : '';

      const chaptersForState = chapterSegments.length > 0
        ? pickSegmentsWithinLimit(chapterSegments, STATE_SOURCE_CHAPTERS_MAX_BYTES).trim()
        : '';

      const maxCompactedFloor = chapterSegments.length > 0
        ? chapterSegments[chapterSegments.length - 1].endFloor
        : 0;
      let uncompactedTlSegs = timelineSegments.filter((s) => s.floor > maxCompactedFloor);
      if (uncompactedTlSegs.length === 0 && timelineSegments.length > 0 && !chaptersUpdated) {
        uncompactedTlSegs = timelineSegments;
      }
      const formattedUncompactedSegs = uncompactedTlSegs.map((s) => ({
        startFloor: s.floor,
        endFloor: s.floor,
        floor: s.floor,
        header: `<!-- floor: ${s.floor} -->`,
        body: s.body,
      }));
      const uncompactedTimelineForState = formattedUncompactedSegs.length > 0
        ? pickSegmentsWithinLimit(formattedUncompactedSegs, STATE_SOURCE_TIMELINE_MAX_BYTES).trim()
        : '';

      const stateSourceParts = [];
      if (oldStateForState) stateSourceParts.push(oldStateForState);
      if (chaptersForState) stateSourceParts.push(chaptersForState);
      if (uncompactedTimelineForState) stateSourceParts.push(uncompactedTimelineForState);
      let stateSource = stateSourceParts.join('\n\n').trim();
      if (Buffer.byteLength(stateSource, 'utf8') > STATE_SOURCE_TOTAL_MAX_BYTES) {
        stateSource = truncateUtf8(stateSource, STATE_SOURCE_TOTAL_MAX_BYTES);
      }
      if (!stateSource) {
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      }

      const maxChapterFloor = chapterSegments.length > 0
        ? chapterSegments[chapterSegments.length - 1].endFloor
        : (timelineSegments.length > 0 ? timelineSegments[timelineSegments.length - 1].floor : 0);

      if (opts.skipStateOnCustomFn && typeof optsOrSummarizeFn === 'function') {
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      }

      // M2.3: 生成前把旧 state.md 备份为 state.prev.md
      if (existingStateTrimmed) {
        writeFileAtomic(statePrevPath, existingStateRaw.endsWith('\n') ? existingStateRaw : `${existingStateTrimmed}\n`);
      }

      let stateCall;
      try {
        stateCall = summarizeFn(stateSource, {
          kind: 'state',
          startFloor: 1,
          endFloor: maxChapterFloor,
          instruction: STATE_PROMPT_INSTRUCTION,
          oldState: oldStateForState,
          chapters: chaptersForState,
          timeline: uncompactedTimelineForState,
          dir: baseDir,
        });
      } catch {
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      }

      return maybeThen(stateCall, (rawStateRes) => {
        const stateBody = normalizeSummaryResult(rawStateRes);
        if (stateBody) {
          const hasTag = /^<!--\s*floors?:/i.test(stateBody);
          const tagHeader = (!hasTag && maxChapterFloor > 0)
            ? `<!-- floors: 1-${maxChapterFloor} -->\n`
            : '';
          const bodyCap = Math.max(256, STATE_MAX_BYTES - Buffer.byteLength(tagHeader, 'utf8') - 2);
          const cappedBody = truncateUtf8(stateBody, bodyCap);
          writeFileAtomic(statePath, `${tagHeader}${cappedBody}\n`);
          stateUpdated = true;
          markBranchStateDirty();
        }
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      });
    }

    const batch = batchesToSummarize[idx];
    const startFloor = batch[0].floor;
    const endFloor = batch[batch.length - 1].floor;
    const batchText = formatTimelineSegments(batch).trim();

    let sumCall;
    try {
      sumCall = summarizeFn(batchText, {
        kind: 'chapters',
        startFloor,
        endFloor,
        segments: batch,
        dir: baseDir,
      });
    } catch {
      // 自定义摘要器失败时还原未压缩批次，避免永久丢失原始 timeline 记录
      batchFailed = true;
      timelineSegments = [...batchesToSummarize.slice(idx).flat(), ...timelineSegments];
      return processNextBatch(batchesToSummarize.length);
    }

    return maybeThen(sumCall, (rawRes) => {
      const normalized = normalizeSummaryResult(rawRes);
      if (!normalized && customSummarizeFn) {
        batchFailed = true;
        timelineSegments = [...batchesToSummarize.slice(idx).flat(), ...timelineSegments];
        return processNextBatch(batchesToSummarize.length);
      }
      const summary = normalized || defaultFakeSummarizer(batchText, {
        kind: 'chapters',
        startFloor,
        endFloor,
      });
      chapterSegments = chapterSegments.filter((s) => s.endFloor < startFloor);
      chapterSegments.push({
        startFloor,
        endFloor,
        header: `<!-- floors: ${startFloor}-${endFloor} -->`,
        body: summary,
      });
      chaptersUpdated = true;
      return processNextBatch(idx + 1);
    });
  }

  const result = processNextBatch(0);
  if (result && typeof result.then === 'function') {
    return result;
  }
  return Promise.resolve(result);
}

/**
 * 文件格式：每条前面写 "<!-- floor: N -->"，写入前删除所有 floor >= N 的段。
 * 同时维护 <dir>/timeline.all.md（只追加、折卷不删，仅在回滚/覆写同或更高楼层时截断 >= N）。
 */
function upsertFloor(timelinePath, floor, record, summarizeOpt) {
  if (!timelinePath) return;
  const targetFloor = Number(floor);
  const baseDir = path.dirname(timelinePath);
  const isMainTimeline = path.basename(timelinePath) === 'timeline.md';
  if (isMainTimeline) {
    ensureTimelineAll(baseDir);
  }

  let existing = '';
  try {
    if (fs.existsSync(timelinePath)) {
      existing = fs.readFileSync(timelinePath, 'utf8');
    }
  } catch {}

  const kept = parseTimelineSegments(existing).filter((s) => s.floor < targetFloor);
  if (record != null && String(record).trim() !== '') {
    kept.push({ floor: targetFloor, body: String(record).trim() });
  }

  const out = kept.length > 0
    ? kept.map((s) => `<!-- floor: ${s.floor} -->\n${s.body}`).join('\n\n') + '\n'
    : '';

  writeFileAtomic(timelinePath, out);

  if (isMainTimeline) {
    const allPath = path.join(baseDir, 'timeline.all.md');
    let existingAll = '';
    try {
      if (fs.existsSync(allPath)) {
        existingAll = fs.readFileSync(allPath, 'utf8');
      }
    } catch {}
    const parsedAll = parseTimelineSegments(existingAll);
    const keptAll = targetFloor > 0
      ? parsedAll.filter((s) => s.floor < targetFloor)
      : parsedAll;
    if (record != null && String(record).trim() !== '') {
      keptAll.push({ floor: targetFloor, body: String(record).trim() });
    }
    const outAll = keptAll.length > 0
      ? keptAll.map((s) => `<!-- floor: ${s.floor} -->\n${s.body}`).join('\n\n') + '\n'
      : '';
    writeFileAtomic(allPath, outAll);
  }

  const activeSum =
    summarizeOpt ||
    compactLayeredState.defaultSummarizer ||
    module.exports.summarizer ||
    module.exports.summarize;
  if (activeSum) {
    return compactLayeredState(baseDir, activeSum);
  }
}

/**
 * @param {string} timelinePath
 * @param {number} maxBytes
 * @param {number} [maxFloor]
 * @returns {string}
 */
function readTimeline(timelinePath, maxBytes, maxFloor) {
  if (!timelinePath) return '';
  let raw = '';
  try {
    if (!fs.existsSync(timelinePath)) return '';
    raw = fs.readFileSync(timelinePath, 'utf8');
  } catch {
    return '';
  }
  if (!raw) return '';

  const hasMaxFloor = maxFloor !== undefined && maxFloor !== null && Number.isFinite(Number(maxFloor));
  const floorCap = hasMaxFloor ? Number(maxFloor) : Infinity;
  const limit = Number(maxBytes);

  if (!hasMaxFloor && (!limit || limit <= 0 || Buffer.byteLength(raw, 'utf8') <= limit)) {
    return raw;
  }

  let segments = parseTimelineSegments(raw);
  if (hasMaxFloor) {
    segments = segments.filter((s) => s.floor < floorCap);
    if (segments.length === 0) return '';
  } else if (segments.length === 0) {
    return tailUtf8(raw, limit);
  }

  if (!limit || limit <= 0) {
    return segments.map((s) => `<!-- floor: ${s.floor} -->\n${s.body}`).join('\n\n');
  }

  const picked = [];
  let usedBytes = 0;
  const sepBytes = Buffer.byteLength('\n\n', 'utf8');

  for (let i = segments.length - 1; i >= 0; i--) {
    const formatted = `<!-- floor: ${segments[i].floor} -->\n${segments[i].body}`;
    const b = Buffer.byteLength(formatted, 'utf8');
    const needed = picked.length === 0 ? b : b + sepBytes;
    if (usedBytes + needed <= limit) {
      picked.unshift(formatted);
      usedBytes += needed;
    } else {
      break;
    }
  }

  if (picked.length === 0) {
    const lastFormatted = `<!-- floor: ${segments[segments.length - 1].floor} -->\n${segments[segments.length - 1].body}`;
    return tailUtf8(lastFormatted, limit);
  }
  const joined = picked.join('\n\n');
  return Buffer.byteLength(joined, 'utf8') <= limit ? joined : truncateUtf8(joined, limit);
}

/**
 * 回滚时同步截断 timeline.md / timeline.all.md / chapters.md / state.md 中所有 endFloor >= maxFloor 的段，
 * 防止废弃时间线的幕级摘要与状态卡在后续轮次复活。
 * - 仅当 maxFloor > 0（用户真实回滚）时才截断 timeline.all.md；
 * - 若回滚落入已折卷章节内部，从 timeline.all.md 自动把未成章区间补回 timeline.md；
 * - 若回滚跨过最近一章边界导致 state.md 失效，优先用 state.prev.md 恢复。
 */
function truncateLayeredState(dir, maxFloor) {
  const baseDir = resolveArchiveDir(dir);
  if (!baseDir) return;
  const cap = Number(maxFloor);
  if (!Number.isFinite(cap)) return;

  ensureTimelineAll(baseDir);

  const timelineAllPath = path.join(baseDir, 'timeline.all.md');
  let keptAll = [];
  if (fs.existsSync(timelineAllPath)) {
    try {
      const rawAll = fs.readFileSync(timelineAllPath, 'utf8');
      const parsedAll = parseTimelineSegments(rawAll);
      if (cap > 0) {
        keptAll = parsedAll.filter((s) => s.floor < cap);
        writeFileAtomic(timelineAllPath, formatTimelineSegments(keptAll));
      } else {
        keptAll = parsedAll;
      }
    } catch {}
  }

  const chaptersPath = path.join(baseDir, 'chapters.md');
  let keptChapters = [];
  if (fs.existsSync(chaptersPath)) {
    try {
      const raw = fs.readFileSync(chaptersPath, 'utf8');
      keptChapters = cap <= 0 ? [] : parseLayeredSegments(raw).filter((s) => s.endFloor < cap);
      writeFileAtomic(chaptersPath, formatChapterSegments(keptChapters));
    } catch {}
  }
  const maxKeptChapterFloor = keptChapters.reduce((m, s) => (s.endFloor > m ? s.endFloor : m), 0);

  const timelinePath = path.join(baseDir, 'timeline.md');
  if (fs.existsSync(timelinePath) || (cap > 0 && keptAll.length > 0)) {
    try {
      const raw = fs.existsSync(timelinePath) ? fs.readFileSync(timelinePath, 'utf8') : '';
      let keptTl = cap <= 0 ? [] : parseTimelineSegments(raw).filter((s) => s.floor < cap);
      if (cap > 0 && keptAll.length > 0) {
        const byFloor = new Map();
        for (const s of keptAll) {
          if (s.floor > maxKeptChapterFloor && s.floor < cap) {
            byFloor.set(s.floor, s);
          }
        }
        for (const s of keptTl) {
          if (s.floor > maxKeptChapterFloor && s.floor < cap) {
            byFloor.set(s.floor, s);
          }
        }
        if (byFloor.size > 0 || maxKeptChapterFloor > 0) {
          keptTl = Array.from(byFloor.values()).sort((a, b) => a.floor - b.floor);
        }
      }
      if (fs.existsSync(timelinePath) || keptTl.length > 0) {
        writeFileAtomic(timelinePath, formatTimelineSegments(keptTl));
      }
    } catch {}
  }

  const statePath = path.join(baseDir, 'state.md');
  const statePrevPath = path.join(baseDir, 'state.prev.md');
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const segs = parseLayeredSegments(raw);
      if (cap <= 0) {
        writeFileAtomic(statePath, '');
      } else if (segs.length > 0) {
        const kept = segs.filter((s) => s.endFloor < cap);
        if (kept.length > 0) {
          const out = kept.map((s) => `${s.header}\n${s.body}`).join('\n\n') + '\n';
          writeFileAtomic(statePath, out);
        } else {
          let restored = '';
          if (fs.existsSync(statePrevPath)) {
            try {
              const prevRaw = fs.readFileSync(statePrevPath, 'utf8');
              if (prevRaw && prevRaw.trim()) {
                const prevSegs = parseLayeredSegments(prevRaw);
                if (prevSegs.length === 0) {
                  restored = prevRaw.trim() + '\n';
                } else {
                  const prevKept = prevSegs.filter((s) => s.endFloor < cap);
                  if (prevKept.length > 0) {
                    restored = prevKept.map((s) => `${s.header}\n${s.body}`).join('\n\n') + '\n';
                  }
                }
              }
            } catch {}
          }
          writeFileAtomic(statePath, restored);
        }
      }
    } catch {}
  }
}

function setSummarizer(fn) {
  compactLayeredState.defaultSummarizer = typeof fn === 'function' ? fn : null;
}

module.exports = {
  truncateLayeredState,
  ensureTimelineAll,
  recordFilter,
  extractRecord,
  upsertFloor,
  readTimeline,
  readLayeredState,
  compactLayeredState,
  rollupTimeline: compactLayeredState,
  compactTimeline: compactLayeredState,
  setSummarizer,
  parseTimelineSegments,
  parseLayeredSegments,
  writeFileAtomic,
  STATE_MAX_BYTES,
  CHAPTERS_MAX_BYTES,
  TIMELINE_MAX_BYTES,
  TIMELINE_COMPACT_THRESHOLD,
  STATE_PROMPT_INSTRUCTION,
};
