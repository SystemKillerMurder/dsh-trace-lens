/**
 * 离线导入 DSH 会话日志（例如从服务器导出的日志），转换成 `deriveTrace` 能读取的
 * 类 TrajectorySnapshot 对象。
 *
 * 支持的输入：JSONL 会话日志（`session.v4.jsonl`）及其 zstd / gzip 压缩文件、
 * 事件 JSON 数组，或 `{ events: [...] }` 形式的 JSON。
 * 导入过程不会写入本地会话存储。
 *
 * 处理流程：文件字节 → decodeSessionBytes（解压、解码为文本）
 *         → parseSessionText（解析成事件列表）
 *         → eventsToSnapshot（重放事件，生成快照）→ deriveTrace
 */

// 文件头魔数，用来识别压缩格式。
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const GZIP_MAGIC = [0x1f, 0x8b]

// 判断字节开头是否与指定魔数一致。
function hasMagic(bytes, magic) {
  return magic.every((value, index) => bytes[index] === value)
}

/**
 * 把文件原始字节解码为 UTF-8 文本；根据魔数自动识别并解压 zstd 或 gzip。
 * zstd 解码器由调用方传入（构建时打包的 fzstd）；gzip 使用浏览器内置的 DecompressionStream。
 * @param {Uint8Array} bytes - 文件内容。
 * @param {{ zstd?: (bytes: Uint8Array) => Uint8Array }} codecs - zstd 解码器。
 * @returns {Promise<string>} 解码后的文本。
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
 * 把会话日志文本解析成事件列表。按以下顺序识别格式：
 *   1. 以 `[` 开头：事件 JSON 数组。
 *   2. 以 `{` 开头且只有一行：`{ events }` / `{ entries }` 包装对象，或单个事件。
 *   3. 其他情况按 JSONL 逐行解析，无法解析或不是事件的行计入 invalidLines 并跳过。
 *   4. 如果 JSONL 一个事件都没解析出来，且文本以 `{` 开头，再尝试按多行格式化的包装对象解析。
 * @param {string} text - JSONL、JSON 数组，或 `{ events }` JSON。
 * @returns {{ events: object[], invalidLines: number }} 解析出的事件，以及被跳过的行数。
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
      // 被截断或损坏的行只计数并跳过，日志的其余部分仍然可用。
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

// 合法事件的最低要求：是对象，且带有字符串类型的 type 字段。
function isEvent(value) {
  return value !== null && typeof value === 'object' && typeof value.type === 'string'
}

// 提取消息内容中的纯文本：字符串直接返回；内容块数组只拼接 text 块。
function textOfContent(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n')
}

// (轮次, 步骤) 的组合键，用 \u0000 分隔，避免和普通字符冲突。
function stepKey(turn, step) {
  return `${turn}\u0000${step}`
}

// 把日志里的助手消息内容块转换成 trajectory 的块格式（type → kind，字段名对齐）。
// 例如 tool-call 块：id → callId，arguments → argsRaw。未识别的块包装成 kind: 'other'。
function assistantBlocks(content) {
  return (Array.isArray(content) ? content : []).map(block => {
    if (block?.type === 'text') return { kind: 'text', text: block.text ?? '' }
    if (block?.type === 'reasoning') return { kind: 'reasoning', text: block.text ?? '' }
    if (block?.type === 'tool-call') return { kind: 'tool-call', callId: block.id, name: block.name, argsRaw: block.arguments ?? '' }
    if (block?.type === 'image') return { kind: 'image', attachment: block.attachment }
    return { kind: 'other', block }
  })
}

// 从流式输出记录里找出首个 token 的时间（用于计算 TTFT）。
// 支持两种记录格式：
//   - 合并后的分片：type 以 '-chunks' 结尾，time0 为起始时间，且 texts/args 中至少有一段非空内容；
//   - 单个分片：type 为 'chunk'，且分片类型以 'delta' 结尾。
// 取所有候选时间中的最小值。
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

// 从一次模型调用尝试的流式记录里找失败原因：finish 分片的 reason 为 error 或 aborted 时，
// 返回错误信息（没有信息则返回 kind）；没有失败返回 null。
function attemptFailure(stream) {
  for (const entry of Array.isArray(stream) ? stream : []) {
    const reason = entry?.chunk?.type === 'finish' ? entry.chunk.reason : null
    if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) return reason.failure?.message ?? reason.kind
  }
  return null
}

/**
 * 把会话事件转换成 `deriveTrace` 读取的 TrajectorySnapshot 字段。
 * 做法是按 seq 顺序"重放"一遍事件，逐步还原出：
 *   - eventNodes：用户消息、上下文消息、助手消息、工具结果等节点；
 *   - requests：每次模型调用（step）和每次上下文压缩的请求记录；
 *   - eventLocations：事件 seq → 所属轮次及该轮是否已结束。
 * @param {object[]} events - 会话日志事件，顺序不限。
 * @returns {{ snapshot: object, info: object }} 快照，以及会话摘要信息（id、标题、模型、事件类型统计等）。
 */
