import type { PeerErrorCode } from '../net/peer-errors'
import { ConnectorInitializationError } from './ConnectorInitializationError'

/**
 * A peer failed its handshake during an interactive add or edit, with the
 * failure classified so the UI can explain it (`reason`) and offer to keep the
 * peer anyway only when retrying later can help.
 */
export class PeerConnectionError extends ConnectorInitializationError {
  constructor(
    message: string,
    public readonly reason: PeerErrorCode,
    /** The HTTP status the peer or its proxy answered with, or null when it didn't answer. */
    public readonly upstreamStatus: number | null,
    cause?: unknown,
  ) {
    super(message, cause)
  }
}
