import type { AttachmentRef, AttachmentData } from './attachments'
import type { ToolItem } from './types'

/** Bytes live in managed storage, not in transcript JSON. */
export interface ToolImageRef extends AttachmentRef {
  key: string
  sourceKind: 'result' | 'file'
  /** Verified original on the CLI host; absent for inline-only images. */
  sourcePath?: string
}
export interface ToolImageData extends AttachmentData {
  path: string
  sourcePath?: string
}
export type ToolImageCapture = (item: ToolItem, content: unknown) => void
export const MAX_TOOL_IMAGE_PIXELS = 32_000_000
