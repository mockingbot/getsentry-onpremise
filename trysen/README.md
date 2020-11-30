# Trysen

> A quick hack to filter & rate limit sentry's client issue by ip

For our 4CPU/8G EC2 onpremise setup, the process speed under full load is about 4issue/sec,
  or 240/min, or ~345K/day.
  
But there can be issue spammers sending 4-20issue/sec,
  so the setup is easily overflowed, and the ever growing backlog will not be dropped,
  hogging the memory and slow the whole system down and crash.

So the simple solution is to reduce the source request with rate limit.


## Rate limit rule

The rule is simple:
- for load under 240/min, for each ip max 8/min is allowed
  (so the spamming pattern can still be seen in the report)
- if prev minute's load is above 240/min, the excess issue is dropped,
  and the time to reach 240 (TTR), say 15sec,
  will be used to calc next minute's ip allowance: Math.ceil(8 * (TTR / 60sec)), which is 2
- the min ip allowance is 1/min


## Sentry issue message pattern

For the HTTP request: `POST /api/2/store/?sentry_key=hash_hash_hash_hash&sentry_version=7` (where the `2` before store is the project id, should be number `>=1`)
with payload like:
```
{
  breadcrumbs: (2) [{…}, {…}]
  environment: "production"
  event_id: "12345678901234567890"
  exception: {values: Array(1)}
  extra: {arguments: Array(0)}
  level: "error"
  platform: "javascript"
  request: {url: "http://localhost:12345/TEST.html", headers: {…}}
  sdk: {name: "sentry.javascript.browser", packages: Array(1), version: "5.27.6", integrations: Array(7)}
  timestamp: 1606701192.448
}
```
and got response 200 with: `{"id":"12345678901234567890"}`


## Other patterns

sourcemap upload:
- `POST /api/0/projects/ORG_SLUG/PROJECT_NAME/releases/` with user agent `sentry-cli/1.59.0`
- `GET /api/0/organizations/ORG_SLUG/chunk-upload/` with user agent `sentry-cli/1.59.0`
- `POST /api/0/organizations/ORG_SLUG/chunk-upload/` with user agent `sentry-cli/1.59.0`
- `POST /api/0/organizations/ORG_SLUG/releases/hash_hash_hash_hash/assemble/` with user agent `sentry-cli/1.59.0`
- `PUT /api/0/projects/ORG_SLUG/PROJECT_NAME/releases/hash_hash_hash_hash/` with user agent `sentry-cli/1.59.0`
