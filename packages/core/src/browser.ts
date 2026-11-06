/*
 * What the browser app takes from the core: the API's types, and nothing that runs on a server.
 * The app builds against this, so no driver, Node module or database client reaches its bundle.
 */
export type * from './types.ts'
export type { UiConfig } from './ui.ts'
