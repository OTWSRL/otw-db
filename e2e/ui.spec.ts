import { expect, test, type Page } from '@playwright/test'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

async function signIn(page: Page) {
  await page.goto('/?token=e2e-token')
  await expect(page.getByRole('list', { name: 'Connections' })).toBeVisible()
}

async function open(page: Page, label: string) {
  await signIn(page)
  await page.getByRole('button', { name: label, exact: true }).click()
  await expect(page.getByLabel('Connection', { exact: true })).toContainText('PostgreSQL 17')
}

const grid = (page: Page, name: string) => page.getByRole('grid', { name })
const cell = (page: Page, gridName: string, row: number, col: number) =>
  grid(page, gridName).locator(
    `[role=row][aria-rowindex="${row + 1}"] [role=gridcell][aria-colindex="${col}"]`,
  )

async function sql(page: Page, text: string) {
  await page.keyboard.press(`${MOD}+e`)
  const editor = page.locator('.tab-body:not([hidden]) .cm-content')
  await editor.click()
  await page.keyboard.insertText(text)
}

test.beforeEach(async ({ page }) => {
  // Tabs are remembered per browser; each test starts with none.
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
})

test('asks to sign in without the token, and lists connections with it', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible()
  await signIn(page)
  const list = page.getByRole('list', { name: 'Connections' })
  // In the order of their names: live, local, main, ops.
  await expect(list.getByRole('button')).toHaveText([
    /Blog \(read-only\)\s*PostgreSQL · live\s*staging/i,
    /Notes\s*SQLite · local\s*local/i,
    /Blog\s*PostgreSQL · main\s*development/i,
    /Operations\s*PostgreSQL · ops\s*production/i,
  ])
  await expect(list.getByRole('button', { name: 'Operations' })).toHaveAccessibleDescription(
    'PostgreSQL · ops',
  )
  await expect(list.getByRole('img', { name: 'Read-only' })).toHaveCount(1)
})

test('shows the server and the schema’s tables by kind', async ({ page }) => {
  await open(page, 'Blog')
  await expect(page.getByLabel('Connection', { exact: true })).toContainText(
    /PostgreSQL 17\.\d+\s*:\s*Blog\s*:\s*postgres/,
  )
  await expect(
    page.getByRole('list', { name: 'Tables', exact: true }).getByRole('button'),
  ).toHaveText([/comments/, /posts\s*1\.5K/, /users\s*40/])
  await expect(
    page.getByRole('list', { name: 'Views', exact: true }).getByRole('button'),
  ).toHaveText([/admins/])
  await expect(
    page.getByRole('list', { name: 'Materialized views' }).getByRole('button'),
  ).toHaveText([/post_counts/])
  await page.getByLabel('Schema').selectOption('shop')
  await expect(
    page.getByRole('list', { name: 'Tables', exact: true }).getByRole('button'),
  ).toHaveText([/products/])
  await page.getByLabel('Search for item').fill('prod')
  await expect(
    page.getByRole('list', { name: 'Tables', exact: true }).getByRole('button'),
  ).toHaveCount(1)
})

