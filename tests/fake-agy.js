#!/usr/bin/env node
'use strict';
/**
 * fake-agy.js v4 —— 假 agy，多模式
 *   slow / failhard / failmid / missing / normal
 * normal：输出一行含「中文测试」的 step_update，并把该行 UTF-8 字节从「中」中间切开分两次写
 */
function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

if (process.argv.includes('/quota')) {
  process.stdout.write(
    'default\tweekly\t89%\t2026-12-01T00:00:00Z\n' +
    'default\t5h\t100%\t2026-11-26T10:00:00Z\n'
  );
  process.exit(0);
}
if (process.argv.includes('models')) {
  process.stdout.write(
    'gemini-4-argon-high\tGemini 4 Argon (High)\n' +
    'gemini-4-argon-low\tGemini 4 Argon (Low)\n'
  );
  process.exit(0);
}

let input = '';
process.stdin.on('data', (c) => { input += c.toString('utf8'); });
process.stdin.on('end', () => {
  // 桥接把 prompt 走 stdin，因此 /quota 也会从 stdin 到达
  if (input.includes('/quota')) {
    process.stdout.write(
      'Gemini Models\tWeekly Limit Remaining\t88%\t2026-12-01T14:05:49Z\n' +
      'Gemini Models\tFive Hour Limit Remaining\t100%\t2026-11-26T09:50:11Z\n'
    );
    process.exit(0);
  }

  const fs = require('fs');
  const convArgIdx = process.argv.indexOf('--conversation');
  const passedConvId = (convArgIdx >= 0 && process.argv[convArgIdx + 1]) ? process.argv[convArgIdx + 1] : null;
  const modelArgIdx = process.argv.indexOf('--model');
  const passedModel = (modelArgIdx >= 0 && process.argv[modelArgIdx + 1]) ? process.argv[modelArgIdx + 1] : null;

  let callSeq = 1;
  if (process.env.FAKE_AGY_LOG) {
    try {
      if (fs.existsSync(process.env.FAKE_AGY_LOG)) {
        const prev = fs.readFileSync(process.env.FAKE_AGY_LOG, 'utf8');
        callSeq = prev.split('\n').filter((l) => l.trim().length > 0).length + 1;
      }
    } catch {}
  }

  const outConvId = passedConvId || process.env.FAKE_AGY_CONV_ID || (process.env.FAKE_AGY_LOG ? `fake-conv-${callSeq}` : 'fake-conv-1');

  if (process.env.FAKE_AGY_LOG) {
    try {
      const logEntry = JSON.stringify({
        seq: callSeq,
        at: Date.now(),
        model: passedModel,
        conversationId: passedConvId,
        returnedConversationId: outConvId,
        home: process.env.HOME || '',
        bytes: Buffer.byteLength(input, 'utf8'),
        isWarmup: input.includes('上下文分片'),
        prompt: input,
      }) + '\n';
      fs.appendFileSync(process.env.FAKE_AGY_LOG, logEntry, 'utf8');
    } catch {}
  }

  const failHome = process.env.FAKE_QUOTA_FAIL_HOME || '/home/novel';
  if (/quota429_all/.test(input)) {
    process.stderr.write('Error: 429 RESOURCE_EXHAUSTED: Individual quota reached (resets at 2026-11-26T10:00:00Z)\n');
    process.exit(1);
    return;
  }
  if ((/quota429|failmain429/.test(input) || process.env.FAKE_WARMUP_429_MAIN === '1') && process.env.HOME === failHome) {
    process.stderr.write('Error: 429 RESOURCE_EXHAUSTED: Individual quota reached (resets at 2026-11-26T10:00:00Z)\n');
    process.exit(1);
    return;
  }
  if (/cap503_all/.test(input)) {
    process.stderr.write('Error: 503 UNAVAILABLE: capacity overloaded\n');
    process.exit(1);
    return;
  }
  const fail503Model = process.env.FAKE_503_FAIL_MODEL || 'gemini-4-argon-high';
  if (
    (/cap503|fail503/.test(input) || process.env.FAKE_503_MAIN === '1') &&
    (passedModel === fail503Model || passedModel === 'fake')
  ) {
    process.stderr.write('Error: 503 UNAVAILABLE: model capacity overloaded\n');
    process.exit(1);
    return;
  }
  if ((process.env.FAKE_WARMUP_FAIL === '1' || /failwarmup/.test(input)) && input.includes('上下文分片')) {
    process.stderr.write('Error: simulated warmup failure\n');
    process.exit(2);
    return;
  }

  const mode = /ignoreterm/.test(input) ? 'ignoreterm' : /slow/.test(input) ? 'slow'
    : /failhard/.test(input) ? 'failhard'
    : /failmid/.test(input) ? 'failmid'
    : /missing/.test(input) ? 'missing' : 'normal';

  if (mode === 'failhard') { process.exit(3); return; }
  if (mode === 'ignoreterm') {
    process.on('SIGTERM', () => {});
    emit({ event: 'init', conversation_id: 'fake-ignoreterm', init: {} });
    setTimeout(() => process.exit(0), 800);
    return;
  }
  if (mode === 'slow') { emit({ event: 'init', conversation_id: 'fake-slow', init: {} }); setTimeout(() => process.exit(0), 30000); return; }
  if (mode === 'failmid') {
    emit({ event: 'init', conversation_id: 'fake-failmid', init: {} });
    emit({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '半截正文' } });
    setTimeout(() => process.exit(3), 60);
    return;
  }
  if (mode === 'missing') {
    process.stderr.write('warning: conversation "dead-beef" not found\n');
    emit({ event: 'init', conversation_id: 'fake-reborn', init: {} });
    setTimeout(() => {
      emit({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '重建后的回复。' } });
      emit({ event: 'result', result: { conversation_id: 'fake-reborn', status: 'SUCCESS', response: '', usage: {} } });
      process.exit(0);
    }, 50);
    return;
  }

  emit({ event: 'init', conversation_id: outConvId, init: {} });
  const compact = process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE || '(unset)';

  const line = JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 1, state: 'ACTIVE', step_type: 'agent_response',
      text_delta: '正文一段。中文测试 COMPACT=' + compact + '\n\n',
    },
  }) + '\n';
  const buf = Buffer.from(line, 'utf8');
  const idx = buf.indexOf(Buffer.from('中', 'utf8'));
  const cut = idx >= 0 ? idx + 1 : Math.floor(buf.length / 2);

  process.stdout.write(buf.subarray(0, cut));
  setTimeout(() => {
    process.stdout.write(buf.subarray(cut));
    emit({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '<ta_record>时间=夜；地点=书店</ta_record>' } });
    emit({ event: 'result', result: { conversation_id: outConvId, status: 'SUCCESS', response: '', usage: {} } });
    process.exit(0);
  }, 40);
});
