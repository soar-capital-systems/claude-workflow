import assert from 'node:assert/strict';
import test from 'node:test';
import { codexTurnInput, CODEX_TURN_INPUT_MAX_CHARS as limit } from '../js/gateway/codex-text-input.js';

test('ordinary inputs retain their original turn/start representation', () => {
  for (const text of ['', 'small', 'x'.repeat(limit)]) {
    assert.deepEqual(codexTurnInput(text), { input: [{ type: 'text', text }] });
  }
});

test('oversized transcripts travel intact as untrusted context, with a bounded input', () => {
  for (const text of ['x'.repeat(limit + 1), 'x'.repeat(limit - 1) + '😀' + 'tail', 'مرحبا😀'.repeat(180000)]) {
    const request = codexTurnInput(text);
    assert.ok(request.input[0].text.length < limit);
    const entries = Object.entries(request.additionalContext).sort(([a], [b]) => a.localeCompare(b));
    assert.equal(entries.map(([, entry]) => entry.value).join(''), text);
    assert.ok(entries.every(([, entry]) => entry.kind === 'untrusted' && Buffer.byteLength(entry.value) <= 3000 && entry.value.isWellFormed()));
  }
});
