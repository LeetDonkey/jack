// @nuxt/icon always registers /api/_nuxt_icon/:collection, a cached handler.
// jack-ui doesn't use it (`icon.provider: 'none'` in nuxt.config.ts), yet it
// answered anyone who could reach jack-ui, and Nitro's in-memory cache keeps an
// entry for every distinct query, a 404 included. Enough different queries
// would fill jack-ui's memory, so the route ends here, before the cache.
// `event.path` is already decoded, as the router matches it.
export default defineEventHandler((event) => {
  if (event.path.startsWith('/api/_nuxt_icon/'))
    throw createError({ statusCode: 404, statusMessage: 'Not Found' })
})
