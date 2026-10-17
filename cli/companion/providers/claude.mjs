import { sandboxCommand } from './sandbox.mjs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
export class ClaudeSession {
  constructor({cwd,env,onEvent,onIdentity}) { const scratch=join(env.HOME,'tmp');mkdirSync(scratch,{recursive:true,mode:0o700});Object.assign(this,{cwd,env:{...env,TMPDIR:scratch,CLAUDE_CODE_TMPDIR:scratch},onEvent,onIdentity}); }
  async open(sessionId) { this.sessionId = sessionId; }
  start(text) {
    this.cancelDelivered = false;
    return new Promise((resolve,reject) => {
      const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit,Write,Grep,Glob,Bash', '--tools', 'Read,Edit,Write,Grep,Glob,Bash', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
      if (this.sessionId) args.push('--resume',this.sessionId);
      const sandbox = sandboxCommand('claude',this.cwd,this.env);
      this.child = spawn(sandbox.command, [...sandbox.args, ...args], { cwd:this.cwd,env:sandbox.env,stdio:['ignore','pipe','pipe'] });
      let buffer='',result;
      this.child.stdout.on('data', chunk => { buffer+=chunk; let end; while ((end=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,end);buffer=buffer.slice(end+1); if(!line.trim()) continue; try { const event=JSON.parse(line);if(event.session_id) {this.sessionId=event.session_id;this.onIdentity({thread_id:this.sessionId,provider:'claude'});}this.onEvent({kind:'progress',payload:event});if(event.type==='result') result=event; } catch(error) {reject(error);} } });
      this.child.once('error',reject);
      this.child.once('exit',(code,signal) => { try { resolve(this.resultOnExit(code,signal,result)); } catch(error) { reject(error); } });
    });
  }
  resultOnExit(code,signal,result) {
    if(signal || this.cancelDelivered) return {status:'interrupted'};
    if(code===0 && result) return {status:result.is_error?'failed':'completed',result};
    throw new Error(`Claude exited ${code} without confirmed result`);
  }
  async control(control) { if(control.kind==='cancel') {if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('Claude has no running process to interrupt.');
      this.cancelDelivered = this.child.kill('SIGINT');
      if (!this.cancelDelivered) throw new Error('Claude interrupt signal was not delivered.');
      return;} throw new Error('Claude API adapter supports interrupt and resumed follow-up after completion; active steering is unavailable.'); }
  async close() { if(this.child?.exitCode===null) this.child.kill('SIGTERM'); }
}
