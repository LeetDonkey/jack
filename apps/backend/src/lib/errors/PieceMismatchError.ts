import { AppError } from './AppError'

/**
 * A piece of the downloaded file doesn't match the peer's piece hashes and no
 * peer could supply a matching copy. The `.part` file is preserved, so this is
 * retryable: the next attempt checks it again.
 */
export class PieceMismatchError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 'PIECE_MISMATCH', { cause })
  }
}
