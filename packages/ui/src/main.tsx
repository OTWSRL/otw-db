import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiConfig } from '@otwdesign/db-core'
import { readConfig } from './api.ts'
import { App } from './App.tsx'
import './styles.css'

/** Shows OTW DB in `element`; returns what removes it. The page's own root mounts itself. */
export function mount(element: HTMLElement, config: UiConfig = readConfig()): () => void {
  const root = createRoot(element)
  root.render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  )
  return () => root.unmount()
}

const root = document.getElementById('root')
if (root) mount(root)
