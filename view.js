const P = (() => {
  try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch (error) {
    // Hosts without the shared primitives module fall back to built-in renderers.
    void error
    return null
  }
})()

const KIND = {
  trace: { label: 'TRACE', color: 'var(--dsw-static-gray-500, #6b7280)' },
  turn: { label: 'SPAN', color: 'var(--dsw-static-indigo-500, #6366f1)' },
  generation: { label: 'GENERATION', color: 'var(--dsw-static-blue-500, #3b82f6)' },
  tool: { label: 'TOOL', color: 'var(--dsw-static-purple-500, #8b5cf6)' },
  delegation: { label: 'TOOL', color: 'var(--dsw-static-teal-500, #14b8a6)' },
  compaction: { label: 'EVENT', color: 'var(--dsw-static-orange-500, #f59e0b)' },
}
const ERROR_COLOR = 'var(--dsw-static-red-500, #ef4444)'
const WARN_COLOR = 'var(--dsw-static-amber-600, #d97706)'
const GREEN = 'var(--dsw-static-green-500, #22c55e)'
const COMPLETE_COLOR = 'var(--dsw-static-blue-500, #3b82f6)'
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const BRAND = 'var(--dsw-alias-brand-primary, #3b82f6)'

const JSON_LABELS = {
  copyValue: '复制值', copyJson: '复制 JSON', copyPath: '复制路径',
  copyPrettyJson: '复制格式化 JSON', copyCompactJson: '复制紧凑 JSON',
  copied: '已复制', copyFailed: '复制失败', collapseNode: '折叠', expandNode: '展开',
  copyButtonTitle: action => `${action}（右键更多）`,
}
const MD_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '脚注' }

function tint(color, percent) {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}

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

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
function formatTokens(value) {
  if (value === null || value === undefined) return '—'
  const count = safeNumber(value)
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(count >= 1e4 ? 1 : 2)}k`
  return String(Math.round(count))
}
function formatMs(value) {
  if (!(value >= 0)) return '—'
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60000) return `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}s`
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`
}
function formatTime(value) {
  if (typeof value !== 'number') return null
  return new Date(value).toLocaleString(undefined, { hour12: false })
}
function statusLabel(status) {
  if (status === 'running') return '运行中'
  if (status === 'error') return '失败'
  if (status === 'warning') return '工具报错'
  if (status === 'complete') return '完成'
  return '未知'
}
function statusTone(node) {
  return node.status === 'error' || node.status === 'warning' || node.status === 'running' || node.status === 'complete' ? node.status : null
}
function toneColor(tone) {
  if (tone === 'error') return ERROR_COLOR
  if (tone === 'warning') return WARN_COLOR
  if (tone === 'running') return GREEN
  if (tone === 'complete') return COMPLETE_COLOR
  return null
}
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
function tokenSummary(usage) {
  if (!usage) return null
  const parts = [`${formatTokens(usage.input)} → ${formatTokens(usage.output)}`]
  if (usage.total !== null && usage.total !== undefined) parts.push(`(∑ ${formatTokens(usage.total)})`)
  return parts.join(' ')
}

// ---------- tree ----------

function spanTree(spans) {
  const ids = new Set(spans.map(span => span.id))
  const groups = new Map()
  for (const span of spans) {
    const key = span.parentId && ids.has(span.parentId) ? span.parentId : ''
    const list = groups.get(key) ?? []
    list.push(span)
    groups.set(key, list)
  }
  const build = parentId => (groups.get(parentId) ?? []).map(span => ({
    id: span.id, kind: span.type, name: span.name, status: span.status, started: span.started,
    completed: span.completed, duration: span.duration, usage: span.usage, model: span.model,
    span, children: build(span.id),
  }))
  return build('')
}

function traceBounds(turns) {
  const starts = turns.map(turn => turn.started).filter(value => value !== null)
  const ends = turns.map(turn => turn.completed).filter(value => value !== null)
  return {
    started: starts.length ? Math.min(...starts) : null,
    completed: ends.length ? Math.max(...ends) : null,
  }
}

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
  const index = new Map()
  const walk = (node, parent) => {
    node.parent = parent
    index.set(node.id, node)
    for (const child of node.children) walk(child, node)
  }
  walk(root, null)
  return { root, index }
}

function nodeText(node) {
  return `${node.name} ${KIND[node.kind]?.label ?? ''} ${node.model ?? ''}`.toLowerCase()
}

