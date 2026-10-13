import test from 'node:test'
import assert from 'node:assert/strict'
import { deriveTrace } from '../data-model.js'

const assistant = (turn, step, seq, blocks, timing = {}) => ({
  kind: 'assistant', turn, step, seq, time: timing.completedTime ?? seq,
  blocks, timing: { stepStartTime: timing.stepStartTime ?? seq - 10, firstTokenTime: timing.firstTokenTime ?? seq - 5, completedTime: timing.completedTime ?? seq },
  providerMetadata: { provider: 'test-provider', model: 'test-model' },
  usage: timing.usage,
})
const toolCall = (callId, name = 'read') => ({ kind: 'tool-call', callId, name, argsRaw: '{"path":"/tmp/x"}' })

function snapshot(overrides = {}) {
  return { eventNodes: [], eventLocations: new Map(), requests: [], runningCalls: [], partial: null, ...overrides }
}

test('maps finalized tool results to assistant turn and generation parent without tool.turn', () => {
  const result = { kind: 'tool-result', seq: 30, callId: 'c1', name: 'read', args: {}, call: { name: 'read', argsRaw: '{}' }, callTime: 120, time: 180, content: [{ type: 'text', text: 'ok' }], isError: false, subCalls: [] }
  const node = assistant(1, 1, 20, [toolCall('c1')], { stepStartTime: 100, firstTokenTime: 110, completedTime: 120, usage: { inputTokens: 4, outputTokens: 2, cacheReadTokens: 3, reasoningTokens: 1 } })
  const trace = deriveTrace(snapshot({ eventNodes: [node, result] }))
  assert.equal(trace.turns.length, 1)
  const [generation, tool] = trace.turns[0].spans
  assert.equal(generation.type, 'generation')
  assert.equal(tool.type, 'tool')
  assert.equal(tool.parentId, generation.id)
  assert.equal(tool.started, 120)
  assert.equal(tool.completed, 180)
  assert.equal(tool.duration, 60)
  assert.equal(generation.ttft, 10)
  assert.deepEqual(trace.turns[0].usage, { input: 4, output: 2, cacheRead: 3, cacheWrite: null, reasoning: 1, total: null })
})

test('recursively emits nested delegation spans and preserves running calls', () => {
  const nested = { kind: 'tool-result', seq: 50, callId: 'child', parentCallId: 'root', name: 'delegate', callTime: 210, time: 240, args: {}, call: { name: 'delegate', argsRaw: '{}' }, content: [], isError: false, subCalls: [] }
  const root = { kind: 'tool-result', seq: 40, callId: 'root', name: 'agent', callTime: 200, time: 260, args: {}, call: { name: 'agent', argsRaw: '{}' }, content: [], isError: false, subCalls: [nested] }
  const node = assistant(2, 1, 30, [toolCall('root', 'agent')], { stepStartTime: 190, completedTime: 200, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
  const running = { phase: 'start', callId: 'live', name: 'shell', turn: 2, step: 2, time: 270, argsRaw: 'pwd', subCalls: [] }
  const trace = deriveTrace(snapshot({ eventNodes: [node, root], runningCalls: [running] }))
  const spans = trace.turns.find((turn) => turn.turn === 2).spans.filter((span) => span.type !== 'generation' || span.id === 'generation-2-1')
  assert.deepEqual(spans.map((span) => [span.type, span.name, span.parentId]), [
    ['generation', 'Step 1', null],
    ['tool', 'agent', 'generation-2-1'],
    ['delegation', 'delegate', 'tool-root'],
    ['tool', 'shell', 'generation-2-2'],
  ])
  assert.equal(spans.at(-1).status, 'running')
  assert.equal(trace.incompleteHistory, true)
})

test('uses eventLocations and sequencing to title turns, marking unresolved history', () => {
  const user = { kind: 'user', seq: 5, time: 5, content: [{ type: 'text', text: '  Explain   this bug  ' }], source: {} }
  const node = assistant(3, 1, 10, [], { stepStartTime: 8, completedTime: 20 })
  const eventLocations = new Map([[5, { kind: 'turn', turn: { turn: 3, status: 'closed' } }]])
  const trace = deriveTrace(snapshot({ eventNodes: [user, node], eventLocations }))
  assert.equal(trace.turns[0].turn, 3)
  assert.equal(trace.turns[0].title, 'Explain this bug')
  assert.equal(trace.turns[0].status, 'complete')

  const orphan = { kind: 'tool-result', seq: 40, callId: 'orphan', name: 'unknown', args: {}, call: null, callTime: null, time: 45, content: [], isError: false, subCalls: [] }
  const orphanTrace = deriveTrace(snapshot({ eventNodes: [orphan] }))
  assert.equal(orphanTrace.incompleteHistory, true)
  assert.match(orphanTrace.warnings.join(' '), /not linked/)
})

test('keeps unknown usage and timestamps null while preserving explicit zero', () => {
  const node = assistant(1, 1, 10, [], { stepStartTime: 0, firstTokenTime: 5, completedTime: 20, usage: { inputTokens: 0, outputTokens: 0 } })
  const request = { purpose: 'assistant', turn: 1, step: 2, startSeq: 11, startedAt: 30, completedAt: null, status: 'running', usage: {} }
  const trace = deriveTrace(snapshot({ eventNodes: [node], requests: [request] }))
  const spans = trace.turns[0].spans
  assert.equal(spans[0].started, 0)
  assert.equal(spans[0].ttft, 5)
  assert.deepEqual(spans[0].usage, { input: 0, output: 0, cacheRead: null, cacheWrite: null, reasoning: null, total: null })
  assert.equal(spans[1].status, 'running')
  assert.equal(spans[1].completed, null)
  assert.equal(spans[1].usage, null)
})

test('attaches messages logged since the previous generation and assistant tool calls', () => {
  const user = { kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: 'hi' }], source: {} }
  const first = assistant(1, 1, 10, [{ kind: 'text', text: 'calling' }, toolCall('c1')])
  const result = { kind: 'tool-result', seq: 12, callId: 'c1', name: 'read', args: {}, call: { name: 'read', argsRaw: '{}' }, callTime: 10, time: 12, content: [{ type: 'text', text: 'file' }], isError: false, subCalls: [] }
  const second = assistant(1, 2, 20, [{ kind: 'text', text: 'done' }])
  const trace = deriveTrace(snapshot({ eventNodes: [user, first, result, second] }))
  const [one, two] = trace.turns[0].spans.filter((span) => span.type === 'generation')
  assert.deepEqual(one.context.map((message) => message.role), ['user'])
  assert.equal(one.contextFromStart, true)
  assert.deepEqual(one.toolCalls, [{ callId: 'c1', name: 'read', args: '{"path":"/tmp/x"}' }])
  assert.deepEqual(two.context.map((message) => [message.role, message.name]), [['tool', 'read']])
  assert.equal(two.contextFromStart, false)
  assert.equal('seqLow' in two, false)
})

