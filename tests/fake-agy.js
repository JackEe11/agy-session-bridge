#!/usr/bin/env node
'use strict';
/**
 * fake-agy.js v4 —— 假 agy，多模式
 *   slow / failhard / failmid / missing / normal
 * normal：输出一行含「中文测试」的 step_update，并把该行 UTF-8 字节从「中」中间切开分两次写
 */
function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

let input = '';
process.stdin.on('data', (c) => { input += c.toString('utf8'); });
process.stdin.on('end', () => {
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

  emit({ event: 'init', conversation_id: 'fake-conv-1', init: {} });
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
    emit({ event: 'result', result: { conversation_id: 'fake-conv-1', status: 'SUCCESS', response: '', usage: {} } });
    process.exit(0);
  }, 40);
});
