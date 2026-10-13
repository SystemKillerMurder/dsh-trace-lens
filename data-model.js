/**
 * Pure projection from the Trajectory snapshot contract to a Langfuse-lite trace.
 *
 * The Trajectory contract intentionally does not put `turn` on finalized tool
 * results.  This module therefore treats assistant tool-call blocks as the
 * authoritative call-to-step mapping, uses eventLocations when available,
 * recursively expands `subCalls`, and only then falls back to chronology.
 *
 * Time values are epoch milliseconds.  Unknown values are `null` (never zero),
 * while a reported zero token count remains zero.  `usage.input` is the
 * uncached input count; cache counters are separate and are never added to it.
 */

const EMPTY = Object.freeze({
  eventNodes: [], eventLocations: new Map(), requests: [], runningCalls: [], partial: null,
})

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function textOf(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n')
  const item = record(value)
  if (item) {
    if (typeof item.text === 'string') return item.text
    if (typeof item.content === 'string') return item.content
    if (Array.isArray(item.content)) return textOf(item.content)
  }
  return String(value)
}
function duration(started, completed) {
  return started !== null && completed !== null ? Math.max(0, completed - started) : null
}
function valueAt(source, ...keys) {
  const item = record(source)
  if (!item) return undefined
  for (const key of keys) if (item[key] !== undefined) return item[key]
  return undefined
}
function locationTurn(location) {
  const item = record(location)
  if (!item) return null
  if (item.kind === 'step') return finite(item.turn?.turn)
  if (item.kind === 'turn') return finite(item.turn?.turn)
  return null
}
function locationStatus(location) {
  const item = record(location)
  const status = item?.kind === 'step' ? item.turn?.status : item?.kind === 'turn' ? item.turn?.status : null
  return status === 'open' || status === 'closed' || status === 'unknown' ? status : null
}
function keyOf(turn, step) {
  return `${turn}\u0000${step}`
}
function idTurn(turn) {
  return turn === null ? 'standalone' : String(turn)
}

/** Convert a provider usage object without manufacturing missing counters. */
function normalizeUsage(source) {
  const value = record(source?.usage ?? source)
  if (!value) return null
  const field = (name) => finite(value[name])
  const input = field('inputTokens')
  const output = field('outputTokens')
  const cacheRead = field('cacheReadTokens')
  const cacheWrite = field('cacheWriteTokens')
  const reasoning = field('reasoningTokens')
  const total = field('totalTokens')
  // A usage-shaped object with no counters is not usage evidence.
  if ([input, output, cacheRead, cacheWrite, reasoning, total].every((entry) => entry === null)) return null
  return { input, output, cacheRead, cacheWrite, reasoning, total }
}
function addUsage(items) {
  const values = items.filter(Boolean)
  if (!values.length) return null
  const sum = (field) => values.every((item) => item[field] !== null)
    ? values.reduce((total, item) => total + item[field], 0)
    : null
  const input = sum('input')
  const output = sum('output')
  const cacheRead = sum('cacheRead')
  const cacheWrite = sum('cacheWrite')
  const reasoning = sum('reasoning')
  let total = sum('total')
  // Derive a total only when every disjoint counter is known.  In particular,
  // cache and reasoning are not added to input/output a second time.
  if (total === null && [input, output, cacheRead, cacheWrite].every((entry) => entry !== null)) {
    total = input + output + cacheRead + cacheWrite
  }
  return { input, output, cacheRead, cacheWrite, reasoning, total }
}
function assistantOutput(node) {
  const blocks = Array.isArray(node?.blocks) ? node.blocks : []
  return blocks.filter((block) => block?.kind === 'text').map((block) => block.text ?? '').join('\n\n') || null
}
function assistantReasoning(node) {
  const blocks = Array.isArray(node?.blocks) ? node.blocks : []
  return blocks.filter((block) => block?.kind === 'reasoning').map((block) => block.text ?? '').join('\n\n') || null
}
function assistantToolCalls(node) {
  return (Array.isArray(node?.blocks) ? node.blocks : []).filter((block) => block?.kind === 'tool-call' && block.callId)
}
function spanBase(id, parentId, type, name) {
  return {
    id, parentId, type, name: name || type, status: 'unknown', started: null, completed: null,
    duration: null, ttft: null, model: null, provider: null, usage: null, input: null,
    output: null, reasoning: null, error: null, metadata: {},
  }
}

