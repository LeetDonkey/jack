<script setup lang="ts">
import type { GroupedRow } from '~/components/LogRow.vue'
import type { LogRecord } from '~/types/management'
import { extractHttp, groupKey, levelName, logDayBreaks, logDayKey, logRuns, logSegmentBreaks } from '~/utils/logFormat'
import { LogTail } from '~/utils/logTail'

type Row = LogRecord & { _id: number }

const { request } = useManagement()

// 'all' means no server-side level floor; the rest map to the pino level names.
const LEVELS = ['all', 'trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const
type LevelFilter = typeof LEVELS[number]
const level = ref<LevelFilter>('all')
const levelItems = LEVELS.map(value => ({ label: value === 'all' ? 'All levels' : value.toUpperCase(), value }))

// How many lines to backfill on load, and the in-memory cap for the live view.
const BACKFILL_LINES = 500
const MAX_ROWS = 2000
// A backfill after a pause or reconnect asks for this many when BACKFILL_LINES
// don't reach back to the lines shown. It leaves room for the latest lines shown
// before, so a hole it can't fill has lines on both sides and a note in it.
const CATCH_UP_LINES = MAX_ROWS - BACKFILL_LINES

const rows = ref<Row[]>([])
// Rows with lines missing just above them: a backfill that couldn't reach back
// to the lines shown before it.
const gaps = ref(new Set<number>())
const pending = ref(false)
const error = ref<unknown>()
const live = ref(true)

// View controls.
const query = ref('')
const collapse = ref(true)

let seq = 0

function tag(record: LogRecord): Row {
  return { ...record, _id: seq++ }
}

function levelQuery(prefix: '?' | '&'): string {
  return level.value === 'all' ? '' : `${prefix}level=${level.value}`
}

function append(records: LogRecord[], scrollToEnd = false): Row[] {
  if (records.length === 0)
    return []
  const added = records.map(tag)
  rows.value.push(...added)
  if (rows.value.length > MAX_ROWS) {
    rows.value.splice(0, rows.value.length - MAX_ROWS)
    const oldest = rows.value[0]!._id
    for (const id of gaps.value) {
      if (id < oldest)
        gaps.value.delete(id)
    }
  }
  scheduleScroll(scrollToEnd)
  return added
}

// The stream only sends lines logged after it opened. Every open (the first, and
// each reopen after jack restarted or the page was paused) fetches the latest
// lines again, and `tail` keeps only those not shown yet.
const tail = new LogTail()
// Bumped when the level changes, so an answer for the old level is dropped.
let generation = 0
let syncing = false
let syncAgain = false
// Lines from the stream while a backfill is on its way, added after it so the
// order holds.
let held: LogRecord[] = []

async function sync() {
  if (syncing) {
    // An open during a backfill: what was logged just before it may be missing.
    syncAgain = true
    return
  }
  const run = generation
  syncing = true
  pending.value = true
  try {
    do {
      syncAgain = false
      try {
        const backfill = await tail.backfill(
          async lines => (await request<{ logs: LogRecord[] }>(`logs?lines=${lines}${levelQuery('&')}`)).logs,
          { lines: BACKFILL_LINES, maxLines: CATCH_UP_LINES, wanted: () => run === generation },
        )
        if (!backfill)
          return
        const added = append(backfill.records, rows.value.length === 0)
        if (backfill.gap && added[0])
          gaps.value.add(added[0]._id)
        error.value = undefined
      }
      catch (err) {
        if (run !== generation)
          return
        error.value = err
      }
    } while (syncAgain)
  }
  finally {
    if (run === generation) {
      syncing = false
      pending.value = false
      append(held.filter(record => tail.take(record)))
      held = []
    }
  }
}

function onRecord(record: LogRecord) {
  if (!record || typeof record !== 'object')
    return
  // jack answers again.
  error.value = undefined
  if (syncing) {
    held.push(record)
    if (held.length > MAX_ROWS)
      held.shift()
  }
  else if (tail.take(record)) {
    append([record])
  }
}

const streamPath = computed(() => live.value ? `logs/stream${levelQuery('?')}` : null)
const { connected, hasConnectedOnce } = useManagementStream<LogRecord>(streamPath, onRecord, { onOpen: sync })

watch(level, () => {
  generation++
  syncing = false
  syncAgain = false
  held = []
  tail.reset()
  rows.value = []
  gaps.value = new Set()
  error.value = undefined
  void sync()
})
onMounted(sync)

function toggleLive() {
  live.value = !live.value
}

function clear() {
  rows.value = []
  gaps.value = new Set()
}

// --- Auto-scroll: stick to the bottom unless the user has scrolled up. ---
const scroller = useTemplateRef<HTMLElement>('scroller')
const stick = ref(true)

function onScroll() {
  const el = scroller.value
  if (el)
    stick.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

function scheduleScroll(force: boolean) {
  if (!force && !stick.value)
    return
  nextTick(() => {
    const el = scroller.value
    if (el)
      el.scrollTop = el.scrollHeight
  })
}

// --- Text filter over the raw stream (path, message, method, status, level). ---
function haystack(row: Row): string {
  const http = extractHttp(row)
  return [
    row.message,
    levelName(row),
    typeof row.severity === 'string' ? row.severity : undefined,
    http?.method,
    http?.path,
    http?.status,
  ].filter(v => v != null).join(' ').toLowerCase()
}

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q)
    return rows.value
  return rows.value.filter(row => haystack(row).includes(q))
})

