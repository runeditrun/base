// Exact inert defaults emitted by the pinned public Wrangler/Vite closure.
// Keep them in the expected contract, rather than permitting arbitrary extra
// fields or stripping the emitted configuration before the production validator.
export function nativeBuildConfig(prepared, configPath = '/seed/qualification-wrangler.json') {
  return {
    ...prepared, configPath, userConfigPath: configPath, topLevelName: prepared.name,
    definedEnvironments: [], jsx_factory: 'React.createElement', jsx_fragment: 'React.Fragment',
    workflows: [], exports: {}, kv_namespaces: [], cloudchamber: {}, send_email: [],
    connect: [], vectorize: [], ai_search_namespaces: [], ai_search: [], agent_memory: [],
    hyperdrive: [], services: [], analytics_engine_datasets: [], dispatch_namespaces: [],
    mtls_certificates: [], pipelines: [], secrets_store_secrets: [], artifacts: [],
    unsafe_hello_world: [], flagship: [], worker_loaders: [], ratelimits: [],
    vpc_services: [], vpc_networks: [], logfwdr: { bindings: [] },
    python_modules: { exclude: ['**/*.pyc'] },
    dev: { ip: 'localhost', local_protocol: 'http', upstream_protocol: 'http', enable_containers: true, generate_types: false },
  };
}
