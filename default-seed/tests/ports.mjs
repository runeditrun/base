import { createServer } from 'node:net'

// Only the documented rer setup/dev journey still needs an explicit port:
// its public startup contract does not accept zero. This availability snapshot
// is not a reservation. Standalone runtimes must bind zero themselves instead;
// see worker-listener.mjs. Remove this with the ephemeral CLI contract change.
const handedOut = new Set()
export async function freePort() {
  for (;;) {
    const server = createServer()
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    if (!handedOut.has(port)) { handedOut.add(port); return port }
  }
}

// Starts runtimes side by side. When one start fails, the ones that did start
// are closed and the failure is thrown, so a bad start is a plain test failure
// and never leaves a runtime holding the test process open.
export async function startTogether(starts, close = (started) => started.close()) {
  const settled = await Promise.allSettled(starts.map((start) => start()))
  const failed = settled.find((result) => result.status === 'rejected')
  if (!failed) return settled.map((result) => result.value)
  await Promise.allSettled(settled.filter((result) => result.status === 'fulfilled').map((result) => close(result.value)))
  throw failed.reason
}
