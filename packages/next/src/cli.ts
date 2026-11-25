import { parseArgs } from 'node:util'
import { apply, detect, plan, report } from './init.ts'

const HELP = `otw-db-next: OTW DB in a Next.js app

Usage: npx @otwdesign/db-next init [--path /db] [--dry-run] [--no-install]

Run it in the app's directory. It writes one route file (app/db/[[...path]]/route.ts), installs
@otwdesign/db-next, and says which variables to set: the password is yours to choose, and it
writes none. It never writes over a file.

  --path /admin/db   where the tool goes; /db unless you say
  --dry-run          say what it would do, and do nothing
  --no-install       write the files, install nothing
`

/** What was typed, as options; null when it's none this command has. */
function options(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        path: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'no-install': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch {
    return null
  }
}

/** The `otw-db-next` command. */
export async function main(argv = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const given = options(argv)
  if (!given) {
    process.stdout.write(HELP)
    process.exitCode = 1
    return
  }
  const { values, positionals } = given
  if (values.help || positionals[0] !== 'init' || positionals.length > 1) {
    process.stdout.write(HELP)
    if (!values.help) process.exitCode = 1
    return
  }
  let detected: ReturnType<typeof detect>
  let planned: ReturnType<typeof plan>
  try {
    detected = detect(cwd)
    planned = plan(detected, {
      ...(values.path === undefined ? {} : { path: values.path }),
      install: !values['no-install'],
    })
  } catch (error) {
    // The code Node gives, and none of its own words: those carry paths as the folder has them.
    const code = (error as NodeJS.ErrnoException).code ?? 'an error'
    process.stderr.write(`Couldn’t read this folder (${code}). Nothing was written.\n`)
    process.exitCode = 1
    return
  }
  if (planned.refused) {
    process.stderr.write(`${planned.refused}\n`)
    process.exitCode = 1
    return
  }
  let outcome: ReturnType<typeof apply> | undefined
  try {
    outcome = values['dry-run'] ? undefined : apply(detected, planned)
  } catch (error) {
    // In a line: the code Node gives, and the path only as this command made it.
    const failed = error as NodeJS.ErrnoException
    const at = planned.files[0]?.path ?? 'the route file'
    process.stderr.write(`Couldn’t write the route file (${failed.code ?? 'it failed'}): ${at}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(report(detected, planned, values['dry-run'] === true, outcome))
  if (outcome?.installFailed) process.exitCode = 1
}
