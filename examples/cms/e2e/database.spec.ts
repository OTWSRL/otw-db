import { expect, test, type Page } from '@playwright/test'

// The Database plugin in a CMS site on its embedded database. One site, set up by the first test.
test.describe.configure({ mode: 'serial' })

const ADMIN = { name: 'Ada Admin', email: 'ada@example.com', password: 'a strong e2e password' }

async function signIn(page: Page) {
  await page.goto('/admin')
  await expect(page).toHaveURL(/\/admin\/login\?next=/)
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Log In' }).click()
  await expect(page).not.toHaveURL(/\/admin\/login/)
}

/** The app: it lives in the element's shadow root, which Playwright's locators go into. */
const app = (page: Page) => page.locator('otw-db-app')

async function openDatabase(page: Page) {
  await signIn(page)
  await page
    .getByRole('navigation', { name: 'Main menu' })
    .getByRole('link', { name: 'Database' })
    .click()
  await expect(page).toHaveURL(/\/admin\/db$/)
  await app(page).getByRole('button', { name: 'This site', exact: true }).click()
  await expect(app(page).getByLabel('Connection', { exact: true })).toContainText(/PGlite \d+\.\d+/)
}

test('the first visit sets up the administrator', async ({ page }) => {
  await page.goto('/admin')
  await expect(page).toHaveURL('/admin/setup')
  await page.getByLabel('Name').fill(ADMIN.name)
  await page.getByLabel('Email').fill(ADMIN.email)
  await page.getByLabel('Password').fill(ADMIN.password)
  await page.getByRole('button', { name: 'Create administrator' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Your site is ready.' })).toBeVisible()
})

test('Database opens the tool in the admin, on the site’s own database', async ({ page }) => {
  await openDatabase(page)
  await expect(app(page).getByLabel('Connection', { exact: true })).toContainText('read-only')
  await app(page)
    .getByRole('button', { name: /^cms_users/ })
    .click()
  const users = app(page).getByRole('grid', { name: 'public.cms_users' })
  await expect(users.getByRole('gridcell', { name: ADMIN.email })).toBeVisible()
  await app(page).getByRole('button', { name: 'Structure' }).click()
  await expect(app(page).getByRole('table', { name: 'Columns' })).toContainText('email')
})

test('runs SQL on it, with the warning in view, and read-only', async ({ page }) => {
  await openDatabase(page)
  await app(page).getByRole('button', { name: 'New SQL editor' }).click()
  await expect(app(page).getByRole('note')).toContainText('a heavy statement holds the whole site')
  await app(page).locator('.tab-body:not([hidden]) .cm-content').click()
  await page.keyboard.insertText('SELECT count(*) AS users FROM cms_users')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await expect(app(page).getByRole('grid', { name: 'Result' }).getByRole('gridcell')).toHaveText([
    '1',
  ])
  await app(page)
    .locator('.tab-body:not([hidden]) .cm-content')
    .fill("UPDATE cms_users SET name = 'x'")
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter')
  await expect(app(page).getByRole('alert')).toContainText(
    'cannot execute UPDATE in a read-only transaction',
  )
})

test('keeps its styles to itself: the admin’s page has none of its elements', async ({ page }) => {
  await openDatabase(page)
  // Every element of the app is inside the shadow root: none of its classes reach the admin.
  expect(
    await page.evaluate(() => document.querySelectorAll('.grid, .toolbar, .tabbar').length),
  ).toBe(0)
  expect(
    await page.evaluate(
      () => document.querySelector('otw-db-app')!.shadowRoot!.querySelectorAll('.toolbar').length,
    ),
  ).toBe(1)
})

test('serves its API to administrators only', async ({ request }) => {
  const anonymous = await request.get('/api/p/db/api/connections', {
    headers: { 'x-db-admin': '1' },
  })
  expect(anonymous.status()).toBe(401)
  const noHeader = await request.get('/api/p/db/api/connections')
  expect(noHeader.status()).toBe(403)
})
