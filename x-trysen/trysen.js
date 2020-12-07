// NOTE: start the server with command like `npx @dr-js/core@0.4.1-dev7 -eI trysen.js`

const { resolve } = require('path')
const { readFileSync } = require('fs')
const { once } = require('@dr-js/core/library/common/function')
const { setTimeoutAsync, setWeakInterval } = require('@dr-js/core/library/common/time')
const { createCacheMap } = require('@dr-js/core/library/common/data/CacheMap')

const { quickRunletFromStream } = require('@dr-js/core/library/node/data/Stream')
const { createServerExot, createRequestListener, describeServerOption } = require('@dr-js/core/library/node/server/Server')
const { responderEnd, responderEndWithStatusCode, createResponderLog, createResponderLogEnd } = require('@dr-js/core/library/node/server/Responder/Common')
const { addExitListenerSync, addExitListenerAsync } = require('@dr-js/core/library/node/system/ExitListener')
const { createLoggerExot } = require('@dr-js/core/library/node/module/Logger')
const { requestHttp } = require('@dr-js/core/library/node/net')

const IS_DROP_DSN_REMAP_FAILED = false // TODO: NOTE: if set issue POST don't have a DSN match in the map will be dropped
const SENTRY_DSN_REMAP = { // remap DSN so yo do not need to change the release that often
  '10-sample_hash': [ 20, 'sample_hash_remapped' ],
  '11-another_sample_hash': [ 21, 'another_sample_hash_remapped' ]
}
const toIssueReplaceUrl = ([ projectId, sentryKey ]) => `/api/${projectId}/store/?sentry_key=${sentryKey}`

// use this setting to rate limit and replace 443-nginx
const IS_SET_X_FORWARD = true // to replace nginx
const SERVER_PROTOCOL = 'https:'
const SERVER_LISTEN_HOSTNAME = '0.0.0.0'
const SERVER_LISTEN_PORT = 443
const BUFFER_CERT_PEM = readFileSync(resolve(__dirname, './cert.pem')) // use for both cert and key

// // use this setting to rate limit between 443-nginx and 9000-docker-nginx
// const IS_SET_X_FORWARD = false
// const SERVER_PROTOCOL = 'http:'
// const SERVER_LISTEN_HOSTNAME = '127.0.0.1'
// const SERVER_LISTEN_PORT = 9001
// const BUFFER_CERT_PEM = undefined

const SERVER_PROXY_ORIGIN = 'http://127.0.0.1:9000' // the sentry docker nginx

const PATH_LOG = resolve(__dirname, './log-gitignore/')

const REGEXP_SENTRY_ISSUE_URL = /^\/api\/(\d+)\/store\/\?sentry_key=(\w+)&/ // match POST /api/12345/store/?sentry_key=hash_hash_hash_hash&sentry_version=7

const INTERVAL_BUST_COUNT = 240
const CACHE_SIZE_SUM_MAX = 8 * 1024 // count, of cacheKey
const CACHE_LIMIT_COUNT = 8 // allowed fail during the expire time
const CACHE_EXPIRE_TIME = 60 * 1000 // in msec, 1min, time to wait until limitLeft is reset

const log = (...args) => console.log(new Date().toISOString(), ...args)

const checkIsRateLimit = (rateCacheMap, remoteAddress, cacheLimitCount) => {
  let limitLeft = rateCacheMap.get(remoteAddress)
  if (limitLeft === undefined) limitLeft = cacheLimitCount
  // log('[checkIsRateLimit]', remoteAddress, limitLeft)
  if (limitLeft <= 0) return true
  rateCacheMap.set(remoteAddress, limitLeft - 1, 1, Date.now() + CACHE_EXPIRE_TIME)
  return false
}

const prefixTime = ({ add, ...loggerExot }) => ({
  ...loggerExot,
  add: (...args) => add(new Date().toISOString(), ...args)
})

