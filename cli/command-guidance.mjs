// Shared terminal and browser guidance for an installation outside PATH.
import { terminalHelp as commandNotFoundHelp } from '../modules/operator-auth/terminal-guidance.mjs';
export { commandNotFoundHelp };

export function withCommandHelp(text) {
 const value = String(text);
 return /(?:~\/\.local\/bin\/)?rer (?:[a-z][a-z-]*|--help)\b/.test(value) && !value.includes(commandNotFoundHelp)
  ? `${value}\n${commandNotFoundHelp}` : value;
}
