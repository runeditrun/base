import { stripVTControlCharacters } from 'node:util'

// The real CLI advertises its listening URL. Wait for that output event, then
// the caller proves HTTP health; no guessed number of early connection polls.
export function viteListening(child, { signal } = {}) {
  return new Promise((resolve, reject) => {
    let output = ''
    const finish = (error, origin) => {
      for (const stream of [child.stdout, child.stderr]) stream.off('data', data)
      child.off('error', failed); child.off('exit', exited)
      signal?.removeEventListener('abort', aborted)
      error ? reject(error) : resolve(origin)
    }
    const data = (chunk) => {
      output += stripVTControlCharacters(String(chunk))
      const origin = output.match(/Local:\s+(http:\/\/127\.0\.0\.1:[1-9]\d*)\//)?.[1]
      if (origin) finish(undefined, origin)
    }
    const failed = error => finish(error)
    const exited = () => finish(Error('Vite exited before advertising its listener'))
    const aborted = () => finish(signal.reason)
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data)
    child.once('error', failed); child.once('exit', exited)
    if (signal?.aborted) aborted()
    else signal?.addEventListener('abort', aborted, { once: true })
  })
}
