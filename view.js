// =====================================================================================
// view.js —— Trace 视图（会话页里的 "Trace" 标签页）
// -------------------------------------------------------------------------------------
// 【这个文件在项目里的位置】
//   整个插件的数据流大致是：
//     dsh 会话的 trajectory 快照（原始事件：user / assistant / tool-result / requests ...）
//       → data-model.js 的 deriveTrace()：把原始事件整理成 { turns, spans, usage, ... }
//       → 本文件 buildTree()：把 turns/spans 组装成一棵 Trace → Turn → Span 的树
//       → 本文件 TraceLensView：左边渲染树/时间线，右边渲染选中节点的详情
//
// 【为什么文件里没有 import / export】
//   本文件不是独立模块。build.mjs 会把 data-model.js、session-import.js、view.js、
//   import-view.js、steady-tabs.js 按顺序"拼接"成一个 client.js，并在最前面注入：
//       const React = require('react'); const h = React.createElement;
//   所以这里可以直接使用 React、h、deriveTrace（来自 data-model.js）等全局名字。
//   改完本文件后必须执行 `npm run build` 重新生成 client.js，插件实际加载的是 client.js。
// =====================================================================================

// 尝试加载宿主提供的通用 UI 组件库（JSON 树、代码高亮、Markdown 渲染等）。
// 这是一个可选依赖（package.json 的 peerDependenciesMeta 里标了 optional）：
// 加载失败时 P 为 null，下文各渲染函数会退回到本文件自带的简易实现。
const P = (() => {
  try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch (error) {
    // Hosts without the shared primitives module fall back to built-in renderers.
    void error
    return null
  }
})()

// 节点类型 → 显示标签与颜色。命名沿用 Langfuse（一个开源 LLM 可观测平台）的概念：
//   trace       整个会话（树根）
//   turn        一轮对话（用户发一句话到助手答完），显示为 SPAN
//   generation  一次模型调用
//   tool        一次工具调用
//   delegation  由另一个工具调用发起的子调用（嵌套工具调用），同样显示为 TOOL，只是颜色不同
//   compaction  上下文压缩事件（历史太长时让模型做摘要），显示为 EVENT
// 颜色写成 var(--主题变量, 兜底色)，宿主没提供该主题变量时使用逗号后的兜底色。
const KIND = {
  trace: { label: 'TRACE', color: 'var(--dsw-static-gray-500, #6b7280)' },
  turn: { label: 'SPAN', color: 'var(--dsw-static-indigo-500, #6366f1)' },
  generation: { label: 'GENERATION', color: 'var(--dsw-static-blue-500, #3b82f6)' },
  tool: { label: 'TOOL', color: 'var(--dsw-static-purple-500, #8b5cf6)' },
  delegation: { label: 'TOOL', color: 'var(--dsw-static-teal-500, #14b8a6)' },
  compaction: { label: 'EVENT', color: 'var(--dsw-static-orange-500, #f59e0b)' },
}
// 状态相关颜色：失败=红，工具报错=琥珀黄，运行中=绿，完成=蓝。
const ERROR_COLOR = 'var(--dsw-static-red-500, #ef4444)'
const WARN_COLOR = 'var(--dsw-static-amber-600, #d97706)'
const GREEN = 'var(--dsw-static-green-500, #22c55e)'
const COMPLETE_COLOR = 'var(--dsw-static-blue-500, #3b82f6)'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const BRAND = 'var(--dsw-alias-brand-primary, #3b82f6)'

// 传给共享组件库 JsonTree 的中文文案（右键菜单、复制提示等）。
const JSON_LABELS = {
  copyValue: '复制值', copyJson: '复制 JSON', copyPath: '复制路径',
  copyPrettyJson: '复制格式化 JSON', copyCompactJson: '复制紧凑 JSON',
  copied: '已复制', copyFailed: '复制失败', collapseNode: '折叠', expandNode: '展开',
  copyButtonTitle: action => `${action}（右键更多）`,
}
// 传给共享组件库 MarkdownText 的中文文案。
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

// 生成某颜色的半透明版本，例如 tint(红, 14) = 14% 浓度的红，用作徽章/选中行的浅色背景。
function tint(color, percent) {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}