const main = async () => {
  const loggerExot = prefixTime(createLoggerExot({ pathLogDirectory: PATH_LOG, saveInterval: 5 * 1000 }))
  const serverExot = createServerExot({
    protocol: SERVER_PROTOCOL,
    cert: SERVER_PROTOCOL === 'https:' ? BUFFER_CERT_PEM : undefined,
    key: SERVER_PROTOCOL === 'https:' ? BUFFER_CERT_PEM : undefined,
    hostname: SERVER_LISTEN_HOSTNAME,
    port: SERVER_LISTEN_PORT,
    forceCloseTimeout: 2 * 1000
  })
  const rateCacheMap = createCacheMap({ valueSizeSumMax: CACHE_SIZE_SUM_MAX, eventHub: null })

  let currentCacheLimitCount = CACHE_LIMIT_COUNT
  let countAccepted = 0
  let countDropped = 0
  let timeIntervalStart = Date.now()
  let timeIntervalBust = undefined
  setWeakInterval(() => {
    loggerExot.add(JSON.stringify({ currentCacheLimitCount, countAccepted, countDropped, timeIntervalStart, timeIntervalBust }))
    currentCacheLimitCount = timeIntervalBust
      ? Math.ceil(CACHE_LIMIT_COUNT * ((timeIntervalBust - timeIntervalStart) / CACHE_EXPIRE_TIME))
      : CACHE_LIMIT_COUNT

    countAccepted = 0
    countDropped = 0
    timeIntervalStart = Date.now()
    timeIntervalBust = undefined
  }, CACHE_EXPIRE_TIME)

  const responderProxy = async (store, url, method, remoteAddress) => {
    const proxyUrl = new URL(url, SERVER_PROXY_ORIGIN)
    const headers = !IS_SET_X_FORWARD ? store.request.headers : {
      ...store.request.headers,
      // add `X-Forward-*` like nginx
      'x-real-ip': remoteAddress,
      'x-forwarded-for': remoteAddress,
      'x-forwarded-proto': SERVER_PROTOCOL === 'https:' ? 'https' : 'http'
    }
    const body = store.request // use request stream as body
    const response = await requestHttp(proxyUrl, { method, headers, timeout: 32 * 1000 }, body).promise
    // log(String(proxyUrl), headers, '||', response.statusCode, response.headers)
    store.response.writeHead(response.statusCode, response.headers) // send back status & header
    return quickRunletFromStream(response, store.response) // send back payload
  }

  const responderSilentDrop = async (store, remoteAddress, reason) => {
    loggerExot.add(`  [DROP|${remoteAddress}] ${reason}`)
    reason === 'rate-limit' && await setTimeoutAsync(32 * 1000) // hold this connection to reduce the resend rate
    return responderEndWithStatusCode(store, { statusCode: 200 })
  }

  const responderMain = async (store) => {
    const { request: { method, url, socket: { remoteAddress } } } = store // the url is the "path" part without host, check: https://nodejs.org/api/http.html#http_message_url

    const result = method === 'POST' && REGEXP_SENTRY_ISSUE_URL.exec(url)
    if (result) { // this is a issue POST
      if (countAccepted === INTERVAL_BUST_COUNT) { // bust
        countDropped++
        return responderSilentDrop(store, remoteAddress, 'interval-bust')
      }

      if (checkIsRateLimit(rateCacheMap, remoteAddress, currentCacheLimitCount)) { // rate limit
        countDropped++
        return responderSilentDrop(store, remoteAddress, 'rate-limit')
      }
      countAccepted++
      if (countAccepted === INTERVAL_BUST_COUNT) timeIntervalBust = Date.now()

      // DSN remap
      const [ , projectId, sentryKey ] = result
      const DSNStringRemap = SENTRY_DSN_REMAP[ `${projectId}-${sentryKey}` ]
      if (IS_DROP_DSN_REMAP_FAILED && !DSNStringRemap) return responderSilentDrop(store, remoteAddress, 'dsn-remap-failed')
      if (DSNStringRemap) { // proxy with url change
        const urlList = url.split('&')
        urlList[ 0 ] = toIssueReplaceUrl(DSNStringRemap)
        return responderProxy(store, urlList.join('&'), method, remoteAddress)
      }
    }

    return responderProxy(store, url, method, remoteAddress) // other request, just proxy
  }

  const responderLogEnd = createResponderLogEnd({ loggerExot })
  serverExot.server.on('request', createRequestListener({
    responderList: [ createResponderLog({ loggerExot }), responderMain ],
    responderEnd: (store) => {
      responderEnd(store)
      responderLogEnd(store)
    }
  }))

  const down = once((eventPack) => {
    log(`[SERVER] down... ${JSON.stringify(eventPack)}${eventPack.error ? ` ${eventPack.error.stack || eventPack.error}` : ''}`)
    return serverExot.down().then(() => log('[SERVER] down'))
  }) // trigger all exot down, the worst case those sync ones may still finish
  addExitListenerAsync(down)
  addExitListenerSync(down)
  addExitListenerSync(loggerExot.down)

  await loggerExot.up()
  await serverExot.up()
  log(describeServerOption(serverExot.option, 'TRYSEN'))
}

main().catch((error) => {
  console.error('[main] error:', error)
  process.exit(1)
})
