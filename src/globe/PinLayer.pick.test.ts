/**
 * Decoding the GPU pick region into a list of pins.
 *
 * This is the half of the hover peek that has no visual tell. If the ordering is
 * wrong the peek still lists the right pins, just in the wrong order — which
 * looks fine and is wrong, so it needs a test rather than an eyeball.
 */
import { describe, expect, it } from 'vitest';
import { decodePickRegion, horizonCos } from './PinLayer';

const IDS = ['pin-a', 'pin-b', 'pin-c'];

/**
 * Build a pick buffer from a picture of the region, top row first — i.e. as it
 * looks on screen. Rows are written bottom-up to match what
 * `readRenderTargetPixels` actually returns, so the pictures below read the way
 * the region looks rather than the way it is stored.
 *
 * `0` is background; 1..n are instance ids (index + 1).
 */
function bufferFrom(rowsTopDown: number[][]): Uint8Array {
  const side = rowsTopDown.length;
  const buf = new Uint8Array(side * side * 4);
  rowsTopDown.forEach((row, screenRow) => {
    const bufferRow = side - 1 - screenRow;
    row.forEach((id, col) => {
      const o = (bufferRow * side + col) * 4;
      buf[o] = id & 0xff;
      buf[o + 1] = (id >> 8) & 0xff;
      buf[o + 2] = (id >> 16) & 0xff;
      buf[o + 3] = 255;
    });
  });
  return buf;
}

describe('decodePickRegion', () => {
  it('returns nothing when the region is empty', () => {
    const buf = bufferFrom([
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ]);
    expect(decodePickRegion(buf, 3, 1, IDS)).toEqual([]);
  });

  it('finds the pin under the exact centre', () => {
    const buf = bufferFrom([
      [0, 0, 0],
      [0, 1, 0],
      [0, 0, 0],
    ]);
    expect(decodePickRegion(buf, 3, 1, IDS)).toEqual(['pin-a']);
  });

  it('finds every distinct pin in the region, not just the centre one', () => {
    // The whole point of the feature: overlapping pins the cursor cannot
    // separate should all be reachable.
    const buf = bufferFrom([
      [2, 0, 3],
      [0, 1, 0],
      [0, 0, 0],
    ]);
    expect(decodePickRegion(buf, 3, 1, IDS).sort()).toEqual(['pin-a', 'pin-b', 'pin-c']);
  });

  it('orders by distance from the centre, nearest first', () => {
    const buf = bufferFrom([
      [3, 0, 0],
      [0, 2, 0],
      [0, 0, 0],
    ]);
    // pin-b sits at the centre, pin-c is a corner away.
    expect(decodePickRegion(buf, 3, 1, IDS)).toEqual(['pin-b', 'pin-c']);
  });

  it('ranks by distance regardless of which side of centre a pin is on', () => {
    // Row ORIENTATION is provably irrelevant here and this pins that: the region
    // is centred and dy is used squared, so a pin one row above centre and one
    // one row below are equidistant. An earlier version flipped the rows to
    // "correct" for the bottom-up readback; a test showed the flip could not
    // change any output, and it was removed rather than left as decoration.
    const above = bufferFrom([
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    const below = bufferFrom([
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(decodePickRegion(above, 5, 2, IDS)).toEqual(['pin-a']);
    expect(decodePickRegion(below, 5, 2, IDS)).toEqual(['pin-a']);

    // And a nearer pin beats a farther one whichever side each sits on.
    const mixed = bufferFrom([
      [0, 0, 2, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 1, 0, 0],
      [0, 0, 0, 0, 0],
    ]);
    expect(decodePickRegion(mixed, 5, 2, IDS)).toEqual(['pin-a', 'pin-b']);
  });

  it('ranks a large pin by its CLOSEST pixel, not its first-scanned one', () => {
    /*
     * Constructed so the two rules genuinely disagree. Rows arrive bottom-up, so
     * the BOTTOM row is scanned first:
     *
     *   'b' appears first at the bottom-left corner (d² = 8) and again just
     *       above centre (d² = 1);
     *   'c' sits below-left of centre (d² = 2).
     *
     * Keeping the closest pixel gives b(1) then c(2). Keeping the first-scanned
     * one gives b(8) — behind c — and the order inverts. An earlier version of
     * this test put 'b' on the top row, where the bottom-up scan reached its
     * near pixel first anyway, so both rules agreed and it proved nothing.
     */
    const buf = bufferFrom([
      [0, 0, 0, 0, 0],
      [0, 0, 2, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 3, 0, 0, 0],
      [2, 0, 0, 0, 0],
    ]);
    expect(decodePickRegion(buf, 5, 2, IDS)).toEqual(['pin-b', 'pin-c']);
  });

  it('ignores ids with no matching factor rather than emitting undefined', () => {
    // The instance buffer can outlive a shrunk factor list for a frame.
    const buf = bufferFrom([
      [0, 0, 0],
      [0, 9, 0],
      [0, 0, 0],
    ]);
    expect(decodePickRegion(buf, 3, 1, IDS)).toEqual([]);
  });

  it('handles a single-pixel region, which is what pick() reduces to', () => {
    const buf = bufferFrom([[1]]);
    expect(decodePickRegion(buf, 1, 0, IDS)).toEqual(['pin-a']);
  });
});

describe('horizonCos', () => {
  it('excludes the far hemisphere', () => {
    // Camera well outside a unit sphere: the horizon sits at cos = R/d, so a
    // point at 90° (dot 0) or beyond is around the back and must not qualify.
    const limit = horizonCos(1, 2.76);
    expect(limit).toBeGreaterThan(0);
    expect(0).toBeLessThan(limit); // a point on the limb-plane is already hidden
    expect(-1).toBeLessThan(limit); // the antipode, emphatically
  });

  it('admits the point facing the camera', () => {
    // dot = 1 is the sub-camera point, always visible.
    expect(1).toBeGreaterThan(horizonCos(1, 2.76));
  });

  it('tightens as the camera pulls back', () => {
    // Further away sees more of the sphere, so the horizon cosine falls toward
    // 0 — at infinite distance exactly half the globe is visible.
    expect(horizonCos(1, 8)).toBeLessThan(horizonCos(1, 2));
    expect(horizonCos(1, 1000)).toBeCloseTo(0, 2);
  });

  it('occludes nothing once the camera is inside the sphere', () => {
    // Guards a divide that would otherwise produce a cosine above 1 and hide
    // every pin at once.
    expect(horizonCos(1, 0.5)).toBe(-1);
    expect(horizonCos(1, 1)).toBe(-1);
  });
});
