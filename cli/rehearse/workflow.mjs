// Mirrors platform managed-workflow.ts (bbf6ca98); keep installation projection behavior aligned.
/** RER's delivery entry for a publisher without its own dispatch-only rer-managed.yml: the Base producer shape, one
 * dispatch-only job calling the trusted build, which runs the project's declared setup, build, verify and artifact. */
export function managedWorkflow(trusted        , artifactFile        )             {
 if (!/^[\w.-]+\/[\w.-]+\/\.github\/workflows\/[\w.-]+\.ya?ml@[a-f0-9]{40}$/.test(trusted)
  || !/^[\w.-]+\.json$/.test(artifactFile)) throw Error('Invalid managed workflow configuration')
 return new TextEncoder().encode(`name: Managed release
on:
  workflow_dispatch:
    inputs:
      installation_id:
        required: true
        type: string
      broker_url:
        required: true
        type: string
      environment:
        required: true
        default: preview
        type: choice
        options: [preview, production]
      verification_profile:
        required: true
        default: full
        type: choice
        options: [full]
permissions:
  contents: read
  actions: read
  id-token: write
jobs:
  release:
    uses: ${trusted}
    with:
      installation_id: \${{ inputs.installation_id }}
      broker_url: \${{ inputs.broker_url }}
      environment: \${{ inputs.environment }}
      verification_profile: \${{ inputs.verification_profile }}
      artifact_file: ${artifactFile}
      build_profile: project
`)
}
