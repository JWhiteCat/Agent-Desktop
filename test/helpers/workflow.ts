import fs from 'node:fs'
import { createRequire } from 'node:module'

// Use the same locked YAML parser as the build tooling, declared directly so
// workflow tests do not depend on an accidental transitive installation.
const { load } = createRequire(import.meta.url)('js-yaml') as { load(source: string): unknown }

export interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
export interface WorkflowJob {
  'runs-on': string
  if?: string
  needs?: string | string[]
  concurrency?: { group: string; 'cancel-in-progress': boolean; queue?: string }
  permissions?: Record<string, string>
  strategy?: { matrix: { include: { arch: string; runner: string }[] } }
  steps: WorkflowStep[]
}
export interface Workflow {
  on: { push: { tags: string[]; branches: string[] } }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean; queue?: string }
  jobs: Record<string, WorkflowJob>
}

export function readWorkflow(file = '.github/workflows/release.yml'): Workflow {
  return load(fs.readFileSync(file, 'utf8')) as Workflow
}

export function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps.find((candidate) => candidate.name === name)
  if (!step) throw new Error(`Missing workflow step: ${name}`)
  return step
}
