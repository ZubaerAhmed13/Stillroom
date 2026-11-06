const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const notice = document.querySelector('#notice');
const inviteToken = location.pathname === '/invite' ? location.hash.slice(1) : '';
if (location.hash && location.pathname === '/invite') history.replaceState(null, '', '/invite');

const icons = {
  library: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
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
const tabs = [
  ['library', 'Library', 'library'],
  ['invites', 'Invitations', 'users'],
  ['trash', 'Trash', 'trash']
];
const state = { user: null, items: [], owner: null, view: 'library', filter: 'all', query: '', sort: 'new', invite: null };
let activeUpload = null;
let selectedFiles = [];
let noticeTimer;
let galleryRevision = 0;
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

function signedOut(invitation = false) {
  app.innerHTML = `
    <main id="main" class="entry">
      <section class="entry-visual" aria-label="Stillroom private media library">
        ${brand}
        <div class="entry-art" aria-hidden="true"><div></div><div></div><div></div></div>
        <div class="entry-copy"><span class="eyebrow">A PRIVATE COLLECTION</span><h1>A place for the<br>moments you keep.</h1><p>Photos and films, shared with the people you choose.</p></div>
      </section>
      <section class="entry-form">
        <div class="entry-fields">
          <span class="pill">${icon('lock')} Invitation only</span>
          <h2>${invitation ? 'Accept your invitation' : 'Welcome back'}</h2>
          <p>${invitation ? 'Create a password to enter the library.' : 'Sign in to your private library.'}</p>
          <form id="auth-form" data-invitation="${invitation}">
            ${invitation ? '' : '<label>Email address<input name="email" type="email" maxlength="254" required autocomplete="username" placeholder="you@example.com"></label>'}
            <label>Password<input name="password" type="password" ${invitation ? 'minlength="12"' : ''} maxlength="128" required autocomplete="${invitation ? 'new-password' : 'current-password'}" placeholder="${invitation ? 'At least 12 characters' : 'Enter your password'}"></label>
            <p class="form-message" role="status"></p>
            <button class="button primary wide" type="submit">${invitation ? 'Join Stillroom' : 'Sign in'} ${icon('arrow')}</button>
          </form>
          ${invitation ? '<a class="quiet-link" href="/">Back to sign in</a>' : '<p class="entry-foot">Need access? Ask the library owner for an invitation.</p>'}
        </div>
      </section>
    </main>`;
}

function isOwner() { return state.user?.role === 'owner'; }

async function refresh() {
  const [catalog, owner] = await Promise.all([
    request('/api/media'), isOwner() ? request('/api/owner') : null
  ]);
  state.items = catalog.items;
  state.owner = owner;
  render();
}

function render() {
  const label = state.user.email.split('@')[0].slice(0, 2).toUpperCase();
  app.innerHTML = `
    <div class="workspace">
      <aside class="sidebar">
        ${brand}
        <nav aria-label="Workspace">
          <span class="nav-label">WORKSPACE</span>
          ${tabs.filter(([name]) => isOwner() || name === 'library').map(([name, title, image]) =>
            `<button class="nav-item" type="button" data-action="nav" data-id="${name}" ${state.view === name ? 'aria-current="page"' : ''}>${icon(image)}<span>${title}</span></button>`).join('')}
        </nav>
        <div class="sidebar-foot">
          <div class="profile"><span class="avatar" aria-hidden="true">${escapeHtml(label)}</span><div><strong>${isOwner() ? 'Owner' : 'Guest'}</strong><small title="${escapeHtml(state.user.email)}">${escapeHtml(state.user.email)}</small></div><button class="icon-button" type="button" data-action="logout" aria-label="Sign out" title="Sign out">${icon('exit')}</button></div>
        </div>
      </aside>
      <main id="main" class="main">
        <header class="topline"><span>YOUR WORKSPACE <span class="divider">/</span> ${state.view === 'library' ? 'Library' : state.view === 'invites' ? 'Invitations' : 'Trash'}</span><span class="pill">${icon('lock')} Private</span></header>
        ${state.view === 'library' ? libraryPage() : state.view === 'invites' ? invitesPage() : trashPage()}
      </main>
    </div>`;
  if (state.view === 'library') drawGallery();
}

function storageMeter({ limit, total, available, trash, reserved }) {
  const nearLimit = total >= limit * 0.8;
  const breakdown = [trash ? bytes(trash) + ' in Trash' : '', reserved ? bytes(reserved) + ' reserved for uploads' : '']
    .filter(Boolean).join(' · ');
  return `<section class="storage${nearLimit ? ' near-limit' : ''}" aria-labelledby="storage-title">
    <div><h3 id="storage-title">Free-tier protection</h3><strong>${bytes(total)} / ${bytes(limit)}</strong></div>
    <progress max="${limit}" value="${Math.min(total, limit)}" aria-label="Storage used and reserved"></progress>
    <p>${available ? bytes(available) + ' available' : 'At limit. New uploads are blocked.'}${breakdown ? ' · ' + breakdown : ''}</p>
  </section>`;
}

function libraryPage() {
  const photos = state.items.filter(item => item.kind === 'photo').length;
  const videos = state.items.length - photos;
  const interrupted = state.owner?.pending.length || 0;
  return `
    <section class="hero" aria-labelledby="library-title">
      <div class="hero-art" aria-hidden="true"><span></span><span></span><span></span></div>
      <div class="hero-copy"><span class="eyebrow"><i></i> YOUR COLLECTION</span><h1 id="library-title">Media library</h1><p>A private home for your photos and videos.</p></div>
      <div class="hero-stats"><span>${icon('photo')} <strong>${photos}</strong> ${photos === 1 ? 'photo' : 'photos'}</span><span>${icon('video')} <strong>${videos}</strong> ${videos === 1 ? 'video' : 'videos'}</span></div>
    </section>
    <section class="collection" aria-labelledby="collection-title">
      <div class="section-heading"><div><h2 id="collection-title">Collection</h2><p>Browse your saved moments.</p></div>
        ${isOwner() ? `<button class="button primary" type="button" data-action="upload">${icon('up')} Upload media</button>` : ''}
      </div>
      ${isOwner() ? storageMeter(state.owner.usage) : ''}
      ${interrupted ? `<button class="pending-banner" type="button" data-action="upload">${icon('clock')} ${interrupted} interrupted ${interrupted === 1 ? 'upload' : 'uploads'} ${icon('arrow')}</button>` : ''}
      <div class="collection-tools">
        <div class="filters" aria-label="Filter media">
          ${[['all', 'All media'], ['photo', 'Photos'], ['video', 'Videos']].map(([key, label]) => `<button type="button" data-action="filter" data-id="${key}" aria-pressed="${state.filter === key}">${label}</button>`).join('')}
        </div>
        <div class="search-tools">
          <label class="search">${icon('search')}<span class="sr-only">Search media</span><input type="search" id="search" placeholder="Search media" value="${escapeHtml(state.query)}"></label>
          <label class="sort"><span class="sr-only">Sort media</span><select id="sort"><option value="new" ${state.sort === 'new' ? 'selected' : ''}>Newest</option><option value="old" ${state.sort === 'old' ? 'selected' : ''}>Oldest</option><option value="name" ${state.sort === 'name' ? 'selected' : ''}>A–Z</option></select></label>
        </div>
      </div>
      <div id="gallery"></div>
    </section>`;
}

function drawGallery() {
  const gallery = document.querySelector('#gallery');
  if (!gallery) return;
  thumbnailObserver?.disconnect();
  const revision = ++galleryRevision;
  const query = state.query.trim().toLowerCase();
  const items = state.items.filter(item => (state.filter === 'all' || item.kind === state.filter) && (item.title + ' ' + item.name).toLowerCase().includes(query));
  if (state.sort === 'old') items.sort((a, b) => a.created - b.created);
  if (state.sort === 'name') items.sort((a, b) => a.title.localeCompare(b.title));
  if (!items.length) {
    const empty = !state.items.length && state.filter === 'all' && !query;
    gallery.innerHTML = `<div class="empty"><div class="empty-icon">${icon('photo')}</div><h3>${empty ? 'Your collection is empty' : 'No matching media'}</h3><p>${empty ? (isOwner() ? 'Add a photo or video to get started.' : 'Shared photos and videos will appear here.') : 'Try a different search or filter.'}</p>${empty && isOwner() ? '<button type="button" class="button secondary" data-action="upload">Add your first file</button>' : ''}</div>`;
    return;
  }
  gallery.innerHTML = '<div class="gallery-grid">' + items.map(item => `
    <button class="media-card" type="button" data-action="media" data-id="${item.id}">
      <span class="card-cover ${item.kind}">${icon(item.kind === 'video' ? 'play' : 'photo')}${item.kind === 'photo' ? `<img alt="" data-thumb="${item.id}" hidden>` : ''}<span class="kind">${item.kind === 'video' ? 'Video' : 'Photo'}</span></span>
      <span class="card-details"><strong>${escapeHtml(item.title)}</strong><small>${date(item.created)} <span>·</span> ${bytes(item.size)}</small></span>
    </button>`).join('') + '</div>';
  const images = [...gallery.querySelectorAll('[data-thumb]')];
  const load = async image => {
    if (revision !== galleryRevision) return;
    try {
      const { url } = await request('/api/media/' + image.dataset.thumb + '/link');
      if (revision !== galleryRevision) return;
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
  return `<section class="page-head"><span class="eyebrow">ACCESS CONTROL</span><h1>Invitations</h1><p>Choose who can view your library. ${used} of ${limit} guest slots used.</p></section>
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
  return `<section class="page-head"><span class="eyebrow">COLLECTION MANAGEMENT</span><h1>Trash</h1><p>Restore an item to the library or delete its original file.</p></section>
    <section class="panel" aria-labelledby="trash-head"><h2 id="trash-head">Deleted media</h2>
      ${items.length ? '<ul class="list">' + items.map(item => `<li><span class="list-icon">${icon(item.kind)}</span><div class="list-info"><strong>${escapeHtml(item.title)}</strong><small>${bytes(item.size)}</small></div><button class="button quiet" type="button" data-action="restore" data-id="${item.id}">Restore</button><button class="button quiet danger-text" type="button" data-action="purge" data-id="${item.id}">Delete forever</button></li>`).join('') + '</ul>' : '<p class="muted">Trash is empty.</p>'}
    </section>`;
}

function openDialog(title, contents, kind = '') {
  playerCleanup();
  playerCleanup = () => {};
  dialog.className = kind;
  dialog.innerHTML = `<header class="dialog-head"><h2 id="dialog-title">${escapeHtml(title)}</h2><button class="icon-button" type="button" data-action="close" aria-label="Close">${icon('close')}</button></header>` + contents;
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
  selectedFiles = [];
  dialog.innerHTML = '';
});

async function showMedia(item) {
  openDialog(item.title, `<div id="viewer" class="viewer"><p role="status">Opening media…</p></div>
    <footer class="dialog-foot"><span class="muted">${escapeHtml(item.name)} · ${bytes(item.size)}</span>
    ${isOwner() ? `<button class="button quiet danger-text" type="button" data-action="trash-item" data-id="${item.id}">${icon('trash')} Move to trash</button>` : ''}</footer>`, 'media-dialog');
  const viewer = dialog.querySelector('#viewer');
  try {
    const route = '/api/media/' + item.id + '/link';
    const link = await request(route);
    let expires = link.expires;
    if (!viewer.isConnected) return;
    const element = document.createElement(item.kind === 'video' ? 'video' : 'img');
    if (item.kind === 'video') {
      element.controls = true;
      element.playsInline = true;
      element.preload = 'metadata';
      let refreshed = false;
      element.addEventListener('error', async () => {
        if (!element.isConnected) return;
        if (!refreshed || expires <= Date.now() + 5000) {
          refreshed = true;
          const time = element.currentTime;
          try {
            const fresh = await request(route);
            if (!element.isConnected) return;
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
      element.addEventListener('error', () => setMessage(viewer, 'This photo could not be opened.'));
    }
    viewer.replaceChildren(element);
    element.src = link.url;
  } catch (error) {
    setMessage(viewer, error.message);
  }
}

const fileTypes = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' };

function showUpload() {
  openDialog('Upload media', `
    <form id="upload-form" class="dialog-body">
      <p id="upload-space" class="upload-space">${bytes(state.owner.usage.available)} available for new files</p>
      <label class="drop" id="drop-zone">${icon('up')}<strong>Choose photos or videos</strong><span>or drop files here</span><small>JPG, PNG, WebP, GIF, MP4 or WebM · Up to 4 GiB each</small><input id="files" type="file" multiple accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.m4v,.webm" aria-label="Choose photos or videos"></label>
      <p id="selection" class="muted" role="status"></p>
      <label id="title-field" hidden>Title (optional)<input id="upload-title" maxlength="120" placeholder="Use the file name"></label>
      <progress id="upload-progress" max="1" value="0" aria-label="Upload progress" hidden></progress>
      <p id="upload-message" class="form-message" role="status"></p>
      <div class="form-actions"><button class="button quiet" type="button" data-action="pause" hidden>Pause</button><button class="button primary" id="upload-submit" type="submit" disabled>${icon('up')} Upload</button></div>
    </form>
    ${state.owner.pending.length ? `<div class="resume-box"><h3>Interrupted uploads</h3><p>Choose the same file again to resume from the last saved part.</p><ul class="list">${state.owner.pending.map(item => `<li><div class="list-info"><strong>${escapeHtml(item.name)}</strong><small>${bytes(item.offset)} of ${bytes(item.size)}</small></div><button class="button quiet" type="button" data-action="discard-upload" data-id="${item.id}">Remove</button></li>`).join('')}</ul></div>` : ''}`, 'upload-dialog');
  const drop = dialog.querySelector('#drop-zone');
  drop.addEventListener('dragover', event => { event.preventDefault(); drop.classList.add('dragging'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    if (!activeUpload) chooseFiles(event.dataTransfer.files);
  });
  chooseFiles(selectedFiles);
}

function chooseFiles(files) {
  selectedFiles = [...files];
  const count = selectedFiles.length;
  setMessage(dialog.querySelector('#selection'), count === 1 ? selectedFiles[0].name : count ? count + ' files selected' : '');
  dialog.querySelector('#title-field').hidden = count !== 1;
  dialog.querySelector('#upload-submit').disabled = !count;
}

async function fingerprint(file) {
  const sampleSize = 65536;
  const sample = new Blob([
    file.slice(0, sampleSize), file.slice(Math.max(0, file.size - sampleSize)),
    JSON.stringify([file.name, file.size, file.lastModified])
  ]);
  const hash = await crypto.subtle.digest('SHA-256', await sample.arrayBuffer());
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function uploadFiles() {
  if (activeUpload || !selectedFiles.length) return;
  const submit = dialog.querySelector('#upload-submit');
  const pause = dialog.querySelector('[data-action="pause"]');
  const progress = dialog.querySelector('#upload-progress');
  const message = dialog.querySelector('#upload-message');
  const input = dialog.querySelector('#files');
  const titleField = dialog.querySelector('#upload-title');
  const title = selectedFiles.length === 1 ? titleField.value : '';
  const controller = new AbortController();
  activeUpload = controller;
  const signal = controller.signal;
  submit.disabled = input.disabled = titleField.disabled = true;
  pause.hidden = false;
  progress.hidden = false;
  let added = 0;
  try {
    for (const file of selectedFiles) {
      progress.value = 0;
      setMessage(message, 'Preparing ' + file.name + '…');
      const mime = fileTypes[file.name.split('.').pop().toLowerCase()];
      if (!mime) throw new Error('Unsupported format: ' + file.name);
      const hash = await fingerprint(file);
      const upload = await request('/api/uploads', { method: 'POST', signal, body: { name: file.name, title, mime, size: file.size, fingerprint: hash } });
      let offset = upload.offset;
      progress.value = offset / file.size;
      while (offset < file.size) {
        setMessage(message, 'Uploading ' + file.name + ' · ' + Math.floor(progress.value * 100) + '%');
        const result = await request('/api/uploads/' + upload.id + '?offset=' + offset, {
          method: 'PUT', body: file.slice(offset, offset + upload.chunkSize), binary: true, signal
        });
        offset = result.offset;
        progress.value = offset / file.size;
      }
      if (!upload.complete) {
        await request('/api/uploads/' + upload.id + '/finish', { method: 'POST', signal });
        added++;
      }
    }
    activeUpload = null;
    closeDialog();
    await refresh();
    flash(added ? (added === 1 ? 'Media uploaded.' : added + ' files uploaded.') : 'These files are already in your library.');
  } catch (error) {
    const paused = error.name === 'AbortError';
    setMessage(message, paused ? 'Upload paused. Select Resume to continue.' : (error instanceof TypeError ? 'Connection interrupted. Select Resume to try again.' : error.message));
    submit.innerHTML = icon('up') + (error.code === 'storage_limit' ? ' Try again' : ' Resume');
    if (dialog.open) {
      try {
        await refresh();
        setMessage(dialog.querySelector('#upload-space'), bytes(state.owner.usage.available) + ' available for new files');
      } catch { /* the dialog retains its retry state */ }
    } else {
      flash(error.message);
    }
  } finally {
    activeUpload = null;
    submit.disabled = input.disabled = titleField.disabled = false;
    pause.hidden = true;
  }
}

document.addEventListener('submit', async event => {
  const form = event.target;
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
      const accepting = form.dataset.invitation === 'true';
      const body = accepting ? { token: inviteToken, password: fields.get('password') } : { email: fields.get('email'), password: fields.get('password') };
      const { user } = await request('/api/auth/' + (accepting ? 'redeem' : 'login'), { method: 'POST', body });
      state.user = user;
      state.view = 'library';
      if (accepting) history.replaceState(null, '', '/');
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
  if (action === 'nav') {
    state.view = id;
    render();
    document.querySelector('[aria-current="page"]')?.focus();
    return;
  }
  if (action === 'filter') {
    state.filter = id;
    document.querySelectorAll('[data-action="filter"]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    drawGallery();
    return;
  }
  if (action === 'upload') return showUpload();
  if (action === 'pause') return activeUpload?.abort();
  if (action === 'close') return closeDialog();
  if (action === 'media') return showMedia(state.items.find(item => item.id === id));
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
      state.query = '';
      state.filter = 'all';
      state.sort = 'new';
      signedOut();
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
      showUpload();
      flash('Interrupted upload removed.');
      return;
    }
    await refresh();
  } catch (error) {
    if (error.status === 401) {
      state.user = state.owner = state.invite = null;
      closeDialog();
      signedOut();
    }
    flash(error.message);
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
  if (inviteToken) {
    signedOut(true);
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
