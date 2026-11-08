import { adjacentItem, buildGallery, shuffleMedia, swipeStep, verticalKeyStep } from './gallery.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const editor = document.querySelector('#editor');
const notice = document.querySelector('#notice');
const entryMode = location.pathname === '/invite' ? 'redeem' : location.pathname === '/setup' ? 'setup' : 'login';
const entryToken = entryMode === 'login' ? '' : location.hash.slice(1);
if (entryToken) history.replaceState(null, '', location.pathname);

const icons = {
  library: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  collection: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  heart: '<path d="M20.8 9.1c0 4-8.8 9-8.8 9s-8.8-5-8.8-9a4.6 4.6 0 0 1 8.8-2 4.6 4.6 0 0 1 8.8 2Z"/>',
  edit: '<path d="m4 16-1 5 5-1L20 8l-4-4L4 16Zm9-9 4 4"/>',
  discover: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2Z"/>',
  shuffle: '<path d="M3 6h3c4 0 5 12 10 12h5m-4-4 4 4-4 4M3 18h3c2 0 3-3 4-5m4-4c1-2 2-3 4-3h3m-4-4 4 4-4 4"/>',
  manage: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2" fill="var(--panel)"/><circle cx="15" cy="12" r="2" fill="var(--panel)"/><circle cx="10" cy="17" r="2" fill="var(--panel)"/>',
  previous: '<path d="m15 6-6 6 6 6"/>',
  next: '<path d="m9 6 6 6-6 6"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M2 20v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2m2-15a3 3 0 0 1 0 6m0 3a4 4 0 0 1 4 4v2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7m4 4v6m4-6v6"/>',
  up: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 1 1 8 0v3m-4 4v3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="15.5" cy="8.5" r="1.5"/><path d="m3 17 5-6 4 4 2-2 7 6"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3V9Z"/>',
  play: '<path d="m9 5 11 7-11 7V5Z" fill="currentColor" stroke="none"/>',
  exit: '<path d="M11 4H4v16h7m-1-8h11m-4-4 4 4-4 4"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
const icon = name => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const brand = '<div class="brand"><img src="/icon.svg" alt="" width="38" height="38"><span>Stillroom<small>PRIVATE MEDIA</small></span></div>';
const state = { user: null, items: [], collections: [], owner: null, view: 'discover', shelf: 'all', filter: 'all', query: '', sort: 'new', invite: null };
let activeUpload = null;
let uploadQueue = [];
let noticeTimer;
let galleryRevision = 0;
let visibleItems = [];
let discovery = { kind: 'all', items: [], index: 0 };
let viewing = null;
let playerCleanup = () => {};

async function request(path, { method = 'GET', body, binary = false, signal } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['content-type'] = binary ? 'application/octet-stream' : 'application/json';
    if (!binary) body = JSON.stringify(body);
  }
  const response = await fetch(path, { method, body, headers, signal, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'The request could not be completed.');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

function flash(text) {
  notice.textContent = text;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice.hidden = true; }, 4300);
}
function setMessage(element, text) {
  if (element) element.textContent = text || '';
}
function bytes(size) {
  if (size < 1000) return size + ' B';
  const unit = Math.min(3, Math.floor(Math.log10(size) / 3));
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(size / 1000 ** unit) + ' ' + ['B', 'KB', 'MB', 'GB'][unit];
}
const date = value => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(value);
const itemCount = count => count + (count === 1 ? ' item' : ' items');

function signedOut(mode = 'login') {
  const invitation = mode === 'redeem';
  const setup = mode === 'setup';
  const activation = invitation || setup;
  const heading = setup ? 'Set up your Stillroom account' : invitation ? 'Accept your invitation' : 'Sign in to Stillroom';
  const description = setup ? 'Choose your owner email address and password.' : invitation ? 'Create a password to enter the library.' : 'Open your private photo and video library.';
  app.innerHTML = `
    <main id="main" class="entry">
      <section class="entry-fields" aria-labelledby="entry-title">
        ${brand}
        <span class="pill">${icon('lock')} Invitation only</span>
        <h1 id="entry-title">${heading}</h1>
        <p>${description}</p>
        <form id="auth-form" data-mode="${mode}">
          ${invitation ? '' : '<label>Email address<input name="email" type="email" maxlength="254" required autocomplete="username" placeholder="you@example.com"></label>'}
          <label>Password<input name="password" type="password" ${activation ? 'minlength="12"' : ''} maxlength="128" required autocomplete="${activation ? 'new-password' : 'current-password'}" placeholder="${activation ? 'At least 12 characters' : 'Enter your password'}"></label>
          <p class="form-message" role="status"></p>
          <button class="button primary wide" type="submit">${setup ? 'Create owner account' : invitation ? 'Join Stillroom' : 'Sign in'} ${icon('arrow')}</button>
        </form>
        ${activation ? '<a class="quiet-link" href="/">Back to sign in</a>' : '<p class="entry-foot">Need access? Ask the library owner for an invitation.</p>'}
      </section>
    </main>`;
}

function isOwner() { return state.user?.role === 'owner'; }

async function refresh() {
  const user = state.user;
  const [catalog, owner] = await Promise.all([
    request('/api/media'), isOwner() ? request('/api/owner') : null
  ]);
  if (state.user !== user) return;
  state.items = catalog.items;
  state.collections = catalog.collections;
  state.owner = owner;
  syncDiscovery();
  render();
}