test('creates standalone compaction spans and does not double count cache or reasoning', () => {
  const compaction = { purpose: 'compaction', turn: null, step: 0, startSeq: 7, startedAt: 100, completedAt: 130, status: 'complete', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 1 }, summary: [{ type: 'text', text: 'summary' }] }
  const trace = deriveTrace(snapshot({ requests: [compaction] }))
  assert.equal(trace.compactions.length, 1)
  assert.equal(trace.turns[0].turn, null)
  assert.deepEqual(trace.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, reasoning: 1, total: 14 })
  assert.equal(trace.turns[0].spans[0].type, 'compaction')
})

test('marks turns with only failed tool calls as warning and any failed generation as error', () => {
  const failedTool = { kind: 'tool-result', seq: 30, callId: 'c1', name: 'read', args: {}, call: { name: 'read', argsRaw: '{}' }, callTime: 120, time: 180, content: [{ type: 'text', text: 'boom' }], isError: true, subCalls: [] }
  const toolNode = assistant(1, 1, 20, [toolCall('c1')], { stepStartTime: 100, completedTime: 120 })
  const recovered = assistant(1, 2, 40, [{ kind: 'text', text: 'done' }], { stepStartTime: 190, completedTime: 200 })
  const warned = deriveTrace(snapshot({ eventNodes: [toolNode, failedTool, recovered] })).turns[0]
  assert.equal(warned.status, 'warning')
  assert.equal(warned.toolErrorCount, 1)
  assert.equal(warned.generationErrorCount, 0)

  const failedRequest = { purpose: 'assistant', turn: 2, step: 1, startSeq: 50, startedAt: 300, completedAt: 310, status: 'error', usage: {} }
  const retried = assistant(2, 2, 60, [{ kind: 'text', text: 'ok' }], { stepStartTime: 320, completedTime: 330 })
  const failed = deriveTrace(snapshot({ eventNodes: [retried], requests: [failedRequest] })).turns[0]
  assert.equal(failed.status, 'error')
  assert.equal(failed.generationErrorCount, 1)
})

test('shows tool-call warnings on a turn that is still running', () => {
  const failedTool = { kind: 'tool-result', seq: 30, callId: 'c1', name: 'read', args: {}, call: { name: 'read', argsRaw: '{}' }, callTime: 120, time: 180, content: [], isError: true, subCalls: [] }
  const node = assistant(1, 1, 20, [toolCall('c1')], { stepStartTime: 100, completedTime: 120 })
  const running = { phase: 'start', callId: 'live', name: 'shell', turn: 1, step: 2, time: 200, argsRaw: 'pwd', subCalls: [] }
  const turn = deriveTrace(snapshot({ eventNodes: [node, failedTool], runningCalls: [running] })).turns[0]
  assert.equal(turn.status, 'warning')
})
