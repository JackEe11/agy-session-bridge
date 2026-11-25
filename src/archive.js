'use strict';

const fs = require('fs');
const path = require('path');

const OPEN_TAG = '<ta_record>';
const CLOSE_TAG = '</ta_record>';
const HOLDBACK_BYTES = 24;

function stripTrailingTagPrefix(s) {
  if (!s) return '';
  const openPrefixIdx = s.indexOf('<ta_');
  if (openPrefixIdx !== -1) {
    return s.slice(0, openPrefixIdx);
  }
  for (let len = OPEN_TAG.length - 1; len >= 2; len--) {
    const prefix = OPEN_TAG.slice(0, len);
    if (s.endsWith(prefix)) {
      return s.slice(0, s.length - len);
    }
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
 * 必须能处理标签被拆到多个 delta 的情况（保留尾部 24 字节 holdback）。
 */
function recordFilter() {
  let buf = '';
  let inRecord = false;

  function drain(isFlush) {
    let out = '';
    while (buf.length > 0) {
      if (!inRecord) {
        const openIdx = buf.indexOf(OPEN_TAG);
        if (openIdx !== -1) {
          out += buf.slice(0, openIdx);
          buf = buf.slice(openIdx + OPEN_TAG.length);
          inRecord = true;
          continue;
        }
        if (isFlush) {
          out += stripTrailingTagPrefix(buf);
          buf = '';
          break;
        }
        const totalBytes = Buffer.byteLength(buf, 'utf8');
        if (totalBytes <= HOLDBACK_BYTES) {
          break;
        }
        const safeFront = truncateUtf8(buf, totalBytes - HOLDBACK_BYTES);
        if (!safeFront) {
          break;
        }
        out += safeFront;
        buf = buf.slice(safeFront.length);
        break;
      } else {
        const closeIdx = buf.indexOf(CLOSE_TAG);
        if (closeIdx !== -1) {
          buf = buf.slice(closeIdx + CLOSE_TAG.length);
          inRecord = false;
          continue;
        }
        if (isFlush) {
          buf = '';
          inRecord = false;
          break;
        }
        const totalBytes = Buffer.byteLength(buf, 'utf8');
        if (totalBytes > HOLDBACK_BYTES) {
          buf = tailUtf8(buf, HOLDBACK_BYTES);
        }
        break;
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
  const re = /<ta_record>([\s\S]*?)<\/ta_record>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    records.push(m[1].trim());
  }
  if (records.length === 0) {
    return { clean: src, record: null };
  }
  const clean = src.replace(/<ta_record>[\s\S]*?<\/ta_record>/g, '').trim();
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
 * @returns {string}
 */
function readTimeline(timelinePath, maxBytes) {
  if (!timelinePath) return '';
  let raw = '';
  try {
    if (!fs.existsSync(timelinePath)) return '';
    raw = fs.readFileSync(timelinePath, 'utf8');
  } catch {
    return '';
  }
  if (!raw) return '';
  const limit = Number(maxBytes);
  if (!limit || limit <= 0 || Buffer.byteLength(raw, 'utf8') <= limit) {
    return raw;
  }

  const segments = parseTimelineSegments(raw);
  if (segments.length === 0) {
    return tailUtf8(raw, limit);
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
    return tailUtf8(raw, limit);
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
