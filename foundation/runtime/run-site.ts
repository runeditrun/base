import { iconHead } from './icon-head'
// The run site's shared pages: the Run page (Direction A: centred headline, one
// command card, the facts under it), a small composed homepage for
// seeds without an approved one (Base's references), and the not-found page.
// /contract is in contract-page.ts, built from the same document and header.
// They are static HTML strings for `rer build --site`; the seed's site entry
// renders them with its own RunData and edition identity, and a seed with an
// approved homepage renders that page instead of siteHomeHtml.
// Visual authority: the 12ui Run page picks.
// This file is copied unchanged to src/base by both maintained exporters.
import { checkIdentity, type EditionIdentity } from './identity'
import { ink } from './theme-frame'
import type { SeedContract } from './seed-contract.mjs'

/** Every Run page string and command for one seed. */
export interface RunData {
  /** The seed's name: "Cradle". */
  name: string
  /** The public source repository: "https://github.com/just-every/cradle". */
  repository: string
  /**
   * The start line for someone who already has Node 22 or later:
   * "npx -y @runeditrun/rer dev just-every/cradle". The Run page's one line is
   * the same `dev just-every/cradle` handed to the installer (startLine).
   */
  clone: string
  /** The folder the start line clones into, where `rer dev` restarts it: "cradle". */
  folder: string
  /** "MIT". */
  licence: string
  /** Whether the run site carries /docs. */
  docs: boolean
  /** Hosted options, shown as cards under the steps. Empty until hosting opens. */
  hosted: HostedOption[]
}
export interface HostedOption { title: string; body: string; href: string; action: string }

const npxStart = 'npx -y @runeditrun/rer '
const repoStart = `${npxStart}dev `
// GitHub repository ids: an alphanumeric owner (hyphens inside) and a
// repository name made of letters, digits, dots, underscores and hyphens.
const repositoryId = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/
// Escape independently of validation; repository ids need no escaping in POSIX shells.
const shellArgument = (value: string) => /^[A-Za-z0-9_./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`
/**
 * The one line on every Run page, homepage snippet and getting-started page: the
 * installer (which brings its own Node when there is none) installs rer, then
 * runs `rer dev <owner>/<repo>` in the same line.
 */
export const startLine = (run: RunData) => {
  checkRunData(run)
  return `curl -fsSL https://runeditrun.com/install.sh | sh -s -- dev ${shellArgument(run.clone.slice(repoStart.length))}`
}
/** The one requirements sentence: rer clones with git; the installer brings Node and rer the pinned pnpm. */
export const runRequirements = 'git is required; rer brings Node and pnpm.'

export const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!))