test('pages through a table, sorts it, and keeps the row numbers going', async ({ page }) => {
  await open(page, 'Blog')
  await page.getByRole('button', { name: /^posts/ }).click()
  await expect(cell(page, 'public.posts', 1, 3)).toHaveText('Post number 1')
  await expect(page.getByText('Rows 1–300 of ~1,500')).toBeVisible()
  await page.getByRole('button', { name: 'Next page' }).click()
  await expect(page.getByText('Rows 301–600 of ~1,500')).toBeVisible()
  await expect(cell(page, 'public.posts', 1, 3)).toHaveText('Post number 301')
  await expect(grid(page, 'public.posts').locator('[aria-rowindex="2"] .number-cell')).toHaveText(
    '301',
  )
  await page.getByRole('button', { name: 'Previous page' }).click()
  await page.getByRole('columnheader', { name: /views/ }).click()
  await page.getByRole('columnheader', { name: /views/ }).click()
  await expect(page.getByRole('columnheader', { name: /views/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  )
  await expect(cell(page, 'public.posts', 1, 5)).toHaveText('10500')
  await page.getByLabel('Rows per page').selectOption('1000')
  await expect(page.getByText('Rows 1–1,000 of ~1,500')).toBeVisible()
})

test('filters with the filter bar, and counts exactly', async ({ page }) => {
  await open(page, 'Blog')
  await page.getByRole('button', { name: /^posts/ }).click()
  await expect(cell(page, 'public.posts', 1, 1)).toHaveText('1')
  await page.keyboard.press(`${MOD}+f`)
  const bar = page.getByRole('form', { name: 'Filters' })
  await bar.getByLabel('Column').selectOption('title')
  await bar.getByLabel('Operator').selectOption('contains')
  await bar.getByLabel('Value').fill('number 14')
  await bar.getByLabel('Value').press('Enter')
  await expect(cell(page, 'public.posts', 1, 3)).toHaveText('Post number 14')
  await page.getByRole('button', { name: 'Add condition' }).click()
  await bar.getByLabel('Column').nth(1).selectOption('views')
  await bar.getByLabel('Operator').nth(1).selectOption('>')
  await bar.getByLabel('Value').nth(1).fill('10000')
  await bar.getByRole('button', { name: 'Apply' }).click()
  await expect(cell(page, 'public.posts', 1, 3)).toHaveText('Post number 1429')
  await page.getByRole('button', { name: 'Count', exact: true }).click()
  // Titles with "number 14" (14, 140–149, 1400–1499) past 10,000 views: posts 1429–1499.
  await expect(page.getByText('Rows 1–71 of 71')).toBeVisible()
  await bar.getByRole('button', { name: 'Clear' }).click()
  await expect(bar).toBeHidden()
  await expect(cell(page, 'public.posts', 1, 3)).toHaveText('Post number 1')
})

test('shows a table’s structure: columns, indexes, keys and checks', async ({ page }) => {
  await open(page, 'Blog')
  await page.getByRole('button', { name: /^posts/ }).click()
  await page.getByRole('button', { name: 'Structure' }).click()
  const columns = page.getByRole('table', { name: 'Columns' })
  await expect(columns.getByRole('row').nth(1)).toContainText(/1\s*id\s*integer\s*NO/)
  await expect(columns.getByRole('img', { name: 'Primary key' })).toHaveCount(1)
  await expect(page.getByRole('table', { name: 'Indexes' })).toContainText(
    'CREATE INDEX posts_author ON public.posts USING btree (author)',
  )
  await expect(page.getByRole('table', { name: 'Foreign keys' })).toContainText(
    'FOREIGN KEY (author) REFERENCES users(id)',
  )
  await expect(page.getByRole('table', { name: 'Checks' })).toContainText('CHECK ((views >= 0))')
})

test('moves through the grid with the keys, and shows the row whole in the panel', async ({
  page,
}) => {
  await open(page, 'Blog')
  await page.getByRole('button', { name: /^posts/ }).click()
  await cell(page, 'public.posts', 1, 4).click()
  await page.keyboard.press('ArrowDown')
  await expect(cell(page, 'public.posts', 2, 4)).toHaveAttribute('aria-selected', 'true')
  await expect(cell(page, 'public.posts', 2, 4)).toHaveText('Line one of post 2 …')
  await page.getByRole('button', { name: 'Row panel' }).click()
  const panel = page.getByRole('complementary', { name: 'Row' })
  await expect(panel).toContainText('Line one of post 2\nLine two')
  await expect(panel).toContainText(/meta\s*jsonb\s*NULL/)
})

test('runs the statement at the cursor, or all of them, from the SQL editor', async ({ page }) => {
  await open(page, 'Blog')
  await sql(
    page,
    "SELECT id, email FROM users WHERE id <= 3 ORDER BY id;\nSELECT 'second' AS which",
  )
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(cell(page, 'Result', 3, 2)).toHaveText('user3@example.com')
  await page.keyboard.press(`Shift+${MOD}+Enter`)
  await expect(page.getByRole('tab', { name: 'Result 2' })).toHaveAttribute('aria-selected', 'true')
  await expect(cell(page, 'Result', 1, 1)).toHaveText('second')
  await page.getByRole('tab', { name: 'Result 1' }).click()
  await expect(cell(page, 'Result', 1, 2)).toHaveText('user1@example.com')
})

test('shows where a statement went wrong', async ({ page }) => {
  await open(page, 'Blog')
  await sql(page, 'SELECT 1;\n\nSELECT *\n  FROM nowhere')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(page.getByRole('alert')).toContainText(
    'relation "nowhere" does not exist (line 4, column 8)',
  )
  await expect(page.getByRole('alert')).toContainText('SQLSTATE 42P01')
})

test('cancels a running statement', async ({ page }) => {
  await open(page, 'Blog')
  await sql(page, 'SELECT pg_sleep(30)')
  await page.keyboard.press(`${MOD}+Enter`)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('alert')).toContainText('The query was canceled.')
})

test('a read-only connection refuses writes', async ({ page }) => {
  await open(page, 'Blog (read-only)')
  await expect(page.getByLabel('Connection', { exact: true })).toContainText('read-only')
  await sql(page, "UPDATE users SET name = 'x' WHERE id = 1")
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(page.getByRole('alert')).toContainText(
    'cannot execute UPDATE in a read-only transaction',
  )
})

test('asks before a write on production, and runs it only when told', async ({ page }) => {
  await open(page, 'Operations')
  await sql(page, "UPDATE shop.products SET price = price WHERE name = 'Pen'")
  await page.keyboard.press(`${MOD}+Enter`)
  const dialog = page.getByRole('alertdialog', { name: 'Run on production?' })
  await expect(dialog).toContainText("UPDATE shop.products SET price = price WHERE name = 'Pen'")
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('status')).toBeHidden()
  await page.keyboard.press(`${MOD}+Enter`)
  await page.getByRole('alertdialog').getByRole('button', { name: 'Run' }).click()
  await expect(page.getByRole('status')).toContainText('UPDATE · 1 rows affected')
})

