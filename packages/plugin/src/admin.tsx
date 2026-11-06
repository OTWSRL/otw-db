import { entry } from '@otwdesign/db-ui/entry'
import { defineAdmin } from '@otwdesign/sdk'
import { createElement, type CSSProperties } from 'react'
import db from './index'

/** The admin entry: Database, the tool inside the admin's own frame. */
export default defineAdmin(db, (cms) => {
  const base = cms.routes.apiUrl('/')
  cms.admin.page({
    name: 'database',
    path: '/',
    title: 'Database',
    capability: 'db.manage',
    menu: { label: 'Database' },
    component: () => <DatabaseScreen base={base} />,
  })
})

const frame: CSSProperties = {
  display: 'block',
  height: 'calc(100vh - 150px)',
  minHeight: 480,
  border: '1px solid #dcdce0',
  borderRadius: 6,
  overflow: 'hidden',
}

/** The app's script and its element; the element mounts the app in a shadow root of its own. */
export function DatabaseScreen({ base }: { base: string }) {
  const config = JSON.stringify({ api: `${base}/api`, style: `${base}/assets/${entry.style}` })
  return (
    <>
      <script type="module" async src={`${base}/assets/${entry.script}`} />
      {/* createElement, not JSX: a JSX tag would need the element added to React's global JSX
          types, which a site with its own copy of React's types (a linked checkout) can't take. */}
      {createElement('otw-db-app', { config, style: frame })}
    </>
  )
}