// --- Fold consecutive identical lines into one row with a ×N counter. ---
function durationOf(row: Row): number | undefined {
  return typeof row.durationMs === 'number' ? row.durationMs : undefined
}

// Each row's jack run (see logRuns), and how many holes (see `gaps`) lie before
// it, by row id. Counted over all rows, so a filter can't hide a restart.
const segments = computed(() => {
  const runs = logRuns(rows.value)
  const byId = new Map<number, { run: number, gap: number }>()
  let gap = 0
  rows.value.forEach((row, index) => {
    if (gaps.value.has(row._id))
      gap++
    byId.set(row._id, { run: runs[index]!, gap })
  })
  return byId
})

const groups = computed<GroupedRow[]>(() => {
  const list = filtered.value
  if (!collapse.value)
    return list.map(r => ({ ...r, _count: 1, _durations: durationOf(r) !== undefined ? [durationOf(r)!] : [] }))

  const out: GroupedRow[] = []
  let prevKey: string | null = null
  for (const r of list) {
    // A run of repeats stops at midnight, at a restart and at a hole, so each
    // side shows its own.
    const segment = segments.value.get(r._id)
    const key = `${groupKey(r)}|${logDayKey(r.time)}|${segment?.run}|${segment?.gap}`
    const dur = durationOf(r)
    const last = out.at(-1)
    if (last && key === prevKey) {
      // Refresh to the latest occurrence but keep the run's first id as a stable
      // key so an expanded row doesn't collapse as identical lines stream in.
      const id = last._id
      const durations = last._durations
      if (dur !== undefined)
        durations.push(dur)
      Object.assign(last, r, { _id: id, _count: last._count + 1, _durations: durations })
    }
    else {
      out.push({ ...r, _count: 1, _durations: dur !== undefined ? [dur] : [] })
      prevKey = key
    }
  }
  return out
})

// The day above each row that starts one (see logDayBreaks). `now` moves on each
// minute, so "Today" turns into "Yesterday" after midnight.
const now = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now()
  }, 60_000)
})
onBeforeUnmount(() => clearInterval(nowTimer))
const dayBreaks = computed(() => logDayBreaks(groups.value, now.value))
// "jack started" above the first row of each run, and the missing-lines note above
// the row after a hole. A group's id is its first row's.
const runBreaks = computed(() => logSegmentBreaks(groups.value.map(group => segments.value.get(group._id)?.run ?? 0)))
const gapBreaks = computed(() => logSegmentBreaks(groups.value.map(group => segments.value.get(group._id)?.gap ?? 0)))

const expanded = ref<Set<number>>(new Set())
function toggle(id: number) {
  const next = new Set(expanded.value)
  if (next.has(id))
    next.delete(id)
  else
    next.add(id)
  expanded.value = next
}

const summary = computed(() => {
  const total = rows.value.length
  const shown = groups.value.length
  if (query.value.trim())
    return `${filtered.value.length} of ${total} lines`
  if (collapse.value && shown !== total)
    return `${shown} rows · ${total} lines`
  return `${total} lines`
})
</script>

