import { expect, test, type Page } from '@playwright/test'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const PASSWORD = 'the example’s own password'

async function signIn(page: Page, password = PASSWORD) {
  await page.goto('/db/sign-in')
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('asks whoever isn’t signed in for the password, on a page of its own', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'An app with OTW DB' })).toBeVisible()
  await page.goto('/db')
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await page.getByRole('link', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/db\/sign-in$/)
  await expect(page.getByRole('heading', { name: 'Sign in to the database' })).toBeVisible()
})

test('refuses a wrong password, and says so', async ({ page }) => {
  await signIn(page, 'not the password at all')
  await expect(page.getByRole('alert')).toHaveText('That isn’t the password.')
  await page.goto('/db')
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
})

test('serves the whole tool from one route file: page, files and API, then signs out', async ({
  page,
}) => {
  await signIn(page)
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

  await page.goto('/db/sign-in')
  await expect(page.getByRole('heading', { name: 'You’re signed in' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in to the database' })).toBeVisible()
  await page.goto('/db')
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
})
