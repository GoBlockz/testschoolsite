(() => {
  const roomIcons = {
    gaming: 'i-game',
    school: 'i-school',
    creative: 'i-spark',
    music: 'i-music',
    life: 'i-sun',
    random: 'i-random'
  };
  const state = {
    user: null,
    rooms: [],
    posts: [],
    activeRoom: 'all',
    sort: 'recent',
    search: '',
    selectedFile: null,
    openReplies: new Set(),
    authMode: 'login',
    toastTimer: null,
    searchTimer: null,
    loadVersion: 0
  };
  const $ = selector => document.querySelector(selector);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  }

  function icon(name, className = 'icon') {
    return `<svg class="${className}" aria-hidden="true"><use href="/icons.svg#${name}"></use></svg>`;
  }

  function avatarMarkup(person, extraClass = 'avatar') {
    const label = person.displayName || person.username || 'Member';
    return `<span class="${extraClass}">${person.avatarUrl ? `<img src="${escapeHtml(person.avatarUrl)}" alt="">` : escapeHtml(label.trim().slice(0, 1).toUpperCase())}</span>`;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    let body = options.body;
    if (body && !(body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(body);
    }
    const response = await fetch(path, { ...options, headers, body, credentials: 'same-origin' });
    if (response.status === 204) return null;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Something went wrong. Please try again.');
    return result;
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function relativeTime(timestamp) {
    const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp);
  }

  function currentRoom() {
    return state.rooms.find(room => room.id === state.activeRoom) || null;
  }

  function renderRoomControls() {
    const rooms = [{ id: 'all', label: 'Everything', postCount: state.rooms.reduce((total, room) => total + room.postCount, 0) }, ...state.rooms];
    const navMarkup = rooms.map(room => {
      const symbol = room.id === 'all' ? 'i-home' : roomIcons[room.id] || 'i-random';
      return `<button class="room-link${state.activeRoom === room.id ? ' active' : ''}" type="button" data-room="${room.id}">${icon(symbol)}<span>${escapeHtml(room.label)}</span><span class="room-count">${room.postCount}</span></button>`;
    }).join('');
    $('#room-nav').innerHTML = navMarkup;
    const selectOptions = state.rooms.map(room => `<option value="${room.id}">${escapeHtml(room.label)}</option>`).join('');
    $('#compose-room').innerHTML = selectOptions;
    const selectedRoom = currentRoom();
    $('#compose-room').value = selectedRoom?.id || state.rooms[0]?.id || '';
    $('#room-title').textContent = selectedRoom?.label || 'The common room';
    $('#room-description').textContent = selectedRoom?.description || 'The good, the weird, the in-between. Pull up a chair.';
    $('#room-kicker').textContent = selectedRoom ? 'A room of its own' : 'A little bit of everything';
    const count = selectedRoom?.postCount ?? rooms[0].postCount;
    $('#room-total').textContent = `${count} ${count === 1 ? 'conversation' : 'conversations'}`;

    const suggestions = [...state.rooms].filter(room => room.id !== state.activeRoom).sort((left, right) => right.postCount - left.postCount).slice(0, 3);
    $('#discovery-list').innerHTML = suggestions.map(room => `<button class="discovery-room" type="button" data-room="${room.id}"><span class="discovery-top"><span class="discovery-name">${icon(roomIcons[room.id] || 'i-random')}${escapeHtml(room.label)}</span><span class="discovery-count">${room.postCount} ${room.postCount === 1 ? 'post' : 'posts'}</span></span><p>${escapeHtml(room.description)}</p></button>`).join('') || '<p class="site-note">Choose a room to start exploring.</p>';
  }

  function renderAccount() {
    const signedIn = Boolean(state.user);
    $('#account-actions').hidden = signedIn;
    $('#member-actions').hidden = !signedIn;
    $('#admin-trigger').hidden = !state.user?.isAdmin;
    if (!state.user) {
      $('#composer-avatar').innerHTML = icon('i-user');
      $('#post-body').placeholder = 'Log in to start a conversation…';
      return;
    }
    $('#profile-trigger').innerHTML = `${avatarMarkup(state.user)}<span>${escapeHtml(state.user.displayName || state.user.username)}</span>`;
    $('#composer-avatar').innerHTML = avatarMarkup(state.user, 'avatar');
    $('#post-body').placeholder = 'Start a conversation…';
  }

  function renderPosts() {
    if (!state.posts.length) {
      const title = state.search ? 'Nothing came up.' : 'A room with space for you.';
      const description = state.search ? 'Try another word or clear your search.' : 'No one has started this conversation yet. Your post can be the first.';
      $('#posts').innerHTML = `<div class="empty-state"><span class="empty-illustration">${icon('i-spark')}</span><h2>${title}</h2><p>${description}</p></div>`;
      return;
    }

    $('#posts').innerHTML = state.posts.map(post => {
      const canRemove = state.user && (state.user.id === post.userId || state.user.isAdmin);
      const threadOpen = state.openReplies.has(post.id);
      const replies = threadOpen ? `<section class="reply-thread">${post.replies.map(reply => `<div class="reply-entry">${avatarMarkup(reply)}<div class="reply-content"><strong>${escapeHtml(reply.displayName || reply.username)}</strong>${escapeHtml(reply.body)}<time>${relativeTime(reply.createdAt)}</time></div></div>`).join('')}<form class="reply-form" data-reply-form="${post.id}"><input name="body" aria-label="Write a reply" placeholder="Add to the conversation…" maxlength="500" required><button class="button button-quiet" type="submit">Reply</button></form></section>` : '';
      const media = post.mediaUrl ? (post.mediaType?.startsWith('video/') ? `<video class="post-media" src="${escapeHtml(post.mediaUrl)}" controls preload="metadata"></video>` : `<img class="post-media" src="${escapeHtml(post.mediaUrl)}" alt="Photo shared by ${escapeHtml(post.displayName || post.username)}" loading="lazy">`) : '';
      return `<article class="post" data-post="${post.id}">
        <header class="post-header">${avatarMarkup(post)}<div class="post-identity"><span class="post-name">${escapeHtml(post.displayName || post.username)}</span>${post.isAdmin ? '<span class="admin-badge">ADMIN</span>' : ''}<span class="post-handle">@${escapeHtml(post.username)}</span><time class="post-time">${relativeTime(post.createdAt)}</time></div><span class="post-room">${escapeHtml(state.rooms.find(room => room.id === post.room)?.label || post.room)}</span></header>
        ${post.body ? `<div class="post-body">${escapeHtml(post.body)}</div>` : ''}${media}
        <footer class="post-actions"><button class="post-action${post.likedByMe ? ' liked' : ''}" type="button" data-like="${post.id}" aria-label="${post.likedByMe ? 'Unlike' : 'Like'} post">${icon('i-heart')}${post.likes}</button><button class="post-action" type="button" data-replies="${post.id}">${icon('i-reply')}${post.replyCount} ${post.replyCount === 1 ? 'reply' : 'replies'}</button>${canRemove ? `<button class="post-action delete-action" type="button" data-delete="${post.id}" aria-label="Remove post">${icon('i-trash')}Remove</button>` : ''}</footer>
        ${replies}
      </article>`;
    }).join('');
  }

  async function loadPosts() {
    const version = ++state.loadVersion;
    const params = new URLSearchParams({ room: state.activeRoom, sort: state.sort === 'popular' ? 'popular' : 'recent' });
    if (state.search) params.set('search', state.search);
    try {
      const result = await api(`/api/posts?${params}`);
      if (version !== state.loadVersion) return;
      state.posts = result.posts;
      renderPosts();
    } catch (error) {
      $('#posts').innerHTML = `<div class="empty-state"><h2>Could not load the room.</h2><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  async function loadRooms() {
    const result = await api('/api/rooms');
    state.rooms = result.rooms;
    if (state.activeRoom !== 'all' && !state.rooms.some(room => room.id === state.activeRoom)) state.activeRoom = 'all';
    renderRoomControls();
  }

  function setRoom(roomId) {
    if (roomId !== 'all' && !state.rooms.some(room => room.id === roomId)) return;
    state.activeRoom = roomId;
    renderRoomControls();
    loadPosts();
  }

  function openAuth(mode) {
    state.authMode = mode;
    const signup = mode === 'signup';
    $('#auth-title').textContent = signup ? 'Find your people.' : 'Good to see you.';
    $('#auth-description').textContent = signup ? 'One name, one password, and you are in.' : 'Pick up where you left off.';
    $('#auth-submit').textContent = signup ? 'Create account' : 'Log in';
    $('#auth-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('#auth-switch').innerHTML = signup ? 'Already a member? <button class="text-link" type="button" data-switch-auth="login">Log in</button>' : 'New around here? <button class="text-link" type="button" data-switch-auth="signup">Join the room</button>';
    $('#auth-error').textContent = '';
    $('#auth-form').reset();
    syncAdminSetupField();
    $('#auth-dialog').showModal();
    $('#auth-username').focus();
  }

  function syncAdminSetupField() {
    const isAdminSignup = state.authMode === 'signup' && $('#auth-username').value.trim().toLowerCase() === 'admin';
    $('#admin-setup-field').hidden = !isAdminSignup;
    $('#admin-setup-key').required = isAdminSignup;
    if (!isAdminSignup) $('#admin-setup-key').value = '';
  }

  function openProfile() {
    if (!state.user) return openAuth('login');
    $('#profile-error').textContent = '';
    $('#display-name').value = state.user.displayName || state.user.username;
    $('#profile-bio').value = state.user.bio || '';
    $('#avatar-input').value = '';
    $('#profile-preview').innerHTML = `${avatarMarkup(state.user)}<span>${escapeHtml(state.user.username)}</span>`;
    $('#profile-dialog').showModal();
  }

  async function openAdmin() {
    if (!state.user?.isAdmin) return;
    if (!$('#admin-dialog').open) $('#admin-dialog').showModal();
    $('#admin-totals').innerHTML = '<p class="admin-empty">Loading the room…</p>';
    try {
      const result = await api('/api/admin/overview');
      $('#admin-totals').innerHTML = `<div class="admin-stat"><span>Members</span><strong>${result.totals.users}</strong></div><div class="admin-stat"><span>Conversations</span><strong>${result.totals.posts}</strong></div><div class="admin-stat"><span>Replies</span><strong>${result.totals.replies}</strong></div>`;
      const otherUsers = result.users.filter(user => user.id !== state.user.id);
      $('#admin-users').innerHTML = otherUsers.length ? otherUsers.map(user => `<div class="admin-row">${avatarMarkup(user)}<div class="admin-row-copy"><strong>${escapeHtml(user.displayName || user.username)}</strong><small>@${escapeHtml(user.username)} · joined ${relativeTime(user.createdAt)}</small></div><button class="button button-quiet" type="button" data-suspend="${user.id}" data-suspended="${user.isSuspended}">${user.isSuspended ? 'Restore' : 'Suspend'}</button></div>`).join('') : '<p class="admin-empty">No other accounts yet.</p>';
      $('#admin-posts').innerHTML = result.posts.length ? result.posts.map(post => `<div class="admin-row"><div class="admin-row-copy"><strong>${escapeHtml(post.displayName || post.username)} · ${escapeHtml(state.rooms.find(room => room.id === post.room)?.label || post.room)}</strong><small>${escapeHtml(post.body || 'Photo or video post')}</small></div><button class="button button-quiet" type="button" data-admin-delete="${post.id}">Remove</button></div>`).join('') : '<p class="admin-empty">No posts to review.</p>';
    } catch (error) {
      $('#admin-totals').innerHTML = `<p class="admin-empty">${escapeHtml(error.message)}</p>`;
    }
  }

  async function handlePost(event) {
    event.preventDefault();
    if (!state.user) return openAuth('login');
    const message = $('#post-message');
    message.textContent = '';
    const formData = new FormData();
    formData.set('body', $('#post-body').value.trim());
    formData.set('room', $('#compose-room').value);
    if (state.selectedFile) formData.set('media', state.selectedFile);
    try {
      await api('/api/posts', { method: 'POST', body: formData });
      state.activeRoom = $('#compose-room').value;
      state.selectedFile = null;
      $('#post-body').value = '';
      $('#media-input').value = '';
      $('#file-label').textContent = '';
      await loadRooms();
      renderRoomControls();
      await loadPosts();
      showToast('Your post is in the room.');
    } catch (error) {
      message.textContent = error.message;
    }
  }

  async function handleReply(event) {
    const form = event.target.closest('[data-reply-form]');
    if (!form) return;
    event.preventDefault();
    const input = form.elements.body;
    try {
      await api(`/api/posts/${form.dataset.replyForm}/comments`, { method: 'POST', body: { body: input.value.trim() } });
      await loadPosts();
      showToast('Reply added.');
    } catch (error) {
      showToast(error.message);
    }
  }

  async function handleAuth(event) {
    event.preventDefault();
    const endpoint = state.authMode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
    $('#auth-error').textContent = '';
    try {
      const result = await api(endpoint, {
        method: 'POST',
        body: {
          username: $('#auth-username').value.trim(),
          password: $('#auth-password').value,
          adminSetupKey: $('#admin-setup-key').value
        }
      });
      state.user = result.user;
      $('#auth-dialog').close();
      renderAccount();
      await loadPosts();
      showToast(state.user.isAdmin ? 'You are in. Admin tools are ready.' : 'You are in. Welcome to the room.');
    } catch (error) {
      $('#auth-error').textContent = error.message;
    }
  }

  async function handleProfile(event) {
    event.preventDefault();
    $('#profile-error').textContent = '';
    const formData = new FormData($('#profile-form'));
    try {
      const result = await api('/api/profile', { method: 'POST', body: formData });
      state.user = result.user;
      $('#profile-dialog').close();
      renderAccount();
      showToast('Profile saved.');
    } catch (error) {
      $('#profile-error').textContent = error.message;
    }
  }

  async function handleAdminAction(button) {
    try {
      if (button.dataset.suspend) {
        const suspended = button.dataset.suspended !== 'true';
        await api(`/api/admin/users/${button.dataset.suspend}/suspension`, { method: 'PATCH', body: { suspended } });
        showToast(suspended ? 'Account suspended.' : 'Account restored.');
      } else if (button.dataset.adminDelete) {
        await api(`/api/posts/${button.dataset.adminDelete}`, { method: 'DELETE' });
        showToast('Post removed.');
        await loadPosts();
      }
      await openAdmin();
    } catch (error) {
      showToast(error.message);
    }
  }

  async function handleClick(event) {
    const roomButton = event.target.closest('[data-room]');
    if (roomButton) return setRoom(roomButton.dataset.room);

    const authButton = event.target.closest('[data-open-auth]');
    if (authButton) return openAuth(authButton.dataset.openAuth);

    const switchButton = event.target.closest('[data-switch-auth]');
    if (switchButton) return openAuth(switchButton.dataset.switchAuth);

    if (event.target.closest('[data-close-dialog]')) {
      event.target.closest('dialog').close();
      return;
    }

    if (event.target.closest('#profile-trigger')) return openProfile();
    if (event.target.closest('#admin-trigger')) return openAdmin();

    const sortButton = event.target.closest('[data-sort]');
    if (sortButton) {
      state.sort = sortButton.dataset.sort;
      document.querySelectorAll('[data-sort]').forEach(button => button.classList.toggle('active', button === sortButton));
      return loadPosts();
    }

    const likeButton = event.target.closest('[data-like]');
    if (likeButton) {
      if (!state.user) return openAuth('login');
      try {
        await api(`/api/posts/${likeButton.dataset.like}/like`, { method: 'POST' });
        return loadPosts();
      } catch (error) { return showToast(error.message); }
    }

    const replyButton = event.target.closest('[data-replies]');
    if (replyButton) {
      if (!state.user) return openAuth('login');
      const id = replyButton.dataset.replies;
      if (state.openReplies.has(id)) state.openReplies.delete(id);
      else state.openReplies.add(id);
      return renderPosts();
    }

    const deleteButton = event.target.closest('[data-delete]');
    if (deleteButton) {
      if (!window.confirm('Remove this post?')) return;
      try {
        await api(`/api/posts/${deleteButton.dataset.delete}`, { method: 'DELETE' });
        await loadRooms();
        await loadPosts();
        showToast('Post removed.');
      } catch (error) { showToast(error.message); }
      return;
    }

    const adminButton = event.target.closest('[data-suspend], [data-admin-delete]');
    if (adminButton) return handleAdminAction(adminButton);
  }

  function bindEvents() {
    document.addEventListener('click', handleClick);
    $('#post-form').addEventListener('submit', handlePost);
    $('#auth-form').addEventListener('submit', handleAuth);
    $('#auth-username').addEventListener('input', syncAdminSetupField);
    $('#profile-form').addEventListener('submit', handleProfile);
    $('#posts').addEventListener('submit', handleReply);
    $('#compose-room').addEventListener('change', event => setRoom(event.target.value));
    $('#search-input').addEventListener('input', event => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(() => {
        state.search = event.target.value.trim();
        loadPosts();
      }, 220);
    });
    $('#media-input').addEventListener('change', event => {
      state.selectedFile = event.target.files[0] || null;
      $('#file-label').textContent = state.selectedFile ? state.selectedFile.name : '';
      $('#post-message').textContent = '';
    });
    $('#avatar-input').addEventListener('change', event => {
      const file = event.target.files[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      $('#profile-preview').innerHTML = `${avatarMarkup({ displayName: state.user.displayName, avatarUrl: previewUrl })}<span>New profile photo</span>`;
    });
    $('#logout-button').addEventListener('click', async () => {
      try { await api('/api/auth/logout', { method: 'POST' }); }
      finally {
        state.user = null;
        renderAccount();
        await loadPosts();
        showToast('You have logged out.');
      }
    });
    $('#auth-dialog').addEventListener('click', event => { if (event.target === $('#auth-dialog')) $('#auth-dialog').close(); });
    $('#profile-dialog').addEventListener('click', event => { if (event.target === $('#profile-dialog')) $('#profile-dialog').close(); });
    $('#admin-dialog').addEventListener('click', event => { if (event.target === $('#admin-dialog')) $('#admin-dialog').close(); });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.sort === 'live') loadPosts();
    });
  }

  async function start() {
    bindEvents();
    try {
      const [session] = await Promise.all([api('/api/auth/me'), loadRooms()]);
      state.user = session.user;
      renderAccount();
      renderRoomControls();
      await loadPosts();
      setInterval(() => {
        if (state.sort === 'live' && !document.hidden) loadPosts();
      }, 7000);
    } catch (error) {
      $('#posts').innerHTML = `<div class="empty-state"><h2>The room is not connected.</h2><p>${escapeHtml(error.message)} Start the app with <code>npm start</code>, then refresh.</p></div>`;
    }
  }

  start();
})();