import { getCurrentUser, getKernel, Slot } from '@otwdesign/next/site'
import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import '@/cms/site.generated'
import '../globals.css'

// The storefront's root layout: this site's own, like a WordPress theme's header.php and
// footer.php. The admin has its own root layout from the CMS, so their styles never mix.

// Every page depends on the database and the active plugins, so nothing is prerendered at build.
export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const site = (await getKernel()).setting('site.title') ?? 'My Site'
  return { title: { default: site, template: `%s · ${site}` } }
}

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const [kernel, user] = await Promise.all([getKernel(), getCurrentUser()])
  return (
    <html lang={kernel.setting('site.locale') || 'en'}>
      <body>
        <header className="site-header">
          <Link href="/" className="site-title">
            {kernel.setting('site.title') ?? 'My Site'}
          </Link>
          <nav aria-label="Main">
            <Slot name="header.nav" />
            {kernel.can(user, 'core.access_admin') && <Link href="/admin">Admin</Link>}
          </nav>
        </header>
        <main className="site-main">{children}</main>
        <Slot name="site.footer" props={{ user }} />
      </body>
    </html>
  )
}