function render() {
  const label = state.user.email.split('@')[0].slice(0, 2).toUpperCase();
  const signOut = `<button class="icon-button" type="button" data-action="logout" aria-label="Sign out" title="Sign out">${icon('exit')}</button>`;
  const page = { discover: discoverPage, library: libraryPage, manage: managePage, invites: invitesPage, trash: trashPage }[state.view];
  const managing = ['manage', 'invites', 'trash'].includes(state.view);
  app.innerHTML = `
    <div class="workspace">
      <aside class="sidebar">
        ${brand}
        <nav aria-label="Workspace">
          <button class="nav-item" type="button" data-action="nav" data-id="discover" ${state.view === 'discover' ? 'aria-current="page"' : ''}>${icon('discover')}<span>Discover</span></button>
          <button class="nav-item" type="button" data-action="nav" data-id="library" ${state.view === 'library' ? 'aria-current="page"' : ''}>${icon('library')}<span>Library</span></button>
          <button class="nav-item" type="button" data-action="search">${icon('search')}<span>Search</span></button>
          ${isOwner() ? `<button class="nav-item" type="button" data-action="nav" data-id="manage" ${managing ? 'aria-current="page"' : ''}>${icon('manage')}<span>Manage</span></button>` : ''}
        </nav>
        <div class="sidebar-foot">
          <div class="profile"><span class="avatar" aria-hidden="true">${escapeHtml(label)}</span><div><strong>${isOwner() ? 'Owner' : 'Guest'}</strong><small title="${escapeHtml(state.user.email)}">${escapeHtml(state.user.email)}</small></div>${signOut}</div>
        </div>
      </aside>
      <main id="main" class="main">
        <header class="topline"><div class="mobile-brand">${brand}</div><span class="pill">${icon('lock')} Private</span><div class="mobile-sign-out">${signOut}</div></header>
        ${page()}
      </main>
    </div>`;
  if (state.view === 'library' && state.shelf !== 'collections') drawGallery();
  else observeThumbnails(app);
}

function storageMeter({ limit, total, available, ready, trash, reserved }, operations) {
  const nearLimit = total >= limit * 0.8;
  const activity = operations && [
    ['R2 writes', operations.writes, operations.writeLimit], ['R2 reads', operations.reads, operations.readLimit]
  ];
  const format = new Intl.NumberFormat();
  return `<section class="storage${nearLimit ? ' near-limit' : ''}" aria-labelledby="storage-title">
    <div><h3 id="storage-title">Free-tier protection</h3><strong>${bytes(total)} / ${bytes(limit)}</strong></div>
    <progress max="${limit}" value="${Math.min(total, limit)}" aria-label="Storage used and reserved"></progress>
    <p>${available ? bytes(available) + ' available' : 'At limit. New uploads are blocked.'}</p>
    <dl class="storage-breakdown"><div><dt>Library</dt><dd>${bytes(ready)}</dd></div><div><dt>Trash</dt><dd>${bytes(trash)}</dd></div><div><dt>Reserved for uploads</dt><dd>${bytes(reserved)}</dd></div></dl>
    ${activity ? `<p>R2 requests · last 32 days</p><dl class="storage-breakdown">${activity.map(([label, count, cap]) =>
      `<div><dt>${label}</dt><dd>${format.format(count)} / ${format.format(cap)}${count >= cap ? ' · Paused' : count >= cap * 0.8 ? ' · Near limit' : ''}</dd></div>`).join('')}</dl>` : ''}
  </section>`;
}

function shuffleDiscovery(kind = discovery.kind) {
  const eligible = state.items.filter(item => kind === 'all' || item.kind === kind);
  discovery = { kind, items: shuffleMedia(eligible, discovery.items[discovery.index]?.id), index: 0 };
}

function syncDiscovery() {
  const eligible = new Map(state.items.filter(item => discovery.kind === 'all' || item.kind === discovery.kind)
    .map(item => [item.id, item]));
  if (eligible.size !== discovery.items.length || discovery.items.some(item => !eligible.has(item.id))) {
    shuffleDiscovery();
    return;
  }
  discovery.items = discovery.items.map(item => eligible.get(item.id));
}

function discoverPage() {
  const item = discovery.items[discovery.index];
  return `<section class="discovery" aria-labelledby="discover-title">
    <div class="section-heading"><div><h1 id="discover-title" tabindex="-1">Discover</h1><p>Shuffle photos and videos from your library.</p></div></div>
    <div class="collection-tools">
      <div class="filters" aria-label="Discovery media type">
        ${[['all', 'All'], ['photo', 'Photos'], ['video', 'Videos']].map(([kind, label]) => `<button type="button" data-action="discover-kind" data-id="${kind}" aria-pressed="${kind === discovery.kind}">${label}</button>`).join('')}
      </div>
      <button class="button secondary" type="button" data-action="discover-shuffle" ${discovery.items.length < 2 ? 'disabled' : ''}>${icon('shuffle')} Shuffle</button>
    </div>
    ${item ? `<div class="discover-feature">
      <button class="discover-cover" type="button" data-action="discover-open" aria-label="${item.kind === 'video' ? 'Open video' : 'Open photo'} ${escapeHtml(item.title)}">
        ${cover(item)}<span class="discover-open-icon">${icon(item.kind === 'video' ? 'play' : 'photo')}</span>
      </button>
      <div class="discover-details"><div><h2>${escapeHtml(item.title)}</h2><p>${discovery.index + 1} of ${discovery.items.length}</p></div>
        <div class="discover-steps"><button class="icon-button" type="button" data-action="discover-previous" aria-label="Previous discovery item" ${discovery.index === 0 ? 'disabled' : ''}>${icon('previous')}</button>
        <button class="icon-button" type="button" data-action="discover-next" aria-label="Next discovery item" ${discovery.index === discovery.items.length - 1 ? 'disabled' : ''}>${icon('next')}</button></div>
      </div></div>` : `<div class="empty"><div class="empty-icon">${icon('photo')}</div><h2>${state.items.length ? 'No media in this filter' : 'Nothing to discover yet'}</h2><p>${state.items.length ? 'Choose another media type.' : 'Shared photos and videos will appear here.'}</p>${isOwner() && !state.items.length && !state.owner?.mediaPaused ? '<button class="button primary" type="button" data-action="upload">Upload media</button>' : ''}</div>`}
  </section>`;
}

function cover(item, showKind = true) {
  if (!item) return `<span class="card-cover">${icon('collection')}</span>`;
  return `<span class="card-cover ${item.kind}">${icon(item.kind === 'video' ? 'play' : 'photo')}${item.kind === 'photo' ? `<img alt="" data-thumb="${item.id}" hidden>` : ''}${showKind ? `<span class="kind">${item.kind === 'video' ? 'Video' : 'Photo'}</span>` : ''}</span>`;
}

function shelfItems() {
  if (state.shelf === 'all') return state.items;
  if (state.shelf === 'favourites') return state.items.filter(item => item.favourite);
  return state.items.filter(item => item.collectionId === state.shelf);
}

function selectShelf(id) {
  state.shelf = id;
  state.filter = 'all';
  state.query = '';
  state.view = 'library';
  render();
  window.scrollTo(0, 0);
  document.querySelector('#library-title')?.focus();
}