export function eventsToSnapshot(events) {
  // type 为 'session' 的事件是会话头，记录 id、版本、工作目录等；其余事件按 seq 排序后重放。
  const header = events.find(event => event.type === 'session') ?? null
  const ordered = events.filter(event => event.type !== 'session' && Number.isFinite(event.seq))
    .sort((left, right) => left.seq - right.seq)
  const eventNodes = []
  const eventLocations = new Map()
  const requests = []
  // (轮次, 步骤) → 模型调用请求。
  const requestByStep = new Map()
  // callId → tool/call 事件，供后面的 tool/result 关联调用名称、参数和开始时间。
  const calls = new Map()
  // compactionId → 压缩请求。
  const compactions = new Map()
  // 已结束的轮次，以及每轮的结束原因。
  const closedTurns = new Set()
  const turnEndReasons = new Map()
  // 事件 seq → 所属轮次，最后用来生成 eventLocations。
  const turnOfSeq = new Map()
  const models = new Set()
  // 事件类型 → 出现次数，用于导入页展示统计。
  const types = new Map()
  // 最近一次 request/header（模型配置与工具定义）和系统提示，新的 step 会沿用它们。
  let requestHeader = null
  let systemText = ''
  // 当前进行中的轮次；不在任何轮次内时为 null。
  let openTurn = null
  let title = null
  // 在 turn/start 之前到达的用户消息 seq，等轮次开始后再归属到该轮。
  let pendingUserSeqs = []

  const locate = (seq, turn) => { turnOfSeq.set(seq, turn) }
  // 最近一个尚未完成的模型调用请求。
  const currentRequest = () => [...requestByStep.values()].reverse().find(request => request.completedAt === null) ?? null

  for (const event of ordered) {
    const data = event.data ?? {}
    types.set(event.type, (types.get(event.type) ?? 0) + 1)
    switch (event.type) {
      // 轮次开始：之前暂存的用户消息归属到这一轮。
      case 'turn/start':
        openTurn = data.turn
        for (const seq of pendingUserSeqs) locate(seq, openTurn)
        pendingUserSeqs = []
        break
      // 轮次结束：记录结束原因，后面用于判断未完成的 step 为什么失败。
      case 'turn/end':
        closedTurns.add(data.turn)
        turnEndReasons.set(data.turn, data.reason ?? null)
        openTurn = null
        break
      // 一次模型调用开始：先建一个运行中的请求，等 assistant/message 到达后再补全结果。
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
      // 系统提示：更新当前系统提示，并写入对应 step 的请求。
      case 'system/message': {
        systemText = textOfContent(data.message?.content)
        const request = requestByStep.get(stepKey(data.turn, data.step))
        if (request) request.prompt = { ...request.prompt, system: systemText }
        break
      }
      // 请求头（模型配置与工具定义）：更新当前值，并写入最近一个未完成的请求。
      case 'request/header': {
        requestHeader = data.header ?? null
        const request = currentRequest()
        if (request) request.prompt = { ...request.prompt, config: requestHeader?.config ?? null, tools: requestHeader?.tools ?? [] }
        break
      }
      case 'session/title':
        if (typeof data.title === 'string') title = data.title
        break
      // 用户消息与开发者消息：
      //   - 真人输入（source 为 user 或 goal 的 user/message）生成 user 节点，并归属到当前轮次；
      //   - 其余（开发者消息、插件或系统注入的内容）生成 context 节点。
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
      // 助手消息：生成 assistant 节点（含耗时与首 token 时间），并把对应的请求标记为完成。
      // provider / model 优先取消息自身的来源信息，没有则取请求配置。
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
      // 模型调用的一次尝试：失败时记录错误信息并累加重试次数。
      case 'assistant/attempt': {
        const request = requestByStep.get(stepKey(data.turn, data.step))
        const failure = attemptFailure(data.stream)
        if (request && failure) {
          request.error = failure
          request.retry = (request.retry ?? 0) + 1
        }
        break
      }
      // 工具调用：先记下来，等对应的 tool/result 到达时再合并。
      case 'tool/call':
        calls.set(data.callId, event)
        break
      // 工具结果：与之前的 tool/call 合并成 tool-result 节点（调用名、参数、开始时间、父调用）。
      // 轮次优先取结果自身的 turn，没有则取调用事件的 turn。
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
      // 上下文压缩：start 建请求（不属于任何轮次时 turn 为 null），summary 记录摘要，end 标记完成或失败。
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

  // 收尾一：所在轮次已结束、但一直没等到助手消息的 step，标记为失败，并根据轮次结束原因给出说明。
  // 轮次仍未结束的 step 保持 running。
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
  // 收尾二：压缩请求追加到请求列表末尾。
  for (const compaction of compactions.values()) requests.push(compaction)
  // 收尾三：生成 eventLocations。助手消息定位到 step，其他事件定位到 turn；
  // 轮次状态为 closed（已结束）或 open（进行中）。
  const kindBySeq = new Map(eventNodes.map(node => [node.seq, node.kind]))
  for (const [seq, turn] of turnOfSeq) {
    const status = closedTurns.has(turn) ? 'closed' : 'open'
    eventLocations.set(seq, kindBySeq.get(seq) === 'assistant'
      ? { kind: 'step', turn: { turn, status } }
      : { kind: 'turn', turn: { turn, status } })
  }

  // 离线日志里没有正在执行的工具调用和流式中间状态，所以 runningCalls 为空、partial 为 null。
  return {
    snapshot: { eventNodes, eventLocations, requests, runningCalls: [], partial: null },
    info: {
      id: header?.id ?? null, version: header?.version ?? null, cwd: header?.cwd ?? null,
      createdAt: header?.createdAt ?? null, agentPreset: header?.agentPreset ?? null, title,
      eventCount: ordered.length, models: [...models], types: Object.fromEntries(types),
    },
  }
}
