// Scratch instrumentation (never committed): logs what each node process in the
// owned runtime still holds after SIGTERM, without changing signal semantics.
const fs = require('fs')
const dir = process.env.STOP_TRACE_DIR
if (dir) {
  const file = `${dir}/node-${process.pid}.log`
  const log = (m) => { try { fs.appendFileSync(file, `${new Date().toISOString()} pid=${process.pid} ${m}\n`) } catch {} }
  log(`start ppid=${process.ppid} pgid? argv=${process.argv.slice(1).join(' ').slice(0, 240)}`)
  const describe = (h) => {
    const n = h?.constructor?.name
    try {
      if (n === 'Socket' || n === 'TLSSocket') return `${n}(${h.localPort ?? ''}->${h.remoteAddress ?? ''}:${h.remotePort ?? ''} fd=${h._handle?.fd ?? '?'} pipe=${!!h._handle && h._handle.constructor?.name})`
      if (n === 'ChildProcess') return `Child(${h.pid} ${String(h.spawnargs?.slice(0, 4).join(' ')).slice(0, 120)} exit=${h.exitCode} sig=${h.signalCode})`
      if (n === 'Server') return `Server(${JSON.stringify(h.address())})`
      if (n === 'Timeout') return `Timeout(${h._idleTimeout} ${h._onTimeout?.name || ''} ${String(h._onTimeout).slice(0, 80).replace(/\s+/g, ' ')})`
    } catch {}
    return n
  }
  let t0, iv
  const snap = (tag) => log(`${tag} +${Math.round(performance.now() - t0)}ms resources=${JSON.stringify(process.getActiveResourcesInfo())} handles=[${process._getActiveHandles().map(describe).join(' | ')}] requests=${process._getActiveRequests().length}`)
  const onTerm = () => {
    if (t0 !== undefined) return
    t0 = performance.now()
    const others = process.listenerCount('SIGTERM') - 1
    log(`SIGTERM received; other listeners=${others}`)
    snap('at-term')
    iv = setInterval(() => snap('after-term'), 250); iv.unref()
    if (others === 0) { process.removeListener('SIGTERM', onTerm); process.kill(process.pid, 'SIGTERM') }
  }
  process.on('SIGTERM', onTerm)
  process.on('exit', (code) => log(`exit code=${code} sinceTerm=${t0 === undefined ? '-' : Math.round(performance.now() - t0)}ms`))
}
