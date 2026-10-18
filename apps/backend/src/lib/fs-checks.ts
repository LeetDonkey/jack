import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'

/** Whether `path` is an existing directory this process may create files in. */
export async function isWritableDirectory(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isDirectory())
      return false
    await access(path, constants.W_OK)
    return true
  }
  catch {
    return false
  }
}
