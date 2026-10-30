import type { DownloadsRepository } from './downloads.repository'
import { readdir, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { isSubtitlePath } from '../../lib/subtitles'

type ArtifactRepository = Pick<DownloadsRepository, 'get' | 'list'>
type ArtifactRecord = ReturnType<DownloadsRepository['list']>[number]

/**
 * Whether another row sharing this path still has a use for the file, which makes it
 * off limits: it's downloading into it, or waiting for *arr to import it, or holds a
 * failed import that a retry would re-trigger against that exact path.
 *
 * `imported` is the one status that doesn't qualify — it's terminal and nothing ever
 * reads its file again. That exception matters: two rows can legitimately share a
 * destination (a re-grab lands while the first is still `import_queued`, since the
 * in-flight duplicate guard only covers active transfers), and without it each would
 * defer to the other on import and the file would outlive both rows.
 */
function siblingNeedsFile(row: ArtifactRecord, resolvedPath: string): boolean {
  if (row.status === 'imported')
    return false
  return [resolve(row.destPath), resolve(row.partPath)].includes(resolvedPath)
}

/**
 * Drop jack's directory entry for one download artifact. Deliberately `unlink` and
 * nothing more: when *arr hardlinked the file into the library, removing jack's link
 * frees the name while the library's link keeps the data alive; when *arr copied it,
 * the copy is untouched either way.
 *
 * Three guards, all evaluated immediately before the syscall so a concurrent
 * delete/retry can't be raced into removing a file that is no longer ours:
 * - the path must resolve inside `completedPath` (never follow a row out of the root)
 * - the live row must still reference it (it may have been deleted or rewritten)
 * - no other download row may still need it (see `siblingNeedsFile`)
 *
 * A missing file (ENOENT) is success, not an error. Returns whether a file was
 * actually removed.
 */
export async function unlinkDownloadArtifact(
  repository: ArtifactRepository,
  id: number,
  artifactPath: string,
  completedPath: string,
): Promise<boolean> {
  const resolved = resolve(artifactPath)
  const fromRoot = relative(resolve(completedPath), resolved)
  const isInsideRoot = fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
  if (!isInsideRoot)
    return false

  const live = repository.get(id)
  const stillOwned = live != null && [resolve(live.partPath), resolve(live.destPath)].includes(resolved)
  if (!stillOwned)
    return false

  if (repository.list().some(row => row.id !== id && siblingNeedsFile(row, resolved)))
    return false

  try {
    await unlink(resolved)
    return true
  }
  catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT')
      return false
    throw err
  }
}

/**
 * Drop the subtitle files jack put next to a download's file (`Film.mkv` →
 * `Film.da.srt`), once the file itself is gone. Only subtitle files named after it,
 * inside `completedPath`. Returns how many were removed.
 */
export async function unlinkSubtitleSiblings(destPath: string, completedPath: string): Promise<number> {
  const resolved = resolve(destPath)
  const fromRoot = relative(resolve(completedPath), resolved)
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot))
    return 0
  const folder = dirname(resolved)
  const prefix = `${basename(resolved, extname(resolved))}.`
  const names = await readdir(folder).catch(() => [] as string[])
  let removed = 0
  for (const name of names) {
    const path = join(folder, name)
    if (!name.startsWith(prefix) || path === resolved || !isSubtitlePath(name))
      continue
    try {
      await unlink(path)
      removed++
    }
    catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ENOENT'))
        throw err
    }
  }
  return removed
}