function collectionGrid() {
  if (!state.collections.length) return `<div class="empty"><div class="empty-icon">${icon('collection')}</div><h3>No collections yet</h3><p>${isOwner() ? 'Create a collection to group related photos and videos.' : 'Shared collections will appear here.'}</p></div>`;
  const groups = new Map(state.collections.map(({ id }) => [id, { count: 0, cover: null }]));
  for (const item of state.items) {
    const group = groups.get(item.collectionId);
    if (!group) continue;
    group.count++;
    if (!group.cover || (group.cover.kind === 'video' && item.kind === 'photo')) group.cover = item;
  }
  return `<div class="gallery-grid collection-grid">${state.collections.map(({ id, name }) => {
    const group = groups.get(id);
    return `<button class="media-card" type="button" data-action="shelf" data-id="${id}">${cover(group.cover, false)}<span class="card-details"><strong title="${escapeHtml(name)}">${escapeHtml(name)}</strong><small>${itemCount(group.count)}</small></span></button>`;
  }).join('')}</div>`;
}

function libraryPage() {
  const collection = state.collections.find(item => item.id === state.shelf);
  const browsing = state.shelf === 'collections';
  const title = collection?.name || (browsing ? 'Collections' : state.shelf === 'favourites' ? 'Favourites' : 'Your Library');
  const sections = [['all', 'All media'], ['collections', 'Collections']];
  if (isOwner()) sections.push(['favourites', 'Favourites']);
  const tabs = `<nav class="library-tabs" aria-label="Library sections">${sections.map(([id, label]) => `<button class="button quiet" type="button" data-action="shelf" data-id="${id}" ${id === (collection ? 'collections' : state.shelf) ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav>`;
  const owner = isOwner() ? state.owner : null;
  const interrupted = owner?.pending.length || 0;
  const usage = owner?.usage;
  let actions = '';
  if (owner && state.shelf === 'all') actions = `<button class="button secondary storage-link${usage.total >= usage.limit * 0.8 ? ' near-limit' : ''}" type="button" data-action="nav" data-id="manage" aria-label="Manage storage, ${bytes(usage.available)} available">${bytes(usage.total)} / ${bytes(usage.limit)}</button>${owner.mediaPaused ? '' : `<button class="button primary" type="button" data-action="upload">${icon('up')} Upload</button>`}`;
  if (owner && browsing) actions = `<button class="button primary" type="button" data-action="collection-edit">${icon('plus')} New collection</button>`;
  if (owner && collection) actions = `<button class="button secondary" type="button" data-action="collection-edit" data-id="${collection.id}">${icon('edit')} Rename collection</button>`;
  return `
    <section class="collection" aria-labelledby="library-title">
      ${tabs}
      ${collection ? `<button class="button quiet collection-back" type="button" data-action="shelf" data-id="collections">${icon('previous')} All collections</button>` : ''}
      <div class="section-heading library-heading">
        <div><h1 id="library-title" tabindex="-1">${escapeHtml(title)}</h1><p>${browsing ? state.collections.length + (state.collections.length === 1 ? ' collection' : ' collections') : itemCount(shelfItems().length)}</p></div>
        ${actions ? `<div class="library-actions">${actions}</div>` : ''}
      </div>
      ${browsing ? collectionGrid() : `
      ${state.shelf === 'all' && usage && usage.total >= usage.limit * 0.8 ? `<p class="capacity-warning" role="status">${usage.available ? bytes(usage.available) + ' available before the storage limit.' : 'Storage full. Free space in Manage to upload more.'}</p>` : ''}
      ${state.shelf === 'all' && interrupted ? `<button class="pending-banner" type="button" data-action="upload">${icon('clock')} ${interrupted} interrupted ${interrupted === 1 ? 'upload' : 'uploads'} ${icon('arrow')}</button>` : ''}
      <div class="collection-tools">
        <div class="filters" aria-label="Filter media">
          ${[['all', 'All'], ['photo', 'Photos'], ['video', 'Videos']].map(([key, label]) => `<button type="button" data-action="filter" data-id="${key}" aria-pressed="${state.filter === key}">${label}</button>`).join('')}
        </div>
        <div class="search-tools">
          <label class="search">${icon('search')}<span class="sr-only">Search media</span><input type="search" id="search" placeholder="Search media" value="${escapeHtml(state.query)}"></label>
          <label class="sort"><span class="sr-only">Sort media</span><select id="sort"><option value="new" ${state.sort === 'new' ? 'selected' : ''}>Newest</option><option value="old" ${state.sort === 'old' ? 'selected' : ''}>Oldest</option><option value="name" ${state.sort === 'name' ? 'selected' : ''}>A–Z</option></select></label>
        </div>
      </div>
      <div id="gallery"></div>`}
    </section>`;
}

function managePage() {
  const { used, limit, pending, trash, usage, operations, mediaPaused } = state.owner;
  const links = [
    ['nav', 'invites', 'users', 'Invitations', used + ' of ' + limit + ' guest slots used'],
    ['upload', '', 'up', 'Uploads', pending.length ? pending.length + ' interrupted' : 'Ready for new files'],
    ['nav', 'trash', 'trash', 'Trash', trash.length + (trash.length === 1 ? ' item' : ' items')]
  ];
  return `
    <section class="page-head"><h1 tabindex="-1">Manage</h1><p>Storage, uploads, and guest access.</p></section>
    ${storageMeter(usage, operations)}
    ${mediaPaused ? '<p class="capacity-warning" role="status">Hosted uploads and playback are paused while storage safeguards are being verified.</p>' : ''}
    <div class="manage-grid">${links.filter(([action]) => !mediaPaused || action !== 'upload').map(([action, id, image, title, detail]) => `
      <button class="manage-card" type="button" data-action="${action}" data-id="${id}">
        <span class="list-icon">${icon(image)}</span><span><strong>${title}</strong><small>${detail}</small></span>${icon('arrow')}
      </button>`).join('')}</div>`;
}

function drawGallery() {
  const gallery = document.querySelector('#gallery');
  if (!gallery) return;
  const source = shelfItems();
  const { items, sections } = buildGallery(source, state);
  visibleItems = items;
  if (!items.length) {
    thumbnailObserver?.disconnect();
    const empty = !source.length;
    const all = state.shelf === 'all';
    const favourites = state.shelf === 'favourites';
    let message = 'Try a different search or filter.';
    if (empty && all) message = isOwner() ? 'Add a photo or video to get started.' : 'Shared photos and videos will appear here.';
    if (empty && !all) message = favourites ? 'Open any item and tap the heart to save it here.' : (isOwner() ? 'Open a photo or video, then choose Details and Edit details to move it here.' : 'Shared photos and videos will appear here.');
    gallery.innerHTML = `<div class="empty"><div class="empty-icon">${icon(favourites ? 'heart' : 'photo')}</div><h3>${empty ? (favourites ? 'No favourites yet' : 'No media yet') : 'No matching media'}</h3><p>${message}</p>${empty && all && isOwner() && !state.owner?.mediaPaused ? '<button type="button" class="button secondary" data-action="upload">Add your first file</button>' : ''}</div>`;
    return;
  }
  gallery.innerHTML = sections.map(section => `<section class="gallery-section">
    ${section.date ? `<h2>${escapeHtml(section.date)}</h2>` : ''}
    <div class="gallery-grid">${section.items.map(item => `
    <button class="media-card" id="media-${item.id}" type="button" data-action="media" data-id="${item.id}">
      ${cover(item)}
      <span class="card-details"><strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong>${isOwner() && item.favourite ? `<span class="card-favourite" aria-hidden="true">${icon('heart')}</span>` : ''}</span>
    </button>`).join('')}</div></section>`).join('');
  observeThumbnails(gallery);
}

function observeThumbnails(container) {
  thumbnailObserver?.disconnect();
  const revision = ++galleryRevision;
  const images = [...container.querySelectorAll('[data-thumb]')];
  const load = async image => {
    if (revision !== galleryRevision || !image.isConnected) return;
    try {
      const { url } = await request('/api/media/' + image.dataset.thumb + '/link');
      if (revision !== galleryRevision || !image.isConnected) return;
      image.addEventListener('load', () => { image.hidden = false; }, { once: true });
      image.src = url;
    } catch { /* the media card still opens and can show its error */ }
  };
  if (!images.length) return;
  if (!('IntersectionObserver' in window)) {
    images.forEach(load);
    return;
  }
  thumbnailObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbnailObserver.unobserve(entry.target);
      load(entry.target.querySelector('[data-thumb]'));
    }
  }, { rootMargin: '150px' });
  images.forEach(image => thumbnailObserver.observe(image.parentElement));
}

let thumbnailObserver;

function invitesPage() {
  const { used, limit, invites } = state.owner;
  return `<section class="page-head"><button class="button quiet back-link" type="button" data-action="nav" data-id="manage">${icon('previous')} Manage</button><h1 tabindex="-1">Invitations</h1><p>Choose who can view your library. ${used} of ${limit} guest slots used.</p></section>
    <section class="panel" aria-labelledby="invite-head"><h2 id="invite-head">Invite a guest</h2><p>Enter their email, then copy the single-use link to share with them.</p>
      <form id="invite-form" class="invite-form"><label>Email address<input name="email" type="email" required maxlength="254" placeholder="guest@example.com"></label><button class="button primary" type="submit">${icon('plus')} Create link</button></form>
      <p class="form-message" role="status"></p>
      ${state.invite ? `<div class="invite-result"><label>Invitation link for ${escapeHtml(state.invite.email)}<input id="invite-url" readonly value="${escapeHtml(location.origin + state.invite.path)}"></label><button class="button secondary" type="button" data-action="copy">Copy link</button></div><p class="muted invite-expiry">Expires ${date(state.invite.expires)}.</p>` : ''}
    </section>
    <section class="panel" aria-labelledby="guests-head"><h2 id="guests-head">Guest access</h2>
      ${invites.length ? '<ul class="list">' + invites.map(item => `<li><span class="list-icon">${icon('users')}</span><div class="list-info"><strong>${escapeHtml(item.email)}</strong><small>${item.status === 'pending' ? 'Expires ' + date(item.expires) : 'Updated ' + date(item.created)}</small></div><span class="badge ${item.status}">${item.status}</span>${['pending', 'active'].includes(item.status) ? `<button class="button quiet" type="button" data-action="revoke" data-id="${item.id}">Revoke</button>` : ''}</li>`).join('') + '</ul>' : '<p class="muted">No invitations yet.</p>'}
    </section>`;
}

function trashPage() {
  const items = state.owner.trash;
  return `<section class="page-head"><button class="button quiet back-link" type="button" data-action="nav" data-id="manage">${icon('previous')} Manage</button><h1 tabindex="-1">Trash</h1><p>Restore an item to the library or delete its original file.</p></section>
    <section class="panel" aria-labelledby="trash-head"><h2 id="trash-head">Deleted media</h2>
      ${items.length ? '<ul class="list">' + items.map(item => `<li><span class="list-icon">${icon(item.kind)}</span><div class="list-info"><strong>${escapeHtml(item.title)}</strong><small>${bytes(item.size)}</small></div><button class="button quiet" type="button" data-action="restore" data-id="${item.id}">Restore</button><button class="button quiet danger-text" type="button" data-action="purge" data-id="${item.id}">Delete forever</button></li>`).join('') + '</ul>' : '<p class="muted">Trash is empty.</p>'}
    </section>`;
}

function openDialog(title, contents, kind = '', actions = '') {
  playerCleanup();
  playerCleanup = () => {};
  dialog.className = kind;
  dialog.innerHTML = `<header class="dialog-head"><h2 id="dialog-title">${escapeHtml(title)}</h2><div class="dialog-actions">${actions}<button class="icon-button" type="button" data-action="close" aria-label="Close">${icon('close')}</button></div></header>` + contents;
  if (!dialog.open) dialog.showModal();
}

function closeDialog() {
  if (activeUpload) return;
  dialog.close();
}
dialog.addEventListener('cancel', event => { if (activeUpload) event.preventDefault(); });
dialog.addEventListener('close', () => {
  if (dialog.open) return;
  playerCleanup();
  playerCleanup = () => {};
  uploadQueue = [];
  dialog.innerHTML = '';
  if (viewing) {
    const { origin, scroll, fromDiscovery, dirty } = viewing;
    viewing = null;
    if (state.user && (dirty || (fromDiscovery && state.view === 'discover'))) render();
    window.scrollTo(scroll.x, scroll.y);
    const fallback = fromDiscovery ? '[data-action="discover-open"]' : '#library-title';
    const restoredOrigin = origin.isConnected ? origin : document.getElementById(origin.id);
    (restoredOrigin || document.querySelector(fallback))?.focus({ preventScroll: true });
  }
});

function stepViewer(step) {
  if (!viewing || !dialog.open || editor.open) return;
  const item = adjacentItem(viewing.items, viewing.id, step);
  if (item) showMedia(item);
}

dialog.addEventListener('keydown', event => {
  if (!viewing || editor.open || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      event.target.closest('input, select, textarea, [contenteditable], .viewer-info[open]')) return;
  const vertical = verticalKeyStep(event.key, event.keyCode);
  if (vertical) {
    event.preventDefault();
    if (!event.repeat) stepViewer(vertical);
    return;
  }
  if (event.target.closest('video')) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  stepViewer(event.key === 'ArrowLeft' ? -1 : 1);
}, { capture: true });

function viewerDetails(item) {
  const collection = state.collections.find(entry => entry.id === item.collectionId);
  return `<strong>${escapeHtml(item.name)}</strong><p>${date(item.created)} · ${bytes(item.size)}</p>
    ${collection ? `<p>Collection · ${escapeHtml(collection.name)}</p>` : ''}
    ${item.description ? `<p class="media-description">${escapeHtml(item.description)}</p>` : ''}
    ${isOwner() ? `<div class="viewer-detail-actions"><button class="button quiet" type="button" data-action="media-edit" data-id="${item.id}">${icon('edit')} Edit details</button>
      <button class="button quiet danger-text" type="button" data-action="trash-item" data-id="${item.id}">${icon('trash')} Move to trash</button></div>` : ''}`;
}

async function showMedia(item, { origin, fromDiscovery = false } = {}) {
  if (origin) {
    const queue = fromDiscovery ? discovery.items : visibleItems;
    viewing = { items: queue.filter(entry => entry.kind === item.kind), origin, fromDiscovery, automatic: false, muted: false,
      scroll: { x: window.scrollX, y: window.scrollY } };
  }
  viewing.id = item.id;
  viewing.syncAuto = null;
  const { items } = viewing;
  const position = items.findIndex(entry => entry.id === item.id);
  if (viewing.fromDiscovery) discovery.index = discovery.items.findIndex(entry => entry.id === item.id);
  const autoButton = items.length > 1
    ? `<button class="button quiet viewer-auto" type="button" data-action="viewer-auto" aria-pressed="${viewing.automatic}">Auto-next</button>` : '';
  const favouriteButton = isOwner() ? `<button class="icon-button viewer-favourite" type="button" data-action="favourite" data-id="${item.id}" aria-label="Favourite" title="Favourite" aria-pressed="${item.favourite}">${icon('heart')}</button>` : '';
  const focused = dialog.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  openDialog(item.title, `
    <div id="viewer" class="viewer"><p role="status">Opening media…</p></div>
    <footer class="viewer-foot">
      <button class="button secondary viewer-step" type="button" data-action="viewer-previous" aria-keyshortcuts="ArrowUp ArrowLeft" ${position <= 0 ? 'disabled' : ''}>${icon('previous')} <span>Previous</span></button>
      <div class="viewer-meta">
        <span>${position + 1} / ${items.length}</span>
        <details class="viewer-info"><summary>Details</summary><div class="viewer-detail-content">${viewerDetails(item)}</div></details>
      </div>
      <button class="button secondary viewer-step" type="button" data-action="viewer-next" aria-keyshortcuts="ArrowDown ArrowRight" ${position === items.length - 1 ? 'disabled' : ''}><span>Next</span> ${icon('next')}</button>
      <p class="viewer-message form-message" role="status"></p>
    </footer>`, 'media-dialog', autoButton + favouriteButton);
  const focusTarget = ['viewer-previous', 'viewer-next'].includes(focused)
    ? dialog.querySelector('[data-action="' + focused + '"]:not(:disabled)') : null;
  (focusTarget || dialog.querySelector('[data-action="close"]')).focus({ preventScroll: true });
  const viewer = dialog.querySelector('#viewer');
  let touch;
  viewer.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const video = event.target.closest('video');
    if (video && event.clientY > video.getBoundingClientRect().bottom - 56) return;
    touch = { x: event.clientX, y: event.clientY };
  });
  viewer.addEventListener('pointercancel', () => { touch = null; });
  viewer.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch' || !event.isPrimary || !touch) return;
    const step = swipeStep(event.clientX - touch.x, event.clientY - touch.y);
    touch = null;
    if (step) stepViewer(step);
  });

  try {
    const route = '/api/media/' + item.id + '/link';
    const link = await request(route);
    let expires = link.expires;
    if (!viewer.isConnected || !dialog.open) return;
    const element = document.createElement(item.kind === 'video' ? 'video' : 'img');
    viewer.replaceChildren(element);
    if (item.kind === 'video') {
      element.controls = true;
      element.playsInline = true;
      element.preload = 'metadata';
      element.muted = viewing.muted;
      element.addEventListener('volumechange', () => {
        if (viewing && element.isConnected) viewing.muted = element.muted;
      });
      const play = document.createElement('button');
      play.className = 'viewer-play';
      play.type = 'button';
      play.setAttribute('aria-label', 'Play video');
      play.innerHTML = icon('play');
      viewer.append(play);
      play.addEventListener('click', () => {
        element.play().catch(() => {
          if (element.isConnected) element.focus();
        });
      });
      element.addEventListener('play', () => { play.hidden = true; });
      element.addEventListener('pause', () => { play.hidden = false; });
      element.addEventListener('ended', () => {
        if (viewer.isConnected && viewing?.automatic) stepViewer(1);
      });
      let refreshed = false;
      element.addEventListener('error', async () => {
        if (!element.isConnected || !dialog.open) return;
        if (!refreshed || (Number.isFinite(expires) && expires <= Date.now() + 5000)) {
          refreshed = true;
          const time = element.currentTime;
          try {
            const fresh = await request(route);
            if (!element.isConnected || !dialog.open) return;
            expires = fresh.expires;
            element.addEventListener('loadedmetadata', () => { element.currentTime = time; }, { once: true });
            element.src = fresh.url;
            return;
          } catch { /* show the playback message below */ }
        }
        setMessage(viewer, 'This video could not play. Try reopening it or use a browser-compatible MP4 or WebM.');
      });
      playerCleanup = () => {
        element.pause();
        element.removeAttribute('src');
        element.load();
      };
    } else {
      element.alt = item.title;
      let timer;
      const schedule = () => {
        clearTimeout(timer);
        if (viewing?.automatic && !editor.open && element.naturalWidth) timer = setTimeout(() => stepViewer(1), 5000);
      };
      viewing.syncAuto = schedule;
      element.addEventListener('load', schedule, { once: true });
      element.addEventListener('error', () => setMessage(viewer, 'This photo could not be opened.'));
      playerCleanup = () => clearTimeout(timer);
    }
    element.src = link.url;
    if (item.kind === 'video') {
      try { await element.play(); }
      catch (error) {
        if (error.name === 'NotAllowedError' && !element.muted && element.isConnected && dialog.open) {
          element.muted = true;
          await element.play().catch(() => {});
        }
      }
    }
  } catch (error) {
    if (viewer.isConnected) setMessage(viewer, error.message);
  }
}

function showEditor(title, formId, id, fields, saveLabel) {
  editor.innerHTML = `<header class="dialog-head"><h2 id="editor-title">${escapeHtml(title)}</h2><button class="icon-button" type="button" data-action="close-editor" aria-label="Close editor">${icon('close')}</button></header>
    <form id="${formId}" class="dialog-body" data-id="${id || ''}">${fields}
      <p class="form-message" role="status"></p><div class="form-actions"><button class="button quiet" type="button" data-action="close-editor">Cancel</button><button class="button primary" type="submit">${saveLabel}</button></div></form>`;
  editor.showModal();
  editor.querySelector('input').focus();
  viewing?.syncAuto?.();
}

editor.addEventListener('close', () => {
  if (!editor.open) viewing?.syncAuto?.();
});

function editCollection(id) {
  const collection = state.collections.find(entry => entry.id === id);
  if (id && !collection) return;
  showEditor(id ? 'Rename collection' : 'New collection', 'collection-form', id,
    `<label>Name<input name="name" maxlength="80" required value="${escapeHtml(collection?.name)}" placeholder="e.g. Travel"></label>`,
    id ? 'Save name' : 'Create collection');
}

function editMedia(id) {
  const item = state.items.find(entry => entry.id === id);
  if (!item) return;
  dialog.querySelector('video')?.pause();
  showEditor('Edit media details', 'media-form', id,
    `<label>Title<input name="title" maxlength="120" required value="${escapeHtml(item.title)}"></label>
    <label>Description<textarea name="description" rows="4" maxlength="2000" placeholder="Add a note about this photo or video">${escapeHtml(item.description)}</textarea></label>
    <label>Collection<select name="collectionId"><option value="">No collection</option>${state.collections.map(entry => `<option value="${entry.id}" ${entry.id === item.collectionId ? 'selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}</select></label>`, 'Save changes');
}

async function updateMedia(id, changes) {
  const user = state.user;
  const result = await request('/api/media/' + id, { method: 'PATCH', body: changes });
  if (state.user !== user) return;
  const edited = Object.fromEntries(Object.keys(changes).map(key => [key, result[key]]));
  const update = item => item.id === id ? { ...item, ...edited } : item;
  state.items = state.items.map(update);
  syncDiscovery();
  if (viewing && dialog.open) {
    viewing.items = viewing.items.map(update);
    viewing.dirty = true;
  } else render();
}

async function saveOrganization(form) {
  const { id } = form.dataset;
  const user = state.user;
  const fields = new FormData(form);
  const submit = form.querySelector('[type="submit"]');
  const message = form.querySelector('.form-message');
  submit.disabled = true;
  setMessage(message, '');
  try {
    if (form.id === 'collection-form') {
      const collection = await request('/api/collections' + (id ? '/' + id : ''), {
        method: id ? 'PATCH' : 'POST', body: { name: fields.get('name') }
      });
      if (state.user !== user) return;
      state.collections = [...state.collections.filter(item => item.id !== collection.id), collection]
        .sort((a, b) => a.name.localeCompare(b.name));
      if (editor.open && form.isConnected) {
        editor.close();
        selectShelf(collection.id);
      } else render();
      flash(id ? 'Collection renamed.' : 'Collection created.');
      return;
    }
    const changes = {};
    const { title, description, collectionId } = form.elements;
    if (title.value !== title.defaultValue) changes.title = title.value;
    if (description.value !== description.defaultValue) changes.description = description.value;
    const originalCollection = Array.from(collectionId.options).find(option => option.defaultSelected)?.value || '';
    if (collectionId.value !== originalCollection) changes.collectionId = collectionId.value || null;
    if (Object.keys(changes).length) await updateMedia(id, changes);
    if (state.user !== user) return;
    if (editor.open && form.isConnected) editor.close();
    const item = viewing?.id === id && dialog.open && state.items.find(entry => entry.id === id);
    if (item) {
      setMessage(dialog.querySelector('#dialog-title'), item.title);
      dialog.querySelector('.viewer img')?.setAttribute('alt', item.title);
      dialog.querySelector('.viewer-detail-content').innerHTML = viewerDetails(item);
      if (!editor.open && dialog.querySelector('.viewer-info').open) dialog.querySelector('[data-action="media-edit"]').focus();
    } else flash('Media details saved.');
  } catch (error) {
    if (form.isConnected && editor.open) setMessage(message, error.message);
    else flash(error.message);
  } finally {
    submit.disabled = false;
  }
}

const fileTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' };

function showUpload() {
  openDialog('Upload media', `
    <form id="upload-form" class="dialog-body">
      <p id="upload-space" class="upload-space">${bytes(state.owner.usage.available)} available for new files</p>
      <label class="drop" id="drop-zone">${icon('up')}<strong>Choose photos or videos</strong><span>or drop files here</span><small>JPG, PNG, WebP, GIF, MP4 or WebM · Up to 4 GiB each</small><input id="files" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.m4v,.webm" aria-label="Choose photos or videos"></label>
      <p id="selection" class="muted" role="status"></p>
      <ul id="file-queue" class="file-queue" aria-label="Selected files" hidden></ul>
      <label id="title-field" hidden>Title (optional)<input id="upload-title" maxlength="120" placeholder="Use the file name"></label>
      <p id="upload-message" class="form-message" role="status"></p>
      <div class="form-actions"><button class="button quiet" type="button" data-action="pause" hidden>Pause</button><button class="button primary" id="upload-submit" type="submit" disabled>${icon('up')} Upload</button></div>
    </form>
    <div id="pending-uploads" class="resume-box" hidden></div>`, 'upload-dialog');
  const drop = dialog.querySelector('#drop-zone');
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    if (!activeUpload) chooseFiles(event.dataTransfer.files);
  });
  drawFileQueue();
  drawPendingUploads();
}

