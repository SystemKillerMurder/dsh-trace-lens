/**
 * Offline import of a DSH session log (for example one exported from a server)
 * into the TrajectorySnapshot-like object consumed by `deriveTrace`.
 *
 * Accepted inputs: JSONL session logs (`session.v4.jsonl`), their zstd or gzip
 * compressed files, a JSON array of events, or `{ events: [...] }`.
 * Nothing is written to the local session store.
 */

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const GZIP_MAGIC = [0x1f, 0x8b]

function hasMagic(bytes, magic) {
  return magic.every((value, index) => bytes[index] === value)
}

/**
 * Decode raw file bytes into UTF-8 text, decompressing zstd or gzip by magic number.
 * @param {Uint8Array} bytes - file contents.
 * @param {{ zstd?: (bytes: Uint8Array) => Uint8Array }} codecs - zstd decoder.
 * @returns {Promise<string>} decoded text.
 */
export async function decodeSessionBytes(bytes, codecs = {}) {
  if (hasMagic(bytes, ZSTD_MAGIC)) {
    if (typeof codecs.zstd !== 'function') throw new Error('缺少 zstd 解码器')
    return new TextDecoder().decode(codecs.zstd(bytes))
  }
  if (hasMagic(bytes, GZIP_MAGIC)) {
    if (typeof DecompressionStream !== 'function') throw new Error('当前环境不支持 gzip 解压')
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Parse session log text into events.
 * @param {string} text - JSONL, JSON array, or `{ events }` JSON.
 * @returns {{ events: object[], invalidLines: number }} parsed events and skipped lines.
 */
export function parseSessionText(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('[')) {
    const value = JSON.parse(trimmed)
    return { events: value.filter(isEvent), invalidLines: 0 }
  }
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    const value = JSON.parse(trimmed)
    const list = Array.isArray(value.events) ? value.events : Array.isArray(value.entries) ? value.entries : [value]
    return { events: list.filter(isEvent), invalidLines: 0 }
  }
  const events = []
  let invalidLines = 0
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (isEvent(value)) events.push(value)
      else invalidLines += 1
    } catch (error) {
      // A truncated or corrupted line is counted and skipped; the rest of the log stays usable.
      void error
      invalidLines += 1
    }
  }
  if (events.length === 0 && trimmed.startsWith('{')) {
    const value = JSON.parse(trimmed)
    const list = Array.isArray(value.events) ? value.events : Array.isArray(value.entries) ? value.entries : []
    return { events: list.filter(isEvent), invalidLines: 0 }
  }
  return { events, invalidLines }
}

function isEvent(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string'
}

function textOfContent(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n')
}

function stepKey(turn, step) {
  return `${turn}\u0000${step}`
}

function assistantBlocks(content) {
  return (Array.isArray(content) ? content : []).map(block => {
    if (block?.type === 'text') return { kind: 'text', text: block.text ?? '' }
    if (block?.type === 'reasoning') return { kind: 'reasoning', text: block.text ?? '' }
    if (block?.type === 'tool-call') return { kind: 'tool-call', callId: block.id, name: block.name, argsRaw: block.arguments ?? '' }
    if (block?.type === 'image') return { kind: 'image', attachment: block.attachment }
    return { kind: 'other', block }
  })
}

function firstTokenTime(stream) {
  let first = null
  for (const entry of Array.isArray(stream) ? stream : []) {
    let time = null
    if (typeof entry?.type === 'string' && entry.type.endsWith('-chunks') && typeof entry.time0 === 'number') {
      const pieces = entry.texts ?? entry.args ?? []
      if (pieces.some(piece => typeof piece === 'string' && piece !== '')) time = entry.time0
    } else if (entry?.type === 'chunk' && typeof entry.time === 'number' && /delta$/.test(entry.chunk?.type ?? '')) {
      time = entry.time
    }
    if (time !== null && (first === null || time < first)) first = time
  }
  return first
}

