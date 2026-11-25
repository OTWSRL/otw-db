import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DbAdminError, exportStream, QueryError, type Driver } from '../src/index.ts'

/** A database for the suite: its driver, where its tables live, and what's slow there. */
export interface Fixture {
  driver: Driver
  /** The schema the suite's tables are in: `public`, a MySQL database, SQLite's `main`. */
  schema: string
  product: string
  /** A statement that runs for several seconds, to time out and cancel. */
  slow: string
  /** A column type that holds bytes, fit for a primary key: `BYTEA`, `VARBINARY(8)`, `BLOB`. */
  bytes: string
  /** Bytes as a literal in this database's SQL, from their hex. */
  hex(hex: string): string
  /**
   * CREATE TABLE conf_made: `id`, a key the database numbers itself (always, where it can be
   * told so); `a`, an integer; and `b`, generated as `a * 2`.
   */
  made: string
  /** Closes what the fixture opened beside the driver. */
  close?(): Promise<void>
}

const LIMITS = { maxRows: 1_000, timeoutMs: 10_000 }
const read = { ...LIMITS, access: 'read' as const }
const write = { ...LIMITS, access: 'write' as const }

/** Portable SQL every driver's database takes: the suite's tables and rows. */
const SEED = [
  'DROP TABLE IF EXISTS conf_items',
  'DROP TABLE IF EXISTS conf_big',
  'DROP TABLE IF EXISTS conf_digits',
  `CREATE TABLE conf_items (
     id INTEGER PRIMARY KEY,
     name VARCHAR(50) NOT NULL,
     price DECIMAL(10,2) NOT NULL,
     stock BIGINT NOT NULL DEFAULT 0,
     note TEXT
   )`,
  `INSERT INTO conf_items (id, name, price, stock, note) VALUES
     (1, 'pen', 1.50, 9007199254740993, NULL),
     (2, 'book', 12.00, 3, 'thick'),
     (3, 'lamp', 30.25, 1, NULL)`,
  'CREATE TABLE conf_digits (d INTEGER PRIMARY KEY)',
  'INSERT INTO conf_digits (d) VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)',
  'CREATE TABLE conf_big (id INTEGER PRIMARY KEY, label VARCHAR(20))',
  `INSERT INTO conf_big (id, label)
     SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + 1, 'row'
       FROM conf_digits a, conf_digits b, conf_digits c, conf_digits e
      WHERE a.d + b.d * 10 + c.d * 100 + e.d * 1000 < 2500`,
]

/**
 * What every driver must do, against a real database: the same tests for each, so the browser
 * app works the same whichever it opens.
 */
