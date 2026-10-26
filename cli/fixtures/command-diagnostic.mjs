import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Public classifications only: never copy child messages, URLs or credentials.
export function commandDiagnostic(child) {
 const events=new Set(['error','result','waiting','ready','setup-ready']);
 const codes=new Set(['invalid_invocation','invalid_setup_manifest','missing_input','safety_refusal','command_failed','cancelled']);
 const rows=[];
 for(const line of child.stdoutText.split('\n')) {
  let row;try{row=JSON.parse(line);}catch{continue;}
  if(!row||!events.has(row.event))continue;
  rows.push({event:row.event,...(codes.has(row.code)?{code:row.code}:{}),...(Number.isInteger(row.exitCode)&&row.exitCode>=0&&row.exitCode<=255?{exitCode:row.exitCode}:{})});
 }
 return {exitCode:child.exitCode,signalCode:child.signalCode,events:rows};
}

// Snapshot the CLI's approved errors and already-redacted runtime log before
// teardown or the next command replaces it. Raw streams and ready events can
// contain credentials, so they must never be copied into the artifact.
export async function retainStartupFailure(root, child) {
 const directory = process.env.RER_TEST_EVIDENCE_DIRECTORY;
 if (!directory) return;
 await mkdir(directory, {recursive: true});
 const evidence = await mkdtemp(join(directory, 'startup-ready-'));
 const messages = child.stdoutText.split('\n').flatMap(line => {
  try { const row = JSON.parse(line); return row?.event === 'error' ? [`${row.code}: ${row.message}`] : []; }
  catch { return []; }
 });
 const log = await readFile(join(root, '.seed/installer/install.log'), 'utf8').catch(() => '');
 await writeFile(join(evidence, 'failure.log'), [
  ...messages, `CLI exit: ${child.exitCode}; signal: ${child.signalCode}`, log,
 ].join('\n'), {mode: 0o600});
}
