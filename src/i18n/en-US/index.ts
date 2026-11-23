import { common } from './common'
import { chat } from './chat'
import { library } from './library'
import { localModels } from './localModels'
import { projects } from './projects'
import { worktrees } from './worktrees'
import { settings } from './settings'
import { memory } from './memory'
import { experiments } from './experiments'
import { errors } from './errors'

const enUS: Record<string, string> = {
  ...common,
  ...chat,
  ...library,
  ...localModels,
  ...projects,
  ...worktrees,
  ...settings,
  ...memory,
  ...experiments,
  ...errors,
}

export default enUS
