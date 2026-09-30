/**
 * Walk the concatenated zstd frames of a DSH session log.
 *
 * `zstdDecompressSync` stops after the first frame, which for an appended
 * session log is only the header. `ZSTD_findFrameCompressedSize` is not exposed
 * to JavaScript, so this locates each frame's end by decompressing from every
 * candidate offset — bounded, and correct for the frame counts real logs carry.
 *
 * This file supports a diagnostic tool, not the installed plugin.
 *
 * @param {Buffer} buffer - the whole log file.
 * @returns {Buffer[]} one buffer per frame, in file order.
 */
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Every offset in `buffer` holding a zstd frame magic. */
function magicOffsets(buffer) {
  const offsets = []
  let at = 0
  while ((at = buffer.indexOf(MAGIC, at)) !== -1) {
    offsets.push(at)
    at += 4
  }
  return offsets
}

/**
 * Decompress the log one frame at a time: for each start offset, take the
 * shortest slice that decodes, which is exactly one frame. A slice spanning two
 * frames decodes too, so the shortest success is the frame boundary.
 * @param {Buffer} buffer - the whole log file.
 * @returns {Buffer[]} one buffer per decodable frame.
 */
export function splitFrames(buffer) {
  const offsets = magicOffsets(buffer)
  const frames = []
  let cursor = 0
  while (cursor < buffer.length) {
    const candidates = offsets.filter(offset => offset > cursor)
    let best = null
    for (const end of candidates) {
      try {
        const text = zstdDecompressSync(buffer.subarray(cursor, end)).toString('utf8')
        if (text.length > 0) {
          best = { end, text }
          break
        }
      } catch {
        // Not a frame boundary yet; try a longer slice.
      }
    }
    if (best === null) {
      // The last frame runs to end of file.
      try {
        const text = zstdDecompressSync(buffer.subarray(cursor)).toString('utf8')
        if (text.length > 0) frames.push(Buffer.from(text))
      } catch {
        // Undecodable tail.
      }
      break
    }
    frames.push(Buffer.from(best.text))
    cursor = best.end
  }
  return frames
}