function chooseFiles(files) {
  uploadQueue = [...files].map(file => ({ file, fraction: 0, status: 'Queued', done: false }));
  setMessage(dialog.querySelector('#upload-message'), '');
  dialog.querySelector('#upload-submit').innerHTML = icon('up') + ' Upload';
  drawFileQueue();
}

function drawFileQueue() {
  const list = dialog.querySelector('#file-queue');
  const count = uploadQueue.length;
  list.hidden = count === 0;
  list.innerHTML = uploadQueue.map(({ file, status, fraction }, index) => `
    <li data-file-index="${index}"><div><strong title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</strong><span>${escapeHtml(status)}</span></div>
    <progress max="1" value="${fraction}" aria-label="Upload progress for ${escapeHtml(file.name)}"></progress></li>`).join('');
  setMessage(dialog.querySelector('#selection'), count ? count + (count === 1 ? ' file selected' : ' files selected') : '');
  dialog.querySelector('#title-field').hidden = count !== 1;
  dialog.querySelector('#upload-submit').disabled = !uploadQueue.some(item => !item.done);
}

function updateFile(index, status, fraction = uploadQueue[index].fraction) {
  const item = uploadQueue[index];
  item.status = status;
  item.fraction = fraction;
  const row = dialog.querySelector('[data-file-index="' + index + '"]');
  row.querySelector('span').textContent = status;
  row.querySelector('progress').value = fraction;
}

