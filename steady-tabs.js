// Layout overrides for dsh-claude-style; every selector only matches while that style is active.
// - Its pill view tabs fade in on hover, which flickers on macOS because the tabs sit inside
//   the window drag region, where Electron reports hover unreliably. Keep them visible.
// - Its header paints a fade gradient over the top of the active view. Offset the in-session
//   Trace view past the opaque half of it; the import overlay lives outside #root and has no
//   such header.
const STEADY_TABS_CSS = `
html body[data-dsh-claude-style] [data-dsh-view-tabs][data-dsh-view-tabs],
html body[data-dsh-claude-style][data-dsh-titlebar-tabs] [data-dsh-view-tabs][data-dsh-view-tabs] {
  opacity: 1 !important;
  transition: none !important;
}
html body[data-dsh-claude-style] #root [data-trace-lens-root] {
  padding-top: calc(var(--dsh-transcript-fade-h, 28px) / 2);
  box-sizing: border-box;
}
`

function installSteadyTabs() {
  const style = document.createElement('style')
  style.setAttribute('data-trace-lens-steady-tabs', '')
  style.textContent = STEADY_TABS_CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