export function checkRunData(run: RunData): RunData {
  for (const key of ['name', 'clone', 'folder', 'licence'] as const) if (typeof run[key] !== 'string' || !run[key].trim()) throw new Error(`Run data needs ${key}.`)
  if (!run.clone.startsWith(repoStart) || !repositoryId.test(run.clone.slice(repoStart.length))) throw new Error(`Run data clone must be ${repoStart}<owner>/<repo> with a valid repository id.`)
  if (!/^https:\/\/[^\s"<>]+$/.test(run.repository)) throw new Error('Run data repository is an https URL.')
  if (!/^[A-Za-z0-9._/-]+$/.test(run.folder) || run.folder.split('/').some(part => !part || part === '..')) throw new Error('Run data folder is a relative folder.')
  if (typeof run.docs !== 'boolean' || !Array.isArray(run.hosted)) throw new Error('Run data declares docs and hosted.')
  for (const option of run.hosted) if (!option?.title || !option.body || !option.action || !/^https:\/\//.test(option.href)) throw new Error('A hosted option has a title, body, action and https link.')
  return run
}

// Shared by the pages: tokens from the seed's rer-theme.css, readable neutrals
// when it cannot load, the one header (at the page gutter on every page, with
// the seed's wordmark weight) and the floor art.
const BASE = '*,*::before,*::after{box-sizing:border-box}html{-webkit-text-size-adjust:100%}'
  + 'body{--art:max(26vh,150px);--site-ink:var(--rer-text,#172033);--site-body:var(--rer-muted,#475569);--site-accent:var(--rer-accent,var(--rer-brand-accent,var(--rer-text,#172033)));--site-accent-ink:var(--rer-accent-text,var(--rer-brand-accent-text,var(--rer-surface,#fff)));'
  + '--site-line:color-mix(in srgb,var(--rer-border,#64748b) 28%,transparent);--site-mono:var(--rer-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);'
  + 'margin:0;min-height:100vh;min-height:100dvh;position:relative;overflow-x:clip;background:var(--rer-page,#f3f5f8);color:var(--site-ink);font:400 17px/1.55 var(--rer-font-body,system-ui,sans-serif);-webkit-font-smoothing:antialiased}'
  + 'h1,h2,p,ol{margin:0;padding:0}ol{list-style:none}a{color:inherit;text-decoration:none}'
  + 'a:focus-visible,button:focus-visible{outline:3px solid var(--rer-focus,var(--site-ink));outline-offset:3px;border-radius:8px}'
  + '.art{position:absolute;left:0;right:0;bottom:0;height:var(--art);pointer-events:none;z-index:0}.art img{width:100%;height:100%;display:block;object-fit:cover;object-position:center bottom}'
  + '.bar,main{position:relative;z-index:1}.bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 16px;max-width:1440px;margin:0 auto;padding:26px 56px 0}'
  + '.brand{display:inline-flex;align-items:center;gap:12px;font:600 28px/1 var(--rer-font-heading,var(--rer-font-body,inherit));font-weight:var(--rer-wordmark-weight,600);letter-spacing:var(--rer-wordmark-tracking,-.02em);color:var(--site-ink)}.brand img{width:40px;height:40px}'
  // The brand takes only its narrowest width when deciding whether the nav still fits beside it, so a long name wraps the nav onto its own row instead of pushing it past the viewport.
  + '.bar .brand{flex:1 1 0;max-width:max-content}.bar nav{display:flex;flex-wrap:wrap;gap:36px;font-weight:500;font-size:16px}'
  + '.bar nav a:hover,.bar nav a[aria-current=page]{text-decoration:underline;text-underline-offset:4px}.bar nav a[aria-current=page]{text-decoration-color:var(--site-accent);text-decoration-thickness:2px}'
  + 'h1{font:600 64px/1.08 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:-.03em;color:var(--site-ink);text-wrap:balance}'
  + '.sub{margin-top:24px;color:var(--site-body);font-size:21px;text-wrap:pretty}'
  + '@media(max-width:760px){body{font-size:16px;--art:180px}.bar{padding:18px 16px 0}.brand{font-size:23px;gap:9px}.brand img{width:32px;height:32px}.bar nav{gap:22px;font-size:15px}.bar nav a{min-height:24px}h1{font-size:38px;line-height:1.12}.sub{font-size:16.5px;margin-top:16px}}'

const HOME = 'main{max-width:1360px;margin:0 auto;padding:0 56px calc(var(--art) + 40px);text-align:center}.hero{padding-top:18vh;display:flex;flex-direction:column;align-items:center}.hero h1{max-width:20ch}.hero .sub{max-width:640px}'
  + '.actions{margin-top:40px;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:16px 28px}'
  + '.btn{display:inline-flex;align-items:center;justify-content:center;gap:14px;min-height:58px;padding:0 32px;border-radius:var(--rer-button-radius,999px);'
  + 'background:linear-gradient(180deg,color-mix(in srgb,var(--site-accent) 90%,white),var(--site-accent));color:var(--site-accent-ink);font-size:19px;font-weight:600;'
  + 'box-shadow:0 1px 0 rgba(255,255,255,.5) inset,0 14px 28px -16px color-mix(in srgb,var(--site-ink) 70%,transparent)}.btn svg{width:19px;height:19px}'
  + '.link{font-weight:500;text-decoration:underline;text-underline-offset:4px}'
  + '@media(max-width:760px){main{padding:0 16px calc(var(--art) + 40px)}.hero{padding-top:96px}.btn{min-height:56px;font-size:18px}}'

// Keep overflow visible so a layout defect cannot be clipped away; the header's
// bar and nav reflow in BASE when a seed's wordmark and links need more room.
const RUN = 'body{--art:max(20vh,150px);overflow-x:visible}main{max-width:1360px;margin:0 auto;padding:0 56px calc(var(--art) + 40px)}.intro{text-align:center;padding-top:36px}.intro h1{font-size:58px}.intro .sub{margin-inline:auto;max-width:760px;margin-top:20px}'
  + '.steps{max-width:990px;margin:34px auto 0;display:grid;gap:18px}'
  + '.step{position:relative;display:block;min-width:0;padding:24px 30px 24px 28px;border-radius:24px;background:color-mix(in srgb,var(--rer-surface,#fff) 86%,transparent);border:1px solid var(--site-line);box-shadow:0 24px 48px -36px color-mix(in srgb,var(--site-ink) 45%,transparent);backdrop-filter:blur(6px)}'
  + '.body{min-width:0}'
  + '.step h2{margin-top:0;font:600 26px/1.25 var(--rer-font-heading,var(--rer-font-body,inherit));letter-spacing:-.02em;color:var(--site-ink)}'
  + '.body>p{color:var(--site-body);font-size:18px;margin-top:6px}.body>p.alt{margin-top:14px;font-size:16px}.body>p.note{margin-top:14px;font-size:17px}.body>p.go{margin-top:14px}.go a{font-weight:600;text-decoration:underline;text-underline-offset:4px}'
  + 'code{font-family:var(--site-mono);font-size:.92em;color:var(--site-ink)}.code-word{white-space:nowrap}.alt code{margin-left:.2em;max-width:100%;overflow-x:auto}.note code{margin-right:.1em}'
  + '.code{position:relative;container-type:inline-size;margin-top:16px;border-radius:12px;background:var(--rer-code-background,var(--site-ink));color:var(--rer-code-text,var(--rer-page,#f3f5f8))}'
  + '.code pre{margin:0;padding:18px 108px 18px 22px;font:500 16px/1.75 var(--site-mono);white-space:pre-wrap;overflow-wrap:anywhere}.code pre code{color:inherit;font-size:inherit}'
  + '.copy{position:absolute;top:50%;right:14px;transform:translateY(-50%);display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:0 14px;border:1px solid color-mix(in srgb,currentColor 35%,transparent);border-radius:999px;background:transparent;color:inherit;font:500 14px/1 var(--rer-font-body,inherit);cursor:pointer}'
  + '.copy:focus-visible{outline-color:var(--rer-code-text,var(--rer-page,#f3f5f8))}.copy:hover{background:color-mix(in srgb,currentColor 12%,transparent)}.copy svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.4}'
  + '.facts{margin-top:32px;color:var(--site-body);font-size:14px;display:grid;gap:6px;text-align:center}.facts a{text-decoration:underline;text-underline-offset:3px}'
  + '@media(max-width:760px){body{--art:180px}main{padding:0 16px calc(var(--art) + 40px)}.intro{padding-top:34px}.intro h1{font-size:38px}.steps{margin-top:28px}'
  + '.step{padding:20px 18px;border-radius:18px}'
  + '.step h2{margin:3px 0 0;min-height:30px;font-size:20px}.body>p,.body>p.note{font-size:15.5px}.body>p.alt{font-size:14.5px}'
  + '.code{margin-top:12px}.facts{font-size:13px;margin-top:28px}}'
  // The command keeps its own room: beside the Copy button while the block is wide enough for both, and under it
  // (button on a row of its own above the text) as soon as it is not, whatever the page width or command length.
  + '@container (max-width:700px){.code pre{padding:52px 20px 18px;font-size:15px;line-height:1.7}.copy{top:10px;right:10px;transform:none;min-height:32px;padding:0 12px;font-size:13px}}'
  + '@container (max-width:480px){.code pre{padding:46px 14px 14px;font-size:13px}.copy{top:8px;right:8px}}'

const COPY_SCRIPT = "document.addEventListener('click',async event=>{const button=event.target.closest('.copy');if(!button)return;try{await navigator.clipboard.writeText(button.dataset.copy);const label=button.querySelector('span');label.textContent='Copied';setTimeout(()=>{label.textContent='Copy'},1600)}catch{}})"
const ARROW = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>'

/**
 * A seed's approved homepage header, so every page of its run site wears the one header: `html` as the homepage
 * renders it (marking the current page as that header does) and `styles`, the stylesheets that style it (the
 * `styles` sitePages receives). Without one, the pages carry Base's header, the one Base's own homepage carries.
 */
export interface HomepageHeader { html: string; styles: string[] }

export function document(identity: EditionIdentity, title: string, description: string, style: string, body: string, script = '', styles: string[] = [], head = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${escape(title)}</title><meta name="description" content="${escape(description)}">`
    + `${iconHead}${identity.fonts ? `<link rel="stylesheet" href="${escape(identity.fonts)}">` : ''}<link rel="stylesheet" href="${escape(identity.theme)}"><style>${identity.accentColor ? `:root{--rer-brand-accent:${identity.accentColor};--rer-brand-accent-text:${ink(identity.accentColor)}}` : ''}${BASE}${style}</style>`
    + `${styles.map(href => `<link rel="stylesheet" href="${escape(href)}">`).join('')}</head>`
