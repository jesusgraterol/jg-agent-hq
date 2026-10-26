// Codex resolves capability roots in an execution environment; local threads use this one
export const LOCAL_ENVIRONMENT_ID = 'local';

// bounded inventory read from each operator-supplied root
export const MAX_ROOT_SKILLS = 128;
export const MAX_SKILL_FILE_BYTES = 65_536;

// catalog scope for skills HQ adds from its extra roots, which native discovery doesn't list
export const HOST_SKILL_SCOPE = 'host';
