// Settings page that imports offline session logs and opens them in a full-window Trace view.

const importStore = (() => {
  let items = []
  const listeners = new Set()
  return {
    get: () => items,
    set(next) { items = next; for (const listener of listeners) listener() },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
})()

const importStyles = {
  page: { display: 'flex', flexDirection: 'column', gap: '16px', color: 'var(--dsw-alias-label-primary)', fontSize: '13px' },
  title: { margin: 0, fontSize: '16px', fontWeight: 600 },
  drop: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', padding: '28px 16px',
    border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: '10px', textAlign: 'center',
    background: 'var(--dsw-alias-bg-layer-2)', cursor: 'pointer',
  },
  dropActive: { borderColor: BRAND, background: tint(BRAND, 8) },
  primary: {
    height: '28px', padding: '0 12px', borderRadius: '6px', border: 0, cursor: 'pointer',
    background: BRAND, color: '#fff', font: 'inherit', fontSize: '12px', fontWeight: 500,
  },
  secondary: {
    height: '28px', padding: '0 12px', borderRadius: '6px', cursor: 'pointer', font: 'inherit', fontSize: '12px',
    border: '1px solid var(--dsw-alias-border-l2)', background: 'transparent', color: 'var(--dsw-alias-label-primary)',
  },
  card: {
    display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '12px 14px',
    border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '10px',
  },
  cardMain: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
  cardTitle: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  error: { padding: '8px 12px', borderRadius: '8px', color: ERROR_COLOR, background: tint(ERROR_COLOR, 10), fontSize: '12px', overflowWrap: 'anywhere' },
  overlay: {
    position: 'fixed', inset: 0, zIndex: 2147483000, display: 'flex', flexDirection: 'column',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', '--dsh-composer-height': '0px',
  },
  overlayHead: {
    display: 'flex', alignItems: 'center', gap: '10px', flex: 'none', padding: '10px 16px',
    paddingTop: 'max(10px, env(titlebar-area-height, 0px))', borderBottom: '1px solid var(--dsw-alias-border-l2)',
    fontSize: '13px',
  },
  select: {
    height: '28px', maxWidth: '40%', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', font: 'inherit', fontSize: '12px',
  },
}

function formatBytes(size) {
  if (size >= 1 << 20) return `${(size / (1 << 20)).toFixed(1)} MB`
  if (size >= 1 << 10) return `${(size / (1 << 10)).toFixed(1)} KB`
  return `${size} B`
}

async function importFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const text = await decodeSessionBytes(bytes, { zstd: data => fzstd.decompress(data) })
  const { events, invalidLines } = parseSessionText(text)
  if (events.length === 0) throw new Error('文件里没有可识别的 session 事件')
  const { snapshot, info } = eventsToSnapshot(events)
  const trace = deriveTrace(snapshot)
  if (trace.turns.length === 0) throw new Error('没有找到任何轮次（是否为 DSH session 日志？）')
  return {
    key: `${file.name}:${file.size}:${file.lastModified}:${Date.now()}`,
    fileName: file.name, size: file.size, importedAt: Date.now(), invalidLines, info, snapshot,
    summary: {
      turns: trace.turns.length, observations: trace.spans.length, usage: trace.usage,
      generationErrors: trace.turns.reduce((total, turn) => total + (turn.generationErrorCount ?? 0), 0),
      toolErrors: trace.turns.reduce((total, turn) => total + (turn.toolErrorCount ?? 0), 0),
    },
  }
}

let overlayHost = null

function closeAnalyzer() {
  if (!overlayHost) return
  overlayHost.root.unmount()
  overlayHost.element.remove()
  overlayHost = null
}

function openAnalyzer(key) {
  const ReactDOMClient = require('react-dom/client')
  if (!overlayHost) {
    const element = document.createElement('div')
    element.setAttribute('data-trace-lens-import', '')
    document.body.appendChild(element)
    overlayHost = { element, root: ReactDOMClient.createRoot(element) }
  }
  overlayHost.root.render(h(AnalyzerOverlay, { initialKey: key, onClose: closeAnalyzer }))
}

