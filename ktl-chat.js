/* ════════════════════════════════════════════════════════════════════════
   KTL-CHAT — team chat: private one-to-one chats + an "Everyone" group chat
   Drop-in script, loaded the same way as ktl-eotm.js / ktl-stock.js:
     <script src="ktl-chat.js"></script>

   WHAT IT DOES
   • A round chat button in the bottom-right corner of every screen, with a
     red count of unread messages. Clicking it slides in a chat panel.
   • Conversation list: "Everyone" pinned on top, then people, most recent
     first, each with last message, time and unread count. Search finds
     anyone to start a new chat.
   • Chat view: bubbles, sender names in the group chat, photos (thumbnail)
     and files (📎), "Seen" under your last private message once read.
   • New messages and read receipts arrive instantly (Supabase Realtime).

   DATA MODEL (see supabase/chat_schema.sql)
   • chat_messages — one row per message ('all:UG' / 'all:KE' or 'dm:<id>:<id>')
   • chat_reads    — how far each person has read each conversation
   • storage bucket chat-files — private; opened via short-lived signed links

   A HONEST NOTE ON PRIVACY
   Like the rest of the app, this uses the shared Supabase client `sb`, whose
   key bypasses Row-Level Security. The UI only ever loads and shows your own
   conversations, and the live feed is filtered server-side to messages to,
   from, or for everyone — but someone deliberately using dev tools could
   still query other people's private messages. The real fix is the same as
   for the rest of the app: switch to the anon key + RLS policies.
   ════════════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__chatLoaded) return;
  window.__chatLoaded = true;

  const CFG = {
    bucket: 'chat-files',
    maxFileMB: 10,
    pageSize: 50,          // messages loaded per conversation (and per "Load earlier")
    recentScan: 500,       // recent private messages scanned to build the conversation list
    signedUrlSecs: 3600,
  };
  // "Everyone" is per country ('all:UG', 'all:KE'); set from your own country at boot
  let ALL = 'all:UG';

  // ── helpers ───────────────────────────────────────────────────────────
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const me = () => (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
  const myId = () => String(me()?.id || '');
  const dmKey = (a, b) => { const [x, y] = [String(a), String(b)].sort(); return `dm:${x}:${y}`; };
  const otherOf = key => { const [, x, y] = key.split(':'); return x === myId() ? y : x; };
  const initials = name => String(name || '?').trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const nameOf = id => chat.users.get(String(id))?.full_name || 'Unknown';
  // Timestamps arrive as "2026-10-13T09:15:02.123456+00:00" from queries but may use
  // a space / short offset from the live feed — compare as milliseconds, never as text.
  const tsOf = s => s ? Date.parse(String(s).replace(' ', 'T').replace(/\.(\d{3})\d+/, '.$1').replace(/([+-]\d\d)$/, '$1:00')) : 0;
  const fmtTime = iso => new Date(tsOf(iso)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  function fmtWhen(iso) {
    const d = new Date(tsOf(iso)), now = new Date();
    if (d.toDateString() === now.toDateString()) return fmtTime(iso);
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  }
  function fmtDay(iso) {
    const d = new Date(tsOf(iso)), now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  }
  const fmtSize = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  const preview = m => m.attachment_path ? ((m.attachment_type || '').startsWith('image/') ? '📷 Photo' : '📎 ' + (m.attachment_name || 'File')) : (m.body || '');

  // ── icons ─────────────────────────────────────────────────────────────
  const ICON_CHAT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>`;
  const ICON_GROUP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14c2.7.2 4.5 2.2 4.5 5"/></svg>`;
  const ICON_CLIP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/></svg>`;
  const ICON_SEND = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>`;
  const ICON_BACK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;

  // ── styles (TRACKER look: Inter, blue accent, flat hairline cards) ─────
  const CSS = `
#chat-btn{position:fixed;right:24px;bottom:24px;z-index:150;height:50px;padding:0 20px 0 16px;gap:9px;border-radius:999px;border:none;
  background:var(--royal);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;
  box-shadow:0 6px 18px rgba(37,99,235,.35);transition:transform .15s,background .15s;}
#chat-btn:hover{background:var(--royal-mid);transform:translateY(-1px);}
#chat-btn svg{width:22px;height:22px;flex-shrink:0;}
.chat-btn-label{font-size:14px;font-weight:600;font-family:inherit;white-space:nowrap;}
#chat-btn-count{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;
  background:#d0361c;color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center;border:2px solid #fff;}
#chat-btn-count.show{display:flex;}
@media(max-width:700px){#chat-btn{right:14px;bottom:146px;width:50px;height:50px;padding:0;border-radius:50%;}
  .chat-btn-label{display:none;}}
.chat-ov{display:none;position:fixed;inset:0;background:rgba(16,24,40,.35);z-index:400;}
.chat-ov.open{display:block;}
.chat-panel{position:fixed;top:0;right:-440px;width:420px;max-width:100vw;height:100vh;height:100dvh;background:var(--bg);z-index:401;
  box-shadow:-10px 0 36px rgba(16,24,40,.18);transition:right .25s cubic-bezier(.4,0,.2,1);display:flex;flex-direction:column;font-family:inherit;}
.chat-panel.open{right:0;}
@media(max-width:700px){.chat-panel{width:100vw;right:-100vw;}}
.chat-hd{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--brd);flex-shrink:0;min-height:62px;}
.chat-hd-title{font-size:16px;font-weight:600;color:var(--txt);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chat-hd-sub{font-size:11.5px;color:var(--txt3);font-weight:400;}
.chat-icon-btn{width:34px;height:34px;border-radius:8px;border:1px solid var(--brd);background:var(--bg);color:var(--txt2);cursor:pointer;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px;line-height:1;}
.chat-icon-btn:hover{background:var(--bg2);color:var(--txt);}
.chat-icon-btn svg{width:17px;height:17px;}
.chat-body{flex:1;overflow-y:auto;min-height:0;}
.chat-search{padding:12px 16px 8px;}
.chat-search input{width:100%;padding:9px 12px;border:1px solid var(--brd2);border-radius:8px;font-size:13px;font-family:inherit;background:var(--bg);color:var(--txt);}
.chat-search input:focus{outline:none;border-color:var(--royal);box-shadow:0 0 0 3px rgba(37,99,235,.15);}
.chat-sec{font-size:11px;font-weight:600;color:var(--txt3);padding:10px 16px 4px;}
.chat-row{display:flex;align-items:center;gap:11px;padding:10px 16px;cursor:pointer;border:none;background:none;width:100%;text-align:left;font-family:inherit;}
.chat-row:hover{background:var(--bg2);}
.chat-av{width:38px;height:38px;border-radius:50%;background:var(--royal-light);color:var(--royal);display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:600;flex-shrink:0;}
.chat-av.group{background:var(--sidebar,#222b9c);color:#fff;}
.chat-av svg{width:19px;height:19px;}
.chat-row-main{flex:1;min-width:0;}
.chat-row-top{display:flex;align-items:baseline;gap:8px;}
.chat-row-name{font-size:13.5px;font-weight:600;color:var(--txt);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chat-row-time{font-size:11px;color:var(--txt3);flex-shrink:0;}
.chat-row-bot{display:flex;align-items:center;gap:8px;margin-top:2px;}
.chat-row-last{font-size:12.5px;color:var(--txt2);flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chat-row.unread .chat-row-last{color:var(--txt);font-weight:500;}
.chat-pill{min-width:19px;height:19px;padding:0 6px;border-radius:999px;background:var(--royal);color:#fff;font-size:10.5px;font-weight:700;
  display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.chat-empty{text-align:center;color:var(--txt3);font-size:12.5px;padding:28px 16px;}
.chat-msgs{padding:12px 14px 6px;display:flex;flex-direction:column;gap:3px;}
.chat-more{align-self:center;margin:4px 0 10px;padding:5px 12px;border-radius:999px;border:1px solid var(--brd);background:var(--bg);
  font-size:11.5px;color:var(--txt2);cursor:pointer;font-family:inherit;}
.chat-day{align-self:center;font-size:11px;color:var(--txt3);background:var(--bg2);padding:3px 10px;border-radius:999px;margin:10px 0 6px;}
.chat-m{display:flex;flex-direction:column;max-width:80%;}
.chat-m.mine{align-self:flex-end;align-items:flex-end;}
.chat-m.theirs{align-self:flex-start;align-items:flex-start;}
.chat-m.gap{margin-top:8px;}
.chat-from{font-size:11px;font-weight:600;color:var(--royal);margin:0 0 2px 10px;}
.chat-bub{padding:8px 11px;border-radius:14px;font-size:13.5px;line-height:1.45;word-wrap:break-word;overflow-wrap:anywhere;white-space:pre-wrap;}
.chat-m.mine .chat-bub{background:var(--royal);color:#fff;border-bottom-right-radius:5px;}
.chat-m.theirs .chat-bub{background:var(--bg2);color:var(--txt);border-bottom-left-radius:5px;}
.chat-meta{font-size:10.5px;color:var(--txt3);margin:2px 6px 0;}
.chat-img{display:block;max-width:220px;max-height:220px;border-radius:10px;margin-bottom:4px;cursor:pointer;background:var(--brd);min-width:80px;min-height:60px;object-fit:cover;}
.chat-file{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:9px;background:rgba(255,255,255,.18);cursor:pointer;margin-bottom:4px;text-decoration:none;color:inherit;}
.chat-m.theirs .chat-file{background:var(--bg);border:1px solid var(--brd);}
.chat-file svg{width:16px;height:16px;flex-shrink:0;}
.chat-file-name{font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;}
.chat-file-size{font-size:10.5px;opacity:.75;}
.chat-seen{font-size:10.5px;color:var(--royal);margin:2px 6px 0;font-weight:500;}
.chat-compose{border-top:1px solid var(--brd);padding:10px 12px;display:flex;align-items:flex-end;gap:8px;flex-shrink:0;background:var(--bg);}
.chat-compose textarea{flex:1;resize:none;border:1px solid var(--brd2);border-radius:10px;padding:9px 11px;font-size:13.5px;font-family:inherit;
  max-height:120px;min-height:40px;line-height:1.4;background:var(--bg);color:var(--txt);}
.chat-compose textarea:focus{outline:none;border-color:var(--royal);box-shadow:0 0 0 3px rgba(37,99,235,.15);}
.chat-send{width:40px;height:40px;border-radius:10px;border:none;background:var(--royal);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.chat-send:hover{background:var(--royal-mid);}
.chat-send:disabled{opacity:.5;cursor:not-allowed;}
.chat-send svg{width:17px;height:17px;}
.chat-pending{padding:8px 12px 0;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--txt2);}
.chat-pending b{color:var(--txt);font-weight:500;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:bottom;}
.chat-pending button{border:none;background:none;color:#d0361c;cursor:pointer;font-size:12px;font-family:inherit;}
.chat-err{margin:8px 12px 0;padding:7px 10px;border-radius:8px;background:#fdeeea;color:#d0361c;border:1px solid #f5c2b8;font-size:12px;}
`;

  // ── markup ────────────────────────────────────────────────────────────
  const HTML = `
<button id="chat-btn" type="button" aria-label="Open chat" onclick="chatOpen()">${ICON_CHAT}<span class="chat-btn-label">Chat now</span><span id="chat-btn-count"></span></button>
<div class="chat-ov" id="chat-ov" onclick="chatClose()"></div>
<div class="chat-panel" id="chat-panel" role="dialog" aria-label="Chat">
  <div class="chat-hd" id="chat-hd"></div>
  <div class="chat-body" id="chat-body"></div>
  <div id="chat-foot"></div>
</div>`;

  function injectOnce() {
    if (!document.getElementById('chat-styles')) {
      const s = document.createElement('style'); s.id = 'chat-styles'; s.textContent = CSS; document.head.appendChild(s);
    }
    if (!document.getElementById('chat-btn')) {
      const w = document.createElement('div'); w.innerHTML = HTML;
      while (w.firstChild) document.body.appendChild(w.firstChild);
    }
  }

  // ── state ─────────────────────────────────────────────────────────────
  const chat = {
    users: new Map(),     // id -> {id, full_name, role}
    convs: new Map(),     // key -> {key, last: msg|null, unread: n}
    myReads: new Map(),   // key -> last_read_at (my own)
    theirReads: new Map(),// dm key -> other person's last_read_at
    msgs: new Map(),      // key -> [msg] ascending, loaded window
    hasMore: new Map(),   // key -> bool
    open: false,
    view: 'list',         // list | conv
    current: null,        // open conversation key
    search: '',
    pendingFile: null,
    sending: false,
    urlCache: new Map(),  // attachment_path -> signed url
    channel: null,
  };

  // ── loading ───────────────────────────────────────────────────────────
  async function loadUsers() {
    const { data, error } = await sb.from('users').select('id,full_name,role').eq('is_active', true)
      .eq('country', me()?.country || 'UG').order('full_name');
    if (error) throw error;
    chat.users = new Map((data || []).map(u => [String(u.id), u]));
  }

  async function loadOverview() {
    const id = myId();
    const [reads, lastAll, dms] = await Promise.all([
      sb.from('chat_reads').select('conversation,last_read_at').eq('user_id', id),
      sb.from('chat_messages').select('*').eq('conversation', ALL).order('created_at', { ascending: false }).limit(1),
      sb.from('chat_messages').select('*').neq('conversation', ALL).or(`sender_id.eq.${id},recipient_id.eq.${id}`)
        .order('created_at', { ascending: false }).limit(CFG.recentScan),
    ]);
    for (const r of [reads, lastAll, dms]) if (r.error) throw r.error;

    chat.myReads = new Map((reads.data || []).map(r => [r.conversation, r.last_read_at]));
    chat.convs = new Map();
    chat.convs.set(ALL, { key: ALL, last: lastAll.data?.[0] || null, unread: 0 });
    (dms.data || []).forEach(m => {
      if (!chat.convs.has(m.conversation)) chat.convs.set(m.conversation, { key: m.conversation, last: m, unread: 0 });
      const read = chat.myReads.get(m.conversation);
      if (String(m.recipient_id) === id && tsOf(m.created_at) > tsOf(read)) chat.convs.get(m.conversation).unread++;
    });

    // Group chat unread: messages from others since my last read
    const readAll = chat.myReads.get(ALL);
    let q = sb.from('chat_messages').select('id', { count: 'exact', head: true }).eq('conversation', ALL).neq('sender_id', id);
    if (readAll) q = q.gt('created_at', readAll);
    const { count } = await q;
    chat.convs.get(ALL).unread = count || 0;

    // Other people's read position in my private chats, for "Seen"
    const dmKeys = [...chat.convs.keys()].filter(k => k !== ALL);
    chat.theirReads = new Map();
    if (dmKeys.length) {
      const { data } = await sb.from('chat_reads').select('user_id,conversation,last_read_at').in('conversation', dmKeys).neq('user_id', id);
      (data || []).forEach(r => chat.theirReads.set(r.conversation, r.last_read_at));
    }
    updateBadge();
  }

  async function loadMessages(key, older = false) {
    const have = chat.msgs.get(key) || [];
    let q = sb.from('chat_messages').select('*').eq('conversation', key).order('created_at', { ascending: false }).limit(CFG.pageSize);
    if (older && have.length) q = q.lt('created_at', have[0].created_at);
    const { data, error } = await q;
    if (error) throw error;
    const batch = (data || []).reverse();
    chat.msgs.set(key, older ? batch.concat(have) : batch);
    chat.hasMore.set(key, (data || []).length === CFG.pageSize);
  }

  async function markRead(key) {
    const list = chat.msgs.get(key) || [];
    const newest = list.length ? list[list.length - 1].created_at : null;
    const conv = chat.convs.get(key);
    if (conv) conv.unread = 0;
    updateBadge();
    if (!newest) return;
    const prev = chat.myReads.get(key);
    if (prev && tsOf(prev) >= tsOf(newest)) return;
    chat.myReads.set(key, newest);
    await sb.from('chat_reads').upsert({ user_id: myId(), conversation: key, last_read_at: newest }, { onConflict: 'user_id,conversation' });
  }

  // ── live updates ──────────────────────────────────────────────────────
  function subscribe() {
    if (chat.channel || !sb.channel) return;
    const id = myId();
    const onMsg = payload => receive(payload.new);
    chat.channel = sb.channel('ktl-chat-' + id)
      // filtered server-side: group chat, messages to me, and my own (other devices)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `conversation=eq.${ALL}` }, onMsg)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `recipient_id=eq.${id}` }, onMsg)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `sender_id=eq.${id}` }, onMsg)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_reads' }, payload => {
        const r = payload.new;
        if (!r || !r.conversation || String(r.user_id) === id || !chat.convs.has(r.conversation)) return;
        chat.theirReads.set(r.conversation, r.last_read_at);
        if (chat.open && chat.view === 'conv' && chat.current === r.conversation) renderConv(false);
      })
      .subscribe();
  }

  function receive(m) {
    if (!m || !m.conversation) return;
    const id = myId();
    if (m.conversation !== ALL && String(m.sender_id) !== id && String(m.recipient_id) !== id) return;
    const list = chat.msgs.get(m.conversation);
    if (list && list.some(x => x.id === m.id)) return;          // already have it (our own send)
    if (list) list.push(m);
    if (!chat.convs.has(m.conversation)) chat.convs.set(m.conversation, { key: m.conversation, last: null, unread: 0 });
    const conv = chat.convs.get(m.conversation);
    conv.last = m;
    const viewing = chat.open && chat.view === 'conv' && chat.current === m.conversation && document.visibilityState === 'visible';
    if (String(m.sender_id) !== id) {
      if (viewing) markRead(m.conversation); else conv.unread++;
    }
    updateBadge();
    if (!chat.open) return;
    if (chat.view === 'list') renderList();
    else if (chat.current === m.conversation) renderConv(true);
  }

  // ── open / close ──────────────────────────────────────────────────────
  window.chatOpen = async function () {
    chat.open = true;
    document.getElementById('chat-ov').classList.add('open');
    document.getElementById('chat-panel').classList.add('open');
    chat.view = 'list';
    renderList(true);
    try { await loadOverview(); renderList(); }
    catch (e) { renderError(e); }
  };
  window.chatClose = function () {
    chat.open = false;
    document.getElementById('chat-ov').classList.remove('open');
    document.getElementById('chat-panel').classList.remove('open');
  };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && chat.open) chatClose(); });

  window.chatOpenConv = async function (key) {
    chat.view = 'conv'; chat.current = key; chat.pendingFile = null;
    if (!chat.convs.has(key)) chat.convs.set(key, { key, last: null, unread: 0 });
    renderConvShell();
    document.getElementById('chat-body').innerHTML = '<div class="chat-empty">Loading…</div>';
    try {
      await loadMessages(key);
      renderConv(true);
      markRead(key);
    } catch (e) { renderError(e); }
  };
  window.chatStartWith = userId => chatOpenConv(dmKey(myId(), userId));
  window.chatBack = function () { chat.view = 'list'; chat.current = null; renderList(); };
  window.chatSearch = function (v) { chat.search = v; renderListRows(); };
  window.chatLoadEarlier = async function () {
    const body = document.getElementById('chat-body');
    const oldH = body.scrollHeight;
    try { await loadMessages(chat.current, true); renderConv(false); body.scrollTop = body.scrollHeight - oldH; }
    catch (e) { renderError(e); }
  };

  // ── rendering: conversation list ──────────────────────────────────────
  function renderList(loading) {
    document.getElementById('chat-hd').innerHTML = `
      <div class="chat-hd-title">Chat</div>
      <button class="chat-icon-btn" onclick="chatClose()" aria-label="Close">&times;</button>`;
    document.getElementById('chat-foot').innerHTML = '';
    document.getElementById('chat-body').innerHTML = `
      <div class="chat-search"><input id="chat-search" placeholder="Search people…" value="${esc(chat.search)}" oninput="chatSearch(this.value)" autocomplete="off"/></div>
      <div id="chat-rows">${loading ? '<div class="chat-empty">Loading…</div>' : ''}</div>`;
    if (!loading) renderListRows();
  }

  function rowHtml({ key, title, avatar, group, last, unread }) {
    const lastTxt = last ? (group && String(last.sender_id) !== myId() ? nameOf(last.sender_id).split(' ')[0] + ': ' : String(last.sender_id) === myId() ? 'You: ' : '') + preview(last) : (group ? 'Say hello to the whole team' : 'Start a conversation');
    return `<button class="chat-row${unread ? ' unread' : ''}" onclick="chatOpenConv('${key}')">
      <div class="chat-av${group ? ' group' : ''}">${avatar}</div>
      <div class="chat-row-main">
        <div class="chat-row-top"><span class="chat-row-name">${esc(title)}</span>${last ? `<span class="chat-row-time">${fmtWhen(last.created_at)}</span>` : ''}</div>
        <div class="chat-row-bot"><span class="chat-row-last">${esc(lastTxt)}</span>${unread ? `<span class="chat-pill">${unread > 99 ? '99+' : unread}</span>` : ''}</div>
      </div></button>`;
  }

  function renderListRows() {
    const el = document.getElementById('chat-rows'); if (!el) return;
    const q = chat.search.trim().toLowerCase();
    const id = myId();
    const all = chat.convs.get(ALL) || { last: null, unread: 0 };
    const dms = [...chat.convs.values()].filter(c => c.key !== ALL && c.last)
      .sort((a, b) => tsOf(b.last.created_at) - tsOf(a.last.created_at));
    const withChat = new Set(dms.map(c => otherOf(c.key)));

    let html = '';
    if (!q || 'everyone'.includes(q)) {
      html += rowHtml({ key: ALL, title: 'Everyone', avatar: ICON_GROUP, group: true, last: all.last, unread: all.unread });
    }
    const dmRows = dms.filter(c => !q || nameOf(otherOf(c.key)).toLowerCase().includes(q));
    if (dmRows.length) {
      html += `<div class="chat-sec">Recent</div>` + dmRows.map(c => {
        const other = otherOf(c.key);
        return rowHtml({ key: c.key, title: nameOf(other), avatar: esc(initials(nameOf(other))), last: c.last, unread: c.unread });
      }).join('');
    }
    const people = [...chat.users.values()].filter(u => String(u.id) !== id && !withChat.has(String(u.id))
      && (!q || (u.full_name || '').toLowerCase().includes(q)));
    if (people.length) {
      html += `<div class="chat-sec">${q ? 'People' : 'Start a chat'}</div>` + people.map(u =>
        `<button class="chat-row" onclick="chatStartWith('${esc(u.id)}')">
          <div class="chat-av">${esc(initials(u.full_name))}</div>
          <div class="chat-row-main"><div class="chat-row-top"><span class="chat-row-name">${esc(u.full_name)}</span></div>
            <div class="chat-row-bot"><span class="chat-row-last" style="text-transform:capitalize;">${esc((u.role || '').replace('_', ' '))}</span></div></div>
        </button>`).join('');
    }
    el.innerHTML = html || '<div class="chat-empty">No one matches that search.</div>';
  }

  // ── rendering: one conversation ───────────────────────────────────────
  function renderConvShell() {
    const key = chat.current, group = key === ALL;
    const title = group ? 'Everyone' : nameOf(otherOf(key));
    const sub = group ? `${chat.users.size} people` : (chat.users.get(otherOf(key))?.role || '').replace('_', ' ');
    document.getElementById('chat-hd').innerHTML = `
      <button class="chat-icon-btn" onclick="chatBack()" aria-label="Back">${ICON_BACK}</button>
      <div class="chat-av${group ? ' group' : ''}" style="width:34px;height:34px;">${group ? ICON_GROUP : esc(initials(title))}</div>
      <div class="chat-hd-title">${esc(title)}<div class="chat-hd-sub" style="text-transform:capitalize;">${esc(sub)}</div></div>
      <button class="chat-icon-btn" onclick="chatClose()" aria-label="Close">&times;</button>`;
    document.getElementById('chat-foot').innerHTML = `
      <div id="chat-pending"></div><div id="chat-err"></div>
      <div class="chat-compose">
        <input type="file" id="chat-file" style="display:none;" onchange="chatPickFile(this.files[0])"/>
        <button class="chat-icon-btn" style="height:40px;width:40px;border-radius:10px;" onclick="document.getElementById('chat-file').click()" aria-label="Attach a photo or file">${ICON_CLIP}</button>
        <textarea id="chat-input" rows="1" placeholder="Message${group ? ' everyone' : ''}…"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();chatSend();}"></textarea>
        <button class="chat-send" id="chat-send" onclick="chatSend()" aria-label="Send">${ICON_SEND}</button>
      </div>`;
    setTimeout(() => document.getElementById('chat-input')?.focus(), 50);
  }

  function attachmentHtml(m) {
    if (!m.attachment_path) return '';
    const isImg = (m.attachment_type || '').startsWith('image/');
    const p = esc(m.attachment_path);
    if (isImg) return `<img class="chat-img" data-path="${p}" alt="${esc(m.attachment_name || 'Photo')}" onclick="chatOpenFile('${p}')"/>`;
    return `<a class="chat-file" onclick="chatOpenFile('${p}')">${ICON_CLIP}<span><div class="chat-file-name">${esc(m.attachment_name || 'File')}</div>
      <div class="chat-file-size">${m.attachment_size ? fmtSize(m.attachment_size) : ''}</div></span></a>`;
  }

  function renderConv(scrollToEnd) {
    const key = chat.current, group = key === ALL, id = myId();
    const list = chat.msgs.get(key) || [];
    const body = document.getElementById('chat-body');
    if (!list.length) {
      body.innerHTML = `<div class="chat-empty">${group ? 'No messages yet — say hello to the whole team.' : 'No messages yet — say hello.'}</div>`;
      return;
    }
    const lastMineIdx = (() => { for (let i = list.length - 1; i >= 0; i--) if (String(list[i].sender_id) === id) return i; return -1; })();
    const theirRead = chat.theirReads.get(key);
    let html = chat.hasMore.get(key) ? `<button class="chat-more" onclick="chatLoadEarlier()">Load earlier messages</button>` : '';
    let prevDay = '', prevSender = '';
    list.forEach((m, i) => {
      const day = new Date(tsOf(m.created_at)).toDateString();
      if (day !== prevDay) { html += `<div class="chat-day">${fmtDay(m.created_at)}</div>`; prevDay = day; prevSender = ''; }
      const mine = String(m.sender_id) === id;
      const newGroup = String(m.sender_id) !== prevSender;
      html += `<div class="chat-m ${mine ? 'mine' : 'theirs'}${newGroup ? ' gap' : ''}">
        ${group && !mine && newGroup ? `<div class="chat-from">${esc(m.sender_name || nameOf(m.sender_id))}</div>` : ''}
        <div class="chat-bub">${attachmentHtml(m)}${esc(m.body || '')}</div>
        <div class="chat-meta">${fmtTime(m.created_at)}</div>
        ${!group && mine && i === lastMineIdx && theirRead && tsOf(theirRead) >= tsOf(m.created_at) ? '<div class="chat-seen">Seen</div>' : ''}
      </div>`;
      prevSender = String(m.sender_id);
    });
    body.innerHTML = `<div class="chat-msgs">${html}</div>`;
    loadThumbs(body);
    if (scrollToEnd) body.scrollTop = body.scrollHeight;
  }

  function renderError(e) {
    console.error('Chat error', e);
    const msg = esc(e?.message || 'Something went wrong');
    if (chat.view === 'list') {
      const el = document.getElementById('chat-rows') || document.getElementById('chat-body');
      el.innerHTML = `<div class="chat-empty">Couldn't load chat right now.</div><div class="chat-err">${msg}</div>`;
    } else {
      const el = document.getElementById('chat-err');
      if (el) el.innerHTML = `<div class="chat-err">${msg}</div>`;
    }
  }

  // ── attachments ───────────────────────────────────────────────────────
  async function signedUrl(path) {
    if (chat.urlCache.has(path)) return chat.urlCache.get(path);
    const { data, error } = await sb.storage.from(CFG.bucket).createSignedUrl(path, CFG.signedUrlSecs);
    if (error) throw error;
    chat.urlCache.set(path, data.signedUrl);
    return data.signedUrl;
  }
  function loadThumbs(root) {
    root.querySelectorAll('img.chat-img[data-path]').forEach(img => {
      signedUrl(img.dataset.path).then(u => { img.src = u; }).catch(() => { img.alt = 'Photo unavailable'; });
    });
  }
  window.chatOpenFile = async function (path) {
    try { window.open(await signedUrl(path), '_blank', 'noopener'); }
    catch (e) { renderError(e); }
  };
  window.chatPickFile = function (file) {
    const pend = document.getElementById('chat-pending');
    document.getElementById('chat-err').innerHTML = '';
    if (!file) return;
    if (file.size > CFG.maxFileMB * 1048576) {
      document.getElementById('chat-err').innerHTML = `<div class="chat-err">That file is ${fmtSize(file.size)} — the limit is ${CFG.maxFileMB} MB.</div>`;
      document.getElementById('chat-file').value = '';
      return;
    }
    chat.pendingFile = file;
    pend.innerHTML = `<div class="chat-pending">📎 <b>${esc(file.name)}</b> · ${fmtSize(file.size)} <button onclick="chatClearFile()">Remove</button></div>`;
  };
  window.chatClearFile = function () {
    chat.pendingFile = null;
    document.getElementById('chat-pending').innerHTML = '';
    document.getElementById('chat-file').value = '';
  };

  // ── sending ───────────────────────────────────────────────────────────
  window.chatSend = async function () {
    if (chat.sending) return;
    const input = document.getElementById('chat-input');
    const text = (input.value || '').trim();
    const file = chat.pendingFile;
    if (!text && !file) return;
    const key = chat.current, group = key === ALL, id = myId();
    const btn = document.getElementById('chat-send');
    chat.sending = true; btn.disabled = true;
    document.getElementById('chat-err').innerHTML = '';
    try {
      const row = {
        conversation: key, sender_id: id, sender_name: me()?.full_name || null,
        recipient_id: group ? null : otherOf(key), body: text || null,
      };
      if (file) {
        const safe = file.name.replace(/[^\w.\-]+/g, '_').slice(-80);
        const path = `${key.replace(/:/g, '_')}/${Date.now()}_${safe}`;
        const up = await sb.storage.from(CFG.bucket).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (up.error) throw up.error;
        Object.assign(row, { attachment_path: path, attachment_name: file.name, attachment_type: file.type || null, attachment_size: file.size });
      }
      const { data, error } = await sb.from('chat_messages').insert(row).select().single();
      if (error) throw error;
      input.value = ''; input.style.height = 'auto';
      if (file) chatClearFile();
      receive(data);
      markRead(key);
    } catch (e) {
      document.getElementById('chat-err').innerHTML = `<div class="chat-err">Couldn't send — ${esc(e?.message || 'try again')}.</div>`;
    } finally {
      chat.sending = false; btn.disabled = false;
      input.focus();
    }
  };

  // ── unread badge ──────────────────────────────────────────────────────
  function updateBadge() {
    const total = [...chat.convs.values()].reduce((s, c) => s + (c.unread || 0), 0);
    const el = document.getElementById('chat-btn-count');
    if (!el) return;
    el.textContent = total > 99 ? '99+' : String(total);
    el.classList.toggle('show', total > 0);
  }

  // Catch up on anything missed while the tab was in the background
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !me()) return;
    loadOverview().then(() => {
      if (!chat.open) return;
      if (chat.view === 'list') renderList();
      else loadMessages(chat.current).then(() => { renderConv(true); markRead(chat.current); });
    }).catch(() => {});
  });

  // ── boot ─────────────────────────────────────────────────────────────
  // Same as the other ktl-*.js modules: wait for login before injecting.
  // currentUser / sb are top-level let/const in index.html, reachable as
  // bare identifiers (not window.*) because this loads as another <script>.
  const readyPoll = setInterval(async () => {
    const appEl = document.getElementById('app');
    const hasUser = typeof currentUser !== 'undefined' && currentUser;
    const hasSb = typeof sb !== 'undefined' && sb;
    if (!(hasUser && hasSb && appEl && !appEl.classList.contains('hidden'))) return;
    clearInterval(readyPoll);
    ALL = 'all:' + (currentUser.country || 'UG');
    injectOnce();
    try {
      await loadUsers();
      await loadOverview();
      subscribe();
    } catch (e) {
      console.warn('Chat not ready — has supabase/chat_schema.sql been run?', e?.message || e);
    }
  }, 300);
})();