function attemptFailure(stream) {
  for (const entry of Array.isArray(stream) ? stream : []) {
    const reason = entry?.chunk?.type === 'finish' ? entry.chunk.reason : null
    if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) return reason.failure?.message ?? reason.kind
  }
  return null
}

/**
 * Convert session events into the TrajectorySnapshot fields `deriveTrace` reads.
 * @param {object[]} events - session log events, in any order.
 * @returns {{ snapshot: object, info: object }} snapshot plus session summary.
 */
export function eventsToSnapshot(events) {
  const header = events.find(event => event.type === 'session') ?? null
  const ordered = events.filter(event => event.type !== 'session' && Number.isFinite(event.seq))
    .sort((left, right) => left.seq - right.seq)
  const eventNodes = []
  const eventLocations = new Map()
  const requests = []
  const requestByStep = new Map()
  const calls = new Map()
  const compactions = new Map()
  const closedTurns = new Set()
  const turnEndReasons = new Map()
  const turnOfSeq = new Map()
  const models = new Set()
  const types = new Map()
  let requestHeader = null
  let systemText = ''
  let openTurn = null
  let title = null
  let pendingUserSeqs = []

  const locate = (seq, turn) => { turnOfSeq.set(seq, turn) }
  const currentRequest = () => [...requestByStep.values()].reverse().find(request => request.completedAt === null) ?? null

  for (const event of ordered) {
    const data = event.data ?? {}
    types.set(event.type, (types.get(event.type) ?? 0) + 1)
    switch (event.type) {
      case 'turn/start':
        openTurn = data.turn
        for (const seq of pendingUserSeqs) locate(seq, openTurn)
        pendingUserSeqs = []
        break
      case 'turn/end':
        closedTurns.add(data.turn)
        turnEndReasons.set(data.turn, data.reason ?? null)
        openTurn = null
        break
      case 'step/start': {
        const request = {
          purpose: 'assistant', turn: data.turn, step: data.step, startSeq: event.seq,
          startedAt: event.time, completedAt: null, status: 'running',
          prompt: { config: requestHeader?.config ?? null, system: systemText, tools: requestHeader?.tools ?? [] },
        }
        requestByStep.set(stepKey(data.turn, data.step), request)
        requests.push(request)
        break
      }
      case 'system/message': {
        systemText = textOfContent(data.message?.content)
        const request = requestByStep.get(stepKey(data.turn, data.step))
        if (request) request.prompt = { ...request.prompt, system: systemText }
        break
      }
      case 'request/header': {
        requestHeader = data.header ?? null
        const request = currentRequest()
        if (request) request.prompt = { ...request.prompt, config: requestHeader?.config ?? null, tools: requestHeader?.tools ?? [] }
        break
      }
      case 'session/title':
        if (typeof data.title === 'string') title = data.title
        break
      case 'user/message':
      case 'developer/message': {
        const message = event.type === 'user/message' ? data : data.message ?? {}
        const sourceKind = message.source?.kind ?? (event.type === 'developer/message' ? 'developer' : 'user')
        const content = Array.isArray(message.content) ? message.content : []
        const human = event.type === 'user/message' && (sourceKind === 'user' || sourceKind === 'goal')
        eventNodes.push(human
          ? { kind: 'user', seq: event.seq, time: event.time, content, source: message.source ?? {} }
          : { kind: 'context', seq: event.seq, time: event.time, content, source: message.source ?? {}, producer: { role: 'user', name: sourceKind }, form: null })
        if (human) {
          if (openTurn !== null) locate(event.seq, openTurn)
          else pendingUserSeqs.push(event.seq)
        }
        break
      }
      case 'assistant/message': {
        const message = data.message ?? {}
        const request = requestByStep.get(stepKey(data.turn, data.step))
        const provider = message.source?.provider ?? request?.prompt?.config?.provider
        const model = message.source?.model ?? request?.prompt?.config?.model
        if (provider || model) models.add([provider, model].filter(Boolean).join(' / '))
        const providerMetadata = provider && model ? { provider, model } : undefined
        eventNodes.push({
          kind: 'assistant', seq: event.seq, time: event.time, turn: data.turn, step: data.step,
          blocks: assistantBlocks(message.content), usage: data.usage, providerMetadata,
          requestConfig: request?.prompt?.config ?? undefined,
          timing: { stepStartTime: request?.startedAt ?? null, firstTokenTime: firstTokenTime(data.stream), completedTime: event.time },
        })
        locate(event.seq, data.turn)
        if (request) Object.assign(request, { completedAt: event.time, status: 'complete', usage: data.usage, providerMetadata, resultSeq: event.seq })
        break
      }
      case 'assistant/attempt': {
        const request = requestByStep.get(stepKey(data.turn, data.step))
        const failure = attemptFailure(data.stream)
        if (request && failure) {
          request.error = failure
          request.retry = (request.retry ?? 0) + 1
        }
        break
      }
      case 'tool/call':
        calls.set(data.callId, event)
        break
      case 'tool/result': {
        const message = data.message ?? {}
        const callId = message.toolCallId ?? message.source?.callId
        const call = calls.get(callId)
        const parentCallId = call?.data?.parentCallId ?? message.source?.parentCallId ?? data.parentCallId
        eventNodes.push({
          kind: 'tool-result', seq: event.seq, time: event.time, callId,
          ...(parentCallId ? { parentCallId } : {}),
          name: call?.data?.name ?? '', args: {},
          call: call ? { name: call.data.name, argsRaw: call.data.arguments ?? '' } : null,
          callTime: call?.time ?? null, content: Array.isArray(message.content) ? message.content : [],
          isError: Boolean(message.isError), meta: data.meta, subCalls: [],
        })
        const turn = data.turn ?? call?.data?.turn
        if (Number.isFinite(turn)) locate(event.seq, turn)
        break
      }
      case 'compaction/start':
        compactions.set(data.compactionId, {
          purpose: 'compaction', turn: Number.isFinite(data.turn) ? data.turn : null, step: 0,
          startSeq: event.seq, startedAt: event.time, completedAt: null, status: 'running',
        })
        break
      case 'compaction/summary': {
        const compaction = compactions.get(data.compactionId)
        if (compaction) compaction.summary = data.summary
        break
      }
      case 'compaction/end': {
        const compaction = compactions.get(data.compactionId)
        if (compaction) Object.assign(compaction, { completedAt: event.time, status: data.error ? 'error' : 'complete', ...(data.error ? { error: String(data.error.message ?? data.error) } : {}) })
        break
      }
      default:
        break
    }
  }

  for (const request of requests) {
    if (request.completedAt !== null) continue
    if (closedTurns.has(request.turn)) {
      const reason = turnEndReasons.get(request.turn)
      request.status = 'error'
      request.error ??= reason?.kind === 'aborted' ? '已被用户中止'
        : reason?.kind === 'error' ? String(reason.error?.message ?? '轮次以错误结束')
          : '该步骤没有产生 assistant 消息'
    }
  }
  for (const compaction of compactions.values()) requests.push(compaction)
  const kindBySeq = new Map(eventNodes.map(node => [node.seq, node.kind]))
  for (const [seq, turn] of turnOfSeq) {
    const status = closedTurns.has(turn) ? 'closed' : 'open'
    eventLocations.set(seq, kindBySeq.get(seq) === 'assistant'
      ? { kind: 'step', turn: { turn, status } }
      : { kind: 'turn', turn: { turn, status } })
  }

  return {
    snapshot: { eventNodes, eventLocations, requests, runningCalls: [], partial: null },
    info: {
      id: header?.id ?? null, version: header?.version ?? null, cwd: header?.cwd ?? null,
      createdAt: header?.createdAt ?? null, agentPreset: header?.agentPreset ?? null, title,
      eventCount: ordered.length, models: [...models], types: Object.fromEntries(types),
    },
  }
}