export function conformance(name: string, open: () => Promise<Fixture>) {
  describe(`${name} conformance`, () => {
    let f: Fixture
    const items = () => ({ schema: f.schema, table: 'conf_items' })
    const ids = async (filters: Parameters<Driver['rows']>[0]['filters']) =>
      (
        await f.driver.rows(
          { ...items(), limit: 10, offset: 0, order: [{ column: 'id' }], filters },
          LIMITS,
        )
      ).rows.map((r) => r[0])
    const all = async () =>
      (await f.driver.query('SELECT id, name, price, stock FROM conf_items ORDER BY id', read)).rows

    beforeAll(async () => {
      f = await open()
      for (const statement of SEED) await f.driver.query(statement, write)
    }, 60_000)

    afterAll(async () => {
      if (!f) return
      for (const table of [
        'conf_items',
        'conf_big',
        'conf_digits',
        'conf_tmp',
        'conf_sneaky',
        'conf_bytes',
        'conf_made',
      ]) {
        await f.driver.query(`DROP TABLE IF EXISTS ${table}`, write)
      }
      await f.driver.close()
      await f.close?.()
    })

    it('lists its tables and describes one', async () => {
      const tables = (await f.driver.tables()).filter((t) => t.schema === f.schema)
      expect(tables.map((t) => t.name)).toEqual(
        expect.arrayContaining(['conf_big', 'conf_digits', 'conf_items']),
      )
      expect(tables.find((t) => t.name === 'conf_items')!.kind).toBe('table')
      const table = await f.driver.table(f.schema, 'conf_items')
      expect(table!.columns.map((c) => [c.name, c.nullable])).toEqual([
        ['id', false],
        ['name', false],
        ['price', false],
        ['stock', false],
        ['note', true],
      ])
      expect(table!.primaryKey).toEqual(['id'])
      expect(await f.driver.table(f.schema, 'conf_missing')).toBeNull()
    })

    it('returns values as the database’s own text: big integers whole, NULL as null', async () => {
      const { rows, columns } = await f.driver.query(
        'SELECT stock, note, price FROM conf_items WHERE id = 1',
        read,
      )
      expect(columns.map((c) => c.name)).toEqual(['stock', 'note', 'price'])
      expect(rows[0]![0]).toBe('9007199254740993')
      expect(rows[0]![1]).toBeNull()
      expect(Number(rows[0]![2])).toBe(1.5)
    })

    it('pages in order, and says when another page follows', async () => {
      const first = await f.driver.rows(
        { ...items(), limit: 2, offset: 0, order: [{ column: 'price', descending: true }] },
        LIMITS,
      )
      expect(first.rows.map((r) => r[1])).toEqual(['lamp', 'book'])
      expect(first.truncated).toBe(true)
      const last = await f.driver.rows(
        { ...items(), limit: 2, offset: 2, order: [{ column: 'price', descending: true }] },
        LIMITS,
      )
      expect(last.rows.map((r) => r[1])).toEqual(['pen'])
      expect(last.truncated).toBe(false)
    })

    it.each([
      [[{ column: 'price', operator: '>', value: '10' }], ['2', '3']],
      [[{ column: 'name', operator: '=', value: 'pen' }], ['1']],
      [[{ column: 'name', operator: '<>', value: 'pen' }], ['2', '3']],
      [[{ column: 'id', operator: 'in', value: ['1', '3'] }], ['1', '3']],
      [[{ column: 'id', operator: 'not in', value: ['1', '3'] }], ['2']],
      [[{ column: 'price', operator: 'between', value: ['1', '12'] }], ['1', '2']],
      [[{ column: 'note', operator: 'is null' }], ['1', '3']],
      [[{ column: 'note', operator: 'is not null' }], ['2']],
      [[{ column: 'name', operator: 'contains', value: 'AM' }], ['3']],
      [[{ column: 'name', operator: 'starts with', value: 'b' }], ['2']],
      [[{ column: 'name', operator: 'ends with', value: 'n' }], ['1']],
      [[{ column: 'name', operator: 'like', value: 'b%k' }], ['2']],
      [[{ column: 'price', operator: 'contains', value: '.25' }], ['3']],
    ] as const)('filters %j', async (filters, expected) => {
      expect(await ids(filters as never)).toEqual(expected)
    })

    it('takes % and _ in a search literally, and a quote in a value as a quote', async () => {
      expect(await ids([{ column: 'name', operator: 'contains', value: '%' }])).toEqual([])
      expect(await ids([{ column: 'name', operator: 'contains', value: '_' }])).toEqual([])
      expect(await ids([{ column: 'name', operator: '=', value: "x' OR '1'='1" }])).toEqual([])
    })

    it('counts what matches', async () => {
      expect(
        await f.driver.count(
          { ...items(), filters: [{ column: 'price', operator: '>', value: '10' }] },
          LIMITS,
        ),
      ).toBe(2)
    })

    it('takes any name as a name, never as SQL', async () => {
      for (const table of [
        'conf_items"; DROP TABLE conf_big; --',
        'conf_items`; DROP TABLE conf_big; --',
      ]) {
        await expect(
          f.driver.rows({ schema: f.schema, table, limit: 1, offset: 0 }, LIMITS),
        ).rejects.toBeInstanceOf(QueryError)
      }
      expect(await f.driver.table(f.schema, 'conf_big')).not.toBeNull()
    })

    it('refuses writes with read access, schema changes too', async () => {
      await expect(f.driver.query("UPDATE conf_items SET name = 'x'", read)).rejects.toBeInstanceOf(
        DbAdminError,
      )
      expect((await all())[0]![1]).toBe('pen')
      // MySQL commits before DDL, ending any transaction: only a read-only session stops this.
      await expect(
        f.driver.query('CREATE TABLE conf_sneaky (x INTEGER)', read),
      ).rejects.toBeInstanceOf(DbAdminError)
      await expect(f.driver.query('DROP TABLE conf_digits', read)).rejects.toBeInstanceOf(
        DbAdminError,
      )
      // And a write inside a statement that reads is the database's to refuse.
      await expect(
        f.driver.query("WITH gone AS (SELECT 1) UPDATE conf_items SET name = 'x'", read),
      ).rejects.toBeInstanceOf(DbAdminError)
      expect((await all())[0]![1]).toBe('pen')
      expect(await f.driver.table(f.schema, 'conf_sneaky')).toBeNull()
      expect(await f.driver.table(f.schema, 'conf_digits')).not.toBeNull()
    })

    it('keeps read access to reading the database, whatever its login may do', async () => {
      // A read-only transaction stops changes to rows. The server's files, its programs, its
      // settings and its other connections aren't rows: a login allowed those (a superuser,
      // root) would still reach them through a connection marked read-only.
      const beyond: Record<string, string[]> = {
        postgres: [
          `COPY (SELECT 1) TO PROGRAM 'cat > /tmp/otw_db_conformance'`,
          `/* a note */ copy conf_items TO '/tmp/otw_db_conformance'`,
          `--x\rCOPY (SELECT 1) TO '/tmp/otw_db_conformance'`,
          `COPY (SELECT 1) TO STDOUT`,
          `DO $$ BEGIN EXECUTE 'COPY (SELECT 1) TO ''/tmp/otw_db_conformance'''; END $$`,
          `SELECT lo_export(1, '/tmp/otw_db_conformance')`,
          `SELECT pg_read_file('/etc/hostname')`,
          `SELECT * FROM pg_ls_dir('/etc')`,
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity`,
          `SELECT * FROM dblink('dbname=postgres', 'DROP TABLE conf_items') AS t(a int)`,
          // An empty statement first, a bracket, a form feed: the server skips them all.
          `;COPY (SELECT 1) TO PROGRAM 'cat > /tmp/otw_db_conformance'`,
          ` ; ;\f/* x */;DO $$ BEGIN NULL; END $$`,
          `LOAD 'plpgsql'`,
          `NOTIFY conf_channel, 'from a reader'`,
          `SET search_path = nowhere`,
          `DEALLOCATE ALL`,
          `CALL conf_none()`,
          // A function that runs the SQL it's given, given the name in pieces.
          `SELECT query_to_xml('select pg_read_' || 'file(''/etc/hostname'')', true, true, '')`,
          `SELECT * FROM ts_stat('select pg_ter' || 'minate_backend(1)')`,
          `SELECT pg_reload_conf()`,
          `SELECT pg_switch_wal()`,
          `SELECT pg_create_physical_replication_slot('conf_slot')`,
          `SELECT pg_advisory_unlock_all()`,
          `SELECT set_config('search_path', 'nowhere', false)`,
          `SELECT U&'\\0041'`,
          `SELECT setseed(0.42)`,
          `SELECT pg_log_backend_memory_contexts(1)`,
          `SELECT * FROM pg_hba_file_rules`,
          `SELECT pg_read_file_old('/etc/hostname', 0, 10)`,
          `SELECT pg_stat_statements_reset()`,
          `SELECT * FROM crosstab('select 1, 1, pg_read_' || 'file(''/etc/hostname'')') AS t(a int, b text)`,
          'SELECT U&"lo\\005Fexport"(1, \'/tmp/otw_db_conformance\')',
        ],
        mysql: [
          `SELECT 'x' INTO OUTFILE '/var/lib/mysql-files/otw_db_conformance'`,
          `SELECT 'x' /*!50000 INTO DUMPFILE '/var/lib/mysql-files/otw_db_conformance' */`,
          `SELECT LOAD_FILE('/etc/hostname')`,
          `SET GLOBAL max_connections = 151`,
          `SET @@global.max_connections = 151`,
          `/*!50000 SET PERSIST max_connections = 151 */`,
          `KILL 999999`,
          `# a note\nFLUSH PRIVILEGES`,
          // A comment before the word, of every kind the server takes.
          `/* x */ KILL 999999`,
          `/**/SET GLOBAL max_connections = 151`,
          `/**/ /* y */ FLUSH STATUS`,
          `--\u0001 x\nKILL 999999`,
          `(/* x */ KILL 999999)`,
          `SELECT 'x' INTO/**/OUTFILE '/var/lib/mysql-files/otw_db_conformance'`,
          `SELECT 'x' INTO -- x\nDUMPFILE '/var/lib/mysql-files/otw_db_conformance'`,
          `SELECT LOAD_FILE/**/('/etc/hostname')`,
          "SELECT `LOAD_FILE`('/etc/hostname')",
          `EXECUTE IMMEDIATE CONCAT('SET GLO', 'BAL max_connections = 151')`,
          `BEGIN NOT ATOMIC SET GLOBAL max_connections = 151; END`,
          `PREPARE s FROM 'KILL 999999'`,
          `DO SLEEP(0)`,
          `HANDLER conf_items OPEN`,
          `SELECT innodb_set_open_files_limit(4001)`,
          `SELECT asynchronous_connection_failover_add_source('c', '127.0.0.1', 3306, '', 50)`,
        ],
      }
      const kind = name === 'PGlite' ? 'postgres' : name === 'MariaDB' ? 'mysql' : f.driver.kind
      for (const sql of beyond[kind] ?? []) {
        await expect(f.driver.query(sql, read), sql).rejects.toMatchObject({
          code: 'not-allowed',
          message: expect.stringContaining('This connection is read-only'),
        })
      }
      // Reading goes on as it did: these only look like the statements above.
      const fine = [
        `SELECT name FROM conf_items WHERE name = 'copy to do kill set global'`,
        `SELECT 'copy' AS a, 'kill' AS b FROM conf_items LIMIT 1`,
        `-- copy\nSELECT name FROM conf_items WHERE name <> 'do'`,
        `WITH n AS (SELECT name FROM conf_items) SELECT count(*) FROM n`,
        `EXPLAIN SELECT name FROM conf_items`,
        // Names that only begin like one refused, and an apostrophe after "you &".
        ...(kind === 'postgres'
          ? [
              `SELECT count(*) FROM pg_replication_slots`,
              `SELECT count(*) FROM pg_stat_replication_slots`,
              `SELECT count(*) FROM pg_replication_origin_status`,
              `SELECT count(*) FROM pg_stat_activity`,
              `SELECT 'you&''me'`,
            ]
          : []),
        ...(kind === 'postgres'
          ? [
              `/* a note */ (SELECT name FROM conf_items) ORDER BY 1`,
              `VALUES (1), (2)`,
              `TABLE conf_items`,
            ]
          : []),
        ...(kind === 'sqlite' ? [] : [`SHOW ${kind === 'mysql' ? 'TABLES' : 'server_version'}`]),
      ]
      for (const sql of fine) await expect(f.driver.query(sql, read), sql).resolves.toBeDefined()
      // And the grid opens a table whatever it's called: its statements are the driver's own.
      await f.driver.query(
        'CREATE TABLE conf_dblink_copy (lo_export INTEGER, load_file INTEGER)',
        write,
      )
      try {
        await f.driver.query('INSERT INTO conf_dblink_copy VALUES (1, 2)', write)
        const grid = await f.driver.rows(
          {
            schema: f.schema,
            table: 'conf_dblink_copy',
            limit: 10,
            offset: 0,
            order: [{ column: 'lo_export' }],
          },
          LIMITS,
        )
        expect(grid.rows).toEqual([['1', '2']])
      } finally {
        await f.driver.query('DROP TABLE conf_dblink_copy', write)
      }
    })

    it('runs one statement at a time', async () => {
      await expect(
        f.driver.query('SELECT 1; DELETE FROM conf_items', write),
      ).rejects.toBeInstanceOf(DbAdminError)
      expect(await all()).toHaveLength(3)
    })

    it('cuts results at the row limit and says so', async () => {
      const result = await f.driver.query('SELECT id FROM conf_big ORDER BY id', {
        ...read,
        maxRows: 10,
      })
      expect(result.rows).toHaveLength(10)
      expect(result.truncated).toBe(true)
    })

    it('writes with write access, and changes the schema', async () => {
      const updated = await f.driver.query(
        'UPDATE conf_items SET stock = stock + 1 WHERE id = 3',
        write,
      )
      expect(updated.affectedRows).toBe(1)
      await f.driver.query('UPDATE conf_items SET stock = stock - 1 WHERE id = 3', write)
      await f.driver.query('CREATE TABLE conf_tmp (x INTEGER)', write)
      expect(await f.driver.table(f.schema, 'conf_tmp')).not.toBeNull()
    })

    it('stops a statement at the timeout', async (context) => {
      if (!f.driver.capabilities.cancel) context.skip()
      const started = performance.now()
      await expect(f.driver.query(f.slow, { ...read, timeoutMs: 300 })).rejects.toBeInstanceOf(
        QueryError,
      )
      expect(performance.now() - started).toBeLessThan(5_000)
      expect((await f.driver.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    })

    it('cancels a running statement when asked', async (context) => {
      // PGlite runs on the host's thread: nothing can stop it mid-statement.
      if (!f.driver.capabilities.cancel) context.skip()
      const controller = new AbortController()
      const started = performance.now()
      const query = f.driver.query(f.slow, { ...read, signal: controller.signal })
      setTimeout(() => controller.abort(), 300)
      await expect(query).rejects.toMatchObject({ code: 'canceled' })
      expect(performance.now() - started).toBeLessThan(5_000)
      expect((await f.driver.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    })

    it('applies changes together, and nothing when a row is gone', async () => {
      const preview = await f.driver.apply(
        items(),
        [{ type: 'update', key: { id: '2' }, values: { price: '13' } }],
        {
          ...LIMITS,
          dryRun: true,
        },
      )
      expect(preview).toMatchObject({
        applied: false,
        statements: [
          expect.stringMatching(/^UPDATE .*conf_items.* SET .*price.* = '13' WHERE .*id.* = '2'$/),
        ],
      })
      await f.driver.apply(
        items(),
        [
          { type: 'insert', values: { id: '4', name: 'mug', price: '7.5' } },
          { type: 'update', key: { id: '2' }, values: { price: '13' } },
        ],
        LIMITS,
      )
      const rows = await all()
      expect(rows.map((r) => [r[0], Number(r[2])])).toEqual([
        ['1', 1.5],
        ['2', 13],
        ['3', 30.25],
        ['4', 7.5],
      ])
      // Left out, the stock takes its default.
      expect(rows[3]![3]).toBe('0')
      const before = await all()
      await expect(
        f.driver.apply(
          items(),
          [
            { type: 'delete', key: { id: '4' } },
            { type: 'delete', key: { id: '999' } },
          ],
          LIMITS,
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(await all()).toEqual(before)
      await f.driver.apply(
        items(),
        [
          { type: 'delete', key: { id: '4' } },
          { type: 'update', key: { id: '2' }, values: { price: '12.00' } },
        ],
        LIMITS,
      )
      expect(await all()).toHaveLength(3)
    })

    it('counts an unchanged update as the one row it matched', async () => {
      const result = await f.driver.apply(
        items(),
        [{ type: 'update', key: { id: '1' }, values: { name: 'pen' } }],
        LIMITS,
      )
      expect(result.applied).toBe(true)
    })

    it('saves nothing when a cell was changed after the person read it', async () => {
      // Someone else changes lamp's note and price while an edit of that note waits to be saved.
      await f.driver.query(`UPDATE conf_items SET note = 'theirs', price = 99 WHERE id = 3`, write)
      const before = await all()
      const refused = f.driver.apply(
        items(),
        [
          {
            type: 'update',
            key: { id: '2' },
            values: { name: 'tome' },
            original: { name: 'book' },
          },
          { type: 'update', key: { id: '3' }, values: { note: 'mine' }, original: { note: null } },
        ],
        LIMITS,
      )
      await expect(refused).rejects.toMatchObject({ code: 'conflict', status: 409 })
      await expect(refused).rejects.toThrow(
        /^Nothing was saved: note was changed by someone else meanwhile, from NULL to 'theirs'\.\nUPDATE .*SET .*note.* = 'mine' WHERE .*id.* = '3'$/,
      )
      // All or nothing: the first edit, which nobody was in the way of, isn't saved either.
      expect(await all()).toEqual(before)
      // An edit of a cell nobody changed is saved, whatever else in its row changed.
      await f.driver.apply(
        items(),
        [
          {
            type: 'update',
            key: { id: '3' },
            values: { name: 'light' },
            original: { name: 'lamp' },
          },
        ],
        LIMITS,
      )
      // Every type's value compares as the grid showed it: a decimal, a big integer, a NULL.
      const page = await f.driver.rows(
        { ...items(), limit: 1, offset: 0, filters: [{ column: 'id', operator: '=', value: '1' }] },
        LIMITS,
      )
      const shown = Object.fromEntries(page.columns.map((c, i) => [c.name, page.rows[0]![i]!]))
      const { id, ...original } = shown
      expect(original.note).toBeNull()
      await f.driver.apply(
        items(),
        [{ type: 'update', key: { id: id! }, values: { ...original, note: 'new' }, original }],
        LIMITS,
      )
      // The row gone, an edit of it with its cells as they were is refused as before.
      await expect(
        f.driver.apply(
          items(),
          [{ type: 'update', key: { id: '999' }, values: { name: 'x' }, original: { name: 'y' } }],
          LIMITS,
        ),
      ).rejects.toThrow('Nothing was saved: its row is gone or its key changed.')
      await f.driver.query(
        `UPDATE conf_items SET name = 'lamp', note = NULL, price = 30.25 WHERE id = 3`,
        write,
      )
      await f.driver.query(`UPDATE conf_items SET note = NULL WHERE id = 1`, write)
    })

    /** A table's rows as an SQL export, whole. */
    async function exported(table: string): Promise<string> {
      const target = { schema: f.schema, table }
      const stream = exportStream(
        'sql',
        f.driver.export({ ...target, order: [{ column: 'id' }] }, LIMITS),
        target,
        f.driver.sql,
        () => {},
      )
      return await new Response(stream).text()
    }

    /** The export's statements, one a line as it writes them. */
    const statements = (file: string) =>
      file
        .split(';\n')
        .map((s) => s.trim())
        .filter(Boolean)

    it('finds, edits and deletes rows whose key is bytes, and writes bytes as bytes', async () => {
      await f.driver.query('DROP TABLE IF EXISTS conf_bytes', write)
      await f.driver.query(
        `CREATE TABLE conf_bytes (id ${f.bytes} PRIMARY KEY, data ${f.bytes}, label VARCHAR(40))`,
        write,
      )
      await f.driver.query(
        `INSERT INTO conf_bytes (id, data, label) VALUES
           (${f.hex('00FF10AA')}, ${f.hex('DEADBEEF')}, 'first'),
           (${f.hex('0A0B')}, NULL, 'it''s a \\ and a "quote"')`,
        write,
      )
      const target = { schema: f.schema, table: 'conf_bytes' }
      const read = async (filters?: Parameters<Driver['rows']>[0]['filters']) =>
        (
          await f.driver.rows(
            { ...target, limit: 10, offset: 0, order: [{ column: 'label' }], filters },
            LIMITS,
          )
        ).rows
      const [first, second] = await read()
      const [firstId, firstData] = first as [string, string, string]
      const secondId = second![0]!
      // A filter takes a key as the grid shows it.
      expect(await read([{ column: 'id', operator: '=', value: firstId }])).toEqual([first])
      expect(
        await read([{ column: 'id', operator: 'in', value: [secondId, firstId] }]),
      ).toHaveLength(2)
      // Edits name their row by its key as shown, and compare bytes as shown.
      await f.driver.apply(
        target,
        [
          {
            type: 'update',
            key: { id: firstId },
            values: { label: 'renamed' },
            original: { label: 'first' },
          },
          // Bytes typed in as the grid shows them are stored as bytes, not as those letters.
          {
            type: 'update',
            key: { id: secondId },
            values: { data: firstData },
            original: { data: null },
          },
        ],
        LIMITS,
      )
      const after = await read()
      expect(after.find((r) => r[0] === firstId)).toEqual([firstId, firstData, 'renamed'])
      expect(after.find((r) => r[0] === secondId)![1]).toBe(firstData)
      await expect(
        f.driver.apply(
          target,
          [
            {
              type: 'update',
              key: { id: secondId },
              values: { label: 'x' },
              original: { data: null },
            },
          ],
          LIMITS,
        ),
      ).rejects.toMatchObject({ code: 'conflict' })
      // The SQL export puts the same rows back: bytes, a backslash and quotes as they were.
      const before = await read()
      const file = await exported('conf_bytes')
      await f.driver.apply(
        target,
        [
          { type: 'delete', key: { id: firstId } },
          { type: 'delete', key: { id: secondId } },
        ],
        LIMITS,
      )
      expect(await read()).toEqual([])
      for (const statement of statements(file)) {
        if (statement.startsWith('INSERT')) await f.driver.query(statement, write)
      }
      expect(await read()).toEqual(before)
    })

    it('exports SQL that puts back a table with generated columns', async () => {
      await f.driver.query('DROP TABLE IF EXISTS conf_made', write)
      await f.driver.query(f.made, write)
      await f.driver.query('INSERT INTO conf_made (a) VALUES (1), (5), (7)', write)
      await f.driver.query('DELETE FROM conf_made WHERE a = 1', write)
      const rows = async () =>
        (await f.driver.query('SELECT id, a, b FROM conf_made ORDER BY id', read)).rows
      const before = await rows()
      expect(before).toEqual([
        ['2', '5', '10'],
        ['3', '7', '14'],
      ])
      const file = await exported('conf_made')
      await f.driver.query('DELETE FROM conf_made', write)
      for (const statement of statements(file)) {
        if (statement.startsWith('INSERT')) await f.driver.query(statement, write)
      }
      // The keys it had, not new ones; what's generated, generated again.
      expect(await rows()).toEqual(before)
      // CSV and JSON still hold every column.
      for await (const batch of f.driver.export({ schema: f.schema, table: 'conf_made' }, LIMITS)) {
        expect(batch.columns.map((c) => c.name)).toEqual(['id', 'a', 'b'])
      }
    })

    it('exports every row in batches, filtered and in order', async () => {
      const sizes: number[] = []
      let last: string | null = null
      for await (const batch of f.driver.export(
        {
          schema: f.schema,
          table: 'conf_big',
          filters: [{ column: 'id', operator: '>', value: '100' }],
          order: [{ column: 'id', descending: true }],
        },
        LIMITS,
      )) {
        expect(batch.columns.map((c) => c.name)).toEqual(['id', 'label'])
        sizes.push(batch.rows.length)
        last = batch.rows.at(-1)![0] ?? null
      }
      expect(sizes).toEqual([1000, 1000, 400])
      expect(last).toBe('101')
      // Stopped early: the driver goes on.
      for await (const batch of f.driver.export({ schema: f.schema, table: 'conf_big' }, LIMITS)) {
        expect(batch.rows).toHaveLength(1000)
        break
      }
      expect((await f.driver.query('SELECT 1 AS one', read)).rows).toEqual([['1']])
    })

    it('reports its server', async () => {
      const info = await f.driver.info()
      expect(info.product).toBe(f.product)
      expect(info.version).toMatch(/^\d+\.\d+/)
    })
  })
}
