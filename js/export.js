'use strict';
// Rendering a reviewed Markdown document for the preview and for export: HTML (and PDF
// through it) and Word .docx with real Word comments, replies, resolved state and
// tracked changes. Also a small store-only ZIP writer for the .docx package.
//
// Review ranges (comments, suggested insertions and deletions) are carried through
// Markdown parsing as private-use "sentinel" characters injected into the source:
// a kind character (U+E000..U+E005) followed by an index character (U+E100 + n).
// marked treats them as ordinary text, so they come out wherever the text lands.

const Review = (() => {
  const KIND = { cs: 0xe000, ce: 0xe001, is: 0xe002, ie: 0xe003, ds: 0xe004, de: 0xe005 };
  const KIND_NAME = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
  const SENTINEL = /([\uE000-\uE005])([\uE100-\uEFFF])/g;
  const ANY_SENTINEL = /[\uE000-\uE005][\uE100-\uEFFF]/g;
  const KIND_CHARS = /[\uE000-\uE005]/g;
  const MAX_ITEMS = 0xefff - 0xe100;

  const mark = (kind, n) => String.fromCharCode(KIND[kind]) + String.fromCharCode(0xe100 + n);
  const stripMarks = s => String(s).replace(ANY_SENTINEL, '');

  // Block syntax at the start of a line that a sentinel must not split.
  const BLOCK_PREFIX = /^[ \t]*(?:(?:#{1,6}|>|[-*+]|\d{1,9}[.)])(?:[ \t]+|$))*(?:\[[ xX]\][ \t]+)?/;
  // Lines a sentinel can't sit on at all: fences, rules, setext underlines, table
  // delimiter rows, HTML block lines.
  const UNTOUCHABLE = /^ {0,3}(?:`{3,}|~{3,}|([-*_])(?: *\1){2,} *$|=+ *$|-+ *$|<)|^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;
  const TABLE_ROW = /^ {0,3}\|/;
  const ATX_CLOSE = /^ {0,3}#{1,6}[ \t].*?([ \t]+#+[ \t]*)$/;
  const BLANK = /^[ \t]*$/;

  function lineStartOf(text, p) { return text.lastIndexOf('\n', p - 1) + 1; }
  function lineEndOf(text, p) { const e = text.indexOf('\n', p); return e < 0 ? text.length : e; }
  const lineAt = (text, p) => { const ls = lineStartOf(text, p); return { ls, le: lineEndOf(text, ls), line: text.slice(ls, lineEndOf(text, ls)) }; };

  // The whitespace-delimited word around p, when it's a URL: sentinels inside URLs break
  // autolinks and get percent-encoded into hrefs.
  function urlWord(text, p) {
    let a = p, b = p;
    while (a > 0 && !/\s/.test(text[a - 1])) a--;
    while (b < text.length && !/\s/.test(text[b])) b++;
    const w = text.slice(a, b);
    return /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\]\()/i.test(w) ? { a, b, w } : null;
  }

  // Moves a range boundary off Markdown syntax so the document still parses the same.
  function safePos(text, p, isStart) {
    if (isStart) {
      for (let guard = 0; guard < 10000; guard++) {
        const { ls, le, line } = lineAt(text, p);
        if (BLANK.test(line) || UNTOUCHABLE.test(line)) {
          if (le >= text.length) return text.length;
          p = le + 1;
          continue;
        }
        const prefix = ls + BLOCK_PREFIX.exec(line)[0].length;
        if (p < prefix) p = prefix;
        // Table rows: stay inside the first cell.
        if (TABLE_ROW.test(line)) { const bar = text.indexOf('|', ls); if (p <= bar) p = bar + 1; }
        break;
      }
      const u = urlWord(text, p);
      if (u && p > u.a) {
        // Inside a link's URL part, start after it; inside a bare URL, before it.
        const close = u.w.indexOf('](');
        p = close >= 0 && p > u.a + close ? u.b : u.a;
      }
      return p;
    }
    for (let guard = 0; guard < 10000; guard++) {
      // A range ending at the start of a line closes at the end of the previous one.
      while (p > 0 && text[p - 1] === '\n') p--;
      const { ls, line } = lineAt(text, p);
      if ((BLANK.test(line) || UNTOUCHABLE.test(line)) && ls > 0) { p = ls - 1; continue; }
      if (BLANK.test(line) || UNTOUCHABLE.test(line)) return ls;
      const atx = ATX_CLOSE.exec(line);
      if (atx && p > ls + line.length - atx[1].length) p = ls + line.length - atx[1].length;
      if (TABLE_ROW.test(line)) {
        const trimmed = line.replace(/[ \t]+$/, '');
        const bar = trimmed.endsWith('|') ? ls + trimmed.length - 1 : -1;
        if (bar >= 0 && p > bar) p = bar;
      }
      break;
    }
    const u = urlWord(text, p);
    if (u && p > u.a && p < u.b) p = u.b;
    return p;
  }

  // Whether text[from, to) crosses from one Markdown block into the next: a blank line, the
  // end of the text, or a following line that opens a block of its own.
  const BLOCK_START = /^ {0,3}(?:[-*+] |\d{1,9}[.)] |#{1,6}(?:\s|$)|>|```|~~~|\||$)/;
  function endsBlock(text, from, to) {
    const gap = text.slice(from, to);
    if (!gap.includes('\n')) return false;
    if (/\n[ \t]*\n/.test(gap) || to >= text.length) return true;
    return BLOCK_START.test(lineAt(text, to).line);
  }

  // ranges: [{ kind: 'c' | 'i' | 'd', n, start, end }] as offsets into text.
  function inject(text, ranges) {
    // Sentinel characters already in the text (pasted, or a crafted file) would read as
    // review markup: neutralize them first (same length, so offsets don't move).
    text = text.replace(KIND_CHARS, '\uFFFD');
    const marks = [];
    for (const r of ranges) {
      if (r.n > MAX_ITEMS) continue;
      let s = safePos(text, r.start, true), e = safePos(text, r.end, false);
      // A suggestion that only touched line breaks or syntax has no visible text to mark.
      if (e <= s && r.kind !== 'c') continue;
      if (e < s) e = s;
      // The end was moved back over the break between two blocks: the suggestion takes in
      // the end of its paragraph (a whole paragraph inserted or deleted), and Word needs to
      // know that. A soft line break inside a paragraph doesn't count.
      if (r.kind !== 'c' && endsBlock(text, e, r.end)) r.throughBreak = true;
      // At one spot, other ranges' ends come first, then starts; a range's own end always
      // follows its own start.
      marks.push({ pos: s, order: 1, n: r.n, str: mark(r.kind + 's', r.n) });
      marks.push({ pos: e, order: e === s ? 2 : 0, n: r.n, str: mark(r.kind + 'e', r.n) });
    }
    marks.sort((a, b) => a.pos - b.pos || a.order - b.order);
    let out = '', last = 0;
    for (const m of marks) {
      out += text.slice(last, m.pos) + m.str;
      last = m.pos;
    }
    return out + text.slice(last);
  }

  // The text with every suggestion accepted (deleted ranges removed).
  function finalText(text, suggestions) {
    const dels = suggestions.filter(s => s.type === 'del').sort((a, b) => a.start - b.start);
    let out = '', last = 0;
    for (const d of dels) {
      if (d.end <= last) continue;
      out += text.slice(last, Math.max(last, d.start));
      last = d.end;
    }
    return out + text.slice(last);
  }

  // marked.lexer with sentinels removed from link and image URLs.
  function lex(src) {
    const tokens = marked.lexer(src, { gfm: true });
    marked.walkTokens(tokens, t => {
      if (t.href) t.href = stripMarks(t.href);
      if (t.type === 'image' || t.type === 'link') t.title = t.title ? stripMarks(t.title) : t.title;
    });
    for (const key of Object.keys(tokens.links || {})) tokens.links[key].href = stripMarks(tokens.links[key].href || '');
    return tokens;
  }

  // Splits Markdown into top-level blocks, each with the source line it starts on.
  function blocks(src) {
    const tokens = lex(src);
    const out = [];
    let cursor = 0, line = 0, counted = 0;
    const lineAtPos = pos => {
      for (let i = counted; i < pos; i++) if (src.charCodeAt(i) === 10) line++;
      counted = Math.max(counted, pos);
      return line;
    };
    for (const t of tokens) {
      const pos = t.raw ? src.indexOf(t.raw, cursor) : -1;
      const at = pos >= 0 ? pos : cursor;
      if (pos >= 0) cursor = pos + t.raw.length;
      if (t.type === 'space' || t.type === 'def') continue;
      const start = lineAtPos(at);
      const end = lineAtPos(at + (t.raw || '').replace(/\n+$/, '').length);
      out.push({ token: t, line: start, endLine: end, links: tokens.links });
    }
    return out;
  }

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Insertions can nest (typing inside someone else's insertion). Only the innermost is
  // marked; when it ends, the one around it carries on.
  const pushIns = (open, it) => { open.ins.push(it); return it; };
  const popIns = (open, it) => { open.ins = open.ins.filter(x => x !== it); return open.ins[open.ins.length - 1] || null; };

  // The app's own review markup carries this per-session key; the sanitizer strips review
  // classes and attributes from everything else, so a document's own HTML can't pose as
  // comments or tracked changes (it can't know the key).
  const KEY = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
  const OURS = ` data-rvk="${KEY}"`;

  // Container tags an <ins>/<del> can't cross: close before them, reopen inside them.
  const CONTAINER = /^<(\/?)(li|td|th|p|h[1-6]|blockquote|pre|tr|thead|tbody|table|ul|ol)\b/i;

  // Renders blocks to HTML with review markup. `items` maps sentinel indices to
  // { kind: 'c'|'i'|'d', id, label } so the markup can name who did what.
  function blocksHtml(src, items, { commentRefs = true } = {}) {
    const open = { i: null, d: null, ins: [] };
    const openTags = () => (open.i ? `<ins${OURS} class="rv-ins" data-sid="${esc(open.i.id)}" title="${esc(open.i.label)}">` : '') +
      (open.d ? `<del${OURS} class="rv-del" data-sid="${esc(open.d.id)}" title="${esc(open.d.label)}">` : '');
    const closeTags = () => (open.d ? '</del>' : '') + (open.i ? '</ins>' : '');
    return blocks(src).map(b => {
      const list = [b.token];
      list.links = b.links;
      let html = marked.parser(list, { gfm: true });
      // Sentinels inside tags (attributes) are dropped; they'd break the markup.
      html = html.replace(/<[^>]*>/g, tag => stripMarks(tag));
      // Raw HTML in the document may leave a tag unfinished, and the review tags spliced in
      // below would become its attributes. Re-serializing through an inert template closes
      // every tag first (nothing in a template runs or loads).
      if (b.token.raw.includes('<')) {
        const t = document.createElement('template');
        t.innerHTML = html;
        for (const el of t.content.querySelectorAll('*')) for (const a of [...el.attributes]) a.value = stripMarks(a.value);
        // Text in a textarea is raw: review tags there would show as text.
        for (const el of t.content.querySelectorAll('textarea')) el.textContent = stripMarks(el.textContent);
        html = t.innerHTML;
      }
      let out = openTags();
      const re = /(<[^>]*>)|([\uE000-\uE005])([\uE100-\uEFFF])/g;
      let last = 0;
      for (let m; (m = re.exec(html));) {
        out += html.slice(last, m.index);
        last = re.lastIndex;
        if (m[1]) {
          const c = CONTAINER.exec(m[1]);
          if (c && (open.i || open.d)) out += c[1] ? closeTags() + m[1] : m[1] + openTags();
          else out += m[1];
          continue;
        }
        const kind = KIND_NAME[m[2].charCodeAt(0)], it = items[m[3].charCodeAt(0) - 0xe100];
        if (!it) continue;
        switch (kind) {
          case 'cs': out += `<span${OURS} class="rv-cs" data-cid="${esc(it.id)}"></span>` + (commentRefs ? `<sup${OURS} class="rv-cref" data-cid="${esc(it.id)}">${esc(it.label)}</sup>` : ''); break;
          case 'ce': out += `<span${OURS} class="rv-ce" data-cid="${esc(it.id)}"></span>`; break;
          case 'is': out += closeTags(); open.i = pushIns(open, it); out += openTags(); break;
          case 'ie': out += closeTags(); open.i = popIns(open, it); out += openTags(); break;
          case 'ds': open.d = it; out += `<del${OURS} class="rv-del" data-sid="${esc(it.id)}" title="${esc(it.label)}">`; break;
          case 'de': if (open.d) out += '</del>'; open.d = null; break;
        }
      }
      out += html.slice(last) + closeTags();
      return { line: b.line, endLine: b.endLine, html: out };
    });
  }

  // Everything an export needs from a document model:
  // { text, comments: [{ id, author, created, text, replies, resolved, start, end }],
  //   suggestions: [{ id, type: 'ins'|'del', author, created, start, end }] }
  // mode 'markup' shows suggestions and comments; 'final' accepts suggestions, no comments.
  function prepare(model, mode) {
    if (mode === 'final') return { src: finalText(model.text, model.suggestions).replace(KIND_CHARS, '\uFFFD'), items: [], comments: [] };
    const items = [], ranges = [];
    const comments = model.comments.filter(c => c.text && (!c.resolved || model.includeResolved))
      .slice().sort((a, b) => a.start - b.start);
    comments.forEach((c, i) => {
      items.push({ kind: 'c', id: c.id, label: String(i + 1), comment: c });
      ranges.push({ kind: 'c', n: items.length - 1, start: c.start, end: c.end });
    });
    for (const s of model.suggestions) {
      items.push({ kind: s.type === 'ins' ? 'i' : 'd', id: s.id, label: `${s.type === 'ins' ? 'Inserted' : 'Deleted'} by ${s.author}`, suggestion: s });
      ranges.push({ kind: s.type === 'ins' ? 'i' : 'd', n: items.length - 1, start: s.start, end: s.end });
    }
    const src = inject(model.text, ranges);
    for (const r of ranges) if (r.throughBreak) items[r.n].throughBreak = true;
    return { src, items, comments };
  }

  // For Markdown that other people's text goes into (the Export for AI bundle): a name or
  // label on one line with Markdown syntax escaped, and free text quoted line by line, so
  // nothing anyone typed can pass for the bundle's own headings or instructions.
  const mdLabel = s => String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[\\`*_#[\]<>|~!]/g, '\\$&');
  const mdQuote = (t, pad = '') => String(t).replace(/\r\n?/g, '\n').split('\n').map(l => `${pad}> ${l}`);
  // Verbatim on one line (file names, identifiers): a code span with a fence longer than any
  // run of backticks inside.
  const mdCode = s => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    const fence = '`'.repeat(Math.max(0, ...(t.match(/`+/g) || []).map(r => r.length)) + 1);
    return t.startsWith('`') || t.endsWith('`') ? `${fence} ${t} ${fence}` : fence + t + fence;
  };

  return { inject, finalText, lex, blocks, blocksHtml, prepare, stripMarks, esc, pushIns, popIns, mdLabel, mdQuote, mdCode, SENTINEL, KIND_NAME, KEY, OURS };
})();

// ---------- Sanitizing document HTML ----------
// Documents come from other people. Their HTML may not load anything from the network
// or other machines (a //server/share image makes Windows send the user's NTLM hash; a
// remote image is a read receipt), may not restyle the app, and may not reuse app ids.

const SafeHtml = (() => {
  const CLASS_OK = /^(?:rv-[a-z-]+|md-block|ink|language-[\w+#-]+|task-list-item(?:-checkbox)?|contains-task-list)$/;
  const IMG_DATA = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[a-z0-9+/=\s]+$/i;
  let imgBase = null;

  // Relative image paths resolve inside the document's own folder, and nowhere else.
  function imageSrc(src) {
    src = String(src || '').trim();
    if (IMG_DATA.test(src)) return src;
    if (!imgBase || /^[a-z][a-z0-9+.-]*:|^[\\/]/i.test(src) || src.includes('\\')) return '';
    let url;
    try { url = new URL(src, imgBase).href; } catch { return ''; }
    return url.startsWith(imgBase) ? url : '';
  }

  // Review markup (rv-* classes, comment/suggestion ids, block line numbers, the tooltips
  // on <ins>/<del>) is kept only on elements the app made; see Review.KEY.
  const REVIEW_ATTRS = ['data-cid', 'data-sid', 'data-line', 'data-end'];
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (node.nodeType !== 1) return;
    const ours = node.getAttribute('data-rvk') === Review.KEY;
    node.removeAttribute('data-rvk');
    if (ours) return;
    for (const a of REVIEW_ATTRS) node.removeAttribute(a);
    for (const c of [...node.classList]) if (c.startsWith('rv-') || c === 'md-block') node.classList.remove(c);
    if (!node.classList.length) node.removeAttribute('class');
    if (node.nodeName === 'INS' || node.nodeName === 'DEL') node.removeAttribute('title');
  });

  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'class') {
      data.attrValue = data.attrValue.split(/\s+/).filter(c => CLASS_OK.test(c)).join(' ');
    } else if (data.attrName === 'src') {
      data.attrValue = node.nodeName === 'IMG' ? imageSrc(data.attrValue) : '';
      if (!data.attrValue) data.keepAttr = false;
    }
  });

  const CONFIG = {
    FORBID_TAGS: ['style', 'link', 'meta', 'base', 'form', 'textarea', 'video', 'audio', 'source', 'track', 'picture', 'iframe', 'frame', 'object', 'embed', 'image', 'use', 'foreignObject', 'feImage'],
    FORBID_ATTR: ['style', 'id', 'name', 'srcset', 'background', 'poster', 'formaction', 'action', 'xlink:href', 'ping'],
    ADD_ATTR: ['data-cid', 'data-sid', 'data-line', 'data-end', 'data-rvk'],
    ALLOW_DATA_ATTR: false,
  };

  // base: the file:// URL of the document's folder (with a trailing slash), or null.
  function sanitize(html, base = null) {
    imgBase = base;
    try { return DOMPurify.sanitize(html, CONFIG); } finally { imgBase = null; }
  }

  return { sanitize };
})();

