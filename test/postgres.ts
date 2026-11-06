import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string
  }
}

/**
 * Real PostgreSQL for the integration tests: TEST_POSTGRES_URL when set (CI's service), or a
 * throwaway postgres:17-alpine container on a free port, removed afterwards.
 */
export default async function setup(project: TestProject) {
  const given = process.env.TEST_POSTGRES_URL
  if (given) {
    project.provide('postgresUrl', given)
    return
  }
  const name = `otw-db-test-${process.pid}`
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
  try {
    docker(
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-e',
      'POSTGRES_PASSWORD=test',
      '-p',
      '127.0.0.1::5432',
      'postgres:17-alpine',
    )
  } catch (error) {
    throw new Error(
      `The PostgreSQL tests need Docker running, or TEST_POSTGRES_URL set (${(error as Error).message})`,
      { cause: error },
    )
  }
  const port = docker('port', name, '5432/tcp').split('\n')[0]!.split(':').pop()
  // The image's first start runs initdb on a socket only, then restarts listening on TCP.
  for (let tries = 0; ; tries++) {
    try {
      docker('exec', name, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres')
      break
    } catch (error) {
      if (tries > 120) throw error
      await sleep(250)
    }
  }
  project.provide('postgresUrl', `postgres://postgres:test@127.0.0.1:${port}/postgres`)
  return () => {
    docker('rm', '-f', name)
  }
}
