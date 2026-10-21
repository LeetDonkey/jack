// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  devtools: { enabled: false },
  ssr: false,

  modules: ['@nuxt/ui'],

  css: ['~/assets/css/main.css'],

  // Icons ship with jack-ui. Without SSR, @nuxt/icon would fetch each one from
  // api.iconify.design in the browser, so a blocked or offline host left every
  // icon-only button blank. The scan bundles every icon named in the app's own
  // files (app.config.ts and utils included, which the default scan skips), and
  // app/icons.test.ts checks that each one is in Phosphor. Nothing is fetched at
  // run time: `none` stops the browser's requests and leaves out the 4.5 MB
  // server bundle, and `serverBundle` only tells the client that `ph` is bundled.
  // server/middleware/icon-api.ts closes the module's server route.
  icon: {
    provider: 'none',
    fallbackToApi: false,
    serverBundle: { collections: ['ph'] },
    clientBundle: {
      scan: {
        globInclude: ['app/**/*.{vue,ts}'],
        globExclude: ['**/*.test.ts'],
      },
    },
  },

  // Old pages, kept working for links and bookmarks. Friends have their own page,
  // Radarr/Sonarr live on the first Settings tab, and the former Connectors page
  // became Settings. Old /settings#<section> links are moved to their tab by the
  // Settings page itself (pages/settings.vue), since a hash never reaches the server.
  routeRules: {
    '/peers': { redirect: '/friends' },
    '/servers': { redirect: '/settings#servers' },
    '/connectors': { redirect: '/settings' },
  },

  app: {
    head: {
      title: 'jack',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },

  // Server-only (the UI is a BFF: these must never reach the browser). The values
  // below are only defaults — Nitro overrides each at RUNTIME from the matching
  // `JACK_`-prefixed env var (JACK_MANAGEMENT_API_URL, JACK_MANAGEMENT_KEY,
  // JACK_SESSION_KEY). Runtime override matters because the image is built by CI;
  // the operator supplies these at container-run time, never at build time.
  runtimeConfig: {
    // Swap Nitro's default `NUXT_` runtime-env prefix for `JACK_`. `@nuxt/schema`
    // builds this as `{ envPrefix: 'NUXT_', ...runtimeConfig.nitro }`, so setting it
    // here (inside runtimeConfig.nitro) is what actually wins. (NITRO_ still works.)
    nitro: { envPrefix: 'JACK_' },
    // Where the jack management API listens (its own MANAGEMENT_PORT).
    managementApiUrl: 'http://localhost:5226',
    // When set, the BFF injects this as `X-Management-Key` and the browser is
    // never prompted (inject mode). When empty, the BFF prompts + stores the key
    // in a sealed cookie (cookie mode).
    managementKey: '',
    // Seals the cookie that holds the management key in cookie mode. MUST be set
    // (>= 32 chars) in production; the default is a clearly-insecure dev value.
    // An empty JACK_SESSION_KEY (Unraid passes empty fields as '') replaces it;
    // without a managementKey too, /api/ping says what to set (server/utils/session-key.ts).
    sessionKey: 'dev-insecure-session-key-change-me-please-1234',
  },
})
