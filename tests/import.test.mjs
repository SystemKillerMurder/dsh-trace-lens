import test from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { decodeSessionBytes, parseSessionText, eventsToSnapshot } from '../session-import.js'
import { deriveTrace } from '../data-model.js'

const events = [
  { type: 'session', version: 4, id: 'session-1', createdAt: 1000, cwd: '/w', agentPreset: 'standard' },
  { type: 'turn/start', seq: 1, time: 1001, data: { turn: 1 } },
  { type: 'step/start', seq: 2, time: 1002, data: { turn: 1, step: 1 } },
  { type: 'system/message', seq: 3, time: 1003, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'SYS' }] } } },
  { type: 'user/message', seq: 4, time: 1003, data: { content: [{ type: 'text', text: '列出文件' }], source: { kind: 'user' }, role: 'user' } },
  { type: 'user/message', seq: 5, time: 1003, data: { content: [{ type: 'text', text: 'now' }], source: { kind: 'time-context' }, role: 'user' } },
  { type: 'request/header', seq: 6, time: 1004, data: { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'bash', description: 'run', parameters: {} }] }, reason: 'initial' } },
  { type: 'assistant/message', seq: 7, time: 1100, data: {
    turn: 1, step: 1,
    message: { role: 'assistant', content: [{ type: 'reasoning', text: 'think' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 0, totalTokens: 17 },
    stream: [{ type: 'reasoning-chunks', time0: 1040, index: 0, dt: [0], texts: ['think'] }],
  } },
  { type: 'tool/call', seq: 8, time: 1101, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
  { type: 'tool/result', seq: 9, time: 1150, data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a.txt' }], isError: false } } },
  { type: 'step/end', seq: 10, time: 1151, data: { turn: 1, step: 1 } },
  { type: 'step/start', seq: 11, time: 1152, data: { turn: 1, step: 2 } },
  { type: 'assistant/attempt', seq: 12, time: 1160, data: { turn: 1, step: 2, stream: [{ type: 'chunk', time: 1160, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } } }] } },
  { type: 'turn/end', seq: 13, time: 1170, data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } },
]
const jsonl = events.map((event) => JSON.stringify(event)).join('\n')

test('parses JSONL, JSON arrays, and skips corrupted lines', () => {
  assert.equal(parseSessionText(jsonl).events.length, events.length)
  assert.equal(parseSessionText(JSON.stringify(events)).events.length, events.length)
  assert.equal(parseSessionText(JSON.stringify({ events })).events.length, events.length)
  const broken = parseSessionText(`${jsonl}\n{"type":"tool/res`)
  assert.equal(broken.events.length, events.length)
  assert.equal(broken.invalidLines, 1)
})

test('decodes gzip and zstd by magic number', async () => {
  assert.equal(await decodeSessionBytes(new Uint8Array(gzipSync(jsonl))), jsonl)
  const zstdLike = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 1])
  assert.equal(await decodeSessionBytes(zstdLike, { zstd: () => new TextEncoder().encode('ok') }), 'ok')
  await assert.rejects(decodeSessionBytes(zstdLike), /zstd/)
})

test('converts session events into a trace with prompt, timing, tools, and failures', () => {
  const { snapshot, info } = eventsToSnapshot(events)
  assert.deepEqual([info.id, info.version, info.cwd, info.models], ['session-1', 4, '/w', ['p / m']])
  const trace = deriveTrace(snapshot)
  assert.equal(trace.turns.length, 1)
  const [turn] = trace.turns
  assert.equal(turn.title, '列出文件')
  const [first, second] = turn.spans.filter((span) => span.type === 'generation')
  assert.equal(first.input.system, 'SYS')
  assert.equal(first.input.tools[0].name, 'bash')
  assert.equal(first.duration, 98)
  assert.equal(first.ttft, 38)
  assert.equal(first.usage.cacheRead, 5)
  assert.deepEqual(first.context.map((message) => [message.role, message.name ?? null]), [['user', null], ['context', 'time-context']])
  const tool = turn.spans.find((span) => span.type === 'tool')
  assert.equal(tool.parentId, first.id)
  assert.equal(tool.duration, 49)
  assert.equal(second.status, 'error')
  assert.equal(second.error, 'boom')
  assert.equal(second.metadata.retry, 1)
  assert.equal(turn.status, 'error')
})
