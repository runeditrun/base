// Mirrors platform repository-automation.ts (bbf6ca98); keep installation projection behavior aligned.
export const MANAGED_WORKFLOW = '.github/workflows/rer-managed.yml'

/** Repository automation belongs to the publisher, not to each installed app. Application runtime
 * schedules (Wrangler, deployment specs and scheduled handlers) are application source and stay intact. */
export function repositoryAutomation(path        )          {
 return path === '.github' || path === '.github/workflows' || path.startsWith('.github/workflows/')
  || /^(?:\.github\/)?(?:dependabot\.ya?ml|\.?renovate(?:rc)?(?:\.json5?)?)$/.test(path)
  || /^(?:\.circleci|\.buildkite|\.teamcity|\.gitlab)(?:\/|$)/.test(path)
  || /^(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|\.travis\.yml|\.drone\.ya?ml|\.woodpecker\.ya?ml|Jenkinsfile)$/.test(path)
}

/** A publisher's own delivery entry is kept verbatim, as installs did before automation was stripped, when GitHub
 * can start it only by an explicit dispatch: its sole `on` event is workflow_dispatch. Anything else (push,
 * pull_request, schedule, a flow mapping RER does not read) is replaced by RER's generated entry. */
export function dispatchOnlyWorkflow(bytes            )          {
 const lines = new TextDecoder().decode(bytes).split(/\r?\n/)
 const top = lines.flatMap((line, index) => /^[^\s#]/.test(line) ? [{line, index}] : [])
 const on = top.filter(({line}) => /^(?:on|'on'|"on")\s*:/.test(line))
 if (on.length !== 1) return false
 const inline = on[0].line.replace(/^[^:]+:/, '').replace(/\s#.*$/, '').trim()
 if (inline) return /^(?:workflow_dispatch|\[\s*workflow_dispatch\s*\])$/.test(inline)
 const end = top.find(({index}) => index > on[0].index)?.index ?? lines.length
 const body = lines.slice(on[0].index + 1, end).filter(line => line.trim() && !/^\s*#/.test(line))
 const depth = (line        ) => line.length - line.trimStart().length
 const indent = Math.min(...body.map(depth))
 const events = body.filter(line => depth(line) === indent).map(line => line.trim().replace(/\s*:.*$/, ''))
 return events.length === 1 && events[0] === 'workflow_dispatch'
}
