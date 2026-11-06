import { entry } from '@otwdesign/db-ui/entry'
import { defineAdmin } from '@otwdesign/sdk'
import db from './index'

// React's own types are in scope inside its module.
declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      /** The app, defined by its own script: it mounts wherever it's put. */
      'otw-db-app': DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & { config: string }
    }
  }
}

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

/** The app's script and its element; the element mounts the app in a shadow root of its own. */
export function DatabaseScreen({ base }: { base: string }) {
  const config = JSON.stringify({ api: `${base}/api`, style: `${base}/assets/${entry.style}` })
  return (
    <>
      <script type="module" async src={`${base}/assets/${entry.script}`} />
      <otw-db-app
        config={config}
        style={{
          display: 'block',
          height: 'calc(100vh - 150px)',
          minHeight: 480,
          border: '1px solid #dcdce0',
          borderRadius: 6,
          overflow: 'hidden',
        }}
      />
    </>
  )
}
