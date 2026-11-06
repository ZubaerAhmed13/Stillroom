export function buildGallery(media, { filter = 'all', query = '', sort = 'new', timeZone } = {}) {
  const search = query.trim().toLowerCase();
  const items = media.filter(item =>
    (filter === 'all' || item.kind === filter) &&
    (item.title + ' ' + item.name + ' ' + (item.description || '')).toLowerCase().includes(search)
  );
  if (sort === 'name') {
    items.sort((a, b) => a.title.localeCompare(b.title));
    return { items, sections: items.length ? [{ date: null, items }] : [] };
  }

  items.sort((a, b) => sort === 'old' ? a.created - b.created : b.created - a.created);
  const calendar = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone });
  const groups = new Map();
  for (const item of items) {
    const date = calendar.format(item.created);
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }
  return { items, sections: [...groups].map(([date, entries]) => ({ date, items: entries })) };
}

export function adjacentItem(items, id, step) {
  const current = items.findIndex(item => item.id === id);
  return current >= 0 ? items[current + step] : undefined;
}

export function swipeStep(x, y) {
  if (Math.abs(x) < 42 || Math.abs(x) < Math.abs(y) * 1.4) return 0;
  return x < 0 ? 1 : -1;
}

export function shuffleMedia(media, previousId, random = Math.random) {
  const items = [...media];
  for (let index = items.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  if (items.length > 1 && items[0].id === previousId) {
    [items[0], items[1]] = [items[1], items[0]];
  }
  return items;
}