function titleFor(content, turn) {
  const text = textOf(content).trim().replace(/\s+/g, ' ')
  if (!text) return `Turn ${turn === null ? 'standalone' : turn}`
  return text.length > 100 ? `${text.slice(0, 97)}…` : text
}

/**
 * Derive a Langfuse-lite trace from a TrajectorySnapshot-like object.
 *
 * Result contract:
 * - `turns`: `{ id, turn, title, status, started, completed, duration, spans,
 *   usage, input, output, errorCount, generationErrorCount, toolErrorCount }`;
 *   standalone compactions use `turn: null`. `status` is `error` when any
 *   non-tool span failed and `warning` when only tool calls failed.
 * - `spans`: flat span list; each span has `id`, `parentId`, `type`, `name`,
 *   lifecycle/timing, provider/model, usage, input/output/reasoning/error and
 *   metadata. Types are `generation`, `tool`, `delegation`, or `compaction`.
 * - `usage`: aggregate disjoint input/output/cache/reasoning counters, or null.
 *   Missing counters are null; explicit zero remains zero.
 * - `incompleteHistory` and `warnings`: indicate window cuts/orphan evidence.
 *
 * Tool turns are resolved in this order: assistant tool-call block, recursive
 * parent call, eventLocations, call turn, then unknown. Finalized tool results
 * must not be expected to carry `turn` themselves.
 */
