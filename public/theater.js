// Stillroom's distraction-free video and photo theater.
// Each opening owns its keyboard/touch listeners, playback, and signed media URLs.
export function startTheater({ root, items, initialId, random = false, requestLink, close, icon, bytes, date, onTrack }) {
  if (!items.length) return () => {};
  const original = items.slice();
  const shuffleList = input => {
    const result = input.slice();
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };
  let shuffled = random;
  let queue = random ? shuffleList(original) : original.slice();
  let index = Math.max(0, queue.findIndex(item => item.id === initialId));
  let closed = false;
  let version = 0;
  let media = null;
  let touchStart = null;
  let lastChange = 0;
  const isVideo = original[0].kind === 'video';

  root.innerHTML =
    '<section class="theater-shell" aria-label="Stillroom media player">' +
      '<div class="theater-stage">' +
        '<div class="theater-topline"><span class="theater-wordmark">STILLROOM <span>WATCH</span></span><span id="theater-current-type"></span></div>' +
        '<div id="theater-screen" class="theater-screen" tabindex="0" aria-label="Video. Press OK or Space to pause or play"></div>' +
        '<div class="theater-stage-foot"><span id="theater-status" role="status" aria-live="polite">Opening…</span>' +
          '<div class="theater-progress"><input id="theater-seek" aria-label="Seek video" type="range" min="0" max="1000" value="0"><span id="theater-time">0:00 / 0:00</span></div>' +
        '</div>' +
      '</div>' +
      '<aside class="theater-info" aria-label="Current media details">' +
        '<div class="theater-info-top"><span class="theater-chip" id="theater-kind"></span><span class="theater-count" id="theater-count"></span></div>' +
        '<div class="theater-copy"><h2 id="theater-title"></h2><p id="theater-meta"></p><p id="theater-file"></p></div>' +
        '<div class="theater-actions">' +
          '<button type="button" class="theater-action" data-player-action="toggle" aria-label="Pause or play">' + icon('pause') + '<span>Pause</span></button>' +
          '<button type="button" class="theater-action" data-player-action="mute" aria-label="Mute or unmute">' + icon('volume') + '<span>Sound</span></button>' +
          '<button type="button" class="theater-action" data-player-action="shuffle" aria-pressed="false">' + icon('shuffle') + '<span>Shuffle</span></button>' +
          '<button type="button" class="theater-action" data-player-action="fullscreen">' + icon('expand') + '<span>Full screen</span></button>' +
        '</div>' +
        '<div class="theater-navigation">' +
          '<button type="button" class="theater-nav" data-player-action="previous" aria-label="Previous media">' + icon('arrow-up') + '<span>Previous</span></button>' +
          '<button type="button" class="theater-nav" data-player-action="next" aria-label="Next media">' + icon('arrow-down') + '<span>Next</span></button>' +
        '</div>' +
        '<p class="theater-remote-hint">TV remote: ↑ previous · ↓ next · OK pause/play</p>' +
        '<div class="theater-owner-actions" id="theater-owner-actions"></div>' +
      '</aside>' +
    '</section>';
  const $ = selector => root.querySelector(selector);
  const screen = $('#theater-screen');
  const status = $('#theater-status');
  const seek = $('#theater-seek');
  const time = $('#theater-time');
  const toggleButton = $('[data-player-action="toggle"]');
  const muteButton = $('[data-player-action="mute"]');
  const shuffleButton = $('[data-player-action="shuffle"]');
  const info = $('.theater-info');
  if (!isVideo) {
    root.classList.add('is-photo-theater');
    screen.setAttribute('aria-label', 'Photo. Use Up and Down to move between photos');
    toggleButton.hidden = true;
    muteButton.hidden = true;
    $('.theater-progress').hidden = true;
  }
  const formatTime = seconds => {
    if (!Number.isFinite(seconds)) return '0:00';
    const s = Math.floor(Math.max(0, seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const updateProgress = () => {
    if (!media || !isVideo) return;
    const length = Number.isFinite(media.duration) ? media.duration : 0;
    seek.value = String(length ? Math.round(media.currentTime / length * 1000) : 0);
    time.textContent = formatTime(media.currentTime) + ' / ' + formatTime(length);
  };
  const setStatus = message => { status.textContent = message; };
  const updatePlayButton = () => {
    if (!isVideo || !media) return;
    const paused = media.paused;
    toggleButton.innerHTML = icon(paused ? 'play' : 'pause') + '<span>' + (paused ? 'Play' : 'Pause') + '</span>';
    toggleButton.setAttribute('aria-label', paused ? 'Play video' : 'Pause video');
  };
  const updateSoundButton = () => {
    if (!isVideo || !media) return;
    muteButton.innerHTML = icon(media.muted ? 'mute' : 'volume') + '<span>' + (media.muted ? 'Unmute' : 'Sound') + '</span>';
    muteButton.setAttribute('aria-label', media.muted ? 'Unmute video' : 'Mute video');
  };
  const disposeMedia = () => {
    if (media?.tagName === 'VIDEO') {
      media.pause();
      media.removeAttribute('src');
      media.load();
    } else if (media) {
      media.removeAttribute('src');
    }
    media = null;
    screen.replaceChildren();
  };
  async function showAt(nextIndex) {
    if (closed) return;
    version++;
    const currentVersion = version;
    disposeMedia();
    index = (nextIndex + queue.length) % queue.length;
    const item = queue[index];
    $('#theater-kind').textContent = item.kind === 'video' ? 'VIDEO' : 'PHOTO';
    $('#theater-current-type').textContent = item.kind === 'video' ? 'Video playback' : 'Photo viewer';
    $('#theater-count').textContent = (index + 1) + ' / ' + queue.length;
    $('#theater-title').textContent = item.title || item.name || 'Untitled';
    $('#theater-meta').textContent = date(item.created) + ' · ' + bytes(item.size);
    $('#theater-file').textContent = item.name || '';
    const deleteButton = $('[data-action="trash-item"]');
    if (deleteButton) deleteButton.dataset.id = item.id;
    if (onTrack) onTrack(item);
    screen.classList.remove('landscape');
    seek.value = '0';
    time.textContent = '0:00 / 0:00';
    setStatus('Opening ' + (item.kind === 'video' ? 'video' : 'photo') + '…');
    try {
      const link = await requestLink(item);
      if (closed || currentVersion !== version) return;
      const element = document.createElement(item.kind === 'video' ? 'video' : 'img');
      media = element;
      element.setAttribute('aria-label', item.title || item.kind);
      if (item.kind === 'video') {
        element.playsInline = true;
        element.loop = true;
        element.preload = 'metadata';
        element.addEventListener('loadedmetadata', () => {
          screen.classList.toggle('landscape', element.videoWidth >= element.videoHeight);
          updateProgress();
        });
        element.addEventListener('timeupdate', updateProgress);
        element.addEventListener('play', () => { updatePlayButton(); setStatus('Playing · repeats until paused'); });
        element.addEventListener('pause', () => { updatePlayButton(); if (media === element) setStatus('Paused'); });
        let retried = false;
        element.addEventListener('error', async () => {
          if (closed || currentVersion !== version || element !== media) return;
          if (retried) {
            setStatus('Playback unavailable. Try an MP4 (H.264/AAC) or WebM supported by your TV.');
            return;
          }
          retried = true;
          const position = element.currentTime || 0;
          try {
            const fresh = await requestLink(item);
            if (closed || currentVersion !== version || element !== media) return;
            element.addEventListener('loadedmetadata', () => { element.currentTime = Math.min(position, element.duration || position); }, { once: true });
            element.src = fresh.url;
            element.play().catch(() => setStatus('Press Play to resume playback.'));
          } catch {
            setStatus('Unable to refresh video link. Reopen the clip.');
          }
        });
        screen.replaceChildren(element);
        element.src = link.url;
        updatePlayButton();
        updateSoundButton();
        element.play().catch(() => { if (media === element) setStatus('Press Play to begin playback.'); });
      } else {
        element.alt = item.title || 'Photo';
        element.addEventListener('error', () => { if (media === element) setStatus('Photo unavailable. Try reopening it.'); });
        element.addEventListener('load', () => { if (media === element) setStatus('Photo'); });
        screen.replaceChildren(element);
        element.src = link.url;
      }
    } catch (error) {
      if (!closed && currentVersion === version) setStatus(error.message || 'Unable to open this media.');
    }
  }
  function move(step) {
    if (closed || queue.length < 2) return;
    lastChange = Date.now();
    showAt(index + step);
  }
  function togglePlay() {
    if (!isVideo || !media) return;
    if (media.paused) media.play().catch(() => setStatus('This video cannot start on this device.'));
    else media.pause();
  }
  function changeShuffle() {
    const current = queue[index];
    shuffled = !shuffled;
    queue = shuffled ? [current, ...shuffleList(original.filter(item => item.id !== current.id))] : original.slice();
    index = queue.findIndex(item => item.id === current.id);
    shuffleButton.setAttribute('aria-pressed', String(shuffled));
    shuffleButton.querySelector('span').textContent = shuffled ? 'Shuffle on' : 'Shuffle';
    $('#theater-count').textContent = (index + 1) + ' / ' + queue.length;
  }
  function seekBy(seconds) {
    if (!isVideo || !media || !Number.isFinite(media.duration)) return;
    media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + seconds));
  }
  function onButtonClick(event) {
    const button = event.target.closest('[data-player-action]');
    if (!button || !root.contains(button)) return;
    const action = button.dataset.playerAction;
    if (action === 'next') move(1);
    if (action === 'previous') move(-1);
    if (action === 'toggle') togglePlay();
    if (action === 'mute' && media && isVideo) { media.muted = !media.muted; updateSoundButton(); }
    if (action === 'shuffle') changeShuffle();
    if (action === 'fullscreen') {
      const target = root.closest('dialog') || root;
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else target.requestFullscreen?.().catch(() => setStatus('Full screen is not supported on this device.'));
    }
  }
  function onKeydown(event) {
    if (closed || !root.isConnected) return;
    const tag = event.target?.tagName;
    const onControl = ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(tag);
    if (tag === 'TEXTAREA' || event.target?.isContentEditable) return;
    if (event.key === 'ArrowDown' || event.key === 'MediaTrackNext') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp' || event.key === 'MediaTrackPrevious') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'ArrowRight') {
      if (isVideo) { event.preventDefault(); seekBy(10); }
    } else if (event.key === 'ArrowLeft') {
      if (isVideo) { event.preventDefault(); seekBy(-10); }
    } else if (event.key === ' ' || event.key === 'MediaPlayPause' || (event.key === 'Enter' && !onControl)) {
      if (!onControl || event.key === 'MediaPlayPause') { event.preventDefault(); togglePlay(); }
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      close();
    }
  }
  function onTouchStart(event) {
    if (event.touches.length !== 1) return;
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
  function onTouchEnd(event) {
    if (!touchStart || !event.changedTouches.length) return;
    const dx = event.changedTouches[0].clientX - touchStart.x;
    const dy = event.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dy) >= 65 && Math.abs(dy) > Math.abs(dx) * 1.3) move(dy < 0 ? 1 : -1);
  }
  function onWheel(event) {
    if (Math.abs(event.deltaY) < 15 || Date.now() - lastChange < 650) return;
    event.preventDefault();
    move(event.deltaY > 0 ? 1 : -1);
  }
  function onScreenClick() {
    if (Date.now() - lastChange > 350) togglePlay();
  }
  function onSeek(event) {
    if (!isVideo || !media || !Number.isFinite(media.duration)) return;
    media.currentTime = media.duration * Number(event.target.value) / 1000;
  }
  root.addEventListener('click', onButtonClick);
  screen.addEventListener('click', onScreenClick);
  root.addEventListener('touchstart', onTouchStart, { passive: true });
  root.addEventListener('touchend', onTouchEnd, { passive: true });
  root.addEventListener('wheel', onWheel, { passive: false });
  seek.addEventListener('input', onSeek);
  document.addEventListener('keydown', onKeydown, true);
  shuffleButton.setAttribute('aria-pressed', String(shuffled));
  shuffleButton.querySelector('span').textContent = shuffled ? 'Shuffle on' : 'Shuffle';
  if (queue.length <= 1) root.classList.add('single-item');
  showAt(index);
  toggleButton.focus({ preventScroll: true });
  return () => {
    closed = true;
    version++;
    disposeMedia();
    root.removeEventListener('click', onButtonClick);
    screen.removeEventListener('click', onScreenClick);
    root.removeEventListener('touchstart', onTouchStart);
    root.removeEventListener('touchend', onTouchEnd);
    root.removeEventListener('wheel', onWheel);
    seek.removeEventListener('input', onSeek);
    document.removeEventListener('keydown', onKeydown, true);
  };
}
