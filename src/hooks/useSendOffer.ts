import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useCallback, useEffect, useState } from 'react'

// A Mac offering a file over the network (Send to iPad; see
// src-tauri/src/receive.rs). Nothing is uploaded until the person accepts;
// an accepted file then opens like any other received one.

export interface SendOffer {
  id: string
  name: string
  from: string
  size: number
}

const OFFER_EVENT = 'neurovue-send-offered'
const OFFER_CLOSED_EVENT = 'neurovue-send-offer-closed'

/**
 * The offer waiting for an answer, if any, and how to answer it. `lastFrom`
 * is who sent the last accepted file, where a drawing goes back to.
 */
export function useSendOffer(enabled: boolean): {
  offer: SendOffer | null
  answer: (accept: boolean) => void
  lastFrom: string | null
} {
  const [offer, setOffer] = useState<SendOffer | null>(null)
  const [lastFrom, setLastFrom] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const unlisteners: Array<() => void> = []
    const subscriptions = [
      listen<SendOffer>(OFFER_EVENT, (event) => setOffer(event.payload)),
      // Answered, timed out, or the Mac gave up.
      listen<string>(OFFER_CLOSED_EVENT, (event) =>
        setOffer((current) => (current?.id === event.payload ? null : current)),
      ),
    ]
    for (const subscription of subscriptions) {
      void subscription
        .then((unlisten) => {
          if (cancelled) unlisten()
          else unlisteners.push(unlisten)
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [enabled])

  const answer = useCallback(
    (accept: boolean) => {
      if (!offer) return
      setOffer(null)
      if (accept) setLastFrom(offer.from)
      void invoke('answer_send_offer', { id: offer.id, accept }).catch(() => {})
    },
    [offer],
  )

  return { offer, answer, lastFrom }
}
