import { runT016 } from './run.mjs';
const result = await runT016('t016-upgrade-rollback');
console.log(JSON.stringify(result));
if (result.result !== 'passed') process.exitCode = 1;