function AnalyzerOverlay({ initialKey, onClose }) {
  const items = React.useSyncExternalStore(importStore.subscribe, importStore.get)
  const [key, setKey] = React.useState(initialKey)
  const item = items.find(entry => entry.key === key) ?? items[0]
  React.useEffect(() => {
    const onKey = event => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  if (!item) return null
  return h('div', { style: importStyles.overlay, role: 'dialog', 'aria-modal': 'true', 'aria-label': '导入的 session 分析' },
    h('div', { style: importStyles.overlayHead },
      h('span', { style: { ...styles.badge, color: BRAND, background: tint(BRAND, 14) } }, 'IMPORT'),
      items.length > 1
        ? h('select', { style: importStyles.select, value: item.key, onChange: event => setKey(event.target.value) },
          items.map(entry => h('option', { key: entry.key, value: entry.key }, entry.info.title ?? entry.fileName)))
        : h('strong', { style: { fontWeight: 600, ...styles.name } }, item.info.title ?? item.fileName),
      h('span', { style: { ...styles.note, ...styles.name } }, [item.fileName, item.info.id].filter(Boolean).join(' · ')),
      h('button', { type: 'button', style: { ...importStyles.secondary, marginLeft: 'auto' }, onClick: onClose }, '关闭（Esc）'),
    ),
    h('div', { style: { flex: 1, minHeight: 0 } },
      h(TraceLensView, { key: item.key, useTrace: select => select(item.snapshot) })),
  )
}

function ImportedCard({ item, onOpen, onRemove }) {
  const { info, summary } = item
  const created = formatTime(info.createdAt)
  return h('div', { style: importStyles.card },
    h('div', { style: importStyles.cardMain },
      h('div', { style: importStyles.cardTitle }, info.title ?? item.fileName),
      h('div', { style: importStyles.meta }, [item.fileName, formatBytes(item.size), info.id].filter(Boolean).join(' · ')),
      h('div', { style: importStyles.meta }, [
        created ? `创建于 ${created}` : null,
        info.cwd ? `目录 ${info.cwd}` : null,
      ].filter(Boolean).join(' · ')),
      h('div', { style: { ...styles.pills, marginTop: '4px' } },
        h(Pill, { label: '轮次', value: String(summary.turns) }),
        h(Pill, { label: '观测', value: String(summary.observations) }),
        h(Pill, { label: 'Tokens', value: tokenSummary(summary.usage) }),
        summary.generationErrors > 0 ? h(Pill, { value: `${summary.generationErrors} 个生成错误`, color: ERROR_COLOR }) : null,
        summary.toolErrors > 0 ? h(Pill, { value: `${summary.toolErrors} 个工具错误`, color: WARN_COLOR }) : null,
        info.models.length > 0 ? h(Pill, { value: info.models.join('、'), color: KIND.generation.color }) : null,
        item.invalidLines > 0 ? h(Pill, { value: `跳过 ${item.invalidLines} 行无效数据`, color: KIND.compaction.color }) : null,
        info.version !== null && info.version !== 4 ? h(Pill, { value: `格式版本 v${info.version}，可能不完全兼容`, color: KIND.compaction.color }) : null,
      ),
    ),
    h('div', { style: { display: 'flex', gap: '6px', flex: 'none' } },
      h('button', { type: 'button', style: importStyles.primary, onClick: onOpen }, '打开分析'),
      h('button', { type: 'button', style: importStyles.secondary, onClick: onRemove }, '移除'),
    ),
  )
}

function SessionImportSection(props) {
  const items = React.useSyncExternalStore(importStore.subscribe, importStore.get)
  const [dragging, setDragging] = React.useState(false)
  const [busy, setBusy] = React.useState(0)
  const [errors, setErrors] = React.useState([])
  const inputRef = React.useRef(null)

  async function addFiles(files) {
    const list = [...files]
    if (list.length === 0) return
    setBusy(count => count + list.length)
    const failures = []
    for (const file of list) {
      try {
        const item = await importFile(file)
        importStore.set([item, ...importStore.get()])
      } catch (error) {
        failures.push(`${file.name}：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setBusy(count => count - 1)
      }
    }
    setErrors(failures)
  }

  function open(key) {
    props.close?.()
    openAnalyzer(key)
  }

  return h('div', { style: importStyles.page },
    h('div', null,
      h('h2', { style: importStyles.title }, 'Session 分析'),
      h('p', { style: { ...styles.note, margin: '6px 0 0' } },
        '导入线上或他人导出的 session 日志，用 Trace 视图分析。支持 session.v4.jsonl、.jsonl.zstd、.gz 以及 JSON 数组。导入的数据只保存在当前窗口内存中，不会写入本地会话，重启后需要重新导入。'),
    ),
    h('div', {
      role: 'button', tabIndex: 0,
      style: { ...importStyles.drop, ...(dragging ? importStyles.dropActive : {}) },
      onClick: () => inputRef.current?.click(),
      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inputRef.current?.click() } },
      onDragOver: event => { event.preventDefault(); setDragging(true) },
      onDragLeave: () => setDragging(false),
      onDrop: event => { event.preventDefault(); setDragging(false); void addFiles(event.dataTransfer.files) },
    },
    h('strong', { style: { fontWeight: 600 } }, busy > 0 ? `正在解析 ${busy} 个文件…` : '拖入日志文件，或点击选择'),
    h('span', { style: styles.note }, '本地日志位置：~/.dsh/sessions/<工作区>/<session>/session.v4.jsonl.zstd'),
    h('input', {
      ref: inputRef, type: 'file', multiple: true, style: { display: 'none' },
      accept: '.jsonl,.json,.zstd,.zst,.gz,.log,.txt',
      onChange: event => { void addFiles(event.target.files); event.target.value = '' },
    }),
    ),
    errors.length > 0 ? h('div', { style: importStyles.error }, errors.map((message, index) => h('div', { key: index }, message))) : null,
    items.length > 0
      ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
        h('div', { style: { display: 'flex', alignItems: 'center' } },
          h('strong', { style: { fontWeight: 600 } }, `已导入 ${items.length} 个`),
          h('button', { type: 'button', style: { ...importStyles.secondary, marginLeft: 'auto' }, onClick: () => importStore.set([]) }, '全部清空')),
        items.map(item => h(ImportedCard, {
          key: item.key, item,
          onOpen: () => open(item.key),
          onRemove: () => importStore.set(importStore.get().filter(entry => entry.key !== item.key)),
        })))
      : null,
  )
}