export function deriveTrace(input = EMPTY) {
  const snapshot = input && typeof input === 'object' ? input : EMPTY
  const nodes = Array.isArray(snapshot.eventNodes) ? snapshot.eventNodes : []
  const requests = Array.isArray(snapshot.requests) ? snapshot.requests : []
  const runningCalls = Array.isArray(snapshot.runningCalls) ? snapshot.runningCalls : []
  const partial = snapshot.partial ?? null
  const locations = snapshot.eventLocations instanceof Map
    ? snapshot.eventLocations
    : new Map(Object.entries(snapshot.eventLocations ?? {}))
  const warnings = []
  let incompleteHistory = false
  const markIncomplete = (warning) => { incompleteHistory = true; if (warning && !warnings.includes(warning)) warnings.push(warning) }

  const assistants = nodes.filter((node) => node?.kind === 'assistant')
  const users = nodes.filter((node) => node?.kind === 'user')
  const assistantsByStep = new Map(assistants.map((node) => [keyOf(node.turn, node.step), node]))
  const requestsByStep = new Map(requests.filter((request) => request?.purpose === 'assistant')
    .map((request) => [keyOf(request.turn, request.step), request]))
  const firstAssistantAfter = (seq) => assistants.find((node) => finite(node.seq) !== null && node.seq >= seq)
  const lastAssistantBefore = (seq) => [...assistants].reverse().find((node) => finite(node.seq) !== null && node.seq <= seq)
  const turnForSeq = (seq) => locationTurn(locations.get(seq))

  // Tool results and in-flight calls form a recursively nested call graph.
  const callsById = new Map()
  const parentById = new Map()
  const indexCall = (call, parentId = null) => {
    if (!call || typeof call.callId !== 'string' || !call.callId) return
    const existing = callsById.get(call.callId)
    // A finalized ToolResultNode is richer than an in-flight call head.
    if (!existing || (existing.kind !== 'tool-result' && call.kind === 'tool-result')) callsById.set(call.callId, call)
    if (parentId && !parentById.has(call.callId)) parentById.set(call.callId, parentId)
    if (call.parentCallId && !parentById.has(call.callId)) parentById.set(call.callId, call.parentCallId)
    for (const child of Array.isArray(call.subCalls) ? call.subCalls : []) indexCall(child, call.callId)
  }
  for (const node of nodes) if (node?.kind === 'tool-result') indexCall(node)
  for (const call of runningCalls) indexCall(call)

  const toolCallTurn = new Map()
  for (const node of assistants) for (const block of assistantToolCalls(node)) toolCallTurn.set(block.callId, node.turn)
  for (const [callId, call] of callsById) {
    if (!toolCallTurn.has(callId)) {
      const located = call.kind === 'tool-result' ? turnForSeq(call.seq) : finite(call.turn)
      if (located !== null) toolCallTurn.set(callId, located)
    }
  }

  const turnData = new Map()
  const ensureTurn = (turn) => {
    const normalized = turn === undefined || !Number.isFinite(turn) ? null : turn
    if (!turnData.has(normalized)) turnData.set(normalized, {
      turn: normalized, id: `turn-${idTurn(normalized)}`, spans: [], users: [], assistantNodes: [], statusHint: null,
    })
    return turnData.get(normalized)
  }
  const addTurn = (turn, source) => {
    const bucket = ensureTurn(turn)
    if (source?.kind === 'user') bucket.users.push(source)
    if (source?.kind === 'assistant') bucket.assistantNodes.push(source)
    const status = source?.locationStatus
    if (status) bucket.statusHint = status
    return bucket
  }

  // Place user messages from resolved event locations, then chronology.
  for (const user of users) {
    const located = turnForSeq(user.seq)
    const following = firstAssistantAfter(user.seq)
    const turn = located ?? following?.turn ?? (lastAssistantBefore(user.seq)?.turn ?? 0) + 1
    addTurn(turn, user)
  }
  for (const node of assistants) addTurn(node.turn, { ...node, locationStatus: locationStatus(locations.get(node.seq)) })
  if (partial && Number.isFinite(partial.turn)) addTurn(partial.turn)
  for (const request of requests) {
    if (request?.purpose === 'assistant') addTurn(request.turn)
    else if (request?.purpose === 'compaction' && Number.isFinite(request.turn)) addTurn(request.turn)
  }
  for (const call of runningCalls) if (Number.isFinite(call?.turn)) addTurn(call.turn)

  const generationByStep = new Map()
  const allSpans = []
  const pushSpan = (span, turn) => { allSpans.push(span); ensureTurn(turn).spans.push(span); return span }
  const generationSpan = (node, request, source = 'finalized') => {
    const turn = node?.turn ?? request?.turn
    const step = node?.step ?? request?.step ?? 0
    const id = `generation-${idTurn(turn)}-${step}`
    if (generationByStep.has(keyOf(turn, step))) return generationByStep.get(keyOf(turn, step))
    const started = finite(request?.startedAt) ?? finite(node?.timing?.stepStartTime)
    const completed = finite(request?.completedAt) ?? finite(node?.timing?.completedTime) ?? finite(node?.time)
    const firstToken = finite(node?.timing?.firstTokenTime)
    const span = spanBase(id, null, 'generation', `Step ${step}`)
    Object.assign(span, {
      status: request?.status ?? (node?.interrupted ? 'error' : source === 'running' ? 'running' : 'complete'),
      started, completed, duration: duration(started, completed), ttft: firstToken !== null && started !== null ? Math.max(0, firstToken - started) : null,
      model: node?.providerMetadata?.model ?? request?.providerMetadata?.model ?? null,
      provider: node?.providerMetadata?.provider ?? request?.providerMetadata?.provider ?? null,
      usage: normalizeUsage(request?.usage !== undefined ? request : node), input: request?.prompt ?? null, output: node ? assistantOutput(node) : null,
      reasoning: node ? assistantReasoning(node) : null, error: request?.error ?? null,
      toolCalls: node ? assistantToolCalls(node).map((block) => ({ callId: block.callId, name: block.name, args: block.argsRaw ?? null })) : [],
      context: [], config: request?.requestConfig ?? node?.requestConfig ?? request?.prompt?.config ?? null,
      seqLow: finite(request?.startSeq), seqHigh: finite(node?.seq),
      metadata: { turn, step, source, ...(firstToken === null ? {} : { firstTokenTime: firstToken }), ...(request?.retry === undefined ? {} : { retry: request.retry }) },
    })
    generationByStep.set(keyOf(turn, step), span)
    return pushSpan(span, turn)
  }

  for (const node of assistants) generationSpan(node, requestsByStep.get(keyOf(node.turn, node.step)))
  for (const request of requests) {
    if (request?.purpose !== 'assistant') continue
    if (!generationByStep.has(keyOf(request.turn, request.step))) generationSpan(null, request)
  }  for (const call of runningCalls) {
    if (!Number.isFinite(call?.turn) || !Number.isFinite(call?.step) || call.step <= 0) continue
    if (!generationByStep.has(keyOf(call.turn, call.step))) {
      generationSpan({ turn: call.turn, step: call.step, time: null, blocks: [], timing: {} }, null, 'running')
    }
  }

  const spanByCall = new Map()
  const childCalls = new Map()
  for (const [callId, call] of callsById) {
    const parentId = parentById.get(callId) ?? call.parentCallId ?? null
    if (parentId) {
      const list = childCalls.get(parentId) ?? []
      if (!list.includes(callId)) list.push(callId)
      childCalls.set(parentId, list)
    }
  }
  const toolTurn = (callId, call, seen = new Set()) => {
    if (toolCallTurn.has(callId)) return toolCallTurn.get(callId)
    if (seen.has(callId)) return null
    seen.add(callId)
    const parentId = parentById.get(callId) ?? call?.parentCallId
    if (parentId) {
      const inherited = toolTurn(parentId, callsById.get(parentId), seen)
      if (inherited !== null) { toolCallTurn.set(callId, inherited); return inherited }
    }
    const located = call?.kind === 'tool-result' ? turnForSeq(call.seq) : finite(call?.turn)
    if (located !== null) toolCallTurn.set(callId, located)
    return located
  }
  const toolSpan = (callId, call, parentSpanId, generationParentId = null) => {
    if (spanByCall.has(callId)) return spanByCall.get(callId)
    const source = call ?? {}
    const result = source.kind === 'tool-result' ? source : null
    const started = result ? finite(result.callTime) : finite(source.time)
    const completed = finite(result?.time)
    const isRunning = !result && (source.phase === 'preparing' || source.phase === 'start')
    const span = spanBase(`tool-${callId}`, parentSpanId ?? generationParentId, parentSpanId ? 'delegation' : 'tool', source.call?.name ?? source.name ?? 'tool')
    spanByCall.set(callId, span)
    const turn = toolTurn(callId, source)
    Object.assign(span, {
      status: result ? (result.isError ? 'error' : 'complete') : (isRunning ? 'running' : 'unknown'),
      started, completed, duration: duration(started, completed),
      input: result ? (result.call ? result.call.argsRaw : null) : (source.argsRaw ?? source.args ?? null),
      output: result?.content ?? null, error: result?.error ?? null,
      metadata: { callId, ...(source.parentCallId || parentById.get(callId) ? { parentCallId: source.parentCallId ?? parentById.get(callId) } : {}),
        ...(result ? {} : { phase: source.phase ?? null }), ...(result ? {} : { incomplete: true }) },
    })
    if (!turnData.has(turn) && turn === null) markIncomplete(`Call ${callId} has no turn mapping`)
    const generation = generationByStep.get(keyOf(turn, source.step))
    if (!span.parentId && generation) span.parentId = generation.id
    pushSpan(span, turn)
    for (const childId of childCalls.get(callId) ?? []) toolSpan(childId, callsById.get(childId), span.id)
    return span
  }
  // Assistant tool-call blocks are the root mapping even when their result has
  // no turn property in the finalized trajectory node.
  for (const node of assistants) {
    const generation = generationByStep.get(keyOf(node.turn, node.step))
    for (const block of assistantToolCalls(node)) {
      const result = callsById.get(block.callId)
      const source = result === undefined ? block : {
        ...block,
        ...result,
        name: result.name || block.name,
        call: result.call ?? { name: block.name, argsRaw: block.argsRaw ?? null },
      }
      toolSpan(block.callId, source, null, generation?.id ?? null)
    }
  }
  // Add calls with no assistant block (history windows and orphan results).
  for (const [callId, call] of callsById) {
    if (spanByCall.has(callId)) continue
    const parentId = parentById.get(callId) ?? call.parentCallId ?? null
    if (parentId && callsById.has(parentId)) toolSpan(callId, call, spanByCall.get(parentId)?.id ?? null)
    else {
      toolSpan(callId, call, null)
      markIncomplete(`Call ${callId} is not linked to an assistant tool-call`)
    }
  }

  // Compaction requests are spans, including compactions that ran between turns.
  const compactionSpans = []
  for (const request of requests.filter((item) => item?.purpose === 'compaction')) {
    const turn = Number.isFinite(request.turn) ? request.turn : turnForSeq(request.startSeq)
    const span = spanBase(`compaction-${request.startSeq}`, null, 'compaction', 'Compaction')
    Object.assign(span, {
      status: request.status ?? 'unknown', started: finite(request.startedAt), completed: finite(request.completedAt),
      duration: duration(finite(request.startedAt), finite(request.completedAt)), model: request.providerMetadata?.model ?? null,
      provider: request.providerMetadata?.provider ?? null, usage: normalizeUsage(request), input: request.prompt ?? null,
      output: request.summary ?? request.rawOutput ?? null, error: request.error ?? null,
      metadata: { turn, replacementSeq: request.replacementSeq ?? null },
    })
    compactionSpans.push(span)
    pushSpan(span, turn)
  }

  // Each generation receives the model-visible messages logged since the
  // previous generation: user, steering, context, and root tool results.
  const contextNodes = nodes.filter((node) => finite(node?.seq) !== null && (
    node.kind === 'user' || node.kind === 'steering' || node.kind === 'context'
    || (node.kind === 'tool-result' && !node.parentCallId)
  ))
  const generations = [...generationByStep.values()].sort((a, b) =>
    (a.seqLow ?? a.seqHigh ?? Infinity) - (b.seqLow ?? b.seqHigh ?? Infinity))
  let previousBound = -Infinity
  for (const span of generations) {
    // Inputs for a request are logged after its step opens, so the upper bound is the assistant message.
    const bound = span.seqHigh ?? Infinity
    span.context = contextNodes.filter((node) => node.seq > previousBound && node.seq < bound).map((node) => {
      if (node.kind === 'tool-result') {
        return { role: 'tool', name: node.name || node.call?.name || 'tool', callId: node.callId, content: node.content ?? [], isError: Boolean(node.isError) }
      }
      if (node.kind === 'context') return { role: 'context', name: node.producer?.name ?? null, content: node.content ?? [] }
      return { role: node.kind, content: node.content ?? [] }
    })
    span.contextFromStart = previousBound === -Infinity
    previousBound = span.seqHigh ?? bound
    delete span.seqLow
    delete span.seqHigh
  }

  // Resolve orphan chronology and turn status after all spans exist.
  const orderedTurns = [...turnData.values()].sort((left, right) => {
    if (left.turn === null) return 1
    if (right.turn === null) return -1
    return left.turn - right.turn
  })
  const turnResults = orderedTurns.map((bucket) => {
    const spans = [...bucket.spans].sort((a, b) => (a.started ?? a.completed ?? Infinity) - (b.started ?? b.completed ?? Infinity))
    const starts = spans.map((span) => span.started).filter((value) => value !== null)
    const ends = spans.map((span) => span.completed).filter((value) => value !== null)
    // A failed model call fails the turn; tool errors only raise a warning. Both outrank running.
    const failed = spans.filter((span) => span.status === 'error')
    const toolErrorCount = failed.filter((span) => span.type === 'tool' || span.type === 'delegation').length
    const errorCount = failed.length
    const generationErrorCount = errorCount - toolErrorCount
    const status = generationErrorCount > 0 ? 'error'
      : toolErrorCount > 0 ? 'warning'
        : spans.some((span) => span.status === 'running') || bucket.statusHint === 'open' ? 'running'
          : bucket.statusHint === 'closed' || spans.length > 0 ? 'complete' : 'unknown'
    if (bucket.statusHint === 'unknown') markIncomplete(`Turn ${bucket.turn ?? 'standalone'} has unresolved location`)
    const usage = addUsage(spans.filter((span) => span.type === 'generation' || span.type === 'compaction').map((span) => span.usage))
    const input = bucket.users.length ? bucket.users.map((user) => user.content).flat() : null
    const output = bucket.assistantNodes.length ? bucket.assistantNodes.map((node) => assistantOutput(node)).filter(Boolean).join('\n\n') || null : null
    return {
      id: bucket.id, turn: bucket.turn, title: titleFor(bucket.users[0]?.content, bucket.turn), status,
      started: starts.length ? Math.min(...starts) : null, completed: ends.length ? Math.max(...ends) : null,
      duration: starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : null,
      spans, usage, input, output, errorCount, generationErrorCount, toolErrorCount,
    }
  })
  const usage = addUsage(turnResults.map((turn) => turn.usage))
  return { turns: turnResults, spans: allSpans, usage, incompleteHistory, warnings, compactions: compactionSpans }
}