test('opens any table with ⌘P, and closes tabs with ⌥W', async ({ page }) => {
  await open(page, 'Blog')
  await page.keyboard.press(`${MOD}+p`)
  await page.getByLabel('Table name').fill('cmts')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: /comments/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Alt+w')
  await expect(page.getByRole('tab')).toHaveCount(0)
})

test('keeps the history of statements run, and its tabs across a reload', async ({ page }) => {
  await open(page, 'Blog')
  await sql(page, 'SELECT 42 AS answer')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(cell(page, 'Result', 1, 1)).toHaveText('42')
  await page.getByRole('button', { name: /^posts/ }).click()
  await page.reload()
  await expect(page.getByRole('tab')).toHaveText([/Query 1/, /posts/])
  await page.getByRole('button', { name: 'History' }).click()
  await page
    .getByRole('list', { name: 'History' })
    .getByRole('button', { name: /SELECT 42 AS answer/ })
    .click()
  await expect(page.getByRole('tab', { name: /Query 2/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.tab-body:not([hidden]) .cm-content')).toHaveText(
    'SELECT 42 AS answer',
  )
})

test.describe('editing', () => {
  async function openTable(page: Page, schema: string, table: string) {
    if (schema !== 'public') await page.getByLabel('Schema').selectOption(schema)
    await page.getByRole('button', { name: new RegExp(`^${table}`) }).click()
    await expect(cell(page, `${schema}.${table}`, 1, 1)).not.toBeEmpty()
  }

  async function editCell(
    page: Page,
    gridName: string,
    row: number,
    col: number,
    column: string,
    value: string,
  ) {
    await cell(page, gridName, row, col).dblclick()
    await page.getByLabel(`Edit ${column}`).fill(value)
    await page.getByLabel(`Edit ${column}`).press('Enter')
  }

  test('edits a cell, shows the SQL with ⌘S, and commits it', async ({ page }) => {
    await open(page, 'Blog')
    await openTable(page, 'public', 'users')
    await editCell(page, 'public.users', 1, 3, 'name', 'Ada')
    await expect(cell(page, 'public.users', 1, 3)).toHaveText('Ada')
    await expect(cell(page, 'public.users', 1, 3)).toHaveClass(/changed/)
    await expect(page.getByText('1 change', { exact: true })).toBeVisible()
    await page.keyboard.press(`${MOD}+s`)
    const dialog = page.getByRole('alertdialog', { name: 'Commit changes?' })
    await expect(dialog.locator('pre')).toHaveText(
      `UPDATE "public"."users" SET "name" = 'Ada' WHERE "id" = '1';`,
    )
    await dialog.getByRole('button', { name: 'Commit' }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText('1 change', { exact: true })).toBeHidden()
    await expect(cell(page, 'public.users', 1, 3)).not.toHaveClass(/changed/)
    await page.reload()
    await expect(cell(page, 'public.users', 1, 3)).toHaveText('Ada')
    // Back as it was, for the other tests.
    await editCell(page, 'public.users', 1, 3, 'name', 'User 1')
    await page.getByRole('button', { name: 'Commit', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Commit' }).click()
    await expect(cell(page, 'public.users', 1, 3)).toHaveText('User 1')
  })

  test('adds and deletes rows, ⌘Z steps back, and Discard drops what’s left', async ({ page }) => {
    await open(page, 'Blog')
    await openTable(page, 'shop', 'products')
    await page.getByRole('button', { name: 'Row', exact: true }).click()
    await expect(grid(page, 'shop.products').locator('[aria-rowindex="5"]')).toHaveClass(/inserted/)
    await expect(cell(page, 'shop.products', 4, 2)).toHaveText('DEFAULT')
    await editCell(page, 'shop.products', 4, 2, 'name', 'Lamp shade')
    await editCell(page, 'shop.products', 4, 3, 'price', '9.99')
    await cell(page, 'shop.products', 3, 2).click()
    await page.keyboard.press('Delete')
    await expect(grid(page, 'shop.products').locator('[aria-rowindex="4"]')).toHaveClass(/deleted/)
    await expect(page.getByText('2 changes')).toBeVisible()
    await page.keyboard.press(`${MOD}+z`)
    await expect(grid(page, 'shop.products').locator('[aria-rowindex="4"]')).not.toHaveClass(
      /deleted/,
    )
    await expect(page.getByText('1 change', { exact: true })).toBeVisible()
    await page.keyboard.press('Delete')
    await page.keyboard.press(`${MOD}+s`)
    const dialog = page.getByRole('alertdialog')
    await expect(dialog.locator('pre')).toHaveText(
      `DELETE FROM "shop"."products" WHERE "id" = '3';\nINSERT INTO "shop"."products" ("name", "price") VALUES ('Lamp shade', '9.99');`,
    )
    await dialog.getByRole('button', { name: 'Commit' }).click()
    await expect(cell(page, 'shop.products', 3, 2)).toHaveText('Lamp shade')
    await expect(cell(page, 'shop.products', 3, 1)).toHaveText('4')
    // Put the lamp back: a staged edit, then Discard, then the real change.
    await editCell(page, 'shop.products', 3, 2, 'name', 'Never saved')
    await page.getByRole('button', { name: 'Discard' }).click()
    await expect(cell(page, 'shop.products', 3, 2)).toHaveText('Lamp shade')
    await sql(page, "UPDATE shop.products SET id = 3, name = 'Lamp', price = 30.25 WHERE id = 4")
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(page.getByRole('status')).toContainText('UPDATE · 1 rows affected')
  })

  test('saves nothing when a row changed in the meantime', async ({ page }) => {
    await open(page, 'Blog')
    await openTable(page, 'shop', 'products')
    await editCell(page, 'shop.products', 2, 3, 'price', '99')
    await sql(page, 'UPDATE shop.products SET id = 200 WHERE id = 2')
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(page.getByRole('status')).toContainText('UPDATE · 1 rows affected')
    await page.getByRole('tab', { name: /products/ }).click()
    await page.getByRole('button', { name: 'Commit', exact: true }).click()
    const dialog = page.getByRole('alertdialog')
    await dialog.getByRole('button', { name: 'Commit' }).click()
    await expect(dialog.getByRole('alert')).toContainText(
      'Nothing was saved: its row is gone or its key changed.',
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByText('1 change', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Discard' }).click()
    await page.getByRole('tab', { name: /Query/ }).click()
    await page
      .locator('.tab-body:not([hidden]) .cm-content')
      .fill('UPDATE shop.products SET id = 2 WHERE id = 200')
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(page.getByRole('status')).toContainText('UPDATE · 1 rows affected')
  })

  test('offers no editing on a read-only connection or a view', async ({ page }) => {
    await open(page, 'Blog (read-only)')
    await openTable(page, 'public', 'users')
    await expect(page.getByRole('button', { name: 'Row', exact: true })).toBeHidden()
    await cell(page, 'public.users', 1, 3).dblclick()
    await expect(page.getByLabel('Edit name')).toBeHidden()
    await page.getByRole('button', { name: 'Connections' }).click()
    await page.getByRole('button', { name: 'Blog', exact: true }).click()
    await page.getByRole('button', { name: /^admins/ }).click()
    await expect(page.getByText('Read-only: no primary key')).toBeVisible()
  })
})

test.describe('exporting', () => {
  test('downloads a table, filtered and in order, as CSV', async ({ page }) => {
    await open(page, 'Blog')
    await page.getByRole('button', { name: /^users/ }).click()
    await page.keyboard.press(`${MOD}+f`)
    const bar = page.getByRole('form', { name: 'Filters' })
    await bar.getByLabel('Column').selectOption('id')
    await bar.getByLabel('Operator').selectOption('<=')
    await bar.getByLabel('Value').fill('2')
    await bar.getByLabel('Value').press('Enter')
    await expect(page.getByText('Rows 1–2')).toBeVisible()
    await page.getByRole('button', { name: 'Export' }).click()
    const saved = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'CSV' }).click()
    const file = await saved
    expect(file.suggestedFilename()).toBe('users.csv')
    const text = await new Response(
      (await file.createReadStream()) as unknown as ReadableStream,
    ).text()
    expect(text).toBe(
      'id,email,name,joined,admin\r\n1,user1@example.com,User 1,2026-01-01 09:00:00+00,t\r\n2,user2@example.com,User 2,2026-01-01 09:00:00+00,f\r\n',
    )
  })

  test('downloads a query’s result as JSON', async ({ page }) => {
    await open(page, 'Blog')
    await sql(page, "SELECT 1 AS n, NULL AS nothing, 'x' AS t")
    await page.keyboard.press(`${MOD}+Enter`)
    await expect(cell(page, 'Result', 1, 3)).toHaveText('x')
    await page.getByRole('button', { name: 'Export' }).click()
    const saved = page.waitForEvent('download')
    await page.getByRole('menuitem', { name: 'JSON' }).click()
    const file = await saved
    const text = await new Response(
      (await file.createReadStream()) as unknown as ReadableStream,
    ).text()
    expect(JSON.parse(text)).toEqual([{ n: '1', nothing: null, t: 'x' }])
  })
})

test('works the same on SQLite: browse, edit, commit and query', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByLabel('Connection', { exact: true })).toContainText(
    /SQLite 3\.\d+.*Notes.*notes\.db/,
  )
  // One schema: no schema picker.
  await expect(page.getByLabel('Schema')).toBeHidden()
  await page.getByRole('button', { name: /^notes/ }).click()
  await expect(cell(page, 'main.notes', 2, 2)).toHaveText('Ship OTW DB')
  await cell(page, 'main.notes', 1, 2).dblclick()
  await page.getByLabel('Edit title').fill('Buy oat milk')
  await page.getByLabel('Edit title').press('Enter')
  await page.keyboard.press(`${MOD}+s`)
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.locator('pre')).toHaveText(
    `UPDATE "main"."notes" SET "title" = 'Buy oat milk' WHERE "id" = '1';`,
  )
  await dialog.getByRole('button', { name: 'Commit' }).click()
  await expect(cell(page, 'main.notes', 1, 2)).toHaveText('Buy oat milk')
  await sql(page, 'SELECT title FROM notes WHERE done = 0 ORDER BY id')
  await page.keyboard.press(`${MOD}+Enter`)
  await expect(grid(page, 'Result').getByRole('gridcell')).toHaveText([
    'Buy oat milk',
    'Write docs',
  ])
})
