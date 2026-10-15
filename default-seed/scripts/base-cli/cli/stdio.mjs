let installed = false;

export function handleBrokenPipes() {
 if (installed) return;
 installed = true;
 for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', error => {
   if (error.code === 'EPIPE') return;
   throw error;
  });
 }
}
