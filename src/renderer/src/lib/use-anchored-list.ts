import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

/** The narrowest a suggestion list gets, however narrow the box it hangs from. */
const MIN_LIST_WIDTH = 288
/** Space kept clear of the window edges. */
const EDGE_GAP = 16
/** Below this much room underneath, the list is better off above the box. */
const MIN_ROOM_BELOW = 200

/**
 * Pins a suggestion list to the box above it, fixed to the window rather than placed inside the layout. A list placed
 * in the flow is clipped by any scrolling ancestor — a table with horizontal scroll, a dialog, a card — which makes it
 * scroll inside its own row instead of hanging over the page. Fixed to the window nothing can clip it, and it flips
 * above the box when there is more room there.
 *
 * The list must carry `fixed` in its own classes as well, so that it is out of the flow on its very first frame,
 * before this has measured anything. A list that renders in the flow even once grows the row it sits in, and the box
 * is then measured against that disturbed layout — which reads as no room below, and flips the list the wrong way.
 */
export function useAnchoredList(open: boolean): {
  readonly anchor: RefObject<HTMLDivElement | null>
  readonly style: CSSProperties
} {
  const anchor = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({})
  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const box = anchor.current?.getBoundingClientRect()
      if (box === undefined) return
      const below = window.innerHeight - box.bottom - EDGE_GAP
      const above = box.top - EDGE_GAP
      const width = Math.max(box.width, MIN_LIST_WIDTH)
      const left = Math.max(EDGE_GAP, Math.min(box.left, window.innerWidth - width - EDGE_GAP))
      setStyle(
        below < MIN_ROOM_BELOW && above > below
          ? {
              position: 'fixed',
              bottom: window.innerHeight - box.top + 4,
              left,
              minWidth: width,
              maxHeight: above
            }
          : { position: 'fixed', top: box.bottom + 4, left, minWidth: width, maxHeight: below }
      )
    }
    place()
    // Any scroll moves the box the list is pinned to, including one inside a table, so listen while it captures.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])
  return { anchor, style }
}
