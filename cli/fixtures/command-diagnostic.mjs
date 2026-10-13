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
