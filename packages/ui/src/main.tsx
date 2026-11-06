import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiConfig } from '@otwdesign/db-core'
import { readConfig } from './api.ts'
import { App } from './App.tsx'
import './styles.css'

/** Where a host's page asks for the app, and with what: `<div data-otw-db='{"api":…,"style":…}'>`. */
export interface EmbedConfig extends UiConfig {
  /** The app's stylesheet, loaded inside its shadow root. */
  style: string
}

/** Shows OTW DB in `element`; returns what removes it. */
export function mount(element: HTMLElement, config: UiConfig = readConfig()): () => void {
  const root = createRoot(element)
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  )
  return () => root.unmount()
}

/**
 * Shows OTW DB inside a host's page, in a shadow root of `host`: the host's styles can't reach
 * the app, nor the app's the host.
 */
export function embed(host: HTMLElement, config: EmbedConfig): () => void {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const style = document.createElement('link')
  style.rel = 'stylesheet'
  style.href = config.style
  const container = document.createElement('div')
  container.className = 'otw-db'
  shadow.replaceChildren(style, container)
  return mount(container, config)
}

// The standalone page has its root; a host's page marks where it wants the app.
const page = document.getElementById('root')
if (page) mount(page)
for (const host of document.querySelectorAll<HTMLElement>('[data-otw-db]')) {
  embed(host, JSON.parse(host.dataset.otwDb!) as EmbedConfig)
}
