import test from 'node:test';
import assert from 'node:assert/strict';
import { marqueeDistance, marqueeKeyframes } from '../../../client/marquee.js';

test('text that fits has nowhere to slide', () => {
  assert.equal(marqueeDistance(120, 200), 0);
  assert.equal(marqueeDistance(200, 200), 0);
});

test('the slide covers exactly the clipped overflow', () => {
  assert.equal(marqueeDistance(320, 200), 120);
});

test('an unmeasured track never animates', () => {
  assert.equal(marqueeDistance(320, 0), 0);
});

test('the keyframes hold at both ends and return to the start', () => {
  const { keyframes } = marqueeKeyframes(100);
  assert.deepEqual(keyframes.map((k) => k.transform), [
    'translateX(0)',
    'translateX(0)',
    'translateX(-100px)',
    'translateX(-100px)',
    'translateX(0)',
  ]);
});

test('the offsets rise from 0 to 1', () => {
  const offsets = marqueeKeyframes(100).keyframes.map((k) => k.offset);
  assert.equal(offsets[0], 0);
  assert.equal(offsets.at(-1), 1);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1], `offset ${i} must rise`);
});

test('duration is the two pauses plus one round trip at the given speed', () => {
  const { duration } = marqueeKeyframes(140, 35, 0.5, 0.8);
  assert.equal(duration, (0.5 + 4 + 0.8 + 4) * 1000);
});

test('extra distance costs time at the given speed, in both directions', () => {
  const speed = 35;
  const short = marqueeKeyframes(70, speed).duration;
  const long = marqueeKeyframes(140, speed).duration;
  assert.equal(long - short, (2 * 70 / speed) * 1000);
});

test('a label with nothing to scroll is just the two pauses', () => {
  assert.equal(marqueeKeyframes(0, 35, 0.5, 0.8).duration, 1300);
});