function flattenTree(root, collapsed, query) {
  const rows = []
  const needle = query.trim().toLowerCase()
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

function timeScale(node) {
  if (node.started === null) return null
  const end = node.completed ?? node.started
  return { origin: node.started, span: Math.max(end - node.started, 1) }
}

function barBox(node, scale) {
  if (!scale || node.started === null) return null
  const left = Math.max(0, ((node.started - scale.origin) / scale.span) * 100)
  const end = node.completed === null ? node.started : node.completed
  const width = Math.max(((end - node.started) / scale.span) * 100, 0.8)
  const clampedLeft = Math.min(left, 99)
  return { left: `${clampedLeft}%`, width: `${Math.min(width, 100 - clampedLeft)}%` }
}

function KindBadge({ node }) {
  const tone = statusTone(node)
  const color = tone === 'error' || tone === 'warning' ? toneColor(tone) : (KIND[node.kind]?.color ?? KIND.generation.color)
  return h('span', { style: { ...styles.badge, color, background: tint(color, 14) } }, KIND[node.kind]?.label ?? node.kind)
}

function StatusDot({ node }) {
  const tone = statusTone(node)
  if (tone === null || (tone === 'complete' && node.kind !== 'turn' && node.kind !== 'trace')) return null
  return h('span', { title: statusLabel(node.status), style: { ...styles.dot, background: toneColor(tone) } })
}

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

function countObservations(node) {
  let count = 0
  const walk = item => { for (const child of item.children) { if (child.span) count += 1; walk(child) } }
  walk(node)
  return count
}

function TreeRow({ row, active, mode, scale, onSelect, onToggle }) {
  const { node, depth, hasChildren, open } = row
  const box = mode === 'timeline' ? barBox(node, scale) : null
  const tone = statusTone(node)
  const color = tone === 'error' || tone === 'warning' ? toneColor(tone) : (KIND[node.kind]?.color ?? KIND.generation.color)
  const [hover, setHover] = React.useState(false)
  return h('div', {
    role: 'treeitem', 'aria-selected': active, 'aria-expanded': hasChildren ? open : undefined,
    'data-node': node.id,
    style: { ...styles.row, ...(hover && !active ? { background: 'var(--dsw-alias-interactive-bg-hover)' } : {}), ...(active ? styles.rowActive : {}) },
    onClick: () => onSelect(node.id),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
  },
  Array.from({ length: depth }, (_, index) => h('span', { key: index, style: styles.guide })),
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
  mode === 'timeline'
    ? h('div', { style: styles.track },
      box ? h('span', { style: { ...styles.bar, ...box, background: color, opacity: node.status === 'running' ? 0.5 : 0.85 } }) : null,
      h('span', { style: { ...styles.barLabel, left: box ? `calc(${box.left} + ${box.width} + 4px)` : 0 } }, formatMs(node.duration)),
    )
    : null,
  )
}

// ---------- rendering primitives ----------

const JSON_TOKEN = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function ColoredJson({ value }) {
  let text
  try { text = JSON.stringify(value, null, 2) ?? String(value) } catch (error) { text = String(error) }
  const parts = []
  let last = 0
  let key = 0
  for (const match of text.matchAll(JSON_TOKEN)) {
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

function JsonView({ value, label = 'JSON' }) {
  if (value === null || value === undefined) return h(Empty)
  if (P?.JsonTree && typeof value === 'object') {
    return h('div', { style: styles.scroll },
      h(P.JsonTree, { data: value, label, labels: JSON_LABELS, collapsedStringLines: 8, expandTopLevel: true }))
  }
  return h(ColoredJson, { value })
}

function RawJson({ value }) {
  if (value === null || value === undefined) return h(Empty)
  if (P?.CodeBlock) {
    let code
    try { code = JSON.stringify(value, null, 2) ?? String(value) } catch (error) { code = String(error) }
    return h('div', { style: styles.scroll }, h(P.CodeBlock, { code, lang: 'json', copyLabel: '复制', copiedLabel: '已复制' }))
  }
  return h(ColoredJson, { value })
}

function CodeView({ code, lang }) {
  if (P?.CodeBlock) {
    return h('div', { style: styles.scroll }, h(P.CodeBlock, { code, lang, copyLabel: '复制', copiedLabel: '已复制' }))
  }
  return h('pre', { style: { ...styles.pre, ...styles.scroll } }, code)
}

function MarkdownView({ text }) {
  if (!text) return h(Empty)
  if (P?.MarkdownText) {
    return h('div', { style: { minWidth: 0 } }, h(P.MarkdownText, { text, labels: MD_LABELS, variant: 'compact' }))
  }
  return h('pre', { style: styles.pre }, text)
}

function Empty() {
  return h('span', { style: styles.note }, '—')
}

function TextValue({ text, markdown }) {
  const json = parseJson(text)
  if (json !== undefined) return h(JsonView, { value: json })
  return markdown ? h(MarkdownView, { text }) : h(CodeView, { code: text })
}

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

const CODE_FIELDS = { command: 'bash', cmd: 'bash', script: 'bash', code: null, patch: 'diff', diff: 'diff', sql: 'sql', query: null }

function guessCodeLanguage(args, code) {
  const declared = typeof args.language === 'string' ? args.language : typeof args.lang === 'string' ? args.lang : null
  if (declared) return declared
  if (/^\s*(def |from \S+ import |import \w+\s*$|print\()/m.test(code) && !/\b(const|let|=>)\b/.test(code)) return 'python'
  return 'typescript'
}

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

function parsedToolCalls(span) {
  return (span.toolCalls ?? []).map(call => ({ ...call, args: parseJson(call.args) ?? call.args }))
}

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

function Pill({ label, value, color }) {
  if (value === null || value === undefined || value === '' || value === '—') return null
  return h('span', { style: { ...styles.pill, ...(color ? { color, borderColor: tint(color, 40), background: tint(color, 8) } : {}) } },
    label ? h('span', { style: styles.muted }, label) : null, value)
}

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

function defaultCollapsed(trace) {
  const next = new Set(trace.turns.map(turn => turn.id))
  const last = trace.turns.at(-1)
  if (last) next.delete(last.id)
  return next
}

function defaultFocus(trace) {
  const turn = trace.turns.at(-1)
  return turn?.spans.at(-1)?.id ?? turn?.id ?? 'trace'
}

function TraceLensView(props) {
  const readTrace = typeof props.useTrace === 'function'
    ? props.useTrace
    : () => ({ eventNodes: [], requests: [], runningCalls: [] })
  const source = readTrace(value => value ?? { eventNodes: [], requests: [], runningCalls: [] })
  const trace = React.useMemo(() => deriveTrace(source), [source])
  const { root, index } = React.useMemo(() => buildTree(trace), [trace])
  const readSession = typeof props.useSession === 'function' ? props.useSession : null
  const hasMore = readSession ? readSession(value => Boolean(value?.hasMore)) : null
  const sessionLoading = readSession ? readSession(value => Boolean(value?.loadingOlder)) : false
  const [focus, setFocus] = React.useState(null)
  const [collapsedState, setCollapsed] = React.useState(null)
  const [mode, setMode] = React.useState('tree')
  const [query, setQuery] = React.useState('')
  const [split, setSplit] = React.useState(40)
  const [loadingOlder, setLoadingOlder] = React.useState(false)
  const [exhausted, setExhausted] = React.useState(false)
  const bodyRef = React.useRef(null)
  const treeRef = React.useRef(null)
  const seenTurns = React.useRef(new Set())
  const pendingScroll = React.useRef(null)
  const collapsed = collapsedState ?? defaultCollapsed(trace)
  const rows = React.useMemo(() => flattenTree(root, collapsed, query), [root, collapsed, query])
  const selected = (focus && index.get(focus)) ?? index.get(defaultFocus(trace)) ?? root
  const scale = timeScale(root)

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

  React.useEffect(() => {
    const id = pendingScroll.current
    if (!id) return
    pendingScroll.current = null
    treeRef.current?.querySelector(`[data-node="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' })
  }, [rows])

  React.useEffect(() => {
    treeRef.current?.querySelector(`[data-node="${CSS.escape(selected.id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected.id])

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

  function toggle(id, open) {
    setCollapsed(previous => {
      const next = new Set(previous ?? defaultCollapsed(trace))
      const shouldOpen = open ?? next.has(id)
      if (shouldOpen) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function setAll(open) {
    if (open) { setCollapsed(new Set()); return }
    const next = new Set()
    for (const node of index.values()) if (node.children.length > 0 && node.kind !== 'trace') next.add(node.id)
    setCollapsed(next)
  }

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

  const canLoad = typeof props.loadOlder === 'function' && hasMore !== false && !exhausted
  const busy = loadingOlder || sessionLoading
  function onEarlier() {
    if (!canLoad || busy) return
    setLoadingOlder(true)
    void Promise.resolve(props.loadOlder()).then(changed => {
      if (changed === false) setExhausted(true)
    }).finally(() => setLoadingOlder(false))
  }

  if (trace.turns.length === 0) {
    return h('div', { style: styles.root }, h('div', { style: styles.empty }, '当前会话还没有可观测的记录。'))
  }

  const toolButton = (label, onClick, on = false, extra = {}) => h('button', {
    type: 'button', style: { ...styles.toolButton, ...(on ? styles.toolButtonOn : {}) }, onClick, ...extra,
  }, label)

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
      h(Detail, { key: selected.id, node: selected, trace, onSelect: select }),
    ),
  )
}
