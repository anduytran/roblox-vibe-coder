/**
 * Environment hygiene. Only these variables reach the Claude engine, the commands it runs, MCP
 * servers, check commands and Hangar's own git processes. Everything else in your environment, like
 * cloud or GitHub tokens, stays out.
 */
export const ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'SystemRoot',
  'SYSTEMROOT', 'SystemDrive', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'USER', 'USERNAME', 'LOGNAME',
  'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'
]

export function minimalEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of ENV_ALLOWLIST) {
    const v = source[k]
    if (typeof v === 'string') env[k] = v
  }
  return env
}

/** Names that look like credentials (removed from Hangar's own environment at startup). */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|AUTH|SESSION|COOKIE)|^(ANTHROPIC|CLAUDE|AWS|AZURE|GCP|GOOGLE|GITHUB|GH|GITLAB|NPM|OPENAI|ROBLOX|SSH|GPG|GIT)_/i

/**
 * Remove credential-looking variables from this process's own environment, so that no child process
 * can inherit them even if a library merges `process.env` into the environment it was given.
 * Returns the names removed (for tests).
 */
export function scrubProcessEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = []
  for (const k of Object.keys(env)) {
    if (ENV_ALLOWLIST.includes(k) || k.startsWith('ELECTRON_')) continue
    if (SECRET_NAME.test(k)) {
      delete env[k]
      removed.push(k)
    }
  }
  return removed
}
