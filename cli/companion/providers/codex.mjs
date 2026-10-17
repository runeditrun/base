import { sandboxCommand } from './sandbox.mjs';
import { JsonlRpc } from './jsonl-rpc.mjs';
export class CodexSession {
  constructor({ cwd, env, onEvent, onIdentity }) {
    this.cwd = cwd; this.onEvent = onEvent; this.onIdentity = onIdentity;
    const sandbox = sandboxCommand('codex', cwd, env);
    this.rpc = new JsonlRpc(sandbox.command, [...sandbox.args, 'app-server', '-c', 'features.apps=false'], { cwd, env:sandbox.env });
    this.requests = new Map();
    this.rpc.onNotification(message => this.handleNotification(message));
    this.rpc.child.once('exit', () => this.reject?.(new Error('Codex disconnected; reconcile the saved session before resuming.')));
  }
  handleNotification(message) {
      if (message.id !== undefined) this.requests.set(String(message.id), message);
      if (message.method === 'turn/completed' && message.params?.threadId === this.thread && (!this.turn || message.params?.turn?.id === this.turn)) { this.turn = null; this.resolve?.(message.params.turn); }
      this.onEvent({ kind: message.id !== undefined ? ((message.method.includes('requestUserInput') || message.method==='item/tool/call') ? 'question' : 'approval') : 'progress', payload: message });
  }
  async open(threadId) {
    await this.rpc.request('initialize', { clientInfo: { name: 'rer-local', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    this.rpc.notify('initialized', {});
    const params = { cwd: this.cwd, approvalPolicy: 'on-request', sandbox: 'danger-full-access' };
    if(!threadId)params.dynamicTools=[{type:'function',name:'rer_question',description:'Ask the installation owner a question and wait for their response before proceeding.',inputSchema:{type:'object',properties:{question:{type:'string'}},required:['question'],additionalProperties:false}}];
    const response = await this.rpc.request(threadId ? 'thread/resume' : 'thread/start', { ...params, ...(threadId ? { threadId } : {}) });
    this.thread = response.thread.id;
    await this.onIdentity({ thread_id: this.thread, provider: 'codex' });
  }
  async start(text) {
    const done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    const response = await this.rpc.request('turn/start', { threadId: this.thread, input: [{ type: 'text', text }], cwd: this.cwd, approvalPolicy: 'on-request', sandboxPolicy: { type: 'externalSandbox', networkAccess: 'enabled' } });
    this.turn = response.turn.id;
    if(this.cancelRequested)await this.rpc.request('turn/interrupt',{threadId:this.thread,turnId:this.turn});
    const result = await done;
    return result;
  }
  async control(control) {
    if (control.kind === 'message') return this.rpc.request('turn/steer', { threadId: this.thread, expectedTurnId: this.turn, input: [{ type: 'text', text: control.payload.text }] });
    if (control.kind === 'cancel') { this.cancelRequested=true; if(!this.turn)return; return this.rpc.request('turn/interrupt', { threadId: this.thread, turnId: this.turn }); }
    if (control.kind === 'respond') {
      const request = this.requests.get(String(control.payload.request_id));
      const id = request?.id ?? request;
      if (id === undefined) throw new Error('Unknown or already answered provider request.');
      // Escalation changes the filesystem boundary, so it requires action at the local terminal.
      let original = control.payload.response;
      if(typeof original==='string') {
        if(request.method==='item/tool/call') original={contentItems:[{type:'inputText',text:original}],success:true};
        else if(request.method==='item/tool/requestUserInput' && request.params?.questions?.length===1) original={answers:{[request.params.questions[0].id]:{answers:[original]}}};
        else if(['decline','cancel'].includes(original)) original={decision:original};
        else throw new Error('A structured provider response is required.');
      }
      if (original?.decision && !['decline', 'cancel'].includes(original.decision)) throw new Error('Command/file escalation must be approved locally, outside the remote relay.');
      this.rpc.send({ id, result: original }); this.requests.delete(String(id)); return;
    }
    throw new Error(`Unsupported active control ${control.kind}`);
  }
  close() { return this.rpc.close(); }
}
