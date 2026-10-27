// Presentation only: the structured error and its captured step stay intact.
export function humanError(error, { retry } = {}) {
 if (error.humanMessage) return error.humanMessage;
 const text = String(error?.message ?? error);
 const download = /https?:\/\/[^\s"'<>]+/.exec(text)?.[0];
 if (download && /ECONNREFUSED/.test(text)) {
  let url; try { url = new URL(download); } catch {}
  const archive = url && /\/([^/]+)-(\d[^/]*)\.tgz/.exec(url.pathname);
  if (url && archive) return `Could not download a dependency (${archive[1]} ${archive[2]}) because the package registry at ${url.host} refused the connection. Check your network or registry setting, then run: ${retry ?? 'rer install'}.`;
 }
 const technical = /(?:^|\n)\s*(?:at |[A-Za-z]*Error:)/.test(text);
 if (technical || ['command_failed', 'launch_failed'].includes(error.code ?? error.event?.code)) {
  const message = text.split('\n')[0].replace(/^[A-Za-z]*Error:\s*/, '').trim();
  return `${message || 'The command failed.'}\nRun ${retry ?? 'the same command'} with --json for details.`;
 }
 return text;
}
