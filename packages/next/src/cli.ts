import { parseArgs } from 'node:util'
import { apply, detect, plan, report } from './init.ts'

const HELP = `otw-db-next: OTW DB in a Next.js app

Usage: npx @otwdesign/db-next init [--path /db] [--dry-run] [--no-install]

Run it in the app's directory. It writes one route file (app/db/[[...path]]/route.ts), adds
DB_ADMIN_PASSWORD to .env.local, and installs @otwdesign/db-next. It never writes over a file.

  --path /admin/db   where the tool goes; /db unless you say
  --dry-run          say what it would do, and do nothing
  --no-install       write the files, install nothing
`

/** The `otw-db-next` command. */
export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      path: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'no-install': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (values.help || positionals[0] !== 'init' || positionals.length > 1) {
    process.stdout.write(HELP)
    if (!values.help) process.exitCode = 1
    return
  }
  const detected = detect(cwd)
  const planned = plan(detected, {
    ...(values.path === undefined ? {} : { path: values.path }),
    install: !values['no-install'],
  })
  if (planned.refused) {
    process.stderr.write(`${planned.refused}\n`)
    process.exitCode = 1
    return
  }
  if (!values['dry-run']) apply(detected, planned)
  process.stdout.write(report(detected, planned, values['dry-run'] === true))
}
