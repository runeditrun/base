/** Identity bindings supplied by RER hosted delivery or the released self-host deploy kit. */
export interface DeploymentBindings {
  RER_RELEASE_DIGEST?: string
  RER_VERSION_METADATA?: { id: string }
  RER_DEPLOY_SOURCE?: string
  RER_DEPLOY_FINGERPRINT?: string
  RER_VERSION?: { id: string }
}

const identity = (value: unknown, format: RegExp): string | null =>
  typeof value === 'string' && format.exec(value)?.[0] === value ? value : null
const sourceSha = /^[a-f0-9]{40}$/
const fingerprint = /^[a-f0-9]{64}$/
const versionId = /^(?!00000000-0000-0000-0000-000000000000)[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
function version(metadata: unknown): string | null {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? identity((metadata as { id?: unknown }).id, versionId) : null
}

/** Missing or malformed fields are null. Never combine identities from different producers. */
export function deploymentHealth(env: DeploymentBindings) {
  // Either hosted binding selects hosted identity, even when malformed. The
  // release digest hashes the release identity; it is not a source commit SHA.
  const hosted = env.RER_RELEASE_DIGEST !== undefined || env.RER_VERSION_METADATA !== undefined
  return {
    ok: true as const,
    deployment: {
      sourceSha: hosted ? null : identity(env.RER_DEPLOY_SOURCE, sourceSha),
      fingerprint: identity(hosted ? env.RER_RELEASE_DIGEST : env.RER_DEPLOY_FINGERPRINT, fingerprint),
      versionId: version(hosted ? env.RER_VERSION_METADATA : env.RER_VERSION),
    },
  }
}
