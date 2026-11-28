import type { ReactNode } from 'react'

/**
 * Sidebar glyph for the memory cloud panel. Drawn inline so the bundle needs no
 * icon package; `currentColor` follows the host's sidebar tokens.
 */
export function MemoryCloudIcon({ size = 16 }: { readonly size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M4.6 10.9a2.6 2.6 0 0 1-.35-5.17 3.2 3.2 0 0 1 6.2-.58 2.5 2.5 0 0 1 .3 4.97"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path d="M8 8.1v4.3M6.7 11.1 8 12.4l1.3-1.3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
