import { basename, extname, isAbsolute, relative, resolve } from 'node:path'

/** Subtitle files jack passes on with a release. Radarr/Sonarr list them as extra files of type `subtitle`. */
export const SUBTITLE_EXTENSIONS: ReadonlySet<string> = new Set(['srt', 'ass', 'ssa', 'sub', 'idx', 'sup', 'vtt', 'smi'])

/** Larger files are skipped. Image-based subtitles (PGS `.sup`) for a whole film stay well below. */
export const MAX_SUBTITLE_BYTES = 64 * 1024 * 1024

/** At most this many subtitle files per release are listed and fetched. */
export const MAX_SUBTITLES = 20

/** A subtitle file next to a release's video file, as the *arr reports it. */
export interface SubtitleFile {
  /** Absolute path on this machine. */
  path: string
  /** Language tags the *arr parsed from the name (e.g. `["da"]`, `["forced"]`). */
  languageTags?: string[] | null
  /** The *arr's title for the file, if it has one. */
  title?: string | null
}

/** What a peer lists for a release: `suffix` is appended to the video's name without extension. */
export interface SubtitleEntry {
  index: number
  suffix: string
  size: number
}

const SUFFIX_PATTERN = /^\.[\w.\- ]{1,120}$/
const UNSAFE_TAG_CHARS = /[^\w\-]+/g
const EDGE_DASHES = /^-+|-+$/g

/** The extension without the dot, lower-case (`"srt"`), or `""`. */
function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

export function isSubtitlePath(path: string): boolean {
  return SUBTITLE_EXTENSIONS.has(extensionOf(path))
}

/** Whether a file's name starts with the video's name and a dot (`Film.mkv` -> `Film.da.srt`). */
export function namedAfter(videoPath: string, path: string): boolean {
  return basename(path).startsWith(`${basename(videoPath, extname(videoPath))}.`)
}

function sanitizeTag(tag: string): string {
  return tag.replace(UNSAFE_TAG_CHARS, '-').replace(EDGE_DASHES, '').slice(0, 40)
}

/**
 * The part of a subtitle file's name after the video's name, so the receiving jack can
 * name it after its own copy of the video (`Film (2020).mkv` + `.da.srt`). Radarr/Sonarr
 * pick up extra files on import by that shared prefix. A subtitle named differently
 * (`Subs/2_Danish.srt`) gets the *arr's language tags and title, or its index, instead.
 * Returns null for a file that isn't a subtitle.
 */
export function subtitleSuffix(videoPath: string, subtitle: SubtitleFile, index: number): string | null {
  const ext = extensionOf(subtitle.path)
  if (!SUBTITLE_EXTENSIONS.has(ext))
    return null
  if (namedAfter(videoPath, subtitle.path)) {
    const suffix = basename(subtitle.path).slice(basename(videoPath, extname(videoPath)).length)
    if (SUFFIX_PATTERN.test(suffix))
      return suffix
  }
  const tags = [...(subtitle.languageTags ?? []), ...(subtitle.title ? [subtitle.title] : [])]
    .map(sanitizeTag)
    .filter(Boolean)
  const middle = tags.length > 0 ? tags.join('.') : String(index + 1)
  return `.${middle}.${ext}`
}

/** Whether a suffix a peer sent is safe to append to a file name (no path parts, a subtitle extension). */
export function isSafeSubtitleSuffix(suffix: string): boolean {
  return SUFFIX_PATTERN.test(suffix) && !suffix.includes('..') && SUBTITLE_EXTENSIONS.has(extensionOf(suffix))
}

/** Whether `path` resolves inside `folder` (a subtitle must sit in the release's own folder tree). */
export function isInside(folder: string, path: string): boolean {
  const rel = relative(resolve(folder), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** The path a subtitle with `suffix` gets next to `videoPath`. */
export function subtitlePathFor(videoPath: string, suffix: string): string {
  return `${videoPath.slice(0, videoPath.length - extname(videoPath).length)}${suffix}`
}
