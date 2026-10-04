import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'

/** Keep real Git fixtures independent of the developer's signing, hooks and repository. */
export function isolateGitEnvironment(root: string): void {
  const templates = path.join(root, 'empty-git-template')
  fs.mkdirSync(templates)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_CONFIG_GLOBAL', os.devNull)
  vi.stubEnv('GIT_TEMPLATE_DIR', templates)
  for (const name of [
    'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE',
    'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
  ]) vi.stubEnv(name, undefined)
}
