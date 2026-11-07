export interface PlatformMeta { mrTitle?: string; mrUrl?: string }

export interface PlatformEvent { type: string; payload?: unknown }

export interface PlatformAdapter {
  enrichCommit?(sha: string): Promise<PlatformMeta | null>
  subscribe?(onEvent: (e: PlatformEvent) => void): () => void
}

export const nullAdapter: PlatformAdapter = {}
