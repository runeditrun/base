// T-057/default-seed owns the real deploy and health implementations. Replace
// this blocked descriptor with reviewed argv arrays when that target exists.
// The executor invokes deploy, then health, without a shell; neither may report
// success without doing its real operation. No user-provided command or URL.
export const stage = Object.freeze({
  cwd: 'default-seed',
  blocked: 'stage-target-unconfigured',
  deploy: null,
  health: null,
});
