// Views run after redaction. The command store still writes every original
// redacted byte to install.log; only the person's progress is shortened here.
export function isWranglerQuery(command, args = []) {
 const words = [command, ...args].map(String);
 const tool = words.findIndex(word => /(^|[\\/])wrangler(\.js)?$/.test(word));
 return tool >= 0 && words.slice(tool + 1).some((word, index, rest) => word === 'd1' && rest[index + 1] === 'execute');
}

export function wranglerQueryView({ log }) {
 let tail = '';
 return {
  write(text) { tail = (tail + text).slice(-32768); return ''; },
  end({ code, signal, error } = {}) {
   // A failed SQL command must keep its actual diagnostic, including its exit
   // status in the command store. Successful query JSON is never user output.
   return code !== 0 || signal || error ? tail : `Database update complete. Full output: ${log}\n`;
  },
 };
}

// Vite emits multiline source-import advisories during setup. Keep both their
// source frames and suppression instructions in the capture, without hiding
// unrelated warnings or errors. A partial/unrecognized block stays visible.
export function viteDiagnosticsView(inner) {
 let pending = '', block = '', kind;
 const emit = text => inner ? inner.write(text) : text;
 const line = text => {
  if (!kind && /\[vite\].*warning:/.test(text)) kind = 'import';
  if (!kind && /Your Vite config uses features that are unsupported by/.test(text)) kind = 'config';
  if (!kind) return emit(text);
  block += text;
  const complete = kind === 'import' ? /^\s*File:/.test(text) : /VITE_CONFIG_NATIVE_IGNORE_WARNING.*suppress this warning/.test(text);
  if (!complete && block.length < 32768) return '';
  const advisory = kind === 'config' || /The above dynamic import cannot be analyzed by Vite/.test(block);
  const result = advisory && complete ? '' : emit(block);
  block = ''; kind = undefined;
  return result;
 };
 return {
  write(text) {
   const lines = (pending + text).split('\n'); pending = lines.pop();
   return lines.map(item => line(item + '\n')).join('');
  },
  end(result) {
   const rest = (pending ? line(pending) : '') + (block ? emit(block) : '');
   pending = ''; block = ''; kind = undefined;
   return rest + (inner?.end(result) ?? '');
  },
  facts: () => inner?.facts?.() ?? {},
 };
}
