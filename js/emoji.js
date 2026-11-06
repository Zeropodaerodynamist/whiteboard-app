'use strict';
// Emoji picker: search by name or keyword, groups, recently used, skin tones.
// EmojiPicker.open(anchor, onPick, { quick }) shows it next to `anchor`; quick mode starts
// with a row of common reactions.

const EmojiPicker = (() => {
  const QUICK = ['👍', '❤️', '😂', '🎉', '👀', '✅', '🤔', '🙏'];
  const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
  const RECENT_MAX = 24;
  let pop = null, onPickCb = null, tone = '';
  let recent = [];
  try { recent = JSON.parse(localStorage.getItem('wb.emoji.recent')) || []; tone = localStorage.getItem('wb.emoji.tone') || ''; } catch { /* storage unavailable */ }
  if (!TONES.includes(tone)) tone = '';

  const data = () => (typeof EMOJI_DATA !== 'undefined' ? EMOJI_DATA : [['Smileys & Emotion', QUICK.map(e => [e, '', '', 0])]]);
  const skinnable = new Set();
  for (const [, list] of data()) for (const e of list) if (e[3]) skinnable.add(e[0]);

  // Puts the skin tone modifier after the first code point (dropping a variation selector
  // there). Sequences with several people would need a tone per person, so they keep the default.
  const PERSON = /[\u{1F466}-\u{1F469}\u{1F9D1}\u{1F474}\u{1F475}]/gu;
  function withTone(e) {
    if (!tone || !skinnable.has(e) || (e.match(PERSON) || []).length > 1) return e;
    const [first, ...rest] = [...e];
    if (rest[0] === '\uFE0F') rest.shift();
    return first + tone + rest.join('');
  }

  function remember(e) {
    recent = [e, ...recent.filter(x => x !== e)].slice(0, RECENT_MAX);
    try { localStorage.setItem('wb.emoji.recent', JSON.stringify(recent)); } catch { /* storage unavailable */ }
  }

  function pick(e) {
    const out = withTone(e), cb = onPickCb;
    remember(e);
    close();
    if (cb) cb(out);
  }

  function close() {
    if (pop) pop.hidden = true;
    onPickCb = null;
  }

  function cell(e, name) {
    return h('button', { class: 'emoji-cell', 'data-e': e, title: name || e, 'aria-label': name || e }, withTone(e));
  }

  function build(quick) {
    const grid = h('div', { class: 'emoji-grid' });
    const search = h('input', { class: 'text-input emoji-search', placeholder: 'Search emoji', spellcheck: 'false' });
    const tabs = h('div', { class: 'emoji-tabs' });
    const sections = [];
    const renderAll = () => {
      grid.replaceChildren();
      sections.length = 0;
      if (recent.length) {
        const sec = h('div', { class: 'emoji-sec', 'data-g': 'Recent' }, h('div', { class: 'emoji-sec-title' }, 'Recently used'), ...recent.map(e => cell(e)));
        grid.append(sec);
        sections.push(sec);
      }
      for (const [name, list] of data()) {
        const sec = h('div', { class: 'emoji-sec', 'data-g': name }, h('div', { class: 'emoji-sec-title' }, name), ...list.map(([e, n]) => cell(e, n)));
        grid.append(sec);
        sections.push(sec);
      }
    };
    const renderSearch = q => {
      const query = q.toLowerCase(), words = query.split(/\s+/).filter(Boolean);
      // Best first: exact name, name starting with the query, a name word starting with it, keywords.
      const rank = (n, k) => {
        if (n === query) return 0;
        if (n.startsWith(query)) return 1;
        if (words.every(w => n.split(/[\s:-]+/).some(x => x.startsWith(w)))) return 2;
        if (words.every(w => n.includes(w))) return 3;
        return words.every(w => (n + ' ' + k).includes(w)) ? 4 : -1;
      };
      const hits = [];
      for (const [, list] of data()) {
        for (const [e, n, k] of list) {
          const r = rank(n.toLowerCase(), k.toLowerCase());
          if (r >= 0) hits.push([r, hits.length, e, n]);
        }
      }
      hits.sort((p, q2) => p[0] - q2[0] || p[1] - q2[1]);
      const cells = hits.slice(0, 200).map(([, , e, n]) => cell(e, n));
      grid.replaceChildren(cells.length ? h('div', { class: 'emoji-sec' }, ...cells) : h('div', { class: 'muted', style: 'padding:12px' }, 'No emoji found'));
    };
    search.addEventListener('input', () => (search.value.trim() ? renderSearch(search.value.trim()) : renderAll()));
    search.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') { const first = grid.querySelector('.emoji-cell'); if (first) pick(first.dataset.e); }
    });
    grid.addEventListener('click', e => { const b = e.target.closest('.emoji-cell'); if (b) pick(b.dataset.e); });
    for (const [name, list] of [['Recent', [[recent[0] || '🕘']]], ...data()]) {
      if (name === 'Recent' && !recent.length) continue;
      tabs.append(h('button', {
        class: 'emoji-tab', title: name,
        onclick: () => { search.value = ''; renderAll(); const sec = grid.querySelector(`.emoji-sec[data-g="${CSS.escape(name)}"]`); if (sec) grid.scrollTop = sec.offsetTop - grid.offsetTop; },
      }, list[0][0]));
    }
    const tones = h('div', { class: 'emoji-tones' }, TONES.map((t, i) => h('button', {
      class: 'emoji-tone' + (t === tone ? ' active' : ''), title: ['Default', 'Light', 'Medium-light', 'Medium', 'Medium-dark', 'Dark'][i] + ' skin tone',
      onclick: () => {
        tone = t;
        try { localStorage.setItem('wb.emoji.tone', t); } catch { /* storage unavailable */ }
        tones.querySelectorAll('.emoji-tone').forEach((b, j) => b.classList.toggle('active', j === i));
        for (const c of grid.querySelectorAll('.emoji-cell')) c.textContent = withTone(c.dataset.e);
      },
    }, '✋' + t)));
    renderAll();
    const full = h('div', { class: 'emoji-full', hidden: quick }, h('div', { class: 'emoji-top' }, search, tones), tabs, grid);
    const quickRow = quick ? h('div', { class: 'emoji-quick' }, QUICK.map(e => cell(e)),
      h('button', { class: 'icon-btn sm', title: 'More emoji', html: icon('plus'), onclick: () => { quickRow.remove(); full.hidden = false; search.focus(); place(); } })) : null;
    if (quickRow) quickRow.addEventListener('click', e => { const b = e.target.closest('.emoji-cell'); if (b) pick(b.dataset.e); });
    return [quickRow, full, () => { if (!quick) search.focus(); }];
  }

  let anchorEl = null;
  function place() {
    if (!pop || !anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    pop.style.left = clamp(r.left + r.width / 2 - pw / 2, 8, innerWidth - pw - 8) + 'px';
    pop.style.top = top + 'px';
  }

  function open(anchor, onPick, { quick = false } = {}) {
    if (!pop) {
      pop = h('div', { class: 'popover panel emoji-pop', id: 'emojiPop', hidden: true });
      pop.addEventListener('pointerdown', e => e.stopPropagation());
      document.body.append(pop);
      document.addEventListener('pointerdown', e => { if (pop && !pop.hidden && !pop.contains(e.target) && e.target !== anchorEl) close(); }, true);
    }
    const [quickRow, full, focus] = build(quick);
    pop.replaceChildren(...[quickRow, full].filter(Boolean));
    onPickCb = onPick;
    anchorEl = anchor;
    pop.hidden = false;
    place();
    focus();
  }

  return { open, close, isOpen: () => !!pop && !pop.hidden, QUICK };
})();