<template>
  <UDashboardPanel id="logs">
    <template #header>
      <UDashboardNavbar title="Logs">
        <template #right>
          <div class="flex items-center gap-2">
            <LiveBadge :connected="connected" :has-connected-once="hasConnectedOnce" :paused="!live" />
            <!-- Below sm only the badge stays here; the controls sit in the filter bar. -->
            <div class="hidden items-center gap-2 sm:flex">
              <USelect v-model="level" :items="levelItems" size="sm" class="w-32" aria-label="Minimum log level" />
              <UButton
                :icon="live ? 'i-ph-pause' : 'i-ph-play'"
                :label="live ? 'Pause' : 'Resume'"
                color="neutral"
                variant="ghost"
                size="sm"
                @click="toggleLive"
              />
              <UButton icon="i-ph-trash" label="Clear" color="neutral" variant="ghost" size="sm" @click="clear" />
              <!-- Icon only until md, so the navbar fits from sm up. -->
              <SupportInfoButton
                variant="ghost"
                size="sm"
                aria-label="Copy support info"
                title="Copy support info"
                :ui="{ label: 'hidden md:inline' }"
              />
            </div>
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <div class="flex h-full flex-col gap-3">
        <!-- Filter bar -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div class="flex w-full flex-wrap items-center gap-2 sm:hidden">
            <USelect v-model="level" :items="levelItems" size="sm" class="w-36" aria-label="Minimum log level" />
            <UButton
              class="ms-auto"
              :icon="live ? 'i-ph-pause' : 'i-ph-play'"
              :label="live ? 'Pause' : 'Resume'"
              color="neutral"
              variant="ghost"
              size="sm"
              @click="toggleLive"
            />
            <UButton icon="i-ph-trash" label="Clear" color="neutral" variant="ghost" size="sm" @click="clear" />
            <!-- Wraps to a line of its own when the row is full. -->
            <SupportInfoButton variant="ghost" size="sm" />
          </div>
          <UInput
            v-model="query"
            icon="i-ph-magnifying-glass"
            placeholder="Filter by path, method, status or message"
            size="sm"
            class="min-w-56 flex-1"
            :ui="{ trailing: 'pe-1' }"
          >
            <template v-if="query" #trailing>
              <UButton
                icon="i-ph-x"
                color="neutral"
                variant="link"
                size="xs"
                aria-label="Clear filter"
                @click="() => { query = '' }"
              />
            </template>
          </UInput>
          <USwitch v-model="collapse" label="Collapse repeats" size="sm" />
          <span class="ms-auto shrink-0 text-xs tabular-nums text-dimmed">{{ summary }}</span>
        </div>

        <LoadErrorAlert v-if="error && rows.length === 0" :error="error" :retry="sync" />

        <p v-else-if="pending && rows.length === 0" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-ph-circle-notch" class="size-4 animate-spin" />
          Loading…
        </p>

        <UCard v-else-if="rows.length === 0" variant="subtle">
          <div class="flex flex-col items-center gap-3 py-6 text-center">
            <UIcon name="i-ph-scroll" class="size-8 text-dimmed" />
            <p class="text-sm text-muted">
              No log lines yet. New entries stream in here as jack logs them.
            </p>
          </div>
        </UCard>

        <div
          v-else-if="groups.length === 0"
          class="flex flex-col items-center gap-2 rounded-lg border border-dashed border-default py-10 text-center"
        >
          <UIcon name="i-ph-magnifying-glass" class="size-6 text-dimmed" />
          <p class="text-sm text-muted">
            No lines match “{{ query }}”.
          </p>
        </div>

        <div
          v-else
          ref="scroller"
          class="min-h-0 flex-1 overflow-auto rounded-lg border border-default bg-elevated/40 font-mono text-xs"
          @scroll="onScroll"
        >
          <template v-for="(row, index) in groups" :key="row._id">
            <!-- Sticks to the top while its day scrolls past. The separators use
                 text-toned in light mode, where text-muted on bg-elevated is only
                 4.35:1. -->
            <div
              v-if="dayBreaks[index]"
              class="sticky top-0 z-10 border-b border-default bg-elevated px-3 py-1 font-sans font-medium text-toned dark:text-muted"
            >
              {{ dayBreaks[index] }}
            </div>
            <div
              v-if="gapBreaks[index]"
              class="flex items-start gap-2 border-b border-default bg-elevated px-3 py-1 font-sans text-toned dark:text-muted"
            >
              <UIcon name="i-ph-warning" class="mt-0.5 size-3.5 shrink-0 text-warning" />
              <span>Some lines are missing here. jack logged too many while the list was paused or reconnecting, so only the latest ones follow.</span>
            </div>
            <div
              v-if="runBreaks[index]"
              class="flex items-center gap-2 border-b border-default bg-elevated px-3 py-1 font-sans font-medium text-toned dark:text-muted"
            >
              <UIcon name="i-ph-power" class="size-3.5 shrink-0" />
              jack started
            </div>
            <LogRow
              :row="row"
              :expanded="expanded.has(row._id)"
              class="border-b border-default/40 last:border-b-0"
              @toggle="toggle(row._id)"
            />
          </template>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
