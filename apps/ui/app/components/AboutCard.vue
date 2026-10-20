<script setup lang="ts">
import type { BuildIdentity, JackVersion } from '~/types/tools'

const { request } = useManagement()

// Which build each container runs: jack's from jack, the UI's from jack-ui's own
// server. Both images report null without the REVISION/BUILD_DATE build args, and
// an older jack has no /version; either way it reads "unknown build".
const { data: jackBuild, pending: jackPending, refresh: refreshJackBuild } = useLazyAsyncData('about-jack-build', () =>
  request<JackVersion>('version').catch(() => null))
const { data: uiBuild, pending: uiPending } = useLazyAsyncData('about-ui-build', () =>
  $fetch<BuildIdentity>('/api/version').catch(() => null))

// TMDB is credited only while jack uses a TMDB key.
const { data: tmdbStatus, refresh: refreshTmdbStatus } = useLazyAsyncData('about-tmdb-status', () =>
  request<{ configured: boolean, ok: boolean }>('catalog/tmdb/status').catch(() => null))

// jack may come back from a restart as another build, and a call that failed
// meanwhile reads as null, so both are asked again.
onJackBack(() => {
  void refreshJackBuild()
  void refreshTmdbStatus()
})

const HEX_REVISION = /^[0-9a-f]{8,}$/i

// A commit hash is shown as git abbreviates it; a tag ("dev") as it is.
function shortRevision(revision: string): string {
  return HEX_REVISION.test(revision) ? revision.slice(0, 7) : revision
}

// "17 Oct", with the year only when it isn't this year.
function shortDate(iso: string | null): string | null {
  const date = iso ? new Date(iso) : null
  if (!date || Number.isNaN(date.getTime()))
    return null
  const thisYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: thisYear ? undefined : 'numeric' })
}

// One build is a prefix of the other when one side reports a short hash.
function sameRevision(a: string, b: string): boolean {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x.startsWith(y) || y.startsWith(x)
}

const mismatch = computed(() => {
  const jack = jackBuild.value?.revision
  const ui = uiBuild.value?.revision
  return Boolean(jack && ui && !sameRevision(jack, ui))
})

function buildText(name: string, build: BuildIdentity | null | undefined, withDate: boolean): string {
  if (!build?.revision)
    return `${name}: unknown build`
  const date = withDate ? shortDate(build.buildDate) : null
  return `${name} build ${shortRevision(build.revision)}${date ? ` (${date})` : ''}`
}

function buildTitle(build: BuildIdentity | null | undefined): string | undefined {
  if (!build?.revision)
    return undefined
  return build.buildDate ? `Commit ${build.revision}, built ${formatDate(build.buildDate)}` : `Commit ${build.revision}`
}

const loading = computed(() => (jackPending.value && jackBuild.value === undefined) || (uiPending.value && uiBuild.value === undefined))
// The UI's date only matters when the two builds differ.
const jackText = computed(() => buildText('jack', jackBuild.value, true))
const uiText = computed(() => buildText('UI', uiBuild.value, mismatch.value))
</script>

<template>
  <UCard variant="subtle" :ui="{ body: 'space-y-4' }">
    <!-- jack's own mark: stated first, in brand color, at full size. -->
    <div class="flex items-center gap-3">
      <UIcon name="i-ph-plugs-connected" class="size-7 shrink-0 text-primary" />
      <div class="min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-2">
          <span class="text-base font-semibold tracking-tight text-highlighted">jack</span>
          <span v-if="loading" class="font-mono text-xs text-dimmed">…</span>
          <span v-else class="font-mono text-xs break-words text-dimmed">
            <span :title="buildTitle(jackBuild)">{{ jackText }}</span>
            · <span :title="buildTitle(uiBuild)">{{ uiText }}</span>
          </span>
        </div>
        <p class="text-xs text-muted">
          Share Radarr and Sonarr libraries with friends
        </p>
      </div>
    </div>

    <UAlert
      v-if="mismatch"
      color="warning"
      variant="soft"
      icon="i-ph-warning"
      title="jack and jack-ui run different builds. Update both containers."
    />

    <!-- TMDB attribution, only while jack uses a TMDB key. Deliberately quieter
         than the jack mark above, per TMDB's terms. -->
    <template v-if="tmdbStatus?.configured">
      <USeparator />
      <div class="flex items-start gap-3">
        <img src="/tmdb.svg" alt="The Movie Database (TMDB)" class="mt-0.5 h-4 w-auto shrink-0">
        <p class="text-xs leading-relaxed text-muted">
          This product uses the TMDB API but is not endorsed or certified by TMDB.
        </p>
      </div>
    </template>

    <USeparator />

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p class="min-w-0 flex-1 text-xs text-muted">
        Copies a summary of your setup and recent errors to send to whoever helps you. Keys,
        header values and webhook URLs are left out.
      </p>
      <SupportInfoButton size="sm" />
    </div>
  </UCard>
</template>
