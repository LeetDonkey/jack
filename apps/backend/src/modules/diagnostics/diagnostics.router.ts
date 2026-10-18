import type { FolderCheck } from './folder-check'
import { Hono } from 'hono'
import { describeRoute, resolver } from 'hono-openapi'
import { z } from 'zod'

const Status = z.enum(['ok', 'error', 'unknown'])

const PathCheckSchema = z.object({ path: z.string(), status: Status, message: z.string() })

const FolderReportSchema = z.object({
  checkedAt: z.string(),
  ok: z.boolean().describe('No check found a problem; checks that couldn\'t run (`unknown`) don\'t count'),
  sources: z.array(z.object({
    serverId: z.string(),
    name: z.string(),
    type: z.string(),
    status: Status,
    message: z.string().nullable().describe('Why the server couldn\'t be checked, or that it has nothing to check; null otherwise'),
    rootFolders: z.array(PathCheckSchema),
    sampleFiles: z.array(PathCheckSchema),
  })),
  completed: z.object({
    path: z.string(),
    status: Status,
    message: z.string(),
    exists: z.boolean(),
    writable: z.boolean().nullable(),
    freeBytes: z.number().nullable(),
    destinations: z.array(z.object({ serverId: z.string(), name: z.string(), type: z.string(), status: Status, message: z.string() })),
  }).nullable().describe('Null when downloads are off'),
})

export function getDiagnosticsRouter(folders: FolderCheck) {
  const app = new Hono()
  app.post('/folders', describeRoute({
    tags: ['Diagnostics'],
    summary: 'Check folder mappings',
    description: [
      'Checks the folders jack shares from and downloads to, as seen from jack\'s container and from each Radarr/Sonarr. Every check has `status` (`ok`, `error` for a problem to fix, `unknown` when it couldn\'t run) and a plain-language `message`.',
      '`sources` has one entry per server that shares its library: each root folder must exist in jack\'s container (`rootFolders`), and up to 2 library files, from different root folders where there are several, must open for reading (`sampleFiles`).',
      '`completed` checks `downloads.completedPath` as saved now: it must exist and take a test file, `freeBytes` is the free space there, and `destinations` has one entry per server jack downloads for, which passes when that *arr lists the test file in the same folder (its `/api/v3/filesystem`). The test file is removed afterwards.',
      'Each *arr request and file system call gives up after 10 seconds; listing a library for the sample files after 30.',
    ].join(' '),
    security: [{ 'X-Management-Key': [] }],
    responses: { 200: { description: 'The folder report', content: { 'application/json': { schema: resolver(FolderReportSchema) } } } },
  }), async c => c.json(await folders.run()))
  return app
}
