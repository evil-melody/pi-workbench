import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

export interface Role {
  id: string
  name: string
  description: string
  prompt: string
}

export function useRoles(root: () => string) {
  const roles = ref<Role[]>([])
  const currentId = ref('')
  const applying = ref(false)

  async function load() {
    roles.value = await invoke<Role[]>('role_list').catch(() => [])
    return roles.value
  }

  async function current() {
    const r = await invoke<Role | null>('role_current', { root: root() || null }).catch(() => null)
    if (r) currentId.value = r.id
    return r
  }

  async function set(id: string) {
    applying.value = true
    try {
      const r = await invoke<Role>('role_set', { id, root: root() || null })
      currentId.value = r.id
    } finally {
      applying.value = false
    }
    return currentId.value
  }

  return { roles, currentId, applying, load, current, set }
}
