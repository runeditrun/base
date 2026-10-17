// The companion's only network path: outbound HTTPS requests to the management
// service named at pairing. It listens on nothing.
import { isIP } from 'node:net';
// Plain HTTP only to a loopback address literal: a DNS name such as
// 127.attacker.example is not loopback.
function loopback(hostname) {
 const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
 return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}
export function assertServerUrl(raw) {
 let url;
 try { url = new URL(raw); } catch { throw new Error('Server must be an absolute HTTPS URL (or loopback HTTP for local testing).'); }
 if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) throw new Error('Server must use HTTPS. HTTP is allowed only for localhost test servers.');
 if (url.username || url.password || url.hash) throw new Error('Server URL must not include credentials or a fragment.');
 return url.toString().replace(/\/$/, '');
}
export class Api {
  constructor(server,token) {this.server=assertServerUrl(server);this.token=token;}
  // A redirect is refused, never followed: the server URL is checked once, here, and a
  // followed redirect would carry the request body to another origin.
  async post(path,body) {
    const response=await fetch(`${this.server}${path}`,{method:'POST',headers:{'content-type':'application/json',...(this.token?{authorization:`Bearer ${this.token}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error'});
    const result=await response.json();
    if(!response.ok) throw Object.assign(new Error(result.error?.message||result.error||`HTTP ${response.status}`),{status:response.status});
    return Object.hasOwn(result,'data') ? result.data : result;
  }
}
