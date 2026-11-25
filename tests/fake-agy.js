#!/usr/bin/env node
'use strict';
/**
 * fake-agy.js —— 假 agy（用于无额度测试）
 * 用法：prompt 里含 "slow" 则长睡（测试抢占）；否则输出带「中文测试」的 step_update，
 *       并把该行的 UTF-8 字节故意从多字节字符中间切开，分两次写。
 */
function emit(o) { process.stdout.write(JSON.stringify(o) + '\n'); }

let input = '';
process.stdin.on('data', (c) => { input += c.toString('utf8'); });
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'fake-conv-1', init: { cwd: process.cwd(), tools: [] } });

  if (input.includes('slow')) {
    setTimeout(() => process.exit(0), 30000);
    return;
  }

  const compact = process.env.AGY_CLI_AUTO_COMPACT_OVERRIDE || '(unset)';
  const line = JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 1, state: 'ACTIVE', step_type: 'agent_response',
      text_delta: '中文测试 COMPACT=' + compact,
    },
  }) + '\n';
  const buf = Buffer.from(line, 'utf8');

  // 找到「中」的起始字节，并在它后面 1 字节处切开（制造跨块多字节）
  const idx = buf.indexOf(Buffer.from('中', 'utf8'));
  const cut = idx >= 0 ? idx + 1 : Math.floor(buf.length / 2);

  process.stdout.write(buf.subarray(0, cut));
  setTimeout(() => {
    process.stdout.write(buf.subarray(cut));
    emit({ event: 'result', result: { conversation_id: 'fake-conv-1', status: 'SUCCESS', response: '', usage: { input_tokens: 1, output_tokens: 1 } } });
    process.exit(0);
  }, 40);
});
