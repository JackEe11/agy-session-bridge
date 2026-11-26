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
 * M1: 读取三层分级记忆 { state, chapters, timeline }，全部按 maxFloor 过滤。
 * <!-- floors: a-b --> 段只要 b >= maxFloor 就丢弃；<!-- floor: N --> 段只要 N >= maxFloor 就丢弃。
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
  const statePath = path.join(baseDir, 'state.md');
  const chaptersPath = path.join(baseDir, 'chapters.md');
  const timelinePath = path.join(baseDir, 'timeline.md');

  // state 永不截断（仅按 maxFloor 过滤）
  const state = readFilteredLayer(statePath, 0, maxFloor, { neverTruncate: true });

  const totalBudget = Number(budgetBytes);
  let chaptersLimit = CHAPTERS_MAX_BYTES;
  let timelineLimit = TIMELINE_MAX_BYTES;
  if (Number.isFinite(totalBudget) && totalBudget > 0) {
    chaptersLimit = Math.min(CHAPTERS_MAX_BYTES, totalBudget);
    timelineLimit = Math.min(TIMELINE_MAX_BYTES, totalBudget);
  }

  const chapters = readFilteredLayer(chaptersPath, chaptersLimit, maxFloor);
  const timeline = readFilteredLayer(timelinePath, timelineLimit, maxFloor);

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

      const shouldUpdateState = chaptersUpdated || forceState || (turns > 0 && turns % 10 === 0);
      if (!shouldUpdateState) {
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      }

      const chaptersForState = formatChapterSegments(chapterSegments).trim();
      const fallbackTimelineForState = formatTimelineSegments(timelineSegments).trim();
      const stateSource = chaptersForState || fallbackTimelineForState;
      if (!stateSource) {
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      }

      const maxChapterFloor = chapterSegments.length > 0
        ? chapterSegments[chapterSegments.length - 1].endFloor
        : (timelineSegments.length > 0 ? timelineSegments[timelineSegments.length - 1].floor : 0);

      if (opts.skipStateOnCustomFn && typeof optsOrSummarizeFn === 'function') {
        return { chaptersUpdated, stateUpdated, batches: batchesToSummarize.length };
      }

      let stateCall;
      try {
        stateCall = summarizeFn(stateSource, {
          kind: 'state',
          startFloor: 1,
          endFloor: maxChapterFloor,
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
      timelineSegments = [...batchesToSummarize.slice(idx).flat(), ...timelineSegments];
      return processNextBatch(batchesToSummarize.length);
    }

    return maybeThen(sumCall, (rawRes) => {
      const normalized = normalizeSummaryResult(rawRes);
      if (!normalized && customSummarizeFn) {
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
 * 文件格式：每条前面写 "<!-- floor: N -->"，写入前删除所有 floor >= N 的段
 */
function upsertFloor(timelinePath, floor, record, summarizeOpt) {
  if (!timelinePath) return;
  const targetFloor = Number(floor);
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

  const activeSum =
    summarizeOpt ||
    compactLayeredState.defaultSummarizer ||
    module.exports.summarizer ||
    module.exports.summarize;
  if (activeSum) {
    return compactLayeredState(path.dirname(timelinePath), activeSum);
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
 * 回滚时同步截断 timeline.md / chapters.md / state.md 中所有 endFloor >= maxFloor 的段，
 * 防止废弃时间线的幕级摘要与状态卡在后续轮次复活。
 */
function truncateLayeredState(dir, maxFloor) {
  const baseDir = resolveArchiveDir(dir);
  if (!baseDir) return;
  const cap = Number(maxFloor);
  if (!Number.isFinite(cap)) return;

  const timelinePath = path.join(baseDir, 'timeline.md');
  if (fs.existsSync(timelinePath)) {
    try {
      const raw = fs.readFileSync(timelinePath, 'utf8');
      const kept = cap <= 0 ? [] : parseTimelineSegments(raw).filter((s) => s.floor < cap);
      writeFileAtomic(timelinePath, formatTimelineSegments(kept));
    } catch {}
  }

  const chaptersPath = path.join(baseDir, 'chapters.md');
  if (fs.existsSync(chaptersPath)) {
    try {
      const raw = fs.readFileSync(chaptersPath, 'utf8');
      const kept = cap <= 0 ? [] : parseLayeredSegments(raw).filter((s) => s.endFloor < cap);
      writeFileAtomic(chaptersPath, formatChapterSegments(kept));
    } catch {}
  }

  const statePath = path.join(baseDir, 'state.md');
  if (fs.existsSync(statePath)) {
    try {
      const raw = fs.readFileSync(statePath, 'utf8');
      const segs = parseLayeredSegments(raw);
      if (cap <= 0) {
        writeFileAtomic(statePath, '');
      } else if (segs.length > 0) {
        const kept = segs.filter((s) => s.endFloor < cap);
        const out = kept.length > 0 ? kept.map((s) => `${s.header}\n${s.body}`).join('\n\n') + '\n' : '';
        writeFileAtomic(statePath, out);
      }
    } catch {}
  }
}

function setSummarizer(fn) {
  compactLayeredState.defaultSummarizer = typeof fn === 'function' ? fn : null;
}

module.exports = {
  truncateLayeredState,
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
};
