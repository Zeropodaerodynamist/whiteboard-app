'use strict';
// Markdown document pane: CodeMirror editor and preview, per-line edit attribution
// ("edited by Sam"), Word-style review (comment threads in the margin with replies,
// reactions and @mentions; Suggesting mode with accept/reject), ink drawn on the
// document, and the review sections exported for AI models and agents.

const AUTHOR_COLORS = ['#4f6bed', '#e3008c', '#0f9d58', '#f7630c', '#886ce4', '#0099bc', '#c239b3', '#a4262c'];

// Same name, same color on every machine: FNV-1a, then a finalizer so the low bits spread.
function authorColor(name) {
  let hash = 0x811c9dc5;
  for (const ch of (name || '').toLowerCase()) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return AUTHOR_COLORS[(hash >>> 0) % AUTHOR_COLORS.length];
}

// Unambiguous local timestamp for exports, e.g. "2026-10-19 14:05".
function stamp(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function initials(name) {
  const parts = (name || '?').trim().split(/\s+/);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function timeAgo(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return formatDate(ts);
}

function avatar(name, size = 22) {
  return h('span', { class: 'avatar', title: name, style: `background:${authorColor(name)};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px` }, initials(name));
}

// Line diff (LCS with common prefix/suffix trimmed). Ops: ' ' same, '-' removed, '+' added,
// each with ai/bi = index of the line in the old/new text.
function diffLines(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
  const ops = [];
  let ai = 0, bi = 0;
  const same = () => { ops.push({ t: ' ', ai, bi, text: a[ai] }); ai++; bi++; };
  const del = () => { ops.push({ t: '-', ai, bi, text: a[ai] }); ai++; };
  const add = () => { ops.push({ t: '+', ai, bi, text: b[bi] }); bi++; };
  while (ai < s) same();
  const n = ea - s, m = eb - s;
  if (n * m > 4e6) {
    while (ai < ea) del();
    while (bi < eb) add();
  } else {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = a[s + i] === b[s + j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[s + i] === b[s + j]) { same(); i++; j++; }
      else if (i < n && (j >= m || L[(i + 1) * W + j] >= L[i * W + j + 1])) { del(); i++; }
      else { add(); j++; }
    }
  }
  while (ai < a.length) same();
  return ops;
}

// Unified diff with 2 lines of context; hunk headers name who edited the added lines.
function unifiedDiff(oldText, newText, lineAuthors) {
  const ops = diffLines(oldText.split('\n'), newText.split('\n'));
  const CTX = 2, out = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') { k++; continue; }
    const start = Math.max(0, k - CTX);
    let end = k, j = k;
    while (j < ops.length) {
      if (ops[j].t !== ' ') { end = j++; continue; }
      let run = 0;
      while (j + run < ops.length && ops[j + run].t === ' ') run++;
      if (j + run >= ops.length || run > CTX * 2) break;
      j += run;
    }
    const stop = Math.min(ops.length, end + 1 + CTX);
    const hunk = ops.slice(start, stop);
    const aLen = hunk.filter(o => o.t !== '+').length, bLen = hunk.filter(o => o.t !== '-').length;
    const who = [...new Set(hunk.filter(o => o.t === '+' && lineAuthors[o.bi]).map(o => lineAuthors[o.bi].a))];
    out.push(`@@ -${hunk[0].ai + 1},${aLen} +${hunk[0].bi + 1},${bLen} @@` + (who.length ? ` edited by ${who.join(', ')}` : ''));
    for (const o of hunk) out.push(o.t + o.text);
    k = stop;
  }
  return out.join('\n');
}

