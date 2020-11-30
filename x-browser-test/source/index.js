import * as Sentry from "@sentry/browser"

Sentry.init({
  dsn: window.TEST_SENTRY_DSN, // injected in TEST.html
  tracesSampleRate: 1.0
})

setTimeout(() => {
  console.log('test_bug')
  console.log(window.something.not.exist)
}, 1000)

console.log('test_bug inited')
