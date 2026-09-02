import { describe, expect, it } from 'vitest';
import { Track } from '@/track/Track';
import { meridianCoast } from '@/data/tracks/meridian-coast';
import { planMarkings } from '@/track/scenery/TrackMarkings';
import { wrapDelta } from '@/core/math';

const track = new Track(meridianCoast);
const markings = planMarkings(track);

/**
 * The maintenance stencilling is decoration, which is exactly why its placement
 * needs pinning: nothing about it will ever fail loudly. A code laid across a
 * speed pad still renders, still looks deliberate, and quietly costs the pad
 * the contrast it needs to be read at four hundred km/h.
 */
describe('maintenance markings', () => {
  it('lays enough of them to be texture, and few enough to be quiet', () => {
    expect(markings.length).toBeGreaterThan(10);
    expect(markings.length).toBeLessThan(track.length / 50);
  });

  it('keeps clear of every speed pad and weapon pad', () => {
    for (const marking of markings) {
      for (const pad of [...track.boostPads, ...track.pickupPads]) {
        const gap = Math.abs(wrapDelta(pad.s, marking.s, track.length));
        expect(gap, `marking ${marking.code} at ${marking.s.toFixed(0)}`).toBeGreaterThan(
          pad.halfLength + 8,
        );
      }
    }
  });

  it('keeps clear of the grid', () => {
    for (const marking of markings) {
      const behind = wrapDelta(track.startS, marking.s, track.length);
      // The grid itself runs from 22 to 70 metres back from the line.
      expect(behind > -74 && behind < 8, `marking at ${marking.s.toFixed(0)}`).toBe(false);
    }
  });

  it('spreads across the road rather than tracking one side', () => {
    const left = markings.filter((m) => m.lateral < 0).length;
    expect(left).toBeGreaterThan(2);
    expect(markings.length - left).toBeGreaterThan(2);

    // And never out where the barrier is.
    for (const marking of markings) {
      const halfWidth = track.frameAt(marking.s).width * 0.5;
      expect(Math.abs(marking.lateral)).toBeLessThan(halfWidth * 0.85);
    }
  });

  it('writes codes the seven segments can actually say', () => {
    for (const marking of markings) {
      expect(marking.code).toMatch(/^[0-9A-F]{3,4}$/);
    }
  });

  it('is the same circuit every time it is built', () => {
    const again = planMarkings(track);
    expect(again).toEqual(markings);
  });
});
