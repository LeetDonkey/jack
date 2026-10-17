import { AppError } from './AppError'

/**
 * The peer knows the item but answered 404 for its file: the file isn't where
 * its *arr says (a move or upgrade in progress, or a missing mount). Usually
 * temporary, so it is retried, but slowly (see downloadRetryAfterMs).
 */
export class PeerFileMissingError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'PEER_FILE_MISSING', { cause })
  }
}