function fenceFor(text, min = 3) {
  const runs = text.match(/`{3,}/g) || [];
  return '`'.repeat(Math.max(min, ...runs.map(r => r.length + 1)));
}

// "@Sam Lee" mentions of known people inside comment text, as text and highlighted nodes.
function mentionNodes(text, people) {
  const names = [...new Set(people)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return [text];
  const re = new RegExp('@(' + names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?![\\p{L}\\p{N}])', 'gu');
  const out = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    out.push(text.slice(last, m.index), h('span', { class: 'mention', style: `--c:${authorColor(m[1])}` }, '@' + m[1]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const DocPane = (() => {
  let cm = null;
  let state = null;          // { name, filePath, baseline, savedText, eol, comments, suggestions, ink }
  let previewOn = false;
  let suggesting = false;
  let showResolved = false;
  let marginOn = true;
  let activeId = null;       // comment or suggestion id highlighted in the margin
  let pendingHandles = [];
  let loading = false;
  let lastDirty = null;
  let reviewOps = [];        // suggest-mode undo/redo: deletion marks aren't in CodeMirror's history
  let reviewRedo = [];
  const drafts = new Map();  // unsent comment and reply text, by composer key
  const focusedOnce = new Set();
  const replyOpen = new Set();
  const hooks = { changed() {}, author: () => 'Me', ensureAuthor: async () => 'Me', people: () => [], keysUnlocked: () => false };

  const REVIEW = '+review';  // origin for changes the review machinery makes itself
  const me = () => hooks.author();

  // ---------- Editor ----------

  function ensureEditor() {
    if (cm) return cm;
    cm = CodeMirror($('cmHost'), {
      mode: { name: 'markdown', highlightFormatting: true, fencedCodeBlockHighlighting: false, strikethrough: true },
      lineNumbers: true,
      lineWrapping: true,
      styleActiveLine: true,
      gutters: ['wb-authors', 'CodeMirror-linenumbers'],
      placeholder: 'Start writing Markdown…',
      indentUnit: 2,
      tabSize: 4,
      extraKeys: {
        Enter: 'newlineAndIndentContinueMarkdownList',
        'Ctrl-Alt-M': () => addComment(),
        'Cmd-Alt-M': () => addComment(),
        'Ctrl-Shift-E': () => setSuggesting(!suggesting),
        'Cmd-Shift-E': () => setSuggesting(!suggesting),
        'Ctrl-Z': () => reviewUndo(),
        'Cmd-Z': () => reviewUndo(),
        'Ctrl-Y': () => reviewRedoOp(),
        'Shift-Ctrl-Z': () => reviewRedoOp(),
        'Shift-Cmd-Z': () => reviewRedoOp(),
        Tab: c => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  '),
        'Shift-Tab': c => c.indentSelection('subtract'),
      },
    });

    // Dropped files go to the app (open .md / insert images on the board), not into the text.
    cm.on('drop', (_cm, e) => { if (e.dataTransfer && e.dataTransfer.files.length) e.codemirrorIgnore = true; });

    cm.on('beforeChange', (_cm, ch) => { if (suggesting && !loading) suggestBeforeChange(ch); });

    // Remember which lines each change produced, then tag them with the current author.
    cm.on('change', (_cm, ch) => {
      if (loading) return;
      const n = ch.text.length;
      const pureInsert = ch.removed.length === 1 && ch.removed[0] === '';
      for (let i = 0; i < n; i++) {
        const line = ch.from.line + i;
        // A line break typed at the end (or start) of a line doesn't change that line's text.
        if (pureInsert && n > 1) {
          if (i === 0 && ch.text[0] === '' && cm.getLine(line).length === ch.from.ch) continue;
          if (i === n - 1 && ch.text[n - 1] === '' && ch.from.ch === 0) continue;
        }
        pendingHandles.push(cm.getLineHandle(line));
      }
    });
    cm.on('changes', (_cm, changes) => {
      if (loading) { pendingHandles = []; return; }
      if (suggesting) markInsertions(changes);
      const author = me(), t = Date.now();
      for (const lh of pendingHandles) {
        if (lh && cm.getLineNumber(lh) != null) cm.setGutterMarker(lh, 'wb-authors', authorMark(author, t));
      }
      pendingHandles = [];
      scheduleStatus();
      scheduleMargin('auto');
      hooks.changed();
    });
    cm.on('scroll', () => scheduleMargin(false));
    cm.on('refresh', () => scheduleMargin(true));
    cm.on('cursorActivity', () => {
      const pos = cm.getCursor();
      const hit = reviewItems().find(it => {
        const r = it.marker && it.marker.find();
        return r && CodeMirror.cmpPos(r.from, pos) <= 0 && CodeMirror.cmpPos(pos, r.to) <= 0;
      });
      if (hit && hit.id !== activeId) setActive(hit.id, false);
    });
    return cm;
  }

  function authorMark(author, t) {
    const el = document.createElement('div');
    el.className = 'wb-author-mark';
    el.style.background = authorColor(author);
    el.dataset.a = author;
    el.dataset.t = t;
    el.title = `Edited by ${author} · ${fullDate(t)}`;
    return el;
  }

  function lineAuthors() {
    const out = [];
    for (let i = 0; i < cm.lineCount(); i++) {
      const m = cm.lineInfo(i).gutterMarkers;
      const el = m && m['wb-authors'];
      out.push(el ? { a: el.dataset.a, t: +el.dataset.t } : null);
    }
    return out;
  }

  // ---------- Suggesting (track changes) ----------
  // The text holds the original plus suggested insertions; suggested deletions stay in the
  // text, struck through, until someone accepts them.
  //
  // A suggestion whose text disappears (undone, rejected, deleted in Editing mode) stays
  // in state.suggestions, dormant: its marker is never cleared explicitly, so when undo
  // brings the text back CodeMirror restores the mark and the suggestion is live again.

  const suggestionClass = type => (type === 'ins' ? 'cm-sugg-ins' : 'cm-sugg-del');

  function markSuggestion(s, from, to) {
    s.marker = cm.markText(from, to, {
      className: suggestionClass(s.type),
      attributes: { 'data-sid': s.id, style: `--author:${authorColor(s.author)}`, title: `${s.type === 'ins' ? 'Inserted' : 'Deleted'} by ${s.author}` },
      inclusiveLeft: false,
      inclusiveRight: false,
    });
    return s;
  }

  function addSuggestion(type, from, to, group) {
    const s = markSuggestion({ id: uid(), type, author: me(), created: Date.now(), group: group || null }, from, to);
    state.suggestions.push(s);
    return s;
  }

  const rangeOf = it => it.marker && it.marker.find();
  const live = s => { const r = rangeOf(s); return !!r && CodeMirror.cmpPos(r.from, r.to) !== 0; };
  const liveSuggestions = () => (state ? state.suggestions.filter(live) : []);
  const idx = p => cm.indexFromPos(p);
  const pos = i => cm.posFromIndex(i);
  const dropSuggestion = s => { if (s.marker) s.marker.clear(); state.suggestions = state.suggestions.filter(x => x !== s); };

  // Live suggestion ranges as index intervals, for the checks below.
  function intervals(filter) {
    const out = [];
    for (const s of liveSuggestions()) {
      if (!filter(s)) continue;
      const r = rangeOf(s);
      out.push({ s, a: idx(r.from), b: idx(r.to) });
    }
    return out;
  }

  // Typing right after your own insertion extends it instead of starting a new one.
  function markInsertion(from, to) {
    if (CodeMirror.cmpPos(from, to) === 0) return;
    const a = idx(from), b = idx(to);
    const mine = intervals(s => s.type === 'ins' && s.author === me());
    // Already inside one of your insertions (typed in its middle): nothing to do.
    if (mine.some(iv => iv.a <= a && b <= iv.b && !(iv.a === a && iv.b === b))) return;
    const touching = mine.filter(iv => iv.b === a || iv.a === b);
    let lo = a, hi = b, keep = null;
    for (const iv of touching) {
      lo = Math.min(lo, iv.a);
      hi = Math.max(hi, iv.b);
      keep = keep || iv.s;
      if (iv.s !== keep) dropSuggestion(iv.s);
    }
    if (keep) {
      keep.marker.clear();
      markSuggestion(keep, pos(lo), pos(hi));
      keep.created = Date.now();
    } else addSuggestion('ins', from, to);
  }

  // Change events arrive after the whole operation, each in the coordinates of the moment
  // it was applied (several cursors = several changes). Map every inserted range through
  // the changes after it, then mark. Undo and redo restore marks themselves (dormant
  // suggestions keep their markers), and the review machinery marks its own changes.
  function mapPos(p, c) {
    if (CodeMirror.cmpPos(p, c.from) < 0) return p;
    const end = CodeMirror.changeEnd(c);
    if (CodeMirror.cmpPos(p, c.to) < 0) return end;
    if (p.line === c.to.line) return { line: end.line, ch: end.ch + (p.ch - c.to.ch) };
    return { line: p.line + (end.line - c.to.line), ch: p.ch };
  }

  function markInsertions(changes) {
    const ranges = [];
    for (const c of changes) {
      for (const r of ranges) { r.from = mapPos(r.from, c); r.to = mapPos(r.to, c); }
      if (c.origin === REVIEW || c.origin === 'undo' || c.origin === 'redo' || c.origin === 'setValue') continue;
      const to = CodeMirror.changeEnd(c);
      if (CodeMirror.cmpPos(c.from, to) !== 0) ranges.push({ from: c.from, to });
    }
    for (const r of ranges) markInsertion(r.from, r.to);
  }

  // Deletions (and replacements) are cancelled and turned into marks. All the ranges of one
  // input (several cursors) are handled together, right after CodeMirror finishes.
  let pendingDeletes = [];
  function suggestBeforeChange(ch) {
    if (ch.origin === REVIEW || ch.origin === 'undo' || ch.origin === 'redo' || ch.origin === 'setValue') return;
    const removing = CodeMirror.cmpPos(ch.from, ch.to) !== 0;
    if (!removing) {
      // Text typed inside a suggested deletion lands after it.
      const at = idx(ch.from);
      const del = intervals(s => s.type === 'del').find(iv => iv.a < at && at < iv.b);
      if (del && ch.update) ch.update(pos(del.b), pos(del.b), ch.text);
      return;
    }
    if (!ch.cancel) return;
    ch.cancel();
    const heads = cm.listSelections().map(r => idx(r.head));
    const a = idx(ch.from), b = idx(ch.to);
    pendingDeletes.push({ a, b, text: ch.text.join('\n'), backwards: heads.includes(b) && !heads.includes(a) });
    if (pendingDeletes.length === 1) queueMicrotask(flushDeletes);
  }

  function flushDeletes() {
    const ops = pendingDeletes.sort((p, q) => q.a - p.a);
    pendingDeletes = [];
    if (!state) return;
    const before = cm.changeGeneration(true);
    const record = { created: [], extended: [], after: new Map() };
    cm.operation(() => {
      // From the end of the document backwards, so earlier offsets stay valid; cursors are
      // bookmarks so they follow the edits made for ranges before them.
      const cursors = ops.map(op => cm.setBookmark(pos(suggestDeletion(op, record))));
      cm.setSelections(cursors.map(bm => { const p = bm.find(); bm.clear(); return { anchor: p, head: p }; }));
    });
    record.gen = cm.changeGeneration(true);
    record.hadText = record.gen !== before;
    for (const s of [...record.created, ...record.extended.map(e => e.s)]) {
      const r = rangeOf(s);
      if (r) record.after.set(s, { a: idx(r.from), b: idx(r.to) });
    }
    if (record.created.length || record.extended.length) {
      reviewOps.push(record);
      reviewRedo = [];
    }
    afterReviewChange();
  }

  // Marks [a, b) as deleted (your own pending insertions just disappear), then inserts
  // the replacement text after it as a suggested insertion. Returns the cursor offset.
  function suggestDeletion({ a, b, text: replacement, backwards }, record) {
    const group = replacement ? uid() : null;
    const ownIns = intervals(s => s.type === 'ins' && s.author === me());
    const dels = intervals(s => s.type === 'del');
    const covered = (x, list) => list.some(iv => iv.a <= x && x < iv.b);
    const kindAt = x => (covered(x, ownIns) ? 'own' : covered(x, dels) ? 'skip' : 'mark');
    // Split [a, b) into runs: inside own insertions (really delete), already deleted (skip), rest (mark).
    const runs = [];
    for (let x = a; x < b;) {
      const kind = kindAt(x);
      let y = x + 1;
      while (y < b && kindAt(y) === kind) y++;
      runs.push({ kind, a: x, b: y });
      x = y;
    }
    for (const r of runs) {
      if (r.kind !== 'mark') continue;
      // Merge with a touching deletion of yours.
      const touch = group ? null : intervals(s => s.type === 'del' && s.author === me() && !s.group).find(iv => iv.b === r.a || iv.a === r.b);
      if (touch) {
        if (!record.extended.some(e => e.s === touch.s) && !record.created.includes(touch.s)) record.extended.push({ s: touch.s, prev: { a: touch.a, b: touch.b } });
        touch.s.marker.clear();
        markSuggestion(touch.s, pos(Math.min(touch.a, r.a)), pos(Math.max(touch.b, r.b)));
        touch.s.created = Date.now();
      } else record.created.push(addSuggestion('del', pos(r.a), pos(r.b), group));
    }
    // Remove own-insertion runs from the end so earlier offsets stay valid.
    let end = b;
    for (const r of runs.slice().reverse()) {
      if (r.kind !== 'own') continue;
      cm.replaceRange('', pos(r.a), pos(r.b), REVIEW);
      end -= r.b - r.a;
    }
    if (replacement) {
      cm.replaceRange(replacement, pos(end), pos(end), REVIEW);
      record.created.push(addSuggestion('ins', pos(end), pos(end + replacement.length), group));
      return end + replacement.length;
    }
    return backwards ? a : end;
  }

  // Ctrl+Z / Ctrl+Y: a suggested deletion is a mark, not a text change, so these undo and
  // redo it themselves when the document is exactly where that suggestion left it.
  function reviewUndo() {
    const top = reviewOps[reviewOps.length - 1];
    if (!top || top.gen !== cm.changeGeneration()) { cm.undo(); return; }
    reviewOps.pop();
    cm.operation(() => {
      if (top.hadText) cm.undo();
      for (const s of top.created) dropSuggestion(s);
      for (const e of top.extended) {
        e.s.marker.clear();
        markSuggestion(e.s, pos(e.prev.a), pos(e.prev.b));
      }
    });
    top.undoneGen = cm.changeGeneration();
    reviewRedo.push(top);
    afterReviewChange();
  }

  function reviewRedoOp() {
    const top = reviewRedo[reviewRedo.length - 1];
    if (!top || top.undoneGen !== cm.changeGeneration()) { cm.redo(); return; }
    reviewRedo.pop();
    cm.operation(() => {
      if (top.hadText) cm.redo();
      for (const s of [...top.created, ...top.extended.map(e => e.s)]) {
        const r = top.after.get(s);
        if (!r) continue;
        if (s.marker) s.marker.clear();
        markSuggestion(s, pos(r.a), pos(r.b));
        if (!state.suggestions.includes(s)) state.suggestions.push(s);
      }
    });
    top.gen = cm.changeGeneration();
    reviewOps.push(top);
    afterReviewChange();
  }

  function groupOf(s) {
    return s.group ? liveSuggestions().filter(x => x.group === s.group) : [s];
  }

  // Accepting an insertion or rejecting a deletion just drops the mark. Removing text
  // keeps the suggestion dormant, so Ctrl+Z brings back both the text and the suggestion.
  function settle(x, accept) {
    const r = rangeOf(x);
    if (r && (x.type === 'ins') !== accept) cm.replaceRange('', r.from, r.to, REVIEW);
    else dropSuggestion(x);
  }

  function resolveSuggestion(s, accept) {
    cm.operation(() => { for (const x of groupOf(s)) settle(x, accept); });
    reviewOps = [];
    reviewRedo = [];
    afterReviewChange();
  }

  function resolveAll(accept) {
    const list = liveSuggestions();
    if (!list.length) return 0;
    const n = new Set(list.map(s => s.group || s.id)).size;
    // Work from the end of the document so earlier ranges stay put.
    list.sort((p, q) => idx(rangeOf(q).from) - idx(rangeOf(p).from));
    cm.operation(() => { for (const s of list) settle(s, accept); });
    reviewOps = [];
    reviewRedo = [];
    afterReviewChange();
    return n;
  }

  function setSuggesting(on) {
    suggesting = !!on && !!state;
    $('suggestBtn').classList.toggle('active', suggesting);
    $('suggestBtn').setAttribute('aria-pressed', suggesting);
    document.body.classList.toggle('suggesting', suggesting);
    if (suggesting && previewOn) setPreview(false);
    toast(suggesting ? 'Suggesting: your edits become suggestions others can accept or reject (Ctrl+Shift+E)' : 'Editing: changes go straight into the text');
  }

  function afterReviewChange() {
    scheduleMargin(true);
    if (previewOn) renderPreview();
    updateCommentCount();
    scheduleStatus();
    hooks.changed();
  }

  const pendingCount = () => new Set(liveSuggestions().map(s => s.group || s.id)).size;

  // The text with every suggestion accepted: what Save writes to the .md file.
  function finalText(eol = '\n') {
    const text = cm.getValue();
    const list = liveSuggestions();
    const out = list.length ? Review.finalText(text, list.map(s => ({ type: s.type, start: idx(rangeOf(s).from), end: idx(rangeOf(s).to) }))) : text;
    return eol === '\n' ? out : out.replace(/\n/g, eol);
  }

  // ---------- Load / save ----------

  function clearMarks() {
    if (!state) return;
    for (const c of state.comments) c.marker && c.marker.clear();
    for (const s of state.suggestions) s.marker && s.marker.clear();
    for (const k of state.ink) k.anchor && k.anchor.clear();
  }

  function load(data) {
    clearMarks();
    reviewOps = [];
    reviewRedo = [];
    pendingDeletes = [];
    activeId = null;
    drafts.clear();
    focusedOnce.clear();
    replyOpen.clear();
    inkUndo = [];
    pendingWrite = [];
    clearTimeout(writeTimer);
    inkGesture = null;
    if (!data) {
      state = null;
      if (cm) { loading = true; cm.setValue(''); loading = false; }
      if (suggesting) setSuggesting(false);
      setDrawTool(null);
      renderMargin();
      updateStatus();
      return;
    }
    ensureEditor();
    const text = (data.markdown || '').replace(/\r\n?/g, '\n');
    state = {
      name: data.name || 'Untitled.md',
      filePath: data.filePath || null,
      baseline: (data.baseline ?? text).replace(/\r\n?/g, '\n'),
      savedText: data.savedText != null ? data.savedText.replace(/\r\n?/g, '\n') : null,
      // Only the two real line endings: anything else would put text the editor never
      // showed into every line break of the saved file.
      eol: data.eol === '\r\n' || (data.eol == null && (data.markdown || '').includes('\r\n')) ? '\r\n' : '\n',
      comments: [],
      suggestions: [],
      ink: [],
    };
    loading = true;
    cm.setValue(text);
    cm.clearHistory();
    (data.lineAuthors || []).forEach((m, i) => {
      if (m && i < cm.lineCount()) cm.setGutterMarker(i, 'wb-authors', authorMark(m.a, m.t));
    });
    for (const s of Array.isArray(data.suggestions) ? data.suggestions : []) {
      if (!s || (s.type !== 'ins' && s.type !== 'del')) continue;
      const r = clipRange(s.from, s.to);
      if (CodeMirror.cmpPos(r.from, r.to) === 0) continue;
      state.suggestions.push(markSuggestion({ id: safeId(s.id), type: s.type, author: name(s.author), created: num(s.created), group: s.group ? safeId(s.group) : null }, r.from, r.to));
    }
    loading = false;
    for (const c of Array.isArray(data.comments) ? data.comments : []) if (c && c.text) attachComment(normalizeComment(c), c.from, c.to);
    for (const k of Array.isArray(data.ink) ? data.ink : []) if (k) attachInk(normalizeInk(k));
    renderMargin();
    if (previewOn) renderPreview();
    updateStatus();
    setTimeout(() => cm.refresh());
  }

  function clipRange(from, to) {
    const last = cm.lastLine();
    const clip = p => {
      const line = clamp(p ? p.line : 0, 0, last);
      return { line, ch: clamp(p ? p.ch : 0, 0, cm.getLine(line).length) };
    };
    return { from: clip(from), to: clip(to) };
  }

  // Review data comes from other people's files: keep ids, names and numbers well-formed.
  const safeId = v => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : uid());
  const name = v => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 100) : 'Someone');
  const num = v => (Number.isFinite(+v) && +v > 0 ? +v : Date.now());

  function normalizeComment(c) {
    const reactions = r => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r)
      .filter(([k, v]) => Array.isArray(v) && k.length <= 32).slice(0, 40).map(([k, v]) => [k, v.filter(x => typeof x === 'string').map(name)])) : {});
    return {
      id: safeId(c.id), author: name(c.author), created: num(c.created), updated: num(c.updated || c.created),
      text: String(c.text || ''), quote: String(c.quote || ''), resolved: !!c.resolved, resolvedBy: c.resolvedBy ? name(c.resolvedBy) : undefined,
      reactions: reactions(c.reactions),
      replies: (Array.isArray(c.replies) ? c.replies : []).filter(r => r && r.text).map(r => ({ id: safeId(r.id), author: name(r.author), created: num(r.created), text: String(r.text), reactions: reactions(r.reactions) })),
    };
  }

  function attachComment(c, from, to) {
    const r = clipRange(from, to);
    c.marker = cm.markText(r.from, r.to, {
      className: c.resolved ? 'cm-wb-comment resolved' : 'cm-wb-comment',
      attributes: { 'data-cid': c.id },
      clearWhenEmpty: false,
    });
    state.comments.push(c);
    return c;
  }

  function commentRange(c) {
    const r = c.marker && c.marker.find();
    return r ? { from: r.from, to: r.to } : { from: c.from || { line: 0, ch: 0 }, to: c.to || { line: 0, ch: 0 } };
  }

  // Unfinished comments (still in their composer) aren't saved or exported.
  function serializeComments() {
    return state.comments.filter(c => !c.draft && c.text).map(c => {
      const { from, to } = commentRange(c);
      const { marker, draft, ...rest } = c;
      return { ...rest, from, to };
    });
  }

  function serializeSuggestions() {
    return liveSuggestions().map(s => {
      const { marker, ...rest } = s;
      const r = rangeOf(s);
      return { ...rest, from: r.from, to: r.to };
    });
  }

  function serialize() {
    if (!state || !cm) return null;
    const out = {
      name: state.name,
      filePath: state.filePath,
      markdown: cm.getValue(),
      baseline: state.baseline,
      savedText: state.savedText,
      eol: state.eol,
      lineAuthors: lineAuthors(),
      comments: serializeComments(),
      suggestions: serializeSuggestions(),
      ink: serializeInk(),
    };
    // Tools that don't understand suggestions read this.
    if (out.suggestions.length) out.acceptedMarkdown = finalText();
    return out;
  }

  function isDirty() {
    return !!state && state.savedText != null && finalText() !== state.savedText;
  }

  function markSaved(path, name) {
    state.savedText = finalText();
    if (path) state.filePath = path;
    if (name) state.name = name;
    updateStatus();
    hooks.changed();
  }

  function resetTracking() {
    if (!state) return;
    state.baseline = cm.getValue();
    cm.clearGutter('wb-authors');
    updateStatus();
    hooks.changed();
  }

  // ---------- Status bar ----------

  let statusTimer = null;
  function scheduleStatus() {
    // Tell the window straight away that closing may lose changes; updateStatus settles
    // whether they really differ from the file once typing pauses.
    if (state && state.filePath && !lastDirty) { lastDirty = true; Platform.setDirty(true); }
    clearTimeout(statusTimer);
    statusTimer = setTimeout(updateStatus, 250);
  }

  let statusKey = '';
  function updateStatus() {
    const el = $('docStatus');
    if (!el) return;
    if (!state) { statusKey = ''; el.replaceChildren(); return; }
    const dirty = isDirty();
    let status;
    if (!state.filePath) status = Platform.desktop ? 'Not saved to a file yet' : 'Kept in this browser';
    else status = dirty ? 'Unsaved changes' : 'Saved';
    const pending = pendingCount();
    const inkNote = state.ink.length && !previewOn ? `${state.ink.length} ink annotation${state.ink.length === 1 ? '' : 's'} (see Preview)` : '';
    const key = [state.name, state.filePath, status, dirty, pending, inkNote, hooks.keysUnlocked()].join('|');
    if (key !== statusKey) {
      statusKey = key;
      fill(el,
        h('span', { class: 'doc-name', title: state.filePath || state.name }, state.name),
        h('span', { class: 'doc-state' + (dirty ? ' dirty' : '') }, status),
        pending ? h('span', { class: 'chip sugg-chip' }, `${pending} suggestion${pending === 1 ? '' : 's'}`) : null,
        inkNote ? h('span', { class: 'doc-state' }, inkNote) : null,
      );
    }
    const now = dirty && !!state.filePath;
    if (now !== lastDirty) { lastDirty = now; Platform.setDirty(now); }
  }

  // ---------- Comments ----------

  function updateCommentCount() {
    const open = state ? state.comments.filter(c => !c.resolved && !c.draft).length : 0;
    const sugg = pendingCount();
    for (const b of [$('commentCount'), $('reviewTabCount')]) if (b) { b.textContent = open + sugg; b.hidden = !(open + sugg); }
  }

  function remark(c) {
    const { from, to } = commentRange(c);
    c.marker.clear();
    c.marker = cm.markText(from, to, { className: c.resolved ? 'cm-wb-comment resolved' : 'cm-wb-comment', attributes: { 'data-cid': c.id }, clearWhenEmpty: false });
  }

  const people = () => {
    const names = new Set(hooks.people());
    if (state) {
      for (const c of state.comments) { names.add(c.author); c.replies.forEach(r => names.add(r.author)); }
      for (const s of state.suggestions) names.add(s.author);
    }
    names.delete(undefined);
    return [...names];
  };

  // Comment box with @mention completion and an emoji button.
  // `key` names the draft: its text survives margin re-renders, and it takes focus only
  // when it first appears.
  function composer(key, placeholder, label, onPost, onCancel) {
    const ta = h('textarea', { placeholder, rows: 2, 'data-key': key });
    ta.value = drafts.get(key) || '';
    const done = () => { drafts.delete(key); focusedOnce.delete(key); };
    const post0 = onPost, cancel0 = onCancel;
    onPost = text => { done(); post0(text); };
    onCancel = () => { done(); cancel0(); };
    const list = h('div', { class: 'mention-list', hidden: true });
    let choices = [], pick = 0;
    const post = () => { const text = ta.value.trim(); if (text) onPost(text); else onCancel(); };
    const query = () => {
      const m = /(^|\s)@([\p{L}\p{N}_. -]{0,30})$/u.exec(ta.value.slice(0, ta.selectionStart));
      return m ? m[2] : null;
    };
    const refresh = () => {
      const q = query();
      choices = q == null ? [] : people().filter(n => n.toLowerCase().startsWith(q.toLowerCase())).slice(0, 6);
      list.hidden = !choices.length;
      pick = Math.min(pick, Math.max(0, choices.length - 1));
      list.replaceChildren(...choices.map((n, i) => h('button', { class: 'mention-item' + (i === pick ? ' active' : ''), onmousedown: e => { e.preventDefault(); complete(n); } }, avatar(n, 18), n)));
    };
    const complete = name => {
      const before = ta.value.slice(0, ta.selectionStart), after = ta.value.slice(ta.selectionStart);
      const start = before.lastIndexOf('@');
      ta.value = before.slice(0, start) + '@' + name + ' ' + after;
      const caret = start + name.length + 2;
      ta.setSelectionRange(caret, caret);
      refresh();
      ta.focus();
    };
    ta.addEventListener('input', () => { drafts.set(key, ta.value); refresh(); });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (!list.hidden && choices.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); pick = (pick + (e.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length; refresh(); return; }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); complete(choices[pick]); return; }
        if (e.key === 'Escape') { e.preventDefault(); list.hidden = true; choices = []; return; }
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    });
    const emojiBtn = h('button', { class: 'icon-btn sm', title: 'Emoji', html: icon('smile') });
    emojiBtn.addEventListener('click', () => EmojiPicker.open(emojiBtn, e => {
      const s = ta.selectionStart, end = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + e + ta.value.slice(end);
      drafts.set(key, ta.value);
      ta.setSelectionRange(s + e.length, s + e.length);
      ta.focus();
    }));
    if (!focusedOnce.has(key)) {
      focusedOnce.add(key);
      setTimeout(() => ta.focus());
    }
    return h('div', { class: 'cm-composer' }, ta, list,
      h('div', { class: 'cm-card-actions' },
        emojiBtn,
        h('span', { class: 'hint' }, '@ to mention · Ctrl+Enter'),
        h('button', { class: 'btn', onclick: onCancel }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: post }, label)));
  }

  async function addComment() {
    if (!state) return;
    const author = await hooks.ensureAuthor();
    if (!author) return;
    let from, to;
    if (previewOn) {
      const r = previewSelectionRange();
      setPreview(false);
      if (r) { from = r.from; to = r.to; }
    }
    if (!from) {
      from = cm.getCursor('from');
      to = cm.getCursor('to');
    }
    if (CodeMirror.cmpPos(from, to) === 0) {
      from = { line: from.line, ch: 0 };
      to = { line: from.line, ch: cm.getLine(from.line).length };
    }
    marginOn = true;
    const c = attachComment(normalizeComment({ author, text: '', quote: cm.getRange(from, to) }), from, to);
    c.draft = true;
    setActive(c.id, false);
    cm.scrollIntoView({ from, to }, 120);
  }

  // A selection in the preview maps back to source lines through the blocks it touches.
  function previewSelectionRange() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !$('docPreview').contains(sel.anchorNode)) return null;
    const blockOf = n => (n.nodeType === 1 ? n : n.parentElement).closest('.md-block');
    const a = blockOf(sel.getRangeAt(0).startContainer), b = blockOf(sel.getRangeAt(0).endContainer);
    if (!a || !b) return null;
    const text = sel.toString().trim();
    const startLine = +a.dataset.line, endLine = +b.dataset.end;
    // Find the selected text in the source between those lines (the same occurrence as in
    // the rendered block); fall back to whole lines.
    const from = { line: startLine, ch: 0 }, to = { line: endLine, ch: cm.getLine(Math.min(endLine, cm.lastLine())).length };
    const slice = cm.getRange(from, to);
    const first = text.split('\n')[0];
    const lead = document.createRange();
    lead.setStart(a, 0);
    lead.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    const before = lead.toString();
    let nth = 0;
    for (let i = before.indexOf(first); first && i >= 0; i = before.indexOf(first, i + 1)) nth++;
    let at = -1;
    for (let i = 0; first && i <= nth; i++) { at = slice.indexOf(first, at + 1); if (at < 0) break; }
    if (at < 0 && first) at = slice.indexOf(first);
    if (at >= 0) {
      const s = idx(from) + at;
      const e = text.includes('\n') ? idx(to) : s + text.length;
      return { from: pos(s), to: pos(e) };
    }
    return { from, to };
  }

  function removeComment(c) {
    c.marker.clear();
    state.comments = state.comments.filter(x => x !== c);
    if (activeId === c.id) activeId = null;
    afterReviewChange();
  }

  function toggleReaction(target, emoji) {
    const who = me();
    const list = target.reactions[emoji] || (target.reactions[emoji] = []);
    const i = list.indexOf(who);
    if (i >= 0) list.splice(i, 1); else list.push(who);
    if (!list.length) delete target.reactions[emoji];
  }

  function reactionsRow(target, owner) {
    const row = h('div', { class: 'reactions' });
    for (const [emoji, names] of Object.entries(target.reactions || {})) {
      row.append(h('button', {
        class: 'reaction' + (names.includes(me()) ? ' mine' : ''), title: names.join(', '),
        onclick: e => { e.stopPropagation(); toggleReaction(target, emoji); owner.updated = Date.now(); renderMargin(); hooks.changed(); },
      }, emoji, h('span', {}, String(names.length))));
    }
    const add = h('button', { class: 'reaction add', title: 'Add a reaction', html: icon('smile') });
    add.addEventListener('click', e => {
      e.stopPropagation();
      EmojiPicker.open(add, emoji => { toggleReaction(target, emoji); owner.updated = Date.now(); renderMargin(); hooks.changed(); }, { quick: true });
    });
    row.append(add);
    return row;
  }

  function toggleResolved(c) {
    c.resolved = !c.resolved;
    c.resolvedBy = c.resolved ? me() : undefined;
    c.updated = Date.now();
    remark(c);
    if (c.resolved && activeId === c.id && !showResolved) activeId = null;
    afterReviewChange();
  }

  function commentCard(c) {
    const active = c.id === activeId;
    const cardPeople = people();
    const toggle = e => { e.stopPropagation(); toggleResolved(c); };
    const card = h('div', { class: 'rv-card' + (active ? ' active' : '') + (c.resolved ? ' resolved' : ''), 'data-id': c.id, style: `--author:${authorColor(c.author)}` });
    if (c.draft) {
      addTo(card,
        h('div', { class: 'cm-card-head' }, avatar(c.author), h('b', {}, c.author)),
        composer('new:' + c.id, 'Add a comment… (what should change, and why)', 'Comment', text => {
          c.draft = false;
          c.text = text;
          c.created = c.updated = Date.now();
          afterReviewChange();
        }, () => removeComment(c)));
      return card;
    }
    const replies = h('div', { class: 'cm-replies' }, c.replies.map(r =>
      h('div', { class: 'cm-reply' },
        h('div', { class: 'cm-card-head' }, avatar(r.author, 18), h('b', {}, r.author), h('span', { class: 'when', title: fullDate(r.created) }, timeAgo(r.created)),
          h('span', { class: 'spacer' }),
          r.author === me() ? h('button', { class: 'icon-btn sm', title: 'Delete reply', html: icon('trash'), onclick: e => { e.stopPropagation(); c.replies = c.replies.filter(x => x !== r); c.updated = Date.now(); afterReviewChange(); } }) : null),
        h('div', { class: 'cm-card-text' }, mentionNodes(r.text, cardPeople)),
        active ? reactionsRow(r, c) : (Object.keys(r.reactions || {}).length ? reactionsRow(r, c) : null))));
    const orphan = !(c.marker && c.marker.find());
    addTo(card,
      h('div', { class: 'cm-card-head' },
        avatar(c.author),
        h('b', {}, c.author),
        h('span', { class: 'when', title: fullDate(c.created) }, timeAgo(c.created)),
        c.resolved ? h('span', { class: 'chip' }, 'Resolved' + (c.resolvedBy ? ' by ' + c.resolvedBy : '')) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn sm', title: c.resolved ? 'Reopen' : 'Resolve', html: icon(c.resolved ? 'undo' : 'check'), onclick: toggle }),
        h('button', { class: 'icon-btn sm', title: 'Delete thread', html: icon('trash'), onclick: e => { e.stopPropagation(); removeComment(c); } })),
      (orphan || active) && c.quote ? h('div', { class: 'rv-quote' }, '“' + (c.quote.length > 300 ? c.quote.slice(0, 300) + '…' : c.quote) + '”') : null,
      h('div', { class: 'cm-card-text' }, mentionNodes(c.text, cardPeople)),
      active || Object.keys(c.reactions).length ? reactionsRow(c, c) : null,
      c.replies.length ? replies : null);
    if (active && !c.resolved && replyOpen.has(c.id)) {
      card.append(h('div', { class: 'cm-card-foot' }, composer('reply:' + c.id, 'Reply… (@ to mention)', 'Reply', text => {
        replyOpen.delete(c.id);
        c.replies.push({ id: uid(), author: me(), created: Date.now(), text, reactions: {} });
        c.updated = Date.now();
        afterReviewChange();
      }, () => { replyOpen.delete(c.id); renderMargin(); })));
    } else if (active && !c.resolved) {
      const replyBtn = h('button', { class: 'link' }, 'Reply');
      replyBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!(await hooks.ensureAuthor())) return;
        replyOpen.add(c.id);
        renderMargin();
      });
      card.append(h('div', { class: 'cm-card-foot' }, replyBtn));
    } else if (!active && c.replies.length) {
      card.append(h('div', { class: 'rv-more' }, `${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}`));
    }
    return card;
  }

  // "Replaced x with y" / "Inserted y" / "Deleted x" for a suggestion and its pair.
  function suggestionWhat(s) {
    const group = groupOf(s);
    const ins = group.find(x => x.type === 'ins'), del = group.find(x => x.type === 'del');
    const textOf = x => { const r = rangeOf(x); return r ? cm.getRange(r.from, r.to) : ''; };
    const clip = t => (t.length > 140 ? t.slice(0, 140) + '…' : t).replace(/\n/g, ' ⏎ ');
    return ins && del
      ? [h('span', {}, 'Replaced '), h('del', {}, clip(textOf(del))), h('span', {}, ' with '), h('ins', {}, clip(textOf(ins)))]
      : ins ? [h('span', {}, 'Inserted '), h('ins', {}, clip(textOf(ins)))]
        : [h('span', {}, 'Deleted '), h('del', {}, clip(textOf(del)))];
  }

  function suggestionCard(s) {
    const what = suggestionWhat(s);
    return h('div', { class: 'rv-card sugg' + (s.id === activeId ? ' active' : ''), 'data-id': s.id, style: `--author:${authorColor(s.author)}` },
      h('div', { class: 'cm-card-head' }, avatar(s.author), h('b', {}, s.author), h('span', { class: 'when', title: fullDate(s.created) }, timeAgo(s.created)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn sm accept', title: 'Accept', html: icon('check'), onclick: e => { e.stopPropagation(); resolveSuggestion(s, true); } }),
        h('button', { class: 'icon-btn sm reject', title: 'Reject', html: icon('close'), onclick: e => { e.stopPropagation(); resolveSuggestion(s, false); } })),
      h('div', { class: 'cm-card-text sugg-text' }, ...what));
  }

  // ---------- The review margin ----------

  // Comments and suggestions in document order (one entry per replace pair).
  function reviewItems() {
    if (!state || !cm) return [];
    const seen = new Set(), items = [];
    for (const s of liveSuggestions()) {
      const key = s.group || s.id;
      if (seen.has(key)) continue;
      seen.add(key);
      const g = groupOf(s);
      const first = g.reduce((p, q) => (CodeMirror.cmpPos(rangeOf(q).from, rangeOf(p).from) < 0 ? q : p));
      items.push({ kind: 'sugg', id: first.id, item: first, marker: first.marker, at: rangeOf(first).from });
    }
    for (const c of state.comments) {
      if (c.resolved && !showResolved && c.id !== activeId) continue;
      items.push({ kind: 'comment', id: c.id, item: c, marker: c.marker, at: commentRange(c).from });
    }
    return items.sort((a, b) => CodeMirror.cmpPos(a.at, b.at));
  }

  // rebuild: true (cards changed), 'auto' (text changed: rebuild only if what the cards show
  // changed) or false (just scrolled: move them).
  let marginFrame = 0, marginRebuild = false, marginSig = '';
  const cardHeights = new Map();
  function marginSignature() {
    return reviewItems().map(it => it.id + (it.kind === 'sugg' ? ':' + groupOf(it.item).map(s => { const r = rangeOf(s); return r ? cm.getRange(r.from, r.to).length : 0; }).join('/') : '')).join('|');
  }
  function scheduleMargin(rebuild) {
    if (rebuild === true || !marginRebuild) marginRebuild = rebuild || marginRebuild;
    if (marginFrame) return;
    marginFrame = requestAnimationFrame(() => {
      marginFrame = 0;
      const mode = marginRebuild;
      marginRebuild = false;
      updateCommentCount(); // the badges count even while the margin is hidden
      if (mode === true || (mode === 'auto' && !$('reviewMargin').hidden && marginSignature() !== marginSig) || (mode === 'auto' && $('reviewMargin').hidden && reviewItems().length)) renderMargin();
      else layoutMargin();
    });
  }

  function renderMargin() {
    marginRebuild = false;
    const margin = $('reviewMargin');
    if (!margin) return;
    cardHeights.clear();
    if (state && cm) marginSig = marginSignature();
    updateCommentCount();
    const items = reviewItems();
    const show = !!state && marginOn && (items.length > 0 || showResolved);
    margin.hidden = !show;
    document.body.classList.toggle('margin-on', show);
    $('reviewBtn').classList.toggle('active', !!state && marginOn);
    if (!show) { margin.replaceChildren(); return; }
    const head = h('div', { class: 'rv-head' },
      h('button', { class: 'icon-btn sm', title: 'Previous (Alt+Up)', html: icon('up'), onclick: () => step(-1) }),
      h('button', { class: 'icon-btn sm', title: 'Next (Alt+Down)', html: icon('down'), onclick: () => step(1) }),
      pendingCount() ? h('button', { class: 'btn sm', title: 'Accept every suggestion', onclick: () => toast(`Accepted ${resolveAll(true)} suggestion(s)`) }, 'Accept all') : null,
      pendingCount() ? h('button', { class: 'btn sm', title: 'Reject every suggestion', onclick: () => toast(`Rejected ${resolveAll(false)} suggestion(s)`) }, 'Reject all') : null,
      h('span', { class: 'spacer' }),
      h('label', { class: 'toggle sm', title: 'Show resolved comments' }, (() => {
        const t = h('input', { type: 'checkbox', checked: showResolved });
        t.addEventListener('change', () => { showResolved = t.checked; renderMargin(); if (previewOn) renderPreview(); });
        return t;
      })(), 'Resolved'));
    // A rebuild must not take the keyboard away from someone typing in a composer.
    const focused = document.activeElement && margin.contains(document.activeElement) && document.activeElement.dataset.key
      ? { key: document.activeElement.dataset.key, a: document.activeElement.selectionStart, b: document.activeElement.selectionEnd } : null;
    const cards = h('div', { class: 'rv-cards' });
    for (const it of items) {
      const card = it.kind === 'sugg' ? suggestionCard(it.item) : commentCard(it.item);
      card.addEventListener('click', e => { if (!e.target.closest('button, textarea, a')) setActive(it.id, true); });
      cards.append(card);
    }
    margin.replaceChildren(head, cards);
    if (focused) {
      const ta = margin.querySelector(`textarea[data-key="${CSS.escape(focused.key)}"]`);
      if (ta) { ta.focus(); ta.setSelectionRange(focused.a, focused.b); }
    }
    layoutMargin();
  }

  // Where an item's anchor is, in pixels from the top of the margin's card area.
  function anchorTop(it, base) {
    if (previewOn) {
      const sel = it.kind === 'comment' ? `.rv-cs[data-cid="${CSS.escape(it.id)}"]` : `[data-sid="${CSS.escape(it.id)}"]`;
      const el = $('docPreview').querySelector(sel);
      if (el) return el.getBoundingClientRect().top - base;
      const line = it.at.line;
      const block = [...$('docPreview').querySelectorAll('.md-block')].reverse().find(b => +b.dataset.line <= line);
      return block ? block.getBoundingClientRect().top - base : 0;
    }
    // Line tops from CodeMirror's height map (no layout per item), plus one measured offset.
    if (lineDelta == null) lineDelta = cm.charCoords({ line: 0, ch: 0 }, 'window').top - cm.heightAtLine(0, 'local');
    return cm.heightAtLine(it.at.line, 'local') + lineDelta - base;
  }
  let lineDelta = null;

  // Cards sit next to their anchors; the active one exactly, the others pushed apart.
  function layoutMargin() {
    const margin = $('reviewMargin');
    if (!margin || margin.hidden) return;
    const box = margin.querySelector('.rv-cards');
    if (!box) return;
    const base = box.getBoundingClientRect().top;
    lineDelta = null;
    const items = reviewItems();
    const cards = items.map(it => box.querySelector(`.rv-card[data-id="${CSS.escape(it.id)}"]`));
    // Anchors just above the card area (the first lines, under the margin's header) still
    // get their card at the top instead of half hidden.
    const tops = items.map(it => { const t = anchorTop(it, base); return t > -80 ? Math.max(4, t) : t; });
    // Heights are measured once per rebuild (reading them forces layout).
    const heights = cards.map((c, i) => {
      if (!c) return 0;
      let hgt = cardHeights.get(items[i].id);
      if (hgt == null) { hgt = c.offsetHeight; cardHeights.set(items[i].id, hgt); }
      return hgt;
    });
    const GAP = 8;
    let ai = items.findIndex(it => it.id === activeId);
    if (ai < 0) ai = 0;
    const y = tops.slice();
    for (let i = ai + 1; i < y.length; i++) y[i] = Math.max(y[i], y[i - 1] + heights[i - 1] + GAP);
    for (let i = ai - 1; i >= 0; i--) y[i] = Math.min(y[i], y[i + 1] - heights[i] - GAP);
    // Pushing cards up must not bury a visible anchor's card under the header: if it did,
    // let the active card move down instead.
    const minFirst = tops[0] > -80 ? 4 : -Infinity;
    if (y[0] < minFirst) {
      y[0] = minFirst;
      for (let i = 1; i < y.length; i++) y[i] = Math.max(y[i], y[i - 1] + heights[i - 1] + GAP);
    }
    cards.forEach((c, i) => { if (c) c.style.transform = `translateY(${Math.round(y[i])}px)`; });
  }

  function setActive(id, scroll) {
    activeId = id;
    renderMargin();
    const it = reviewItems().find(x => x.id === id);
    if (!it) return;
    if (scroll) {
      if (previewOn) {
        const el = $('docPreview').querySelector(it.kind === 'comment' ? `.rv-cs[data-cid="${CSS.escape(it.id)}"]` : `[data-sid="${CSS.escape(it.id)}"]`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      } else {
        const r = it.marker && it.marker.find();
        if (r) { cm.setSelection(r.from, r.to); cm.scrollIntoView(r, 160); }
      }
    }
    if (previewOn) paintHighlights();
    for (const el of document.querySelectorAll('.CodeMirror .rv-active-mark')) el.classList.remove('rv-active-mark');
    for (const el of document.querySelectorAll(`.CodeMirror [data-cid="${CSS.escape(id)}"], .CodeMirror [data-sid="${CSS.escape(id)}"]`)) el.classList.add('rv-active-mark');
    scheduleMargin(false);
  }

  // Next/previous comment or suggestion, wrapping around.
  function step(dir) {
    const items = reviewItems();
    if (!items.length) { toast('No comments or suggestions'); return; }
    let i = items.findIndex(it => it.id === activeId);
    i = i < 0 ? (dir > 0 ? 0 : items.length - 1) : (i + dir + items.length) % items.length;
    setActive(items[i].id, true);
  }

  function toggleMargin() {
    if (!state) return;
    marginOn = !marginOn;
    renderMargin();
    if (marginOn && !reviewItems().length) toast('No comments or suggestions yet. Select text and press Comment, or turn on Suggesting.');
  }

  // ---------- Preview ----------

  function setPreview(on) {
    previewOn = on;
    $('cmHost').hidden = on;
    $('docPreview').hidden = !on;
    for (const b of document.querySelectorAll('#docViewSeg button')) b.classList.toggle('active', (b.dataset.view === 'preview') === on);
    if (on) renderPreview();
    else {
      setDrawTool(null);
      if (cm) { cm.refresh(); cm.focus(); }
    }
    scheduleMargin(true);
    scheduleStatus();
  }

  function exportModel(includeResolved) {
    const text = cm.getValue();
    const comments = serializeComments().map(c => ({ ...c, start: idx(c.from), end: idx(c.to) }));
    const suggestions = serializeSuggestions().map(s => ({ ...s, start: idx(s.from), end: idx(s.to) }));
    return { name: state.name, text, comments, suggestions, includeResolved };
  }

  function renderPreview() {
    const el = $('docPreview');
    if (!state || !cm) { el.replaceChildren(); return; }
    const model = exportModel(showResolved);
    const { src, items } = Review.prepare(model, 'markup');
    const html = Review.blocksHtml(src, items, { commentRefs: false })
      .map(b => `<div${Review.OURS} class="md-block" data-line="${b.line}" data-end="${b.endLine}">${b.html}</div>`).join('');
    const scroll = el.scrollTop;
    const base = state.filePath ? Platform.fileUrl(Platform.dirOf(state.filePath), '') : null;
    el.innerHTML = SafeHtml.sanitize(html, base);
    for (const img of el.querySelectorAll('img')) img.addEventListener('load', () => scheduleMargin(false), { once: true });
    el.scrollTop = scroll;
    paintHighlights();
    paintInk();
  }

  // Comment ranges in the preview, highlighted with the CSS Custom Highlight API so they
  // can span across paragraphs and list items.
  function paintHighlights() {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    const all = new Highlight(), active = new Highlight();
    const el = $('docPreview');
    for (const s of el.querySelectorAll('.rv-cs')) {
      const id = s.dataset.cid;
      const e = el.querySelector(`.rv-ce[data-cid="${CSS.escape(id)}"]`);
      if (!e) continue;
      const r = new Range();
      r.setStartAfter(s);
      r.setEndBefore(e);
      const c = state.comments.find(x => x.id === id);
      if (id === activeId) active.add(r);
      else if (c && !c.resolved) all.add(r);
    }
    CSS.highlights.set('wb-comment', all);
    CSS.highlights.set('wb-comment-active', active);
  }

  document.getElementById('docPreview').addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (a) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) return;
      e.preventDefault();
      Platform.openExternal(a.href);
      return;
    }
    const sid = e.target.closest('[data-sid]');
    if (sid) { setActive(sid.dataset.sid, false); return; }
    // A click inside a highlighted comment range activates its thread.
    const caret = document.caretPositionFromPoint ? document.caretPositionFromPoint(e.clientX, e.clientY) : null;
    if (caret && CSS.highlights) {
      for (const name of ['wb-comment', 'wb-comment-active']) {
        const hl = CSS.highlights.get(name);
        if (!hl) continue;
        for (const r of hl) {
          if (r.isPointInRange(caret.offsetNode, caret.offset)) {
            const s = r.startContainer.childNodes[r.startOffset - 1] || r.startContainer;
            const cs = s.closest ? s.closest('.rv-cs') : null;
            const id = cs ? cs.dataset.cid : null;
            if (id) { setActive(id, false); return; }
          }
        }
      }
    }
  });
  document.getElementById('docPreview').addEventListener('scroll', () => scheduleMargin(false));

  // ---------- Ink on the document ----------
  // Strokes are drawn over the preview and anchored to the Markdown block they start in
  // (a bookmark on its first line moves with edits). Points are CSS pixels relative to
  // that block's top-left corner.

  let drawTool = null;      // null | 'pen' | 'highlighter' | 'write' | 'eraser'
  const inkSettings = { color: '#e81224', size: 3 };
  let inkGesture = null;
  let inkUndo = [];
  let writeTimer = null;
  let pendingWrite = [];    // strokes waiting to be turned into text

  function normalizeInk(k) {
    const finite = v => Number.isFinite(+v);
    return {
      id: safeId(k.id), author: name(k.author), created: num(k.created),
      color: /^#[0-9a-f]{3,8}$/i.test(k.color) ? k.color : '#e81224', size: clamp(+k.size || 3, 0.5, 80), highlighter: !!k.highlighter, pressure: !!k.pressure,
      points: (Array.isArray(k.points) ? k.points : []).filter(p => Array.isArray(p) && finite(p[0]) && finite(p[1])).slice(0, 20000)
        .map(p => [+p[0], +p[1], finite(p[2]) ? clamp(+p[2], 0, 1) : 0.5]),
      line: Math.max(0, k.line | 0),
    };
  }

  function attachInk(k) {
    if (!k.points.length) return null;
    const line = clamp(k.line, 0, cm.lastLine());
    k.anchor = cm.setBookmark({ line, ch: 0 }, { insertLeft: true });
    state.ink.push(k);
    return k;
  }

  const inkLine = k => { const p = k.anchor && k.anchor.find(); return p ? p.line : k.line; };

  // Takes a stroke off the document, remembering its current line so undo puts the same
  // stroke back where it was.
  function detachInk(k) {
    k.line = inkLine(k);
    if (k.anchor) k.anchor.clear();
    k.anchor = null;
    state.ink = state.ink.filter(x => x !== k);
  }

  function serializeInk() {
    return state.ink.map(k => {
      const { anchor, ...rest } = k;
      return { ...rest, line: inkLine(k) };
    });
  }

  function blockForLine(line) {
    const blocks = [...$('docPreview').querySelectorAll('.md-block')];
    let best = blocks[0] || null;
    for (const b of blocks) { if (+b.dataset.line <= line) best = b; else break; }
    return best;
  }

  // SVG for the strokes anchored in a block (also used by HTML/PDF export).
  function inkSvgFor(line, endLine) {
    if (!state) return '';
    const mine = state.ink.filter(k => { const l = inkLine(k); return l >= line && l <= endLine; });
    if (!mine.length) return '';
    return `<svg class="ink" width="1" height="1">${mine.map(k => strokeSvg(k)).join('')}</svg>`;
  }

  function paintInk() {
    const el = $('docPreview');
    for (const svg of el.querySelectorAll('svg.ink')) svg.remove();
    if (!state.ink.length) return;
    const byBlock = new Map();
    for (const k of state.ink) {
      const b = blockForLine(inkLine(k));
      if (!b) continue;
      if (!byBlock.has(b)) byBlock.set(b, []);
      byBlock.get(b).push(k);
    }
    for (const [b, list] of byBlock) {
      b.insertAdjacentHTML('beforeend', `<svg class="ink" width="1" height="1">${list.map(k => strokeSvg(k)).join('')}</svg>`);
    }
  }

  function setDrawTool(tool) {
    drawTool = tool;
    document.body.classList.toggle('doc-drawing', !!tool);
    $('docDrawBar').hidden = !tool;
    $('drawDocBtn').classList.toggle('active', !!tool);
    for (const b of $('docDrawBar').querySelectorAll('[data-ink-tool]')) b.classList.toggle('active', b.dataset.inkTool === tool);
    const canvas = $('docInk');
    canvas.hidden = !tool;
    if (tool) sizeInkCanvas();
    if (!tool) flushWrite();
  }

  async function toggleDraw() {
    if (!state) return;
    if (drawTool) { setDrawTool(null); return; }
    await hooks.ensureAuthor();
    if (!previewOn) setPreview(true);
    setDrawTool('pen');
  }

  let liveInk = null; // createLiveInk for the doc ink canvas, made on first use

  function sizeInkCanvas() {
    const canvas = $('docInk'), r = $('docPreview').getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.style.left = $('docPreview').offsetLeft + 'px';
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    if (liveInk) liveInk.reset(); // setting the size cleared it, even when it didn't change
  }

  // Pointer position in the preview's content coordinates (scroll included).
  function contentPoint(e) {
    const el = $('docPreview'), r = el.getBoundingClientRect();
    return [e.clientX - r.left + el.scrollLeft, e.clientY - r.top + el.scrollTop, e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5];
  }

  function blockAtY(y) {
    const blocks = [...$('docPreview').querySelectorAll('.md-block')];
    let best = blocks[0] || null;
    for (const b of blocks) { if (b.offsetTop <= y) best = b; else break; }
    return best;
  }

  function drawInkLive() {
    const canvas = $('docInk'), g = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1, el = $('docPreview');
    if (!liveInk) liveInk = createLiveInk(canvas, g);
    if (inkGesture && inkGesture.kind === 'draw') {
      liveInk.draw(inkGesture.builder, [], dpr, -el.scrollLeft * dpr, -el.scrollTop * dpr);
      return;
    }
    liveInk.reset();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
  }

  function inkHit(x, y, r) {
    const hits = [];
    for (const k of state.ink) {
      const b = blockForLine(inkLine(k));
      if (!b) continue;
      if (hitTest({ type: 'stroke', size: k.size, pressure: k.pressure, points: k.points }, x - b.offsetLeft, y - b.offsetTop, r)) hits.push(k);
    }
    return hits;
  }

  function onInkDown(e) {
    if (!drawTool || e.button > 0 && e.pointerType !== 'pen') return;
    if (e.pointerType === 'pen') inkSawPen = true;
    // A pen takes over from a touch that got there first (a resting palm): that touch's
    // stroke is dropped. Otherwise one stroke at a time, and once a pen has been used a
    // touch is a palm.
    if (inkGesture && e.pointerType === 'pen' && inkGesture.pointerType === 'touch') { inkGesture = null; drawInkLive(); }
    if (inkGesture || (e.pointerType === 'touch' && inkSawPen)) return;
    e.preventDefault();
    $('docInk').setPointerCapture(e.pointerId);
    const p = contentPoint(e);
    const tool = (e.pointerType === 'pen' && (e.buttons & 32)) ? 'eraser' : drawTool;
    if (tool === 'eraser') {
      inkGesture = { kind: 'erase', id: e.pointerId, pointerType: e.pointerType };
      eraseInk(p);
      return;
    }
    const writing = tool === 'write';
    const el = {
      type: 'stroke', color: writing ? '#1f6feb' : inkSettings.color, size: tool === 'highlighter' ? 18 : writing ? 2.5 : inkSettings.size,
      highlighter: tool === 'highlighter', pressure: e.pointerType === 'pen' && tool !== 'highlighter', points: [p],
    };
    $('docInk').style.opacity = el.highlighter ? '0.4' : '';
    inkGesture = { kind: 'draw', id: e.pointerId, pointerType: e.pointerType, el, builder: strokeBuilder(el, true), writing };
    clearTimeout(writeTimer);
    drawInkLive();
  }

  let inkSawPen = false;

  function onInkMove(e) {
    if (!inkGesture || e.pointerId !== inkGesture.id) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      const p = contentPoint(ev);
      if (inkGesture.kind === 'erase') { eraseInk(p); continue; }
      const pts = inkGesture.el.points, last = pts[pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 1) continue;
      pts.push([p[0], p[1], last[2] * 0.5 + p[2] * 0.5]);
    }
    if (inkGesture.kind === 'draw') { extendStroke(inkGesture.builder); drawInkLive(); }
  }

  function onInkUp(e) {
    if (!inkGesture || e.pointerId !== inkGesture.id) return;
    const g = inkGesture;
    inkGesture = null;
    $('docInk').style.opacity = '';
    drawInkLive();
    if (g.kind === 'erase') return;
    const block = blockAtY(g.el.points[0][1]);
    if (!block) return;
    const ox = block.offsetLeft, oy = block.offsetTop;
    const k = attachInk(normalizeInk({
      author: me(), color: g.el.color, size: g.el.size, highlighter: g.el.highlighter, pressure: g.el.pressure,
      points: g.el.points.map(([x, y, pr]) => [x - ox, y - oy, pr]), line: +block.dataset.line,
    }));
    if (!k) return;
    inkUndo.push({ add: k });
    paintInk();
    hooks.changed();
    scheduleStatus();
    if (g.writing) {
      pendingWrite.push(k);
      writeTimer = setTimeout(flushWrite, 1200);
    }
  }

  function eraseInk(p) {
    const hits = inkHit(p[0], p[1], 8);
    if (!hits.length) return;
    for (const k of hits) {
      detachInk(k);
      inkUndo.push({ remove: k });
    }
    paintInk();
    hooks.changed();
  }

  function undoInk() {
    const op = inkUndo.pop();
    if (!op) return;
    if (op.add) detachInk(op.add);
    else if (op.remove) attachInk(op.remove);
    paintInk();
    hooks.changed();
  }

  function clearMyInk() {
    const mine = state.ink.filter(k => k.author === me());
    if (!mine.length) return;
    for (const k of mine) { detachInk(k); inkUndo.push({ remove: k }); }
    paintInk();
    hooks.changed();
    toast(`Removed ${mine.length} of your ink strokes`, 'Undo', () => { for (let i = 0; i < mine.length; i++) undoInk(); });
  }

  // Handwriting written with the "Write" pen becomes text, inserted after the block it
  // was written on (as a suggestion when Suggesting is on).
  async function flushWrite() {
    clearTimeout(writeTimer);
    const strokes = pendingWrite.filter(k => state && state.ink.includes(k));
    pendingWrite = [];
    if (!strokes.length) return;
    const doc = state;
    // Recognize in a common coordinate space: block-relative points plus the block's offset.
    const pts = strokes.map(k => {
      const b = blockForLine(inkLine(k));
      const ox = b ? b.offsetLeft : 0, oy = b ? b.offsetTop : 0;
      return k.points.map(([x, y, p]) => [x + ox, y + oy, p]);
    });
    let res;
    try { res = await Platform.recognizeInk(pts, 'text'); } catch (err) { toast(err.message || 'Handwriting recognition failed'); return; }
    if (state !== doc || !strokes.every(k => state.ink.includes(k))) return; // the document changed meanwhile
    const text = (res.lines || []).sort((a, b) => a.rect[1] - b.rect[1]).map(l => l.text).join('\n').trim();
    if (!text) { toast('Couldn’t read that handwriting'); return; }
    const line = Math.max(...strokes.map(inkLine));
    const block = blockForLine(line);
    const endLine = block ? Math.min(+block.dataset.end, cm.lastLine()) : cm.lastLine();
    const at = { line: endLine, ch: cm.getLine(endLine).length };
    for (const k of strokes) detachInk(k);
    // Insert as a normal edit; in Suggesting mode it becomes a suggested insertion.
    cm.replaceRange('\n\n' + text, at, at, suggesting ? '+input' : '+write');
    renderPreview();
    toast(`Inserted “${text.length > 40 ? text.slice(0, 40) + '…' : text}”`, 'Undo', () => cm.undo());
  }

  const inkCanvas = document.getElementById('docInk');
  inkCanvas.addEventListener('pointerdown', onInkDown);
  inkCanvas.addEventListener('pointermove', onInkMove);
  inkCanvas.addEventListener('pointerup', onInkUp);
  inkCanvas.addEventListener('pointercancel', onInkUp);
  inkCanvas.addEventListener('lostpointercapture', onInkUp);
  inkCanvas.addEventListener('wheel', e => { $('docPreview').scrollTop += e.deltaY; $('docPreview').scrollLeft += e.deltaX; drawInkLive(); }, { passive: true });
  inkCanvas.addEventListener('contextmenu', e => e.preventDefault());

  // ---------- Merging a returned copy ----------
  // Comment threads from another copy of this document are added (or updated) by id;
  // anchors are found again by the quoted text when the text has moved.

  function collisionId(id, author) {
    let hash = 0;
    for (const ch of id + '\n' + author) hash = (Math.imul(hash, 31) + ch.codePointAt(0)) | 0;
    return id + '-' + (hash >>> 0).toString(36);
  }

  function mergeReview(other) {
    if (!state || !other) return { added: 0, updated: 0 };
    let added = 0, updated = 0;
    const text = cm.getValue();
    const locate = c => {
      const q = (c.quote || '').trim();
      if (c.from && c.to) {
        const r = clipRange(c.from, c.to);
        if (!q || cm.getRange(r.from, r.to).trim() === q) return r;
      }
      const at = q ? text.indexOf(q) : -1;
      if (at >= 0) return { from: pos(at), to: pos(at + q.length) };
      return clipRange(c.from, c.from);
    };
    for (const raw of Array.isArray(other.comments) ? other.comments : []) {
      if (!raw || !raw.text || raw.draft) continue;
      const theirs = normalizeComment(raw);
      // Same id but a different author is a collision, not the same thread. The new id is
      // derived from both, so merging the same copy again finds this thread instead of
      // adding it twice.
      if (state.comments.some(c => c.id === theirs.id && c.author !== theirs.author)) theirs.id = collisionId(theirs.id, theirs.author);
      const mine = state.comments.find(c => c.id === theirs.id);
      if (!mine) {
        const r = locate(raw);
        attachComment(theirs, r.from, r.to);
        added++;
        continue;
      }
      let changed = false;
      for (const rep of theirs.replies) {
        if (!mine.replies.some(x => x.id === rep.id)) { mine.replies.push(rep); changed = true; }
      }
      mine.replies.sort((a, b) => a.created - b.created);
      for (const target of [mine, ...mine.replies]) {
        const src = target === mine ? theirs : theirs.replies.find(x => x.id === target.id);
        if (!src) continue;
        for (const [emoji, names] of Object.entries(src.reactions)) {
          const list = target.reactions[emoji] || (target.reactions[emoji] = []);
          for (const n of names) if (!list.includes(n)) { list.push(n); changed = true; }
        }
      }
      if (theirs.updated > mine.updated && theirs.resolved !== mine.resolved) {
        mine.resolved = theirs.resolved;
        mine.resolvedBy = theirs.resolvedBy;
        remark(mine);
        changed = true;
      }
      if (changed) { mine.updated = Math.max(mine.updated, theirs.updated); updated++; }
    }
    afterReviewChange();
    return { added, updated };
  }

  // ---------- Review export (bundle for AI models and agents) ----------

  function reviewData() {
    const text = cm.getValue();
    const authors = lineAuthors();
    const comments = serializeComments();
    const contributors = new Map();
    const bump = (name, key) => {
      if (!name) return;
      const c = contributors.get(name) || { lines: 0, comments: 0 };
      c[key]++;
      contributors.set(name, c);
    };
    authors.forEach(m => m && bump(m.a, 'lines'));
    for (const c of comments) { bump(c.author, 'comments'); c.replies.forEach(r => bump(r.author, 'comments')); }
    return {
      name: state.name,
      filePath: state.filePath,
      text,
      lineCount: cm.lineCount(),
      comments,
      contributors,
      diff: text === state.baseline ? '' : unifiedDiff(state.baseline, text, authors),
      editedRanges: editedRanges(authors),
    };
  }

  // Consecutive lines last edited by the same person, e.g. "Sam: lines 12–18".
  function editedRanges(authors) {
    const out = [];
    authors.forEach((m, i) => {
      const prev = out[out.length - 1];
      if (!m) return;
      if (prev && prev.author === m.a && prev.to === i) { prev.to = i + 1; prev.t = Math.max(prev.t, m.t); }
      else out.push({ author: m.a, from: i + 1, to: i + 1, t: m.t });
    });
    return out;
  }

  // Markdown sections for the review bundle: comments, suggestions, changes, current document.
  // People's names and text go in escaped and quoted (Review.mdLabel / mdQuote). Quoting
  // also keeps blank lines in comments through the bundle's blank-line cleanup.
  const who = n => Review.mdLabel(n) || 'Someone';
  const quoted = Review.mdQuote;

  function reviewSections() {
    const d = reviewData();
    const parts = [];
    // In document order, so the numbers read top to bottom like the text.
    const byPos = (a, b) => a.from.line - b.from.line || a.from.ch - b.from.ch;
    const open = d.comments.filter(c => !c.resolved).sort(byPos), resolved = d.comments.filter(c => c.resolved).sort(byPos);
    parts.push(`## Comments (${open.length} open, ${resolved.length} resolved)`, '');
    if (!d.comments.length) parts.push('_No comments._', '');
    const writeComment = (c, i) => {
      const lineRef = c.from.line === c.to.line || (c.to.ch === 0 && c.to.line === c.from.line + 1)
        ? `line ${c.from.line + 1}` : `lines ${c.from.line + 1}–${c.to.ch === 0 ? c.to.line : c.to.line + 1}`;
      parts.push(`### ${i + 1}. ${lineRef}${c.resolved ? ' (resolved' + (c.resolvedBy ? ' by ' + who(c.resolvedBy) : '') + ')' : ''}`);
      if (c.quote) parts.push('', ...quoted(c.quote));
      const reacts = x => Object.entries(x.reactions || {}).map(([e, n]) => `${Review.mdLabel(e)} ${n.map(who).join(', ')}`).join('; ');
      parts.push('', `**${who(c.author)}** (${stamp(c.created)}) wrote:`, '', ...quoted(c.text));
      for (const r of c.replies) {
        parts.push('', `- **${who(r.author)}** (${stamp(r.created)}) replied:`, '', ...quoted(r.text, '  '));
        if (reacts(r)) parts.push('', `  Reactions: ${reacts(r)}`);
      }
      if (reacts(c)) parts.push('', `Reactions: ${reacts(c)}`);
      parts.push('');
    };
    [...open, ...resolved].forEach(writeComment);

    const suggestions = serializeSuggestions();
    if (suggestions.length) {
      parts.push(`## Pending suggestions (${new Set(suggestions.map(s => s.group || s.id)).size})`, '',
        'Suggested edits that nobody has accepted or rejected yet. Line numbers refer to the "Current document" below, which still contains the suggested deletions.', '');
      for (const s of suggestions.sort((a, b) => a.from.line - b.from.line || a.from.ch - b.from.ch)) {
        const txt = cm.getRange(s.from, s.to);
        parts.push(`- line ${s.from.line + 1}, **${who(s.author)}** suggests ${s.type === 'ins' ? 'inserting' : 'deleting'}: ${JSON.stringify(txt.length > 300 ? txt.slice(0, 300) + '…' : txt)}`);
      }
      parts.push('');
    }
    if (state.ink.length) {
      const lines = [...new Set(state.ink.map(k => inkLine(k) + 1))].sort((a, b) => a - b);
      parts.push(`_The document also has ${state.ink.length} hand-drawn ink annotation(s), near line(s) ${lines.join(', ')}._`, '');
    }

    parts.push('## Changes since import', '');
    if (d.editedRanges.length) {
      parts.push('Who edited what (current line numbers):', '');
      for (const r of d.editedRanges) parts.push(`- ${who(r.author)}: ${r.from === r.to ? 'line ' + r.from : `lines ${r.from}–${r.to}`} (last edit ${stamp(r.t)})`);
      parts.push('');
    }
    if (d.diff) {
      const f = fenceFor(d.diff);
      parts.push('Unified diff against the originally imported version:', '', f + 'diff', d.diff, f, '');
    } else parts.push('_No changes to the text since it was imported._', '');

    const docFence = fenceFor(d.text, 4);
    const documentPart = [`## Current document: ${Review.mdCode(d.name)} (${d.lineCount} lines)`, '',
      'Line numbers in the comments and changes above refer to this version.', '',
      docFence + 'markdown', d.text, docFence, ''].join('\n');
    return { title: Review.mdCode(d.name), contributors: d.contributors, open: open.length, body: parts.join('\n'), document: documentPart };
  }

  window.addEventListener('resize', () => { if (drawTool) sizeInkCanvas(); scheduleMargin(false); });

  // ---------- Review panel (the Review tab on the board's toolbar) ----------

  // Every comment (resolved too) and pending suggestion, in document order.
  function overview() {
    if (!state || !cm) return { comments: [], suggestions: [], edited: [] };
    const byLine = (a, b) => CodeMirror.cmpPos(a.at, b.at);
    const comments = state.comments.filter(c => !c.draft && c.text).map(c => ({ c, at: commentRange(c).from })).sort(byLine);
    const suggestions = reviewItems().filter(it => it.kind === 'sugg').map(it => ({ s: it.item, at: it.at }));
    return { comments, suggestions, edited: editedRanges(lineAuthors()) };
  }

  // What the Review panel shows, worked out once per render: the overview, its counts, and
  // per tab a signature of everything its rows display, so the panel can skip rebuilding.
  function panelData() {
    const o = overview();
    const open = o.comments.filter(x => !x.c.resolved).length;
    o.counts = { open, resolved: o.comments.length - open, pending: o.suggestions.length, edited: o.edited.length };
    const textOf = x => { const r = rangeOf(x); return r ? cm.getRange(r.from, r.to) : ''; };
    o.sig = {
      comments: JSON.stringify(o.comments.map(({ c, at }) => [c.id, at.line, c.author, c.created, c.text, c.resolved, c.replies.length])),
      changes: JSON.stringify([
        o.suggestions.map(({ s, at }) => [s.id, at.line, s.author, s.created, groupOf(s).map(x => [x.type, textOf(x)])]),
        o.edited.map(r => [r.author, r.from, r.to, Math.floor(r.t / 60000)]), // shown as "5m ago": the minute is enough
      ]),
    };
    return o;
  }

  function reviewCounts() {
    return panelData().counts;
  }

  // The list for one tab of the panel ('comments' or 'changes'). `open(id)` shows the
  // item in the document; `showResolved` includes resolved comments.
  function panelList(tab, { open, showResolved: withResolved, data }) {
    const o = data || overview();
    const line = at => h('span', { class: 'rp-line' }, `line ${at.line + 1}`);
    const item = (id, author, cls, ...children) => {
      const el = h('div', { class: 'rp-item' + cls, style: `--author:${authorColor(author)}`, tabindex: '0', role: 'button' }, ...children);
      el.addEventListener('click', e => { if (!e.target.closest('button')) open(id); });
      el.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === el) open(id); });
      return el;
    };
    if (tab === 'comments') {
      const list = o.comments.filter(x => withResolved || !x.c.resolved);
      if (!list.length) return [h('div', { class: 'rp-empty' }, o.comments.length ? 'No open comments.' : 'No comments yet. Select text in the document and press Comment.')];
      return list.map(({ c, at }) => item(c.id, c.author, c.resolved ? ' resolved' : '',
        h('div', { class: 'rp-meta' }, avatar(c.author, 20), h('b', {}, c.author), h('span', { class: 'when', title: fullDate(c.created) }, timeAgo(c.created)),
          h('span', { class: 'spacer' }), line(at),
          h('button', { class: 'icon-btn sm', title: c.resolved ? 'Reopen' : 'Resolve', html: icon(c.resolved ? 'undo' : 'check'), onclick: () => toggleResolved(c) })),
        c.quote ? h('div', { class: 'rv-quote' }, '“' + (c.quote.length > 120 ? c.quote.slice(0, 120) + '…' : c.quote) + '”') : null,
        h('div', { class: 'cm-card-text' }, c.text.length > 240 ? c.text.slice(0, 240) + '…' : c.text),
        c.resolved ? h('div', { class: 'rv-more' }, 'Resolved' + (c.resolvedBy ? ' by ' + c.resolvedBy : '')) : null,
        c.replies.length ? h('div', { class: 'rv-more' }, `${c.replies.length} repl${c.replies.length === 1 ? 'y' : 'ies'}`) : null));
    }
    const out = [];
    if (o.suggestions.length) {
      out.push(h('div', { class: 'rp-actions' },
        h('button', { class: 'btn sm', onclick: () => toast(`Accepted ${resolveAll(true)} suggestion(s)`) }, 'Accept all'),
        h('button', { class: 'btn sm', onclick: () => toast(`Rejected ${resolveAll(false)} suggestion(s)`) }, 'Reject all')));
      for (const { s, at } of o.suggestions) {
        out.push(item(s.id, s.author, ' sugg',
          h('div', { class: 'rp-meta' }, avatar(s.author, 20), h('b', {}, s.author), h('span', { class: 'when', title: fullDate(s.created) }, timeAgo(s.created)),
            h('span', { class: 'spacer' }), line(at),
            h('button', { class: 'icon-btn sm accept', title: 'Accept', html: icon('check'), onclick: () => resolveSuggestion(s, true) }),
            h('button', { class: 'icon-btn sm reject', title: 'Reject', html: icon('close'), onclick: () => resolveSuggestion(s, false) })),
          h('div', { class: 'cm-card-text sugg-text' }, ...suggestionWhat(s))));
      }
    } else out.push(h('div', { class: 'rp-empty' }, 'No pending suggestions. Turn on Suggest (Ctrl+Shift+E) to propose edits.'));
    if (o.edited.length) {
      out.push(h('div', { class: 'rp-section' }, 'Edited since import'));
      for (const r of o.edited) {
        const el = h('div', { class: 'rp-edit', style: `--author:${authorColor(r.author)}`, tabindex: '0', role: 'button', title: 'Show these lines' },
          h('b', {}, r.author), h('span', {}, r.from === r.to ? ` line ${r.from}` : ` lines ${r.from}–${r.to}`), h('span', { class: 'when' }, timeAgo(r.t)));
        const go = () => open({ line: r.from - 1 });
        el.addEventListener('click', go);
        el.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
        out.push(el);
      }
    }
    return out;
  }

  // Shows a comment or suggestion (by id) or a line ({ line }) in the document.
  function openItem(target) {
    if (!state || !cm) return;
    if (typeof target === 'object') {
      if (previewOn) setPreview(false);
      cm.setCursor({ line: target.line, ch: 0 });
      cm.scrollIntoView({ line: target.line, ch: 0 }, 160);
      cm.focus();
      return;
    }
    // The preview leaves resolved threads out; show those in the editor instead.
    if (previewOn && !$('docPreview').querySelector(`.rv-cs[data-cid="${CSS.escape(target)}"], [data-sid="${CSS.escape(target)}"]`)) setPreview(false);
    marginOn = true;
    setActive(target, true);
  }

  return {
    init(h2) { Object.assign(hooks, h2); },
    reviewCounts,
    panelData,
    panelList,
    openItem,
    hasDoc: () => !!state,
    info: () => state && { name: state.name, filePath: state.filePath },
    text: () => (cm ? finalText(state ? state.eol : '\n') : ''),
    plainText: () => (cm ? finalText() : ''),
    load,
    serialize,
    isDirty,
    markSaved,
    resetTracking,
    addComment,
    setPreview,
    isPreview: () => previewOn,
    setSuggesting,
    isSuggesting: () => suggesting,
    toggleMargin,
    step,
    resolveAll,
    toggleDraw,
    setDrawTool,
    drawTool: () => drawTool,
    inkSettings,
    undoInk,
    clearMyInk,
    flushWrite,
    exportModel: () => exportModel(true),
    inkSvgFor,
    hasInk: () => !!state && state.ink.length > 0,
    mergeReview,
    reviewSections,
    insertText(text) {
      if (!cm || !state) return;
      if (previewOn) setPreview(false);
      cm.replaceSelection(text);
      cm.focus();
    },
    refresh() { if (cm && !previewOn) cm.refresh(); scheduleMargin(true); if (drawTool) sizeInkCanvas(); },
    focus() { if (cm && !previewOn) cm.focus(); },
  };
})();
