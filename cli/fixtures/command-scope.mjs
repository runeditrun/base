import { ChildProcess } from 'node:child_process';

// Mark descendants at launch without marking the top-level CLI as nested.
// In particular, its normal installer log must stay at install.log.
const spawn = ChildProcess.prototype.spawn;
ChildProcess.prototype.spawn = function (options) {
 const token = process.env.RER_TEST_COMMAND_SCOPE;
 if (token) {
  const name = 'RER_ONBOARDING_PROCESS_OWNER=';
  const pairs = options.envPairs ?? [];
  const prior = pairs.find(pair => pair.startsWith(name))?.slice(name.length);
  options = { ...options, envPairs: [...pairs.filter(pair => !pair.startsWith(name)), name + [prior, token].filter(Boolean).join(',')] };
 }
 return spawn.call(this, options);
};
