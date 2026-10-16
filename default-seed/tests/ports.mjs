import { createServer } from 'node:net'

// A port the OS hands out and the test releases can be taken before the runtime
// binds it: by a parallel test file, or by any process's outgoing connection in
// the ephemeral range. So a port is never handed out twice in this process, and
// a start that still loses the race is retried on a fresh port.
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

export const addressInUse = (error) => [error, error?.cause].some((value) =>
  value?.code === 'ERR_ADDRESS_IN_USE' || value?.code === 'EADDRINUSE' || /ERR_ADDRESS_IN_USE|EADDRINUSE|address already in use/i.test(value?.message ?? ''))

// Runs start(port) on a free port; if the port was taken before the runtime bound
// it, runs it again on a fresh one. Any other failure surfaces at once.
export async function startOnFreePort(start, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try { return await start(await freePort()) } catch (error) { if (!addressInUse(error) || attempt >= attempts) throw error }
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
