import { expect, test } from '@playwright/test'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

test('asks for the app’s sign-in, and sends the browser to it', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'An app with OTW DB' })).toBeVisible()
  await page.goto('/db')
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
})

test('serves the whole tool from one route handler: page, files and API', async ({ page }) => {
  await page.goto('/login?secret=e2e')
  await expect(page).toHaveURL(/\/db$/)
  await page.getByRole('button', { name: 'Guests DB', exact: true }).click()
  await expect(page.getByLabel('Connection', { exact: true })).toContainText('PostgreSQL 17')
  await page.getByRole('button', { name: /^guests/ }).click()
  const grid = page.getByRole('grid', { name: 'public.guests' })
  await expect(grid.getByRole('gridcell', { name: 'Grace' })).toBeVisible()
  await page.keyboard.press(`${MOD}+e`)
  await page.locator('.tab-body:not([hidden]) .cm-content').click()
  await page.keyboard.insertText('SELECT count(*) AS guests FROM guests')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(page.getByRole('grid', { name: 'Result' }).getByRole('gridcell')).toHaveText(['3'])
})
