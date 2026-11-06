import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adjacentItem, buildGallery, shuffleMedia, swipeStep } from '../public/gallery.mjs';

const item = (id, title, kind, date, name = title) => ({ id, title, kind, name, created: Date.parse(date) });
const media = [
  item('b', 'Blue gate', 'photo', '2026-10-18T17:00:00Z'),
  item('c', 'City walk', 'video', '2026-10-19T00:15:00Z', 'gate-take.mp4'),
  item('a', 'Afterglow', 'photo', '2026-10-16T18:00:00Z')
];

test('the date grid groups by the viewer’s calendar day and shows newest files first', () => {
  const { sections } = buildGallery(media, { timeZone: 'America/New_York' });
  assert.deepEqual(sections.map(section => section.items.map(entry => entry.id)), [['c', 'b'], ['a']]);
  assert.deepEqual(media.map(entry => entry.id), ['b', 'c', 'a']);
});

test('filters find filenames as well as titles and the viewer follows the resulting order', () => {
  const filtered = buildGallery(media, { filter: 'video', query: ' Gate ' });
  assert.deepEqual(filtered.items.map(entry => entry.id), ['c']);
  const alphabetical = buildGallery(media, { sort: 'name' });
  assert.equal(alphabetical.sections.length, 1);
  assert.equal(alphabetical.sections[0].date, null);
  assert.equal(adjacentItem(alphabetical.items, 'a', 1)?.id, 'b');
  assert.equal(adjacentItem(alphabetical.items, 'a', -1), undefined);
  assert.equal(adjacentItem(alphabetical.items, 'missing', 1), undefined);
});

test('a horizontal swipe moves one item and vertical gestures leave the viewer unchanged', () => {
  assert.equal(swipeStep(-86, 20), 1);
  assert.equal(swipeStep(88, -12), -1);
  assert.equal(swipeStep(60, 70), 0);
  assert.equal(swipeStep(18, 0), 0);
});

test('gallery search finds words in media descriptions', () => {
  const photo = { ...media[0], description: 'Sunset at the Baltic coast.' };
  assert.deepEqual(buildGallery([photo, ...media.slice(1)], { query: 'baltic' }).items.map(entry => entry.id), [photo.id]);
});

test('discovery plays every candidate once and avoids an immediate repeat when reshuffled', () => {
  const queue = shuffleMedia(media, 'b', () => 0.99);
  assert.deepEqual(queue.map(entry => entry.id), ['c', 'b', 'a']);
  assert.deepEqual(media.map(entry => entry.id), ['b', 'c', 'a']);
  assert.deepEqual(shuffleMedia([media[0]], 'b').map(entry => entry.id), ['b']);
});
