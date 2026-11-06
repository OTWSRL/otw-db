import { execFileSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string
    mysqlUrl: string
    mariadbUrl: string
  }
}

interface Server {
  /** Given to the tests as this name. */
  key: 'postgresUrl' | 'mysqlUrl' | 'mariadbUrl'
  /** Set it to test against a server of your own (CI's services). */
  env: string
  image: string
  port: number
  environment: Record<string, string>
  /** Succeeds once the server takes connections over TCP, past the image's first-start setup. */
  ready: string[]
  url(port: string): string
}

const SERVERS: Server[] = [
  {
    key: 'postgresUrl',
    env: 'TEST_POSTGRES_URL',
    image: 'postgres:17-alpine',
    port: 5432,
    environment: { POSTGRES_PASSWORD: 'test' },
    ready: ['pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'],
    url: (port) => `postgres://postgres:test@127.0.0.1:${port}/postgres`,
  },
  {
    key: 'mysqlUrl',
    env: 'TEST_MYSQL_URL',
    image: 'mysql:8.4',
    port: 3306,
    environment: { MYSQL_ROOT_PASSWORD: 'test', MYSQL_DATABASE: 'conf' },
    ready: ['mysql', '-h', '127.0.0.1', '-uroot', '-ptest', '-e', 'SELECT 1'],
    url: (port) => `mysql://root:test@127.0.0.1:${port}/conf`,
  },
  {
    key: 'mariadbUrl',
    env: 'TEST_MARIADB_URL',
    image: 'mariadb:11.4',
    port: 3306,
    environment: { MARIADB_ROOT_PASSWORD: 'test', MARIADB_DATABASE: 'conf' },
    ready: ['mariadb', '-h', '127.0.0.1', '-uroot', '-ptest', '-e', 'SELECT 1'],
    url: (port) => `mariadb://root:test@127.0.0.1:${port}/conf`,
  },
]

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * Real databases for the integration tests: each `TEST_*_URL` that's set (CI's services), or a
 * throwaway container on a free port, all started at once and removed afterwards.
 */
export default async function setup(project: TestProject) {
  const started: string[] = []
  await Promise.all(
    SERVERS.map(async (server) => {
      const given = process.env[server.env]
      if (given) return project.provide(server.key, given)
      const name = `otw-db-test-${server.key.replace('Url', '')}-${process.pid}`
      const environment = Object.entries(server.environment).flatMap(([k, v]) => [
        '-e',
        `${k}=${v}`,
      ])
      try {
        docker(
          'run',
          '-d',
          '--rm',
          '--name',
          name,
          ...environment,
          '-p',
          `127.0.0.1::${server.port}`,
          server.image,
        )
      } catch (error) {
        throw new Error(
          `The database tests need Docker running, or ${server.env} set (${(error as Error).message})`,
          { cause: error },
        )
      }
      started.push(name)
      const port = docker('port', name, `${server.port}/tcp`).split('\n')[0]!.split(':').pop()!
      for (let tries = 0; ; tries++) {
        try {
          docker('exec', name, ...server.ready)
          break
        } catch (error) {
          if (tries > 240) throw error
          await sleep(500)
        }
      }
      project.provide(server.key, server.url(port))
    }),
  )
  return () => {
    for (const name of started) docker('rm', '-f', name)
  }
}