function drawPendingUploads() {
  const box = dialog.querySelector('#pending-uploads');
  if (!box) return;
  const pending = state.owner.pending;
  box.hidden = pending.length === 0;
  box.innerHTML = pending.length ? `<h3>Interrupted uploads</h3><p>Choose the same file to resume from its last saved part.</p>
    <ul class="list">${pending.map(item => `<li><div class="list-info"><strong>${escapeHtml(item.name)}</strong><small>${bytes(item.offset)} of ${bytes(item.size)}</small></div>
    <button class="button quiet" type="button" data-action="discard-upload" data-id="${item.id}">Cancel upload</button></li>`).join('')}</ul>` : '';
}

async function fingerprint(file, signal) {
  if (state.owner.operations) {
    const chunkSize = 8 * 1024 * 1024;
    const hashes = new Uint8Array(Math.ceil(file.size / chunkSize) * 32);
    for (let offset = 0, index = 0; offset < file.size; offset += chunkSize, index++) {
      signal.throwIfAborted();
      const part = await file.slice(offset, offset + chunkSize).arrayBuffer();
      const hash = await crypto.subtle.digest('SHA-256', part);
      hashes.set(new Uint8Array(hash), index * 32);
    }
    signal.throwIfAborted();
    const hash = await crypto.subtle.digest('SHA-256', hashes);
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const sampleSize = 65536;
  const sample = new Blob([
    file.slice(0, sampleSize), file.slice(Math.max(0, file.size - sampleSize)),
    JSON.stringify([file.name, file.size, file.lastModified])
  ]);
  const hash = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function uploadFiles() {
  if (activeUpload || !uploadQueue.some(item => !item.done)) return;
  const submit = dialog.querySelector('#upload-submit');
  const pause = dialog.querySelector('[data-action="pause"]');
  const close = dialog.querySelector('[data-action="close"]');
  const message = dialog.querySelector('#upload-message');
  const input = dialog.querySelector('#files');
  const titleField = dialog.querySelector('#upload-title');
  const title = uploadQueue.length === 1 ? titleField.value : '';
  const controller = new AbortController();
  activeUpload = controller;
  const signal = controller.signal;
  submit.disabled = input.disabled = titleField.disabled = close.disabled = true;
  pause.hidden = false;
  setMessage(message, '');
  let added = 0;
  let index = 0;
  try {
    for (const [position, entry] of uploadQueue.entries()) {
      if (entry.done) continue;
      index = position;
      const { file } = entry;
      updateFile(index, 'Preparing');
      const mime = fileTypes[file.name.split('.').pop().toLowerCase()];
      if (!mime) throw new Error('Unsupported format: ' + file.name);
      const hash = await fingerprint(file, signal);
      const upload = await request('/api/uploads', { method: 'POST', signal, body: { name: file.name, title, mime, size: file.size, fingerprint: hash } });
      let offset = upload.offset;
      while (offset < file.size) {
        updateFile(index, Math.floor(offset / file.size * 100) + '%', offset / file.size);
        const result = await request('/api/uploads/' + upload.id + '?offset=' + offset, {
          method: 'PUT', body: file.slice(offset, offset + upload.chunkSize), binary: true, signal
        });
        offset = result.offset;
      }
      if (!upload.complete) {
        updateFile(index, 'Finalizing', 1);
        await request('/api/uploads/' + upload.id + '/finish', { method: 'POST', signal });
        added++;
      }
      entry.done = true;
      updateFile(index, upload.complete ? 'In library' : 'Complete', 1);
    }
    await refresh();
    activeUpload = null;
    closeDialog();
    flash(added ? (added === 1 ? 'Media uploaded.' : added + ' files uploaded.') : 'These files are already in your library.');
  } catch (error) {
    const paused = error.name === 'AbortError';
    if (!uploadQueue[index].done) updateFile(index, paused ? 'Paused' : 'Needs attention');
    setMessage(message, paused ? 'Upload paused. Select Resume to continue.' : (error instanceof TypeError ? 'Connection interrupted. Select Resume to try again.' : error.message));
    submit.innerHTML = icon('up') + (error.code === 'storage_limit' ? ' Try again' : ' Resume');
    try {
      await refresh();
      setMessage(dialog.querySelector('#upload-space'), bytes(state.owner.usage.available) + ' available for new files');
      drawPendingUploads();
    } catch { /* the dialog retains its retry state */ }
  } finally {
    activeUpload = null;
    submit.disabled = !uploadQueue.some(item => !item.done);
    input.disabled = titleField.disabled = close.disabled = false;
    pause.hidden = true;
  }
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id === 'collection-form' || form.id === 'media-form') {
    event.preventDefault();
    return saveOrganization(form);
  }
  if (!['auth-form', 'invite-form', 'upload-form'].includes(form.id)) return;
  event.preventDefault();
  if (form.id === 'upload-form') return uploadFiles();
  const fields = new FormData(form);
  const submit = form.querySelector('button[type="submit"]');
  const message = (form.id === 'invite-form' ? form.closest('.panel') : form).querySelector('.form-message');
  submit.disabled = true;
  setMessage(message, '');
  try {
    if (form.id === 'auth-form') {
      const mode = form.dataset.mode;
      const body = { email: fields.get('email'), password: fields.get('password') };
      if (mode !== 'login') body.token = entryToken;
      const { user } = await request('/api/auth/' + mode, { method: 'POST', body });
      state.user = user;
      state.view = 'discover';
      state.shelf = 'all';
      if (mode !== 'login') history.replaceState(null, '', '/');
    } else {
      state.invite = await request('/api/invites', { method: 'POST', body: { email: fields.get('email') } });
      flash('Invitation link created.');
    }
    await refresh();
  } catch (error) {
    setMessage(message, error.message);
  } finally {
    submit.disabled = false;
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === 'nav' || action === 'search') {
    const view = action === 'search' ? 'library' : id;
    if (action === 'search' && state.shelf !== 'all') selectShelf('all');
    if (state.view !== view) {
      state.view = view;
      render();
      window.scrollTo(0, 0);
    }
    document.querySelector(action === 'search' ? '#search' : '#main h1')?.focus();
    return;
  }
  if (action === 'shelf') return selectShelf(id);
  if (action === 'collection-edit') return editCollection(id);
  if (action === 'media-edit') return editMedia(id);
  if (action === 'close-editor') return editor.close();
  if (action === 'filter') {
    state.filter = id;
    document.querySelectorAll('[data-action="filter"]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    drawGallery();
    return;
  }
  if (action === 'discover-open') return showMedia(discovery.items[discovery.index], { origin: button, fromDiscovery: true });
  if (['discover-kind', 'discover-shuffle', 'discover-previous', 'discover-next'].includes(action)) {
    if (action === 'discover-kind') shuffleDiscovery(id);
    if (action === 'discover-shuffle') shuffleDiscovery();
    if (action === 'discover-previous') discovery.index--;
    if (action === 'discover-next') discovery.index++;
    render();
    const control = [...document.querySelectorAll('[data-action="' + action + '"]:not(:disabled)')]
      .find(element => action !== 'discover-kind' || element.dataset.id === id);
    (control || document.querySelector('[data-action="discover-open"]'))?.focus({ preventScroll: true });
    return;
  }
  if (action === 'upload' && !state.owner?.mediaPaused) return showUpload();
  if (action === 'pause') return activeUpload?.abort();
  if (action === 'close') return closeDialog();
  if (action === 'viewer-previous') return stepViewer(-1);
  if (action === 'viewer-next') return stepViewer(1);
  if (action === 'viewer-auto') {
    viewing.automatic = !viewing.automatic;
    button.setAttribute('aria-pressed', String(viewing.automatic));
    viewing.syncAuto?.();
    return;
  }
  if (action === 'media') {
    const item = visibleItems.find(item => item.id === id);
    if (item) return showMedia(item, { origin: button });
    return;
  }
  if (action === 'copy') {
    const input = document.querySelector('#invite-url');
    try {
      await navigator.clipboard.writeText(input.value);
      flash('Invitation link copied.');
    } catch {
      input.focus();
      input.select();
      flash('Select Copy to share the link.');
    }
    return;
  }
  button.disabled = true;
  try {
    if (action === 'logout') {
      await request('/api/auth/logout', { method: 'POST' });
      state.user = state.owner = state.invite = null;
      state.items = [];
      state.collections = [];
      discovery = { kind: 'all', items: [], index: 0 };
      state.query = '';
      state.filter = 'all';
      state.sort = 'new';
      signedOut();
      return;
    }
    if (action === 'favourite') {
      const favourite = button.getAttribute('aria-pressed') !== 'true';
      setMessage(dialog.querySelector('.viewer-message'), '');
      await updateMedia(id, { favourite });
      if (viewing?.id === id && dialog.open) {
        dialog.querySelector('[data-action="favourite"]')?.setAttribute('aria-pressed', String(favourite));
      }
      return;
    }
    if (action === 'revoke') {
      if (!confirm('Revoke this guest’s access?')) return;
      await request('/api/invites/' + id, { method: 'DELETE' });
      if (state.invite?.id === id) state.invite = null;
      flash('Guest access revoked.');
    }
    if (action === 'trash-item') {
      await request('/api/media/' + id, { method: 'DELETE' });
      closeDialog();
      flash('Moved to trash.');
    }
    if (action === 'restore') {
      await request('/api/media/' + id + '/restore', { method: 'POST' });
      flash('Media restored.');
    }
    if (action === 'purge') {
      if (!confirm('Permanently delete this original file?')) return;
      await request('/api/media/' + id + '/purge', { method: 'DELETE' });
      flash('Media deleted.');
    }
    if (action === 'discard-upload') {
      if (activeUpload || !confirm('Remove this interrupted upload?')) return;
      await request('/api/uploads/' + id, { method: 'DELETE' });
      await refresh();
      setMessage(dialog.querySelector('#upload-space'), bytes(state.owner.usage.available) + ' available for new files');
      drawPendingUploads();
      setMessage(dialog.querySelector('#upload-message'), 'Interrupted upload canceled.');
      return;
    }
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      state.user = state.owner = state.invite = null;
      closeDialog();
      signedOut();
    }
    if (action === 'favourite' && button.isConnected && dialog.open) {
      setMessage(dialog.querySelector('.viewer-message'), error.message);
    } else flash(error.message);
  } finally {
    button.disabled = false;
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'search') {
    state.query = event.target.value;
    drawGallery();
  }
});
document.addEventListener('change', event => {
  if (event.target.id === 'sort') {
    state.sort = event.target.value;
    drawGallery();
  }
  if (event.target.id === 'files') chooseFiles(event.target.files);
});

try {
  if (entryToken) {
    signedOut(entryMode);
  } else {
    const session = await request('/api/session');
    state.user = session.user;
    if (state.user) await refresh();
    else signedOut();
  }
} catch (error) {
  signedOut();
  flash(error.message);
}