// ---------- ZIP (store only) ----------

const Zip = (() => {
  const CRC_TABLE = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  const enc = new TextEncoder();

  // entries: [{ name, data: string | Uint8Array }] -> Uint8Array
  function store(entries) {
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const chunks = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
      chunks.push(new Uint8Array(lh.buffer), name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((n, c) => n + c.length, 0);
    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(8, entries.length, true); eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, cdSize, true); eocd.setUint32(16, offset, true);
    const parts = [...chunks, ...central, new Uint8Array(eocd.buffer)];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }
  return { store, crc32 };
})();

// ---------- Exporters ----------

const Exporter = (() => {
  const { esc } = Review;

  // ---- HTML (also the source for PDF) ----

  const HTML_CSS = `
    @page { size: A4; margin: 18mm; }
    * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    body { margin: 0 auto; max-width: 820px; padding: 32px; color: #24292f; background: #fff;
      font: 15px/1.65 "Segoe UI", system-ui, -apple-system, sans-serif; }
    @media print { body { padding: 0; max-width: none; } }
    h1, h2 { padding-bottom: .3em; border-bottom: 1px solid #ddd; }
    h1, h2, h3 { break-after: avoid; }
    pre, table, img, blockquote, figure { break-inside: avoid; }
    a { color: #4f6bed; }
    code { padding: .15em .4em; border-radius: 4px; background: #f2f2f2; font: .88em "Cascadia Code", Consolas, monospace; }
    pre { padding: 12px 14px; overflow: auto; border-radius: 8px; background: #f2f2f2; }
    pre code { padding: 0; background: none; }
    blockquote { margin: 0; padding: 0 1em; border-left: 3px solid #ddd; color: #616161; }
    table { border-collapse: collapse; } th, td { padding: 6px 12px; border: 1px solid #ccc; }
    img { max-width: 100%; }
    .md-block { position: relative; }
    .md-block > svg.ink { position: absolute; left: 0; top: 0; overflow: visible; pointer-events: none; }
    ins.rv-ins { color: #0f7b3e; text-decoration: underline; background: rgba(15,123,62,.08); }
    del.rv-del { color: #c42b1c; text-decoration: line-through; }
    sup.rv-cref { margin: 0 1px; padding: 0 4px; border-radius: 6px; background: #ffe58a; color: #5a4300; font-size: 10px; font-weight: 700; }
    .rv-comments { margin-top: 40px; padding-top: 12px; border-top: 2px solid #ddd; font-size: 13px; }
    .rv-comments h2 { font-size: 1.1em; border: 0; }
    .rv-comment { margin: 0 0 12px; padding: 8px 12px; border-left: 3px solid #f0b400; background: #fffbea; break-inside: avoid; }
    .rv-comment .q { color: #666; font-style: italic; }
    .rv-comment .r { margin: 4px 0 0 14px; }
    .rv-comment.resolved { border-left-color: #999; background: #f6f6f6; }
    .board-sketch { margin-top: 40px; } .board-sketch img { border: 1px solid #ddd; border-radius: 6px; }
    .doc-meta { color: #888; font-size: 12px; margin-bottom: 24px; }`;

  function commentsAppendix(comments) {
    if (!comments.length) return '';
    const one = (c, i) => `<div class="rv-comment${c.resolved ? ' resolved' : ''}">
      <div><b>${i + 1}. ${esc(c.author)}</b> · ${esc(stamp(c.created))}${c.resolved ? ' · resolved' : ''}</div>
      ${c.quote ? `<div class="q">“${esc(c.quote)}”</div>` : ''}
      <div>${esc(c.text)}</div>
      ${(c.replies || []).map(r => `<div class="r"><b>${esc(r.author)}</b>: ${esc(r.text)}</div>`).join('')}
    </div>`;
    return `<section class="rv-comments"><h2>Comments</h2>${comments.map(one).join('')}</section>`;
  }

  // inkFor(line, endLine) -> svg markup for annotations anchored in that block (optional).
  // Ink belongs to the block it was drawn on: each block takes the anchors from its own
  // first line up to the next block (the same rule the preview uses).
  function html(model, { mode = 'markup', inkFor = null, boardPng = null, title } = {}) {
    const { src, items, comments } = Review.prepare(model, mode);
    const blocks = Review.blocksHtml(src, items);
    const body = blocks.map((b, i) => {
      const from = i === 0 ? -Infinity : b.line, to = i + 1 < blocks.length ? blocks[i + 1].line - 1 : Infinity;
      return `<div${Review.OURS} class="md-block">${b.html}${inkFor ? inkFor(from, to) : ''}</div>`;
    }).join('\n');
    const clean = SafeHtml.sanitize(body);
    const name = title || model.name || 'Document';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(name)}</title><style>${HTML_CSS}</style></head>
<body>
<div class="doc-meta">${esc(name)} · exported ${esc(stamp(Date.now()))}${model.exportedBy ? ' by ' + esc(model.exportedBy) : ''}</div>
${clean}
${mode === 'final' ? '' : commentsAppendix(comments)}
${boardPng ? `<section class="board-sketch"><h2>Board</h2><img src="${boardPng}" alt="Whiteboard sketch"></section>` : ''}
</body></html>`;
  }

  // ---- DOCX ----

  // Characters XML 1.0 can't hold; lone surrogates become U+FFFD first.
  const XML_BAD = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
  const x = s => String(s).toWellFormed().replace(XML_BAD, '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const wDate = ts => new Date(ts || Date.now()).toISOString().replace(/\.\d+Z$/, 'Z');
  const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

  function decodeDataUrl(src) {
    const m = /^data:(image\/(png|jpeg));base64,(.*)$/i.exec(src || '');
    if (!m) return null;
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, ext: m[2].toLowerCase() === 'png' ? 'png' : 'jpeg' };
  }

  function imageSize(bytes, ext) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (ext === 'png' && bytes.length > 24) return [dv.getUint32(16), dv.getUint32(20)];
    // JPEG: walk the segments to the first SOFn marker.
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i] !== 0xff) { i++; continue; }
      const m = bytes[i + 1], len = dv.getUint16(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
      i += 2 + len;
    }
    return [400, 300];
  }

  class DocxWriter {
    constructor(model, items) {
      this.items = items;
      this.body = [];
      this.rels = [];
      this.media = [];
      this.nums = [];          // extra w:num entries: { id, abstract, start }
      this.revId = 1000;
      this.docPr = 1;
      this.open = { i: null, d: null, ins: [] };
      this.paraMarks = [];     // suggestions that end with the paragraph being written
      this.comments = [];      // { id (w), item, reply? }
      this.commentStarted = new Set();
      this.commentEnded = new Set();
      this.para = null;
      this.paraIds = 0x10000001;
      this.wIds = new Map();   // item index -> [w ids for root and replies]
      items.forEach((it, n) => {
        if (it.kind !== 'c') return;
        const c = it.comment, ids = [];
        const add = (author, created, text, parent) => {
          const id = this.comments.length;
          this.comments.push({ id, author, created, text, parent, paraId: (this.paraIds++).toString(16).toUpperCase(), done: !!c.resolved });
          ids.push(id);
          return id;
        };
        const root = add(c.author, c.created, c.text, null);
        for (const r of c.replies || []) add(r.author, r.created, r.text, root);
        this.wIds.set(n, ids);
      });
    }

    rel(type, target, external) {
      const id = 'rId' + (this.rels.length + 10);
      this.rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${x(target)}"${external ? ' TargetMode="External"' : ''}/>`);
      return id;
    }

    // ---- runs ----
    revAttrs(it) { return `w:id="${this.revId++}" w:author="${x(it.suggestion.author)}" w:date="${wDate(it.suggestion.created)}"`; }

    rPr(f) {
      let p = '';
      if (f.code) p += '<w:rStyle w:val="CodeChar"/>';
      else if (f.link) p += '<w:rStyle w:val="Hyperlink"/>';
      if (f.b) p += '<w:b/><w:bCs/>';
      if (f.i) p += '<w:i/><w:iCs/>';
      if (f.s) p += '<w:strike/>';
      return p ? `<w:rPr>${p}</w:rPr>` : '';
    }

    // Puts a run inside the open suggestion(s). Text inserted by one person and deleted
    // by another is an insertion containing a deletion, as Word writes it.
    wrap(run) {
      if (this.open.d) run = `<w:del ${this.revAttrs(this.open.d)}>${run}</w:del>`;
      if (this.open.i) run = `<w:ins ${this.revAttrs(this.open.i)}>${run}</w:ins>`;
      return run;
    }

    textRun(text, f) {
      const tag = this.open.d ? 'w:delText' : 'w:t';
      const parts = text.split('\n');
      const inner = parts.map((t, i) => (i ? '<w:br/>' : '') + (t ? `<${tag} xml:space="preserve">${x(t).replace(/\t/g, `</${tag}><w:tab/><${tag} xml:space="preserve">`)}</${tag}>` : '')).join('');
      if (!inner) return '';
      return this.wrap(`<w:r>${this.rPr(f)}${inner}</w:r>`);
    }

    // Text possibly containing sentinels -> runs and comment/revision markers.
    text(s, f = {}) {
      let out = '', last = 0;
      Review.SENTINEL.lastIndex = 0;
      for (let m; (m = Review.SENTINEL.exec(s));) {
        out += this.textRun(s.slice(last, m.index), f);
        last = m.index + m[0].length;
        const kind = Review.KIND_NAME[m[1].charCodeAt(0)], n = m[2].charCodeAt(0) - 0xe100, it = this.items[n];
        if (!it) continue;
        switch (kind) {
          case 'cs': out += this.commentStart(n); break;
          case 'ce': out += this.commentEnd(n); break;
          case 'is': this.open.i = Review.pushIns(this.open, it); break;
          case 'ie': this.open.i = Review.popIns(this.open, it); if (it.throughBreak) this.paraMarks.push(['ins', it]); break;
          case 'ds': this.open.d = it; break;
          case 'de': this.open.d = null; if (it.throughBreak) this.paraMarks.push(['del', it]); break;
        }
      }
      return out + this.textRun(s.slice(last), f);
    }

    commentStart(n) {
      if (this.commentStarted.has(n)) return '';
      this.commentStarted.add(n);
      return (this.wIds.get(n) || []).map(id => `<w:commentRangeStart w:id="${id}"/>`).join('');
    }

    commentEnd(n) {
      if (!this.commentStarted.has(n) || this.commentEnded.has(n)) return '';
      this.commentEnded.add(n);
      return (this.wIds.get(n) || []).map(id => `<w:commentRangeEnd w:id="${id}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${id}"/></w:r>`).join('');
    }

    // ---- inline tokens ----
    inline(tokens, f = {}) {
      let out = '';
      for (const t of tokens || []) {
        switch (t.type) {
          case 'text':
            out += t.tokens && t.tokens.length && t.tokens[0] !== t ? this.inline(t.tokens, f) : this.text(soft(decodeEntities(t.text)), f);
            break;
          case 'escape': out += this.text(decodeEntities(t.text), f); break;
          case 'strong': out += this.inline(t.tokens, { ...f, b: true }); break;
          case 'em': out += this.inline(t.tokens, { ...f, i: true }); break;
          case 'del': out += this.inline(t.tokens, { ...f, s: true }); break;
          case 'codespan': out += this.text(soft(t.text), { ...f, code: true }); break;
          case 'br': out += this.wrap('<w:r><w:br/></w:r>'); break;
          case 'link': {
            const href = Review.stripMarks(t.href || '');
            const inner = this.inline(t.tokens, { ...f, link: true });
            if (/^(https?:|mailto:)/i.test(href)) out += `<w:hyperlink r:id="${this.rel('hyperlink', href, true)}" w:history="1">${inner}</w:hyperlink>`;
            else out += inner;
            break;
          }
          case 'image': out += this.image(t.href, Review.stripMarks(t.text || '')) || this.text(t.text ? `[${t.text}]` : '', f); break;
          case 'checkbox': out += this.text(t.checked ? '☑ ' : '☐ ', f); break;
          case 'html': out += this.text(soft(t.text.replace(/<[^>]*>/g, '')), f); break;
          default:
            if (t.tokens) out += this.inline(t.tokens, f);
            else if (t.text) out += this.text(soft(decodeEntities(t.text)), f);
        }
      }
      return out;
    }

    image(src, alt, maxWidthPx = 624) {
      const img = decodeDataUrl(Review.stripMarks(src || ''));
      if (!img) return '';
      const n = this.media.length + 1;
      const file = `image${n}.${img.ext === 'png' ? 'png' : 'jpeg'}`;
      this.media.push({ name: 'word/media/' + file, data: img.bytes });
      const rid = this.rel('image', 'media/' + file);
      let [w, h] = imageSize(img.bytes, img.ext);
      if (w > maxWidthPx) { h = Math.round(h * maxWidthPx / w); w = maxWidthPx; }
      const cx = w * 9525, cy = h * 9525, id = this.docPr++;
      return this.wrap(`<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
        `<wp:docPr id="${id}" name="Picture ${id}" descr="${x(alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${file}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`);
    }

    // ---- blocks ----
    p(content, pPr = '') {
      // A suggestion still open at the end of the paragraph includes its paragraph mark, so
      // accepting or rejecting it in Word takes the whole paragraph instead of leaving it empty.
      const marks = [...this.paraMarks];
      if (this.open.i) marks.push(['ins', this.open.i]);
      if (this.open.d) marks.push(['del', this.open.d]);
      this.paraMarks = [];
      // Word wants at most one of each, insertion first.
      const one = kind => { const m = marks.find(([k]) => k === kind); return m ? `<w:${kind} ${this.revAttrs(m[1])}/>` : ''; };
      if (marks.length) pPr += `<w:rPr>${one('ins')}${one('del')}</w:rPr>`;
      this.body.push(`<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${content}</w:p>`);
    }

    newNum(abstract, start) {
      const id = this.nums.length + 10;
      this.nums.push({ id, abstract, start });
      return id;
    }

    block(t, ctx = {}) {
      const style = ctx.quote ? '<w:pStyle w:val="Quote"/>' : '';
      switch (t.type) {
        case 'heading':
          this.p(this.inline(t.tokens), `<w:pStyle w:val="Heading${Math.min(t.depth, 4)}"/>`);
          break;
        case 'paragraph':
          this.p(this.inline(t.tokens), style);
          break;
        case 'text':
          this.p(this.inline(t.tokens || [{ type: 'text', text: t.text }]), style);
          break;
        case 'code':
          this.p(this.text(t.text, {}), '<w:pStyle w:val="Code"/>');
          break;
        case 'blockquote':
          for (const c of t.tokens) this.block(c, { ...ctx, quote: true });
          break;
        case 'hr':
          this.p('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>');
          break;
        case 'list': this.list(t, ctx, 0); break;
        case 'table': this.table(t); break;
        case 'html': {
          const txt = t.text.replace(/<[^>]*>/g, '').trim();
          if (txt) this.p(this.text(decodeEntities(txt)), style);
          break;
        }
        case 'space': case 'def': break;
        default:
          if (t.tokens) this.p(this.inline(t.tokens), style);
          else if (t.text) this.p(this.text(t.text), style);
      }
    }

    list(t, ctx, level) {
      const num = t.ordered ? this.newNum(1, t.start === '' || t.start == null ? 1 : +t.start) : 1;
      for (const item of t.items) {
        let first = true;
        const lead = item.task ? (item.checked ? '☑ ' : '☐ ') : '';
        for (const c of item.tokens) {
          if (c.type === 'list') { this.list(c, ctx, Math.min(level + 1, 8)); continue; }
          if (c.type === 'checkbox' || c.type === 'space') continue;
          if (c.type !== 'text' && c.type !== 'paragraph') { this.block(c, ctx); first = false; continue; }
          const pPr = `<w:pStyle w:val="ListParagraph"/>` + (first ? `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${num}"/></w:numPr>` : `<w:ind w:left="${720 * (level + 1)}"/>`);
          const content = (first && lead ? this.textRun(lead, {}) : '') + this.inline(c.tokens || [{ type: 'text', text: c.text }]);
          this.p(content, pPr);
          first = false;
        }
        if (first) this.p(this.textRun(lead, {}), `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${num}"/></w:numPr>`);
      }
    }

    table(t) {
      const cols = t.header.length || 1, w = Math.floor(9360 / cols);
      const cell = c => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p>${this.inline(c.tokens)}</w:p></w:tc>`;
      const row = (cells, header) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map(cell).join('')}</w:tr>`;
      this.body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="1" w:noVBand="1"/></w:tblPr>` +
        `<w:tblGrid>${('<w:gridCol w:w="' + w + '"/>').repeat(cols)}</w:tblGrid>${row(t.header, true)}${t.rows.map(r => row(r, false)).join('')}</w:tbl>`);
      this.p('');
    }

    // Comments whose start never appeared (anchored inside dropped markup) still
    // need a home: they're anchored to the last paragraph.
    closeDangling() {
      let tail = '';
      this.wIds.forEach((ids, n) => {
        if (!this.commentStarted.has(n)) tail += this.commentStart(n);
      });
      this.wIds.forEach((ids, n) => { if (!this.commentEnded.has(n)) tail += this.commentEnd(n); });
      if (tail) this.p(tail);
    }
  }

  const soft = s => String(s).replace(/\n/g, ' ');

  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|#39|apos|nbsp);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
      if (k === 'quot') return '"'; if (k === '#39' || k === 'apos') return "'"; if (k === 'nbsp') return ' ';
      const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    });
  }

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}>
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="numbering" w:default="1" w:styleId="NoList"><w:name w:val="No List"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/></w:style>
${[1, 2, 3, 4].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/>${n > 1 ? '<w:unhideWhenUsed/>' : ''}<w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${[360, 280, 240, 200][n - 1]}" w:after="${[120, 100, 80, 60][n - 1]}"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="${n < 3 ? '1F3864' : '2F5496'}"/><w:sz w:val="${[36, 30, 26, 24][n - 1]}"/><w:szCs w:val="${[36, 30, 26, 24][n - 1]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="360" w:right="360"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:customStyle="1" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/><w:bottom w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/><w:ind w:left="144" w:right="144"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:customStyle="1" w:styleId="CodeChar"><w:name w:val="Inline Code"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="1"/><w:qFormat/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas" w:cs="Consolas"/><w:noProof/><w:sz w:val="20"/><w:szCs w:val="20"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:basedOn w:val="DefaultParagraphFont"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="99"/><w:unhideWhenUsed/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:left w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:right w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/></w:tblBorders><w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblStylePr w:type="firstRow"><w:rPr><w:b/><w:bCs/></w:rPr><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr></w:tblStylePr></w:style>
</w:styles>`;

  function numbering(nums) {
    const bulletChars = ['•', '◦', '▪'];
    const fmts = ['decimal', 'lowerLetter', 'lowerRoman'];
    const lvls = fn => Array.from({ length: 9 }, (_, i) => fn(i)).join('');
    const bullets = lvls(i => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${bulletChars[i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:hint="default"/></w:rPr></w:lvl>`);
    const decimals = lvls(i => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmts[i % 3]}"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`);
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W_NS}>
<w:abstractNum w:abstractNumId="0"><w:nsid w:val="1A2B3C01"/><w:multiLevelType w:val="hybridMultilevel"/>${bullets}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:nsid w:val="1A2B3C02"/><w:multiLevelType w:val="hybridMultilevel"/>${decimals}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
${nums.map(n => `<w:num w:numId="${n.id}"><w:abstractNumId w:val="${n.abstract}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${Math.max(0, n.start | 0)}"/></w:lvlOverride></w:num>`).join('\n')}
</w:numbering>`;
  }

  function commentsXml(list) {
    const body = list.map(c => `<w:comment w:id="${c.id}" w:author="${x(c.author)}" w:date="${wDate(c.created)}" w:initials="${x(initials(c.author))}">` +
      String(c.text).split('\n').map((line, i, all) => `<w:p${i === all.length - 1 ? ` w14:paraId="${c.paraId}" w14:textId="77777777"` : ''}><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${i === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : ''}<w:r><w:t xml:space="preserve">${x(line)}</w:t></w:r></w:p>`).join('') +
      '</w:comment>').join('\n');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W_NS} xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14">
${body}
</w:comments>`;
  }

  function commentsExXml(list) {
    const byId = new Map(list.map(c => [c.id, c]));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
${list.map(c => `<w15:commentEx w15:paraId="${c.paraId}"${c.parent != null ? ` w15:paraIdParent="${byId.get(c.parent).paraId}"` : ''} w15:done="${c.done ? 1 : 0}"/>`).join('\n')}
</w15:commentsEx>`;
  }

  // Returns the .docx bytes. opts: { mode: 'markup'|'final', boardPng: dataURL, author }
  function docx(model, { mode = 'markup', boardPng = null, author = '' } = {}) {
    const { src, items } = Review.prepare(model, mode);
    const w = new DocxWriter(model, items);
    const tokens = Review.lex(src);
    for (const t of tokens) w.block(t);
    w.open = { i: null, d: null, ins: [] };
    w.paraMarks = [];
    w.closeDangling();
    if (boardPng) {
      w.p(w.textRun('Board', {}), '<w:pStyle w:val="Heading2"/>');
      const pic = w.image(boardPng, 'Whiteboard sketch');
      if (pic) w.p(pic);
    }
    if (!w.body.length) w.p('');
    const hasComments = w.comments.length > 0;
    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
${w.body.join('\n')}
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
</w:body></w:document>`;
    const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R}styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="${R}settings" Target="settings.xml"/>
<Relationship Id="rId3" Type="${R}numbering" Target="numbering.xml"/>
${hasComments ? `<Relationship Id="rId4" Type="${R}comments" Target="comments.xml"/>
<Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>` : ''}
${w.rels.join('\n')}
</Relationships>`;
    const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.';
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Default Extension="jpeg" ContentType="image/jpeg"/>
<Override PartName="/word/document.xml" ContentType="${CT}document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="${CT}styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="${CT}settings+xml"/>
<Override PartName="/word/numbering.xml" ContentType="${CT}numbering+xml"/>
${hasComments ? `<Override PartName="/word/comments.xml" ContentType="${CT}comments+xml"/>
<Override PartName="/word/commentsExtended.xml" ContentType="${CT}commentsExtended+xml"/>` : ''}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
    const now = wDate(Date.now());
    const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${x((model.name || 'Document').replace(/\.[^.]+$/, ''))}</dc:title><dc:creator>${x(author || 'ZP Whiteboard')}</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
    const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings ${W_NS}><w:defaultTabStop w:val="720"/><w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;
    const entries = [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="${R}officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>` },
      { name: 'docProps/core.xml', data: core },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/_rels/document.xml.rels', data: docRels },
      { name: 'word/styles.xml', data: STYLES },
      { name: 'word/settings.xml', data: settings },
      { name: 'word/numbering.xml', data: numbering(w.nums) },
      ...(hasComments ? [
        { name: 'word/comments.xml', data: commentsXml(w.comments) },
        { name: 'word/commentsExtended.xml', data: commentsExXml(w.comments) },
      ] : []),
      ...w.media,
    ];
    return Zip.store(entries);
  }

  return { html, docx };
})();
