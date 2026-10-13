import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const Fragment = Symbol('Fragment')
const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat(Infinity) } })
// The first useState call in TraceLensView holds the focused node id.
const stateOverrides = []
const FakeReact = {
  Fragment, createElement,
  useState: (initial) => [stateOverrides.length ? stateOverrides.shift() : typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (factory) => factory(),
  useEffect: () => {},
  useRef: (current) => ({ current }),
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

function render(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (Array.isArray(node)) { for (const child of node) render(child, out); return out }
  if (typeof node !== 'object') { out.push(String(node)); return out }
  if (typeof node.type === 'function') return render(node.type(node.props), out)
  for (const child of node.props.children ?? []) render(child, out)
  return out
}

function loadComponents(primitives) {
  let factory
  globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
  globalThis.CSS = { escape: (value) => value }
  new Function(fs.readFileSync(path.join(root, 'client.js'), 'utf8'))()
  const modules = { react: FakeReact, '@deepseek-ai/dsh-client-ui-primitives': primitives }
  const components = {}
  const effects = {}
  const plugin = factory((id) => {
    if (modules[id] === undefined) throw new Error(`missing ${id}`)
    return modules[id]
  })
  plugin.apply({
    uiSession: { provide: () => {} }, uiConversation: {}, sessions: {},
    effect: (callback, label) => { effects[label] = callback },
    slots: { inject: (_name, register) => register(), register: (options, component) => { components[options.name] = { options, component } } },
  })
  components.effects = effects
  return components
}
const loadView = (primitives) => loadComponents(primitives)['conversation.view'].component

const assistant = (turn, step, seq, blocks) => ({
  kind: 'assistant', turn, step, seq, time: seq, blocks,
  timing: { stepStartTime: seq - 10, firstTokenTime: seq - 5, completedTime: seq },
  providerMetadata: { provider: 'deepseek', model: 'deepseek-chat' }, usage: { inputTokens: 10, outputTokens: 5 },
})
const snapshot = {
  eventNodes: [
    { kind: 'user', seq: 1, time: 1, content: [{ type: 'text', text: '修复 **bug**' }], source: {} },
    assistant(1, 1, 20, [{ kind: 'reasoning', text: '想一想' }, { kind: 'text', text: '先运行命令' }, { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{"command":"ls -la","timeout":10}' }]),
    { kind: 'tool-result', seq: 25, callId: 'c1', name: 'bash', args: {}, call: { name: 'bash', argsRaw: '{"command":"ls -la","timeout":10}' }, callTime: 20, time: 25, content: [{ type: 'text', text: '{"ok":true}' }], isError: false, subCalls: [] },
    assistant(1, 2, 40, [{ kind: 'text', text: '完成' }]),
  ],
  eventLocations: new Map(),
  requests: [{ purpose: 'assistant', turn: 1, step: 1, startSeq: 2, startedAt: 10, completedAt: 20, status: 'complete', prompt: { config: { provider: 'deepseek', model: 'deepseek-chat' }, system: '你是助手', tools: [{ name: 'bash', description: '运行命令', parameters: { type: 'object' } }] } }],
  runningCalls: [],
}

for (const [label, primitives] of [['fallback renderers', {}], ['shared primitives', {
  JsonTree: (props) => createElement('json-tree', null, JSON.stringify(props.data)),
  CodeBlock: (props) => createElement('code-block', null, `${props.lang ?? 'plain'}:${props.code}`),
  MarkdownText: (props) => createElement('markdown', null, props.text),
}]]) {
  test(`renders tree and every detail kind with ${label}`, () => {
    const View = loadView(primitives)
    const draw = (focus) => {
      stateOverrides.push(focus)
      return render(createElement(View, { useTrace: (select) => select(snapshot) })).join('')
    }
    const tree = draw(null)
    for (const expected of ['TRACE', 'SPAN', 'GENERATION', 'TOOL', '第 1 轮', 'Input', 'Output', 'Metadata']) assert.match(tree, new RegExp(expected))
    assert.match(draw('trace'), /修复/)
    assert.match(draw('turn-1'), /完成/)
    const generation = draw('generation-1-1')
    for (const expected of ['SYSTEM', '你是助手', 'TOOLS', 'USER', 'REASONING', 'ASSISTANT', 'TOOL CALL', 'ls -la']) assert.match(generation, new RegExp(expected))
    const tool = draw('tool-c1')
    assert.match(tool, /ls -la/)
    assert.match(tool, /"ok"/)
    if (label === 'shared primitives') assert.match(tool, /bash:ls -la/)
    assert.match(draw('generation-1-2'), /TOOL.*bash/)
  })
}

test('registers a settings section that renders the import page', () => {
  const { options, component } = loadComponents({})['settings.section']
  assert.equal(options.id, 'trace-lens-import')
  assert.equal(options.label(), 'Session 分析')
  const text = render(createElement(component, { close: () => {} })).join('')
  assert.match(text, /拖入日志文件/)
  assert.match(text, /session\.v4\.jsonl/)
})

test('keeps claude-style view tabs visible while installed and removes the override on dispose', () => {
  const appended = []
  globalThis.document = {
    createElement: () => ({ attributes: {}, setAttribute(name, value) { this.attributes[name] = value }, remove() { appended.splice(appended.indexOf(this), 1) } }),
    head: { appendChild: (element) => { appended.push(element) } },
  }
  const { effects } = loadComponents({})
  const dispose = effects['trace-lens steady view tabs']()
  assert.equal(appended.length, 1)
  assert.match(appended[0].textContent, /\[data-dsh-view-tabs\][\s\S]*opacity: 1 !important/)
  assert.match(appended[0].textContent, /transition: none !important/)
  assert.match(appended[0].textContent, /#root \[data-trace-lens-root\] \{\s*padding-top: calc\(var\(--dsh-transcript-fade-h, 28px\) \/ 2\)/)
  dispose()
  assert.equal(appended.length, 0)
  delete globalThis.document
})

test('renders an empty trace message', () => {
  const View = loadView({})
  const text = render(createElement(View, { useTrace: (select) => select(undefined) })).join('')
  assert.match(text, /还没有可观测的记录/)
})
