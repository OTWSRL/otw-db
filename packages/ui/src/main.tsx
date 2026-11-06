import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiConfig } from '@otwdesign/db-core'
import { readConfig } from './api.ts'
import { App } from './App.tsx'
import './styles.css'

/** What a host's page gives the app: `<otw-db-app config='{"api":…,"style":…}'>`. */
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
 * `<otw-db-app config='…'>`: OTW DB inside a host's page, in a shadow root, so the host's styles
 * can't reach the app nor the app's the host. A custom element, so it shows wherever it's put,
 * however it got there: on page load, or later by a client-side router (the CMS admin's).
 */
class OtwDbApp extends HTMLElement {
  #unmount: (() => void) | null = null

  connectedCallback() {
    const config = JSON.parse(this.getAttribute('config') ?? '{}') as EmbedConfig
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: 'open' })
    const style = document.createElement('link')
    style.rel = 'stylesheet'
    style.href = config.style
    const container = document.createElement('div')
    container.className = 'otw-db'
    shadow.replaceChildren(style, container)
    this.#unmount = mount(container, config)
  }

  disconnectedCallback() {
    this.#unmount?.()
    this.#unmount = null
  }
}

if (!customElements.get('otw-db-app')) customElements.define('otw-db-app', OtwDbApp)

// The standalone page has its root.
const page = document.getElementById('root')
if (page) mount(page)
