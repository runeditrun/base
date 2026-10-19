// DIAGNOSTIC ONLY (gr-base-268 draft PR, never merged): explains a slow owned
// runtime stop by dumping the process tree, each node process's post-SIGTERM
// handles, and every process holding the harness's output pipe.
import { mkdtempSync, readFileSync, readdirSync, readlinkSync, appendFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const traceDir = mkdtempSync(join(tmpdir(), 'stop-trace-'))
export const traceEnv = { STOP_TRACE_DIR: traceDir, NODE_OPTIONS: `--require ${fileURLToPath(new URL('./stop-trace-hook.cjs', import.meta.url))}` }
const harness = join(traceDir, 'harness.log')
export const trace = (m) => appendFileSync(harness, `${new Date().toISOString()} ${m}\n`)

function rows() {
  return execFileSync('ps', ['-eo', 'pid=,ppid=,pgid=,stat=,etime=,args=']).toString().split('\n').filter(Boolean).map((line) => {
    const [pid, ppid, pgid, stat, etime, ...rest] = line.trim().split(/\s+/)
    return { pid: +pid, ppid: +ppid, pgid: +pgid, stat, etime, command: rest.join(' ').slice(0, 160) }
  })
}
export function tree(rootPid, known) {
  const all = rows()
  let grew = true
  while (grew) { grew = false; for (const row of all) if (!known.has(row.pid) && (known.has(row.ppid) || row.pgid === rootPid)) { known.add(row.pid); grew = true } }
  return all.filter((row) => known.has(row.pid)).map((row) => `  ${row.pid} ppid=${row.ppid} pgid=${row.pgid} ${row.stat} ${row.etime} ${row.command}`).join('\n')
}
// Linux only: who still holds the read side's peer (our child's stdout/stderr).
export function pipeHolders(child) {
  if (process.platform !== 'linux') return '  (pipe holders: linux only)'
  const inodes = new Set()
  for (const stream of [child.stdout, child.stderr]) {
    const fd = stream?._handle?.fd
    if (fd >= 0) try { inodes.add(readlinkSync(`/proc/self/fd/${fd}`)) } catch {}
  }
  const out = [`  pipes ${[...inodes].join(' ')}`]
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    if (+pid === process.pid) continue
    let fds = []
    try { fds = readdirSync(`/proc/${pid}/fd`) } catch { continue }
    const held = fds.filter((fd) => { try { return inodes.has(readlinkSync(`/proc/${pid}/fd/${fd}`)) } catch { return false } })
    if (!held.length) continue
    let stat = '', cmd = ''
    try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ').slice(0, 4).join(' ') } catch {}
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').slice(0, 200) } catch {}
    out.push(`  holder pid=${pid} fds=${held.join(',')} state/ppid/pgrp=${stat} ${cmd}`)
  }
  return out.join('\n')
}
export function dump(reason) {
  const recent = Date.now() - 60_000
  const parts = [`===== STOP TRACE (${reason}) =====`, readFileSync(harness, 'utf8').split('\n').slice(-400).join('\n')]
  for (const name of readdirSync(traceDir).filter((file) => file.startsWith('node-'))) {
    const file = join(traceDir, name)
    if (statSync(file).mtimeMs < recent) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    parts.push(`--- ${name}`, ...lines.slice(0, 1), ...lines.filter((line) => !line.includes(' start ')).slice(-12))
  }
  process.stderr.write(parts.join('\n').split('\n').map((line) => line.slice(0, 1500)).join('\n') + '\n===== END STOP TRACE =====\n')
}
