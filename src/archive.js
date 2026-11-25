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
    segments.push({ floor: cur.floor, body });
  }
  return segments;
}

/**
 * 文件格式：每条前面写 "<!-- floor: N -->"，写入前删除所有 floor >= N 的段
 */
function upsertFloor(timelinePath, floor, record) {
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

  fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
  fs.writeFileSync(timelinePath, out, 'utf8');
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

module.exports = {
  recordFilter,
  extractRecord,
  upsertFloor,
  readTimeline,
};