// ---------- 样式表 ----------
// 所有组件共用的内联样式，使用时通过 { ...styles.row, ...styles.rowActive } 组合，后者覆盖前者。
// --dsh-composer-height 是底部输入框高度，tree/detail 底部留出这段空白，避免内容被输入框挡住。
const styles = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
    fontSize: '13px', lineHeight: 1.45,
  },
  header: {
    display: 'flex', alignItems: 'center', gap: '10px', flex: 'none', flexWrap: 'wrap',
    padding: '10px 16px', borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  muted: { color: 'var(--dsw-alias-label-secondary)' },
  body: { display: 'flex', minHeight: 0, flex: 1, position: 'relative' },
  treePane: { display: 'flex', flexDirection: 'column', minWidth: '260px', minHeight: 0, flex: 'none' },
  toolbar: {
    display: 'flex', alignItems: 'center', gap: '6px', flex: 'none',
    padding: '8px 10px', borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  search: {
    flex: 1, minWidth: 0, height: '26px', padding: '0 8px', borderRadius: '6px',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)',
    color: 'inherit', font: 'inherit', fontSize: '12px', outline: 'none',
  },
  toolButton: {
    height: '26px', padding: '0 8px', borderRadius: '6px', flex: 'none',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit', fontSize: '12px',
  },
  toolButtonOn: { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
  tree: {
    flex: 1, minHeight: 0, overflow: 'auto', outline: 'none', padding: '4px 0',
    paddingBottom: 'calc(var(--dsh-composer-height, 152px) + 12px)',
  },
  splitter: {
    width: '5px', flex: 'none', cursor: 'col-resize', background: 'transparent',
    borderLeft: '1px solid var(--dsw-alias-border-l2)',
  },
  detail: {
    flex: 1, minWidth: 0, overflow: 'auto',
    padding: '14px 18px calc(var(--dsh-composer-height, 152px) + 16px)',
  },
  row: {
    display: 'flex', alignItems: 'stretch', width: '100%', cursor: 'pointer',
    padding: '0 10px 0 6px', minHeight: '40px', boxSizing: 'border-box',
  },
  rowActive: {
    background: tint(BRAND, 14),
    boxShadow: `inset 3px 0 0 ${BRAND}`,
  },
  guide: { width: '14px', flex: 'none', marginLeft: '7px', borderLeft: '1px solid var(--dsw-alias-border-l2)' },
  caret: {
    width: '18px', flex: 'none', border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer', padding: 0, alignSelf: 'center', fontSize: '10px',
  },
  rowMain: { display: 'flex', flexDirection: 'column', justifyContent: 'center', minWidth: 0, flex: 1, padding: '4px 0' },
  rowLine: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
  rowSub: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  badge: {
    flex: 'none', fontSize: '10px', letterSpacing: '.03em', fontWeight: 600,
    padding: '0 5px', borderRadius: '4px', lineHeight: '16px',
  },
  name: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  dot: { width: '6px', height: '6px', borderRadius: '50%', flex: 'none' },
  track: { position: 'relative', flex: 'none', width: '46%', alignSelf: 'center', height: '18px', marginLeft: '8px' },
  bar: { position: 'absolute', top: '4px', height: '10px', borderRadius: '3px', minWidth: '3px' },
  barLabel: { position: 'absolute', top: 0, fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
  pill: {
    display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', lineHeight: '20px',
    padding: '0 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  },
  pills: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '10px' },
  section: { marginTop: '16px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', overflow: 'hidden' },
  sectionHead: {
    display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px',
    background: 'var(--dsw-alias-bg-layer-2)', borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  sectionTitle: { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, font: 'inherit', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' },
  sectionBody: { padding: '10px', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 },
  segment: { display: 'inline-flex', marginLeft: 'auto', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '6px', overflow: 'hidden' },
  segmentButton: { border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', padding: '1px 8px', font: 'inherit', fontSize: '11px' },
  segmentOn: { background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
  message: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '8px', minWidth: 0 },
  messageHead: { display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 10px', fontSize: '11px', fontWeight: 600, letterSpacing: '.04em', cursor: 'pointer' },
  messageBody: { padding: '2px 10px 10px', minWidth: 0, overflowWrap: 'anywhere' },
  pre: {
    whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, padding: '8px 10px',
    borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2)', fontFamily: MONO, fontSize: '12px',
  },
  scroll: { maxHeight: '560px', overflow: 'auto', minWidth: 0 },
  chip: { display: 'inline-block', padding: '2px 8px', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-2)', fontSize: '12px' },
  link: { border: 0, background: 'transparent', color: 'var(--dsw-static-blue-500, #3b82f6)', cursor: 'pointer', padding: 0, font: 'inherit', fontSize: '11px', marginLeft: 'auto' },
  errorBox: { marginTop: '12px', padding: '8px 10px', borderRadius: '8px', color: ERROR_COLOR, background: tint(ERROR_COLOR, 10), whiteSpace: 'pre-wrap', fontFamily: MONO, fontSize: '12px' },
  note: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
  empty: { padding: '28px 20px', color: 'var(--dsw-alias-label-secondary)' },
}

// ---------- 格式化与状态工具函数 ----------

// 只接受有限数字（排除 NaN / Infinity / 非数字），否则返回 0。
function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
// token 数量格式化：1234 → "1.23k"，12345 → "12.3k"，1500000 → "1.5M"；null/undefined 显示为 "—"。
function formatTokens(value) {
  if (value === null || value === undefined) return '—'
  const count = safeNumber(value)
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(count >= 1e4 ? 1 : 2)}k`
  return String(Math.round(count))
}
// 毫秒耗时格式化：<1s 显示 ms，<1min 显示秒，否则显示 "Xm Ys"。
// 注意 !(value >= 0) 这种写法：null、undefined、NaN、负数都会走到 "—"。
function formatMs(value) {
  if (!(value >= 0)) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s`
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`
}
// 时间戳（毫秒）→ 本地时间字符串（24 小时制）。
function formatTime(value) {
  if (typeof value !== 'number') return null
  return new Date(value).toLocaleString(undefined, { hour12: false })
}
// 状态码 → 中文文案。status 取值来自 data-model.js：running / error / warning / complete / unknown。
function statusLabel(status) {
  if (status === 'running') return '运行中'
  if (status === 'error') return '失败'
  if (status === 'warning') return '工具报错'
  if (status === 'complete') return '完成'
  return '未知'
}
// 取节点的"色调"：只有四种已知状态才有颜色，其它（如 unknown）返回 null 表示不着色。
function statusTone(node) {
  return node.status === 'error' || node.status === 'warning' || node.status === 'running' || node.status === 'complete' ? node.status : null
}
// 色调 → 具体颜色。
function toneColor(tone) {
  if (tone === 'error') return ERROR_COLOR
  if (tone === 'warning') return WARN_COLOR
  if (tone === 'running') return GREEN
  if (tone === 'complete') return COMPLETE_COLOR
  return null
}
// "尽量"把字符串解析成 JSON：只有以 { 或 [ 开头才尝试解析，失败返回 undefined（不抛异常）。
// 调用方据此决定是按 JSON 树渲染，还是按普通文本/Markdown 渲染。
function parseJson(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!(text.startsWith('{') || text.startsWith('['))) return undefined
  try { return JSON.parse(text) } catch (error) {
    // Not JSON: the caller renders the original string.
    void error
    return undefined
  }
}
// token 用量摘要，例如 "1.2k → 300 (∑ 1.5k)"：输入 → 输出 (总计)。
function tokenSummary(usage) {
  if (!usage) return null
  const parts = [`${formatTokens(usage.input)} → ${formatTokens(usage.output)}`]
  if (usage.total !== null && usage.total !== undefined) parts.push(`(∑ ${formatTokens(usage.total)})`)
  return parts.join(' ')
}

// ---------- tree ----------
// 这一部分负责：数据 → 树结构 → 扁平的"可见行"列表 → 每一行的渲染。
//
// 树节点（下文统一叫 node）的结构：
//   { id, kind, name, status, started, completed, duration, usage, model,
//     children: node[],   子节点
//     parent: node|null,  父节点（buildTree 最后统一回填）
//     span?: 原始 span    仅 generation/tool/delegation/compaction 节点有
//     turn?: 原始 turn    仅 turn 节点有 }

// 把某一轮里"扁平的 span 列表"按 parentId 组装成树。
// parentId 为空、或指向的父节点不在本轮内的 span，都当作顶层节点（key 为 ''）。
function spanTree(spans) {
  const ids = new Set(spans.map(span => span.id))
  // groups：父 id → 子 span 列表。
  const groups = new Map()
  for (const span of spans) {
    const key = span.parentId && ids.has(span.parentId) ? span.parentId : ''
    const list = groups.get(key) ?? []
    list.push(span)
    groups.set(key, list)
  }
  // 递归构造：从 '' 开始取顶层，再对每个子节点递归取它自己的子节点。
  const build = parentId => (groups.get(parentId) ?? []).map(span => ({
    id: span.id, kind: span.type, name: span.name, status: span.status, started: span.started,
    completed: span.completed, duration: span.duration, usage: span.usage, model: span.model,
    span, children: build(span.id),
  }))
  return build('')
}

// 计算整个 trace 的起止时间：所有轮次里最早的开始时间、最晚的结束时间。
function traceBounds(turns) {
  const starts = turns.map(turn => turn.started).filter(value => value !== null)
  const ends = turns.map(turn => turn.completed).filter(value => value !== null)
  return {
    started: starts.length ? Math.min(...starts) : null,
    completed: ends.length ? Math.max(...ends) : null,
  }
}

// 把 deriveTrace() 的结果组装成三层树：
//   Trace（根）
//    └─ Turn（每一轮，名称形如 "第 N 轮 · 用户问题摘要"；turn 为 null 表示不属于任何轮次的会话级压缩）
//        └─ Span 树（generation / tool / delegation / compaction，见 spanTree）
// 根节点状态按优先级汇总：任一轮失败 > 任一轮工具报错 > 任一轮运行中 > 完成。
// 返回 { root, index }，index 是 id → node 的 Map，用于按 id O(1) 查找节点。
function buildTree(trace) {
  const bounds = traceBounds(trace.turns)
  const root = {
    id: 'trace', kind: 'trace', name: trace.turns[0]?.title ?? 'Trace',
    status: trace.turns.some(turn => turn.status === 'error') ? 'error'
      : trace.turns.some(turn => turn.status === 'warning') ? 'warning'
        : trace.turns.some(turn => turn.status === 'running') ? 'running' : 'complete',
    started: bounds.started, completed: bounds.completed,
    duration: bounds.started !== null && bounds.completed !== null ? bounds.completed - bounds.started : null,
    usage: trace.usage, model: null,
    children: trace.turns.map(turn => ({
      id: turn.id, kind: 'turn', name: `${turn.turn === null ? '会话级压缩' : `第 ${turn.turn} 轮`} · ${turn.title}`,
      status: turn.status, started: turn.started, completed: turn.completed, duration: turn.duration,
      usage: turn.usage, model: null, turn, children: spanTree(turn.spans),
    })),
  }
  // 深度优先遍历一遍：给每个节点回填 parent 指针，并登记到 index。
  const index = new Map()
  const walk = (node, parent) => {
    node.parent = parent
    index.set(node.id, node)
    for (const child of node.children) walk(child, node)
  }
  walk(root, null)
  return { root, index }
}

// 搜索时用来匹配的文本：名称 + 类型标签 + 模型名，统一转小写做不区分大小写的匹配。
function nodeText(node) {
  return `${node.name} ${KIND[node.kind]?.label ?? ''} ${node.model ?? ''}`.toLowerCase()
}

// 把树"拍平"成当前应当显示的行列表（左侧树就是逐行渲染这个列表）。
//   collapsed：被折叠的节点 id 集合，折叠节点的子孙不输出。
//   query：搜索词。有搜索词时，忽略折叠状态全部展开，只保留"自身匹配或有子孙匹配"的节点，
//          这样匹配项的祖先链也会显示出来，方便看清它在哪一层。
// 返回的每一行：{ node, depth(缩进层级), hasChildren, open(是否展开) }。
function flattenTree(root, collapsed, query) {
  const rows = []
  const needle = query.trim().toLowerCase()
  // matches 是匹配结果的缓存（记忆化），避免对同一子树反复递归判断。
  const matches = new Map()
  const match = node => {
    if (matches.has(node.id)) return matches.get(node.id)
    const value = nodeText(node).includes(needle) || node.children.some(match)
    matches.set(node.id, value)
    return value
  }
  const walk = (node, depth) => {
    if (needle && !match(node)) return
    const open = needle ? true : !collapsed.has(node.id)
    rows.push({ node, depth, hasChildren: node.children.length > 0, open })
    if (open) for (const child of node.children) walk(child, depth + 1)
  }
  walk(root, 0)
  return rows
}

// 时间线模式的时间刻度：以根节点开始时间为原点，整个 trace 的时长为 100%。
// span 至少取 1ms，防止后面做除法时除以 0。
function timeScale(node) {
  if (node.started === null) return null
  const end = node.completed ?? node.started
  return { origin: node.started, span: Math.max(end - node.started, 1) }
}

// 计算时间线里某个节点色条的位置：left = 开始时间相对原点的百分比，width = 时长占比。
// 宽度至少 0.8%（太短的调用也能看见），并保证色条不会超出右边界。
// 还在运行中（completed 为 null）的节点按 0 时长处理，只显示最小宽度。
function barBox(node, scale) {
  if (!scale || node.started === null) return null
  const left = Math.max(0, ((node.started - scale.origin) / scale.span) * 100)
  const end = node.completed === null ? node.started : node.completed
  const width = Math.max(((end - node.started) / scale.span) * 100, 0.8)
  const clampedLeft = Math.min(left, 99)
  return { left: `${clampedLeft}%`, width: `${Math.min(width, 100 - clampedLeft)}%` }
}

// 类型徽章组件（TRACE / SPAN / GENERATION / TOOL / EVENT）。
// 节点失败或工具报错时，徽章改用红/黄色，否则使用该类型自己的颜色。
function KindBadge({ node }) {
  const tone = statusTone(node)
  const color = tone === 'error' || tone === 'warning' ? toneColor(tone) : (KIND[node.kind]?.color ?? KIND.generation.color)
  return h('span', { style: { ...styles.badge, color, background: tint(color, 14) } }, KIND[node.kind]?.label ?? node.kind)
}

// 名称后面的小圆点，表示状态。
// 为了减少视觉噪音：普通 span 处于"完成"状态时不显示圆点，只有 trace / turn 显示"完成"的蓝点。
function StatusDot({ node }) {
  const tone = statusTone(node)
  if (tone === null || (tone === 'complete' && node.kind !== 'turn' && node.kind !== 'trace')) return null
  return h('span', { title: statusLabel(node.status), style: { ...styles.dot, background: toneColor(tone) } })
}

// 树模式下每行第二行的灰色小字：耗时 · token 用量 · 模型名；
// trace / turn 节点额外显示观测数，以及生成错误、工具错误的数量（有错才显示）。
function rowSubtitle(node) {
  const parts = []
  if (node.duration !== null && node.duration !== undefined) parts.push(formatMs(node.duration))
  const tokens = tokenSummary(node.usage)
  if (tokens) parts.push(tokens)
  if (node.model) parts.push(node.model)
  if (node.kind === 'turn' || node.kind === 'trace') {
    const count = countObservations(node)
    parts.push(`${count} 个观测`)
    const turns = node.kind === 'turn' ? [node.turn] : node.children.map(child => child.turn)
    const generationErrors = turns.reduce((total, turn) => total + (turn?.generationErrorCount ?? 0), 0)
    const toolErrors = turns.reduce((total, turn) => total + (turn?.toolErrorCount ?? 0), 0)
    if (generationErrors > 0) parts.push(`${generationErrors} 个生成错误`)
    if (toolErrors > 0) parts.push(`${toolErrors} 个工具错误`)
  }
  return parts.join(' · ')
}

// 统计某节点下所有"观测"数量：只统计挂着 span 的节点（generation/tool 等），不含 turn 节点本身。
function countObservations(node) {
  let count = 0
  const walk = item => { for (const child of item.children) { if (child.span) count += 1; walk(child) } }
  walk(node)
  return count
}

// 左侧树的一行。props：
//   row       flattenTree 产出的一行
//   active    是否为当前选中行
//   mode      'tree'（树模式，显示副标题）或 'timeline'（时间线模式，右侧画色条）
//   scale     时间线刻度
//   onSelect  点击行时回调（选中该节点）
//   onToggle  点击 ▶/▼ 时回调（展开/折叠）
// 每行的组成：缩进竖线 × depth → 展开箭头 → [类型徽章 名称 状态点] / 副标题 → 时间线色条（可选）。
// data-node 属性用于外部通过 querySelector 定位这一行并滚动到可见区域。
function TreeRow({ row, active, mode, scale, onSelect, onToggle }) {
  const { node, depth, hasChildren, open } = row
  const box = mode === 'timeline' ? barBox(node, scale) : null
  const tone = statusTone(node)
  const color = tone === 'error' || tone === 'warning' ? toneColor(tone) : (KIND[node.kind]?.color ?? KIND.generation.color)
  // 鼠标悬停高亮用的局部状态。
  const [hover, setHover] = React.useState(false)
  return h('div', {
    role: 'treeitem', 'aria-selected': active, 'aria-expanded': hasChildren ? open : undefined,
    'data-node': node.id,
    style: { ...styles.row, ...(hover && !active ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {}), ...(active ? styles.rowActive : {}) },
    onClick: () => onSelect(node.id),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  },
  // 缩进竖线，每层一条。
  Array.from({ length: depth }, (_, index) => h('span', { key: index, style: styles.guide })),
  // 有子节点才显示可点击的展开箭头；stopPropagation 防止点击箭头的同时也触发整行的"选中"。
  hasChildren
    ? h('button', {
      type: 'button', style: styles.caret, tabIndex: -1, 'aria-label': open ? '折叠' : '展开',
      onClick: event => { event.stopPropagation(); onToggle(node.id) },
    }, open ? '▼' : '▶')
    : h('span', { style: styles.caret }),
  h('div', { style: styles.rowMain },
    h('div', { style: styles.rowLine },
      h(KindBadge, { node }),
      h('span', { style: { ...styles.name, fontWeight: node.kind === 'trace' || active ? 600 : 400, ...(active ? { color: BRAND } : {}) } }, node.name),
      h(StatusDot, { node }),
    ),
    mode === 'tree' ? h('div', { style: styles.rowSub }, rowSubtitle(node)) : null,
  ),
  // 时间线模式：右侧画一条按时间比例定位的色条，色条右边标注耗时；运行中的色条半透明。
  mode === 'timeline'
    ? h('div', { style: styles.track },
      box ? h('span', { style: { ...styles.bar, ...box, background: color, opacity: node.status === 'running' ? 0.5 : 0.85 } }) : null,
      h('span', { style: { ...styles.barLabel, left: box ? `calc(${box.left} + ${box.width} + 4px)` : 0 } }, formatMs(node.duration)),
    )
    : null,
  )
}

// ---------- rendering primitives ----------
// 通用的内容渲染组件：JSON、代码、Markdown、消息卡片、可折叠分区等。
// 统一模式：如果宿主提供了共享组件（P?.Xxx 存在）就用它；否则用本文件的简易兜底实现。

// 用于 JSON 语法高亮的正则，依次匹配：
//   字符串（可带结尾冒号，带冒号说明是 key）、true/false/null、数字。
const JSON_TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

// 兜底的 JSON 高亮渲染：先格式化成带缩进的文本，再按正则切分，给不同 token 上色。
//   key → 紫色；字符串值 → 绿色；true/false/null → 橙色；数字 → 蓝色。
function ColoredJson({ value }) {
  let text
  try { text = JSON.stringify(value, null, 2) ?? String(value) } catch (error) { text = String(error) }
  const parts = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
    // 两个 token 之间的普通字符（空格、括号、逗号等）原样保留。
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    const color = token.startsWith('"')
      ? (token.trimEnd().endsWith(':') ? 'var(--dsw-static-purple-500, #8b5cf6)' : GREEN)
      : /^(true|false|null)$/.test(token) ? KIND.compaction.color : KIND.generation.color
    parts.push(h('span', { key: key++, style: { color } }, token))
    last = match.index + token.length
  }
  parts.push(text.slice(last))
  return h('pre', { style: { ...styles.pre, ...styles.scroll } }, parts)
}

// "格式化"展示 JSON：对象/数组优先用共享组件的可折叠 JSON 树，否则退回彩色文本。
function JsonView({ value, label = 'JSON' }) {
  if (value === null || value === undefined) return h(Empty)
  if (P?.JsonTree && typeof value === 'object') {
    return h('div', { style: styles.scroll },
      h(P.JsonTree, { data: value, label, labels: JSON_LABELS, collapsedStringLines: 8, expandTopLevel: true }))
  }
  return h(ColoredJson, { value })
}

// "原始 JSON"展示：用代码块显示完整 JSON 文本（Section 右上角切到 "JSON" 时使用）。
function RawJson({ value }) {
  if (value === null || value === undefined) return h(Empty)
  if (P?.CodeBlock) {
    let code
    try { code = JSON.stringify(value, null, 2) ?? String(value) } catch (error) { code = String(error) }
    return h('div', { style: styles.scroll }, h(P.CodeBlock, { code, lang: 'json', copyLabel: '复制', copiedLabel: '已复制' }))
  }
  return h(ColoredJson, { value })
}

// 代码块：有共享组件时带语法高亮和复制按钮，否则就是普通 <pre>。
function CodeView({ code, lang }) {
  if (P?.CodeBlock) {
    return h('div', { style: styles.scroll }, h(P.CodeBlock, { code, lang, copyLabel: '复制', copiedLabel: '已复制' }))
  }
  return h('pre', { style: { ...styles.pre, ...styles.scroll } }, code)
}

// Markdown 渲染：有共享组件时渲染成富文本，否则原样显示。
function MarkdownView({ text }) {
  if (!text) return h(Empty)
  if (P?.MarkdownText) {
    return h('div', { style: { minWidth: 0 } }, h(P.MarkdownText, { text, labels: MD_LABELS, variant: 'compact' }))
  }
  return h('pre', { style: styles.pre }, text)
}

// 空值占位符 "—"。
function Empty() {
  return h('span', { style: styles.note }, '—')
}

// 渲染一段文本：如果它其实是 JSON 字符串就按 JSON 树展示；
// 否则 markdown=true 时按 Markdown 渲染（用户/助手消息），false 时按代码块渲染（工具输出）。
function TextValue({ text, markdown }) {
  const json = parseJson(text)
  if (json !== undefined) return h(JsonView, { value: json })
  return markdown ? h(MarkdownView, { text }) : h(CodeView, { code: text })
}

// 渲染消息内容。内容可能是：字符串、内容块数组、或任意对象。
// 内容块数组中：text 块按文本渲染；image/file 块只显示一个"图片 · 文件名"标签（不渲染真实图片）；
// 其他未知类型的块按 JSON 展示。
function Blocks({ blocks, markdown }) {
  if (blocks === null || blocks === undefined || blocks === '') return h(Empty)
  if (typeof blocks === 'string') return h(TextValue, { text: blocks, markdown })
  if (!Array.isArray(blocks)) return h(JsonView, { value: blocks })
  if (blocks.length === 0) return h(Empty)
  return h(React.Fragment, null, blocks.map((block, index) => {
    if (block?.type === 'text') return h(TextValue, { key: index, text: block.text ?? '', markdown })
    if (block?.type === 'image' || block?.type === 'file') {
      const name = block.attachment?.name ?? block.attachment?.mediaType ?? block.type
      return h('span', { key: index, style: styles.chip }, `${block.type === 'image' ? '图片' : '文件'} · ${name}`)
    }
    return h(JsonView, { key: index, value: block })
  }))
}

// 可折叠的消息卡片（详情面板里的 USER / ASSISTANT / TOOL CALL / SYSTEM 等）。
//   role         左上角的角色名
//   name         角色名旁边的补充说明（工具名、字符数等）
//   color        左侧色条与角色名的颜色
//   defaultOpen  默认是否展开（内容很长时默认折叠）
//   action       标题栏右侧的附加按钮（例如"查看调用 →"）
//   children     卡片正文
// 标题栏支持鼠标点击，也支持键盘 Enter/空格切换展开。
function Message({ role, name, color, defaultOpen = true, action, children }) {
  const tone = color ?? 'var(--dsw-alias-label-secondary)'
  const [open, setOpen] = React.useState(defaultOpen)
  return h('div', { style: { ...styles.message, borderLeft: `3px solid ${tint(tone, 70)}` } },
    h('div', { style: styles.messageHead, role: 'button', tabIndex: 0, 'aria-expanded': open,
      onClick: () => setOpen(!open),
      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(!open) } } },
    h('span', { style: { ...styles.muted, fontSize: '9px' } }, open ? '▼' : '▶'),
    h('span', { style: { color: tone } }, role),
    name ? h('span', { style: { ...styles.muted, fontWeight: 400, letterSpacing: 0 } }, name) : null,
    action ?? null,
    ),
    open ? h('div', { style: styles.messageBody }, children) : null,
  )
}

// 详情面板里的一个大分区（Input / Output / Metadata）。
//   title        分区标题，点击可折叠
//   raw          原始数据，切换到 "JSON" 模式时直接展示它
//   children     "格式化"模式下展示的内容
//   toggle       是否显示右上角的 "格式化 / JSON" 切换（Metadata 本身就是 JSON，所以不需要）
function Section({ title, raw, children, defaultOpen = true, toggle = true }) {
  const [open, setOpen] = React.useState(defaultOpen)
  const [mode, setMode] = React.useState('pretty')
  return h('section', { style: styles.section },
    h('div', { style: { ...styles.sectionHead, ...(open ? {} : { borderBottom: 0 }) } },
      h('button', { type: 'button', style: styles.sectionTitle, onClick: () => setOpen(!open) },
        h('span', { style: { ...styles.muted, fontSize: '10px' } }, open ? '▼' : '▶'), title),
      toggle && open
        ? h('div', { style: styles.segment },
          [['pretty', '格式化'], ['json', 'JSON']].map(([value, label]) => h('button', {
            key: value, type: 'button', style: { ...styles.segmentButton, ...(mode === value ? styles.segmentOn : {}) },
            onClick: () => setMode(value),
          }, label)))
        : null,
    ),
    open ? h('div', { style: styles.sectionBody }, mode === 'json' && toggle ? h(RawJson, { value: raw }) : children) : null,
  )
}

// ---------- detail ----------
// 右侧详情面板：根据选中节点的类型，决定 Input / Output / Metadata 三个分区里展示什么。

// 工具参数里"看起来像代码"的字段名 → 代码高亮语言。
// 值为 null 表示语言不确定，交给 guessCodeLanguage 猜测。
const CODE_FIELDS = { command: 'bash', cmd: 'bash', script: 'bash', code: null, patch: 'diff', diff: 'diff', sql: 'sql', query: null }

// 猜测代码语言：优先使用参数里显式声明的 language/lang；
// 否则有 Python 特征（def / import / print( 且没有 const/let/=>）就当 python，其余默认 typescript。
function guessCodeLanguage(args, code) {
  const declared = typeof args.language === 'string' ? args.language : typeof args.lang === 'string' ? args.lang : null
  if (declared) return declared
  if (/^\s*(def |from \S+ import |import \w+\s*$|print\()/m.test(code) && !/\b(const|let|=>)\b/.test(code)) return 'python'
  return 'typescript'
}

// 渲染工具调用的入参（模型生成的参数通常是 JSON 字符串）。
// 逻辑：
//   1. 解析失败 → 原样按代码块展示；不是普通对象 → 按 JSON 展示。
//   2. 从参数对象里挑出"代码类字段"（字段名在 CODE_FIELDS 里，且是多行、长度 > 40 或字段名是 command），
//      这些字段单独用带语法高亮的代码块展示，比塞在 JSON 里转义成一行好读得多。
//   3. 剩余字段（rest）作为普通 JSON 展示；如果没有任何代码字段，也展示（可能是空对象）。
function ToolInput({ raw }) {
  const args = typeof raw === 'string' ? parseJson(raw) : raw
  if (args === undefined) return raw ? h(CodeView, { code: String(raw) }) : h(Empty)
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return h(JsonView, { value: args })
  const code = Object.entries(args).filter(([key, value]) =>
    key in CODE_FIELDS && typeof value === 'string' && (value.includes('\n') || value.length > 40 || key === 'command'))
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !code.some(([name]) => name === key)))
  return h(React.Fragment, null,
    code.map(([key, value]) => h('div', { key },
      h('div', { style: { ...styles.note, marginBottom: '4px', fontFamily: MONO } }, key),
      h(CodeView, { code: value, lang: CODE_FIELDS[key] ?? guessCodeLanguage(args, value) }))),
    Object.keys(rest).length > 0 || code.length === 0 ? h(JsonView, { value: rest, label: '参数' }) : null,
  )
}

// 把一次模型调用的上下文消息（span.context 中的一条）渲染成消息卡片。
// role 来自 data-model.js：
//   tool      工具执行结果（报错时为红色），内容按代码展示
//   context   插件/系统注入的上下文，默认折叠
//   steering  用户在助手运行过程中"插话"
//   其余      普通用户消息
function contextMessage(message, index) {
  if (message.role === 'tool') {
    return h(Message, { key: index, role: 'TOOL', name: message.name, color: message.isError ? ERROR_COLOR : KIND.tool.color },
      h(Blocks, { blocks: message.content, markdown: false }))
  }
  if (message.role === 'context') {
    return h(Message, { key: index, role: 'CONTEXT', name: message.name, color: KIND.compaction.color, defaultOpen: false },
      h(Blocks, { blocks: message.content, markdown: true }))
  }
  return h(Message, { key: index, role: 'USER', name: message.role === 'steering' ? '插话' : null, color: GREEN },
    h(Blocks, { blocks: message.content, markdown: true }))
}

// 本次模型调用可用的工具清单（默认折叠）。
// 每个工具用原生 <details>/<summary> 做二级折叠：标题行显示工具名和描述，展开后显示完整描述与参数 JSON Schema。
function ToolCatalog({ tools }) {
  if (!Array.isArray(tools) || tools.length === 0) return null
  return h(Message, { role: 'TOOLS', name: `${tools.length} 个可用工具`, defaultOpen: false },
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
      tools.map((tool, index) => h('details', { key: `${tool.name}:${index}` },
        h('summary', { style: { cursor: 'pointer', display: 'flex', gap: '8px', minWidth: 0 } },
          h('span', { style: { fontFamily: MONO, color: KIND.tool.color, flex: 'none' } }, tool.name),
          h('span', { style: { ...styles.muted, ...styles.name } }, tool.description ?? '')),
        h('div', { style: { padding: '6px 0 6px 12px', display: 'flex', flexDirection: 'column', gap: '6px' } },
          tool.description ? h(MarkdownView, { text: tool.description }) : null,
          h(JsonView, { value: tool.parameters ?? {}, label: `${tool.name} 参数` }))))))
}

// GENERATION（模型调用）的 Input 区：系统提示 → 可用工具 → 上下文消息。
// 注意 contextFromStart：为了不在每一步都重复展示整段历史，data-model.js 只给每次调用分配
// "上一次调用之后新增的消息"；窗口内第一次调用则包含此前全部消息。顶部的说明文字就是在解释这一点。
// 系统提示超过 800 字符时默认折叠。
function generationInput(span) {
  const prompt = span.input ?? {}
  const system = typeof prompt.system === 'string' ? prompt.system : ''
  return h(React.Fragment, null,
    h('div', { style: styles.note }, span.contextFromStart
      ? '系统提示、工具定义，以及已加载窗口内此前的全部消息。'
      : '系统提示、工具定义，以及上一次模型调用之后新增的消息；更早的历史已在之前的步骤展示。'),
    system ? h(Message, { role: 'SYSTEM', name: `${system.length} 字符`, defaultOpen: system.length < 800 }, h(MarkdownView, { text: system })) : null,
    h(ToolCatalog, { tools: prompt.tools }),
    (span.context ?? []).map(contextMessage),
  )
}

// GENERATION（模型调用）的 Output 区：思考过程 → 回复正文 → 发起的工具调用。
// 每个工具调用卡片右上角有"查看调用 →"按钮，点击后跳转选中对应的 TOOL 节点
// （TOOL 节点 id 的约定是 `tool-${callId}`，见 data-model.js 的 toolSpan）。
function generationOutput(span, onSelect) {
  return h(React.Fragment, null,
    span.reasoning ? h(Message, { role: 'REASONING', name: '思考过程', color: KIND.turn.color, defaultOpen: span.reasoning.length < 1200 },
      h(MarkdownView, { text: span.reasoning })) : null,
    span.output ? h(Message, { role: 'ASSISTANT', color: KIND.generation.color }, h(MarkdownView, { text: span.output })) : null,
    (span.toolCalls ?? []).map(call => h(Message, {
      key: call.callId, role: 'TOOL CALL', name: call.name, color: KIND.tool.color,
      action: h('button', {
        type: 'button', style: styles.link,
        onClick: event => { event.stopPropagation(); onSelect(`tool-${call.callId}`) },
      }, '查看调用 →'),
    }, h(ToolInput, { raw: call.args }))),
    !span.reasoning && !span.output && !(span.toolCalls ?? []).length ? h(Empty) : null,
  )
}

// 原始 JSON 视图用：把工具调用参数从 JSON 字符串解析成对象（解析失败保留原字符串）。
function parsedToolCalls(span) {
  return (span.toolCalls ?? []).map(call => ({ ...call, args: parseJson(call.args) ?? call.args }))
}

// 详情面板的"数据准备"：按节点类型分派，
// 返回 { input, inputRaw, output, outputRaw, metadata }：
//   input/output         "格式化"模式下渲染的 UI
//   inputRaw/outputRaw   "JSON"模式下展示的原始数据
//   metadata             Metadata 分区展示的对象
// 各类型的取值：
//   trace       Input = 第一轮用户输入，Output = 最后一轮助手回复
//   turn        Input = 本轮用户输入，Output = 本轮助手回复
//   generation  见 generationInput / generationOutput
//   compaction  Input = 压缩请求，Output = 压缩摘要
//   其他（tool / delegation）  Input = 工具参数，Output = 工具结果
function detailModel(node, trace, onSelect) {
  const span = node.span
  if (node.kind === 'trace') {
    const first = trace.turns[0]
    const last = trace.turns.at(-1)
    return {
      input: h(Message, { role: 'USER', color: GREEN }, h(Blocks, { blocks: first?.input, markdown: true })), inputRaw: first?.input ?? null,
      output: h(Message, { role: 'ASSISTANT', color: KIND.generation.color }, h(MarkdownView, { text: last?.output })), outputRaw: last?.output ?? null,
      metadata: { turns: trace.turns.length, observations: trace.spans.length, usage: trace.usage, incompleteHistory: trace.incompleteHistory, warnings: trace.warnings },
    }
  }
  if (node.kind === 'turn') {
    const turn = node.turn
    return {
      input: h(Message, { role: 'USER', color: GREEN }, h(Blocks, { blocks: turn.input, markdown: true })), inputRaw: turn.input,
      output: h(Message, { role: 'ASSISTANT', color: KIND.generation.color }, h(MarkdownView, { text: turn.output })), outputRaw: turn.output,
      metadata: { turn: turn.turn, status: turn.status, observations: turn.spans.length, usage: turn.usage, started: turn.started, completed: turn.completed },
    }
  }
  if (span.type === 'generation') {
    return {
      input: generationInput(span),
      inputRaw: { system: span.input?.system ?? null, tools: span.input?.tools ?? [], messages: span.context ?? [] },
      output: generationOutput(span, onSelect),
      outputRaw: { text: span.output, reasoning: span.reasoning, toolCalls: parsedToolCalls(span) },
      metadata: { provider: span.provider, model: span.model, config: span.config, usage: span.usage, ttft: span.ttft, ...span.metadata },
    }
  }
  if (span.type === 'compaction') {
    return {
      input: span.input ? h(JsonView, { value: span.input }) : h(Empty), inputRaw: span.input,
      output: h(Blocks, { blocks: span.output, markdown: true }), outputRaw: span.output,
      metadata: { provider: span.provider, model: span.model, usage: span.usage, ...span.metadata },
    }
  }
  return {
    input: h(ToolInput, { raw: span.input }), inputRaw: parseJson(span.input) ?? span.input,
    output: h(Blocks, { blocks: span.output, markdown: false }), outputRaw: span.output,
    metadata: { status: span.status, ...span.metadata },
  }
}

// 小标签（例如 "延迟 1.2s"、"Tokens 1k → 200"）。值为空或 "—" 时不渲染，避免出现一排空标签。
function Pill({ label, value, color }) {
  if (value === null || value === undefined || value === '' || value === '—') return null
  return h('span', { style: { ...styles.pill, ...(color ? { color, borderColor: tint(color, 40), background: tint(color, 8) } : {}) } },
    label ? h('span', { style: styles.muted }, label) : null, value)
}

// 右侧详情面板整体布局：
//   标题行（类型徽章 + 名称）
//   开始时间
//   一排指标标签：状态 / 延迟 / 首 token 时间(TTFT) / 供应商与模型 / Tokens / 缓存读 / 推理 tokens / 重试次数
//   错误信息框（有错误时）
//   Input、Output、Metadata 三个分区（Metadata 默认折叠）
function Detail({ node, trace, onSelect }) {
  const span = node.span
  const model = detailModel(node, trace, onSelect)
  const usage = node.usage
  const started = formatTime(node.started)
  const statusColor = toneColor(statusTone(node))
  return h('aside', { style: styles.detail },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 } },
      h(KindBadge, { node }),
      h('strong', { style: { fontSize: '15px', fontWeight: 600, ...styles.name } }, node.name),
    ),
    started ? h('div', { style: { ...styles.note, marginTop: '4px' } }, started) : null,
    h('div', { style: styles.pills },
      h(Pill, { value: statusLabel(node.status), color: statusColor }),
      h(Pill, { label: '延迟', value: formatMs(node.duration) }),
      span?.ttft !== null && span?.ttft !== undefined ? h(Pill, { label: '首 token', value: formatMs(span.ttft) }) : null,
      h(Pill, { value: [span?.provider, node.model].filter(Boolean).join(' / ') || null, color: KIND.generation.color }),
      h(Pill, { label: 'Tokens', value: tokenSummary(usage) }),
      usage?.cacheRead ? h(Pill, { label: '缓存读', value: formatTokens(usage.cacheRead) }) : null,
      usage?.reasoning ? h(Pill, { label: '推理', value: formatTokens(usage.reasoning) }) : null,
      span?.metadata?.retry !== undefined ? h(Pill, { label: '重试', value: String(span.metadata.retry), color: KIND.compaction.color }) : null,
    ),
    span?.error ? h('div', { style: styles.errorBox }, typeof span.error === 'string' ? span.error : JSON.stringify(span.error, null, 2)) : null,
    h(Section, { title: 'Input', raw: model.inputRaw }, model.input),
    h(Section, { title: 'Output', raw: model.outputRaw }, model.output),
    h(Section, { title: 'Metadata', raw: model.metadata, toggle: false, defaultOpen: false }, h(JsonView, { value: model.metadata, label: '元数据' })),
  )
}

// ---------- view ----------
// 顶层组件 TraceLensView，以及它用到的默认状态计算。

// 默认折叠状态：除最后一轮外，其余轮次全部折叠（用户最关心的通常是最新一轮）。
function defaultCollapsed(trace) {
  const next = new Set(trace.turns.map(turn => turn.id))
  const last = trace.turns.at(-1)
  if (last) next.delete(last.id)
  return next
}

// 默认选中：最后一轮的最后一个 span；没有 span 就选最后一轮；再不行就选根节点。
function defaultFocus(trace) {
  const turn = trace.turns.at(-1)
  return turn?.spans.at(-1)?.id ?? turn?.id ?? 'trace'
}

// Trace 视图的顶层组件，由 build.mjs 注册到宿主的 'conversation.view' 插槽（即会话页的 "Trace" 标签页）。
// props 由宿主注入：
//   useTrace(selector)    订阅当前会话的 trajectory 快照（原始事件数据），数据变化时组件自动重新渲染
//   useSession(selector)  订阅会话状态，用于判断是否还有更早的历史（hasMore）、是否正在加载
//   loadOlder()           加载更早的历史记录，返回 false 表示没有加载到新内容
// 整体流程：快照 → deriveTrace → buildTree → flattenTree → 左侧树 + 右侧详情。
function TraceLensView(props) {
  // 宿主没传 useTrace 时（例如单测）使用空快照兜底。
  const readTrace = typeof props.useTrace === 'function'
    ? props.useTrace
    : () => ({ eventNodes: [], requests: [], runningCalls: [] })
  const source = readTrace(value => value ?? { eventNodes: [], requests: [], runningCalls: [] })
  // 只有快照变了才重新推导 trace 和重建树（useMemo 缓存）。
  const trace = React.useMemo(() => deriveTrace(source), [source])
  const { root, index } = React.useMemo(() => buildTree(trace), [trace])
  const readSession = typeof props.useSession === 'function' ? props.useSession : null
  const hasMore = readSession ? readSession(value => Boolean(value?.hasMore)) : null
  const sessionLoading = readSession ? readSession(value => Boolean(value?.loadingOlder)) : false

  // ---- 组件状态 ----
  // focus：当前选中节点 id；null 表示用户还没手动选过，此时跟随 defaultFocus（新消息到来会自动跟到最新）。
  const [focus, setFocus] = React.useState(null)
  // collapsedState：被折叠的节点 id 集合；null 表示用户还没手动折叠/展开过，此时用 defaultCollapsed。
  const [collapsedState, setCollapsed] = React.useState(null)
  // mode：'tree' 树模式 / 'timeline' 时间线模式。
  const [mode, setMode] = React.useState('tree')
  // query：搜索框内容。
  const [query, setQuery] = React.useState('')
  // split：左侧树面板宽度百分比，可拖动分隔条调整（限制在 22%～70%）。
  const [split, setSplit] = React.useState(40)
  // loadingOlder：本组件发起的"加载更早记录"是否进行中；exhausted：是否已确认没有更早记录。
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [exhausted, setExhausted] = React.useState(false)

  // ---- DOM 引用和跨渲染的可变数据 ----
  const bodyRef = React.useRef(null)
  const treeRef = React.useRef(null)
  // seenTurns：已经见过的轮次 id，用于识别"新加载进来"的轮次。
  const seenTurns = React.useRef(new Set())
  // pendingScroll：下一次渲染完成后需要滚动到的节点 id。
  const pendingScroll = React.useRef(null)

  const collapsed = collapsedState ?? defaultCollapsed(trace)
  const rows = React.useMemo(() => flattenTree(root, collapsed, query), [root, collapsed, query])
  // 选中节点：优先用户选的；该节点不存在（例如数据刷新后消失）就退回默认选中，最后兜底根节点。
  const selected = (focus && index.get(focus)) ?? index.get(defaultFocus(trace)) ?? root
  const scale = timeScale(root)

  // 副作用一：处理"加载更早的记录"后新出现的旧轮次。
  //   - 首次渲染只做登记，不处理。
  //   - 新出现的轮次中，除了最后一轮（那是正常进行中的新一轮），其余都是刚加载进来的旧历史：
  //     把它们折叠起来，并记下最早那一轮，渲染后滚动过去，让用户看到新加载的内容从哪里开始。
  React.useEffect(() => {
    const ids = trace.turns.map(turn => turn.id)
    const first = seenTurns.current.size === 0
    const fresh = ids.filter(id => !seenTurns.current.has(id))
    for (const id of ids) seenTurns.current.add(id)
    if (first || fresh.length === 0) return
    const last = ids.at(-1)
    const older = fresh.filter(id => id !== last)
    if (older.length === 0) return
    pendingScroll.current = older[0]
    setCollapsed(previous => {
      const next = new Set(previous ?? defaultCollapsed(trace))
      for (const id of older) next.add(id)
      return next
    })
  }, [trace])

  // 副作用二：行列表更新后，如果有待滚动的目标，把它滚动到树面板顶部（执行一次后清空）。
  React.useEffect(() => {
    const id = pendingScroll.current
    if (!id) return
    pendingScroll.current = null
    treeRef.current?.querySelector(`[data-node="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' })
  }, [rows])

  // 副作用三：选中节点变化时，把对应行滚动到可见区域（'nearest' 表示已可见则不滚动）。
  React.useEffect(() => {
    treeRef.current?.querySelector(`[data-node="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected.id])

  // 选中某个节点：先把它的所有祖先展开（保证它在树里可见），再设为选中。
  // 如果祖先本来就都是展开的，返回原 Set 对象，React 判断引用没变就不会额外重新渲染。
  function select(id) {
    const node = index.get(id)
    if (!node) return
    setCollapsed(previous => {
      const base = previous ?? defaultCollapsed(trace)
      const next = new Set(base)
      for (let parent = node.parent; parent; parent = parent.parent) next.delete(parent.id)
      return next.size === base.size ? base : next
    })
    setFocus(id)
  }

  // 展开/折叠单个节点。open 不传则在当前状态上取反；传 true/false 则强制展开/折叠。
  function toggle(id, open) {
    setCollapsed(previous => {
      const next = new Set(previous ?? defaultCollapsed(trace))
      const shouldOpen = open ?? next.has(id)
      if (shouldOpen) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // 全部展开 / 全部折叠（全部折叠时保留根节点展开，否则整棵树只剩一行）。
  function setAll(open) {
    if (open) { setCollapsed(new Set()); return }
    const next = new Set()
    for (const node of index.values()) if (node.children.length > 0 && node.kind !== 'trace') next.add(node.id)
    setCollapsed(next)
  }

  // 树的键盘导航（与常见的文件树操作一致）：
  //   ↑/↓  上一行/下一行
  //   →    展开当前节点
  //   ←    当前节点已展开则折叠，否则跳到父节点
  function onKeyDown(event) {
    const at = rows.findIndex(row => row.node.id === selected.id)
    const row = rows[at]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = rows[Math.min(rows.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]
      if (next) setFocus(next.node.id)
    } else if (event.key === 'ArrowRight' && row?.hasChildren && !row.open) {
      event.preventDefault()
      toggle(row.node.id, true)
    } else if (event.key === 'ArrowLeft' && row) {
      event.preventDefault()
      if (row.hasChildren && row.open) toggle(row.node.id, false)
      else if (row.node.parent) setFocus(row.node.parent.id)
    }
  }

  // 拖动中间分隔条调整左右面板宽度：
  // 按下时在 window 上注册 pointermove / pointerup 监听，移动时按鼠标位置换算百分比，松开时移除监听。
  function startResize(event) {
    const body = bodyRef.current
    if (!body) return
    event.preventDefault()
    const rect = body.getBoundingClientRect()
    const move = moveEvent => setSplit(Math.min(70, Math.max(22, ((moveEvent.clientX - rect.left) / rect.width) * 100)))
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  // "加载更早的记录"按钮：
  //   canLoad  宿主提供了 loadOlder，会话没明确说没有更多，且之前没有加载到空结果
  //   busy     本组件或宿主正在加载中（防止重复点击）
  const canLoad = typeof props.loadOlder === 'function' && hasMore !== false && !exhausted
  const busy = loadingOlder || sessionLoading
  function onEarlier() {
    if (!canLoad || busy) return
    setLoadingOlder(true)
    // Promise.resolve 兼容 loadOlder 同步/异步两种返回。
    void Promise.resolve(props.loadOlder()).then(changed => {
      if (changed === false) setExhausted(true)
    }).finally(() => setLoadingOlder(false))
  }

  // 没有任何轮次时显示空状态。
  // 注意：这个提前 return 必须放在所有 React.useXxx 调用之后——React 要求每次渲染调用 Hook 的顺序和数量完全一致。
  if (trace.turns.length === 0) {
    return h('div', { style: styles.root }, h('div', { style: styles.empty }, '当前会话还没有可观测的记录。'))
  }

  // 工具栏按钮的小工厂函数，on=true 时显示为按下状态。
  const toolButton = (label, onClick, on = false, extra = {}) => h('button', {
    type: 'button', style: { ...styles.toolButton, ...(on ? styles.toolButtonOn : {}) }, onClick, ...extra,
  }, label)

  // ---- 页面结构 ----
  //   header：根节点徽章与名称、轮次/观测/延迟/Tokens 汇总、"历史不完整"提示、加载更早记录按钮
  //   body：
  //     左侧 treePane：搜索框 + 树/时间线切换 + 全部展开/折叠，下方是树（每行一个 TreeRow）
  //     中间 splitter：可拖动的分隔条
  //     右侧 Detail：选中节点的详情
  // data-trace-lens-root 属性供 steady-tabs.js 里的 CSS 定位本视图。
  return h('div', { style: styles.root, 'data-trace-lens-root': '' },
    h('header', { style: styles.header },
      h(KindBadge, { node: root }),
      h('strong', { style: { fontWeight: 600, ...styles.name, maxWidth: '40%' } }, root.name),
      h(Pill, { label: '轮次', value: String(trace.turns.length) }),
      h(Pill, { label: '观测', value: String(trace.spans.length) }),
      h(Pill, { label: '延迟', value: formatMs(root.duration) }),
      h(Pill, { label: 'Tokens', value: tokenSummary(trace.usage) }),
      trace.incompleteHistory ? h(Pill, { value: '历史不完整', color: KIND.compaction.color }) : null,
      h('span', { style: { marginLeft: 'auto' } },
        canLoad
          ? toolButton(busy ? '正在加载…' : '加载更早的记录', onEarlier, false, { disabled: busy })
          : h('span', { style: { ...styles.note } }, '已是最早的记录')),
    ),
    h('div', { style: styles.body, ref: bodyRef },
      h('div', { style: { ...styles.treePane, width: `${split}%` } },
        h('div', { style: styles.toolbar },
          h('input', {
            type: 'search', value: query, placeholder: '搜索名称、类型、模型', style: styles.search,
            onChange: event => setQuery(event.target.value),
          }),
          toolButton('树', () => setMode('tree'), mode === 'tree'),
          toolButton('时间线', () => setMode('timeline'), mode === 'timeline'),
          toolButton('展开', () => setAll(true), false, { title: '全部展开' }),
          toolButton('折叠', () => setAll(false), false, { title: '全部折叠' }),
        ),
        // 树容器：tabIndex=0 使其可获得键盘焦点，从而响应 onKeyDown 的方向键导航。
        h('div', { role: 'tree', tabIndex: 0, style: styles.tree, ref: treeRef, onKeyDown },
          rows.map(row => h(TreeRow, {
            key: row.node.id, row, mode, scale, active: row.node.id === selected.id,
            onSelect: select, onToggle: id => toggle(id),
          })),
          rows.length === 0 && query ? h('div', { style: styles.empty }, '没有匹配的观测') : null,
          trace.warnings?.length ? h('div', { style: { ...styles.note, padding: '8px 12px' } }, trace.warnings.join(' · ')) : null,
        ),
      ),
      h('div', { style: styles.splitter, onPointerDown: startResize, role: 'separator', 'aria-orientation': 'vertical' }),
      // key 设为选中节点 id：切换选中时 Detail 会整个重建，
      // 这样里面各个 Section / Message 的折叠状态会重置为默认值，不会沿用上一个节点的状态。
      h(Detail, { key: selected.id, node: selected, trace, onSelect: select }),
    ),
  )
}
