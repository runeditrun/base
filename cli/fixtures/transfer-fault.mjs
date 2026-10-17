// Only the transfer worker's process edge is faulted, as a dead worker or a failing native call would.
// The first "Staging the restore" line means one part is staged: `crash` kills the worker there with
// no cleanup, `native` throws an error whose message holds data that must never reach the terminal.
const [fault] = (process.env.RER_TEST_TRANSFER_FAULT ?? '').split(':');
if (fault && process.argv[1]?.endsWith('portability-worker.mjs') && process.argv[2] === 'import') {
 const send = process.send.bind(process);
 process.send = (message, ...rest) => {
  if (/^Staging the restore/.test(message?.progress ?? '')) {
   if (fault === 'crash') process.kill(process.pid, 'SIGKILL');
   throw new RangeError('private row content');
  }
  return send(message, ...rest);
 };
}
