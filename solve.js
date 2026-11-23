// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
// Byte-identical output to the reference build, restructured for CPU time:
// fused block lex+render (no token objects), regex/indexOf-driven inline
// scanner with chunked HTML escaping (no per-character escape calls),
// ASCII fast paths for slugs, manual front-matter scan, per-case slug cache.
// No cross-case state: every run() builds fresh locals only.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/* ---------------- text ---------------- */

const ESC_ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// Shared regexes, re-entrancy safe: every use sets lastIndex explicitly before
// exec and consumes the match at once, so a nested call cannot corrupt the
// outer scan (inline() recurses while scanning).
const ESC_RE = /[&<>"']/g;

// Append `s` to `out` with & < > " ' escaped. Plain runs are copied verbatim,
// only the five specials are ever touched.
function escAppend(out, s) {
  let i = 0;
  for (;;) {
    ESC_RE.lastIndex = i;
    const m = ESC_RE.exec(s);
    if (m === null) { out.push(s.slice(i)); return; }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    out.push(ESC_ENTITY[m[0]]);
    i = j + 1;
  }
}

function escStr(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  const out = [];
  escAppend(out, s);
  return out.join('');
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// Slug of `text`, exactly as the reference: NFKD, combining marks dropped,
// A-Z lowered, each run of other chars one '-', cut to 64 (trailing '-' at the
// cut dropped), 'untitled' when empty. ASCII fast path: NFKD is identity on
// ASCII and no ASCII char is a combining mark.
function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  // The cut: reference slices the (ASCII-only) slug to 64 then strips '-'.
  if (out.length > 64) {
    out = out.slice(0, 64);
    let e = out.length;
    while (e > 0 && out[e - 1] === '-') e--;
    out = out.slice(0, e);
  }
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) { taken.add(slug); return slug; }
  let n = 2;
  for (;; n++) {
    const out = `${slug}-${n}`;
    if (!taken.has(out)) { taken.add(out); return out; }
  }
}

// Whitespace per /\s/: ASCII set plus the Unicode spaces (all BMP).
function isWS(code) {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 128) return false;
  return code === 160 || code === 5760 || (code >= 8192 && code <= 8202) || code === 8232 || code === 8233 || code === 8239 || code === 8287 || code === 12288 || code === 65279;
}

// The words of a body: runs of non-whitespace, counted without allocating.
// ASCII whitespace is a table lookup; the rest are the Unicode spaces.
const WS_TABLE = new Uint8Array(128);
for (const _c of [9, 10, 11, 12, 13, 32]) WS_TABLE[_c] = 1;

function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  let inW = false;
  while (i < len) {
    const c = text.charCodeAt(i++);
    const ws = c < 128 ? WS_TABLE[c] === 1 : c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inW = false;
    else if (!inW) { n++; inW = true; }
  }
  return n;
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/* ---------------- front matter ---------------- */

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmStringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function fmValueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmStringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
    let y = 0, mo = 0, d = 0;
    if (ok) {
      for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
    }
    if (ok) { y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10)); }
    if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
    for (const t of tags) {
      if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
    }
    if (raw.length === 0) return { error: 'key "layout": not a template name' };
    return { value: raw };
  }
  if (key === 'slug') {
    let ok = raw.length > 0 && raw.length <= 64;
    if (ok) {
      // [a-z0-9]+(-[a-z0-9]+)* : alnum runs joined by single '-'.
      let prevDash = false;
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (c === '-') {
          if (i === 0 || prevDash || i === raw.length - 1) { ok = false; break; }
          prevDash = true;
        } else if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) prevDash = false;
        else { ok = false; break; }
      }
    }
    return ok ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

// One line of front matter: returns {key, raw} or null when not "key: value".
// raw is the value with trailing spaces/tabs dropped ('' when no value given).
function fmLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (!((c >= 'a' && c <= 'z') || c === '_')) break;
    i++;
  }
  if (i === 0 || i >= line.length || line[i] !== ':') return null;
  const key = line.slice(0, i);
  let raw;
  if (i + 1 === line.length) raw = '';
  else if (line[i + 1] === ' ') raw = line.slice(i + 2);
  else return null;
  let e = raw.length;
  while (e > 0 && (raw[e - 1] === ' ' || raw[e - 1] === '\t')) e--;
  return { key, raw: raw.slice(0, e) };
}

// Lines of `text` as slices, via indexOf (no full split for the body).
function fmLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) { lines.push(text.slice(start)); break; }
    lines.push(text.slice(start, nl));
    start = nl + 1;
    if (start === text.length) { lines.push(''); break; }
  }
  return lines;
}

function parseFrontMatter(text) {
  // First line must be exactly '---'.
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing '---' line.
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let closeLine = -1;
  let closeStart = -1;
  let closeEnd = -1;
  let lineNo = 1;
  for (;;) {
    if (pos >= text.length) break;
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    lineNo++;
    if (line === '---') { closeLine = lineNo; closeStart = pos; closeEnd = end; break; }
    pos = end + 1;
    if (nl === -1) break;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Walk lines 2..closeLine-1 (1-based), i.e. between the markers.
  pos = nl0 + 1;
  for (let n = 2; n < closeLine; n++) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    pos = end + 1;
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue; // '#' comment
    const m = fmLine(line);
    if (m === null) return { error: `line ${n} is not "key: value"` };
    if (!FM_KEYS.includes(m.key)) return { error: `unknown key "${m.key}"` };
    if (Object.hasOwn(data, m.key)) return { error: `key "${m.key}" is given twice` };
    if (m.raw === '') return { error: `key "${m.key}" has no value` };
    const v = fmValueOf(m.key, m.raw);
    if ('error' in v) return v;
    data[m.key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const body = closeEnd === text.length ? '' : text.slice(closeEnd + 1);
  return { data, body };
}

/* ---------------- markdown ---------------- */

const ESCAPABLE = "\\`*_[]()#+-.!>";

function findUnescaped(s, what, from) {
  let j = from;
  for (;;) {
    const p = s.indexOf(what, j);
    if (p === -1) return -1;
    // `what` at p is escaped iff an odd run of backslashes precedes it: the
    // reference scanner consumes backslash pairs left to right, so a run of
    // k backslashes leaves the occurrence escaped exactly when k is odd.
    let k = 0;
    while (p - 1 - k >= from && s[p - 1 - k] === '\\') k++;
    if (k % 2 === 0) return p;
    j = p + 1;
  }
}

function findSingleStar(s, from) {
  let j = from;
  for (;;) {
    const p = s.indexOf('*', j);
    if (p === -1) return -1;
    let k = 0;
    while (p - 1 - k >= from && s[p - 1 - k] === '\\') k++;
    if (k % 2 === 1) { j = p + 1; continue; } // escaped star
    if (s[p + 1] === '*') { j = p + 2; continue; } // part of a '**' run
    return p;
  }
}

const SPECIAL_RE = /[\\`*\[&<>"']/g;

function nextSpecial(s, from) {
  SPECIAL_RE.lastIndex = from;
  const m = SPECIAL_RE.exec(s);
  return m === null ? -1 : m.index;
}

function hasWS(s) {
  for (let i = 0; i < s.length; i++) if (isWS(s.charCodeAt(i))) return true;
  return false;
}

// Inline rendering, exactly the reference's rules, driven by indexOf jumps
// between interesting characters instead of a per-character loop. Plain runs
// between specials hold no escapable character and are copied verbatim.
function inline(s, env) {
  const out = [];
  let i = 0;
  const len = s.length;
  while (i < len) {
    const j = nextSpecial(s, i);
    if (j === -1) { out.push(s.slice(i)); break; }
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '&') { out.push('&amp;'); i = j + 1; continue; }
    if (c === '<') { out.push('&lt;'); i = j + 1; continue; }
    if (c === '>') { out.push('&gt;'); i = j + 1; continue; }
    if (c === '"') { out.push('&quot;'); i = j + 1; continue; }
    if (c === "'") { out.push('&#39;'); i = j + 1; continue; }
    if (c === '\\') {
      if (j + 1 < len && ESCAPABLE.indexOf(s[j + 1]) !== -1) {
        out.push(s[j + 1] === '>' ? '&gt;' : s[j + 1]);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out.push('<code>');
        escAppend(out, s.slice(j + 1, k));
        out.push('</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out.push('<strong>');
          out.push(inline(s.slice(j + 2, k), env));
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out.push('<em>');
          out.push(inline(s.slice(j + 1, k), env));
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    // '[': link, else literal.
    const k = findUnescaped(s, ']', j + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasWS(target)) {
      out.push('<a href="');
      escAppend(out, env.link(target));
      out.push('">');
      out.push(inline(s.slice(j + 1, k), env));
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i = j + 1;
    }
  }
  return out.join('');
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return line.slice(a, b);
}

function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line[j];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-')) break;
    j++;
  }
  for (let k = j; k < line.length; k++) if (line[k] !== ' ' && line[k] !== '\t') return null;
  return line.slice(3, j);
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) if (line[k] !== ' ' && line[k] !== '\t') return false;
  return true;
}

function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || (line[n] !== ' ' && line[n] !== '\t')) return null;
  let j = n;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  let e = line.length;
  while (e > j && (line[e - 1] === ' ' || line[e - 1] === '\t')) e--;
  if (e === j) return null;
  return { depth: n, text: line.slice(j, e) };
}

function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let k = 3; k < line.length; k++) if (line[k] !== ' ' && line[k] !== '\t') return false;
  return true;
}

function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

function bulletMatch(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

function orderedMatch(line) {
  let j = 0;
  while (j < line.length && line[j] >= '0' && line[j] <= '9') j++;
  if (j < 1 || j > 9) return null;
  if (line[j] !== '.' || line[j + 1] !== ' ') return null;
  return { num: Number(line.slice(0, j)), content: line.slice(j + 2) };
}

function isContinued(line) {
  let k = 0;
  while (k < line.length && line[k] === ' ') k++;
  if (k < 2 || k >= line.length) return false;
  return !isWS(line.charCodeAt(k));
}

function splitLines(src) {
  const lines = [];
  let start = 0;
  for (;;) {
    const nl = src.indexOf('\n', start);
    if (nl === -1) { lines.push(src.slice(start)); break; }
    lines.push(src.slice(start, nl));
    start = nl + 1;
    if (start === src.length) { lines.push(''); break; }
  }
  return lines;
}

// Fused lex+render: blocks are rendered as they are scanned, no token list.
// env: { link(target)->href, slug(text)->slug }.
function renderMarkdown(src, env) {
  const lines = splitLines(src);
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fenceLang = fenceOpen(line);
    if (fenceLang !== null) {
      const body = [];
      i++;
      while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const code = [];
      for (let k = 0; k < body.length; k++) { escAppend(code, body[k]); code.push('\n'); }
      blocks.push(`<pre><code${fenceLang === '' ? '' : ` class="language-${fenceLang}"`}>${code.join('')}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(env.slug(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) { blocks.push('<hr>'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l[1] === ' ' ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletMatch(line);
    const ordered = bullet === null ? orderedMatch(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.num : 1;
      const items = [];
      while (i < n) {
        if (isOrdered) {
          const m = orderedMatch(lines[i]);
          if (m !== null) { items.push([trimLine(m.content)]); i++; continue; }
        } else {
          const m = bulletMatch(lines[i]);
          if (m !== null) { items.push([trimLine(m)]); i++; continue; }
        }
        if (items.length > 0 && isContinued(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const lis = [];
      for (const parts of items) lis.push(`<li>${inline(parts.join('\n'), env)}</li>\n`);
      blocks.push(`${open}\n${lis.join('')}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

/* ---------------- templates ---------------- */

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') out.push(n.text);
    else if (n.kind === 'var') escAppend(out, textOf(lookup(scope, n.path)));
    else if (n.kind === 'raw') out.push(textOf(lookup(scope, n.path)));
    else if (n.kind === 'if') {
      const v = truthy(lookup(scope, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
      }
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
    }
  }
}

/* ---------------- template codegen ---------------- */

// Scope is an array of vars objects, innermost last. Same lookup rule as the
// reference: first name from the nearest scope holding it, then own properties.
function lk(S, path) {
  for (let i = S.length - 1; i >= 0; i--) {
    const vars = S[i];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

function genNodes(nodes, code, ctr) {
  for (const n of nodes) {
    if (n.kind === 'text') code.push(`O.push(${JSON.stringify(n.text)});`);
    else if (n.kind === 'var') code.push(`H.ea(O,H.tx(H.lk(S,${JSON.stringify(n.path)})));`);
    else if (n.kind === 'raw') code.push(`O.push(H.tx(H.lk(S,${JSON.stringify(n.path)})));`);
    else if (n.kind === 'if') {
      code.push(`if(H.tr(H.lk(S,${JSON.stringify(n.path)}))===${n.not ? 'false' : 'true'}){`);
      genNodes(n.then, code, ctr);
      if (n.else !== null) {
        code.push('}else{');
        genNodes(n.else, code, ctr);
      }
      code.push('}');
    } else if (n.kind === 'for') {
      const id = ctr.n++;
      code.push(`{let _x${id}=H.lk(S,${JSON.stringify(n.path)});if(Array.isArray(_x${id})){for(let _k${id}=0;_k${id}<_x${id}.length;_k${id}++){S.push({${JSON.stringify(n.name)}:_x${id}[_k${id}],loop:{index:_k${id}+1,first:_k${id}===0,last:_k${id}===_x${id}.length-1,length:_x${id}.length}});`);
      genNodes(n.body, code, ctr);
      code.push('S.pop();}}}');
    } else if (n.kind === 'include') {
      code.push(`H.inc(C,${JSON.stringify(n.name)},S,D,O);`);
    }
  }
}

const H = {
  lk,
  tx: textOf,
  ea: escAppend,
  tr: truthy,
  inc(C, name, S, D, O) {
    const fn = C.fns.get(name);
    if (fn === undefined || D >= INCLUDE_DEPTH) return;
    // Memoize the include: a template's render is a pure function of its
    // name, its depth and the values of its free roots, so an include with
    // the same (name, depth, root values) renders the same string. This
    // collapses the per-page repeats (header, footer, recent-partials) and
    // the per-post repeats (card on index and tag pages) to one render each.
    const roots = C.roots.get(name);
    let node = C.memo;
    for (let k = 0; k < roots.length + 2; k++) {
      const part = k === 0 ? name : k === 1 ? D : lk(S, [roots[k - 2]]);
      let nxt = node.get(part);
      if (nxt === undefined) { nxt = new Map(); node.set(part, nxt); }
      node = nxt;
    }
    const hit = node.get(MEMO_VAL);
    if (hit !== undefined) { O.push(hit); return; }
    const start = O.length;
    if (fn === null) {
      // Codegen failed for this template: interpret its AST instead, with the
      // scope array rebuilt as the interpreter's linked chain.
      let scope = null;
      for (let i = 0; i < S.length; i++) scope = { vars: S[i], parent: scope };
      renderNodes(C.ast.get(name), scope, { templates: C.ast }, D + 1, O);
    } else {
      fn(H, C, S, D + 1, O);
    }
    const rendered = O.slice(start).join('');
    node.set(MEMO_VAL, rendered);
    O.length = start;
    O.push(rendered);
  },
};

// Compile one template's AST to a function (H, C, S, D, O) => void, or null
// when codegen fails (the interpreter above is the fallback).
function compileTemplate(nodes) {
  try {
    const code = [];
    genNodes(nodes, code, { n: 0 });
    return new Function('H', 'C', 'S', 'D', 'O', code.join(''));
  } catch {
    return null;
  }
}

// A template's free roots: the first names its render can read from the scope
// it is called in (its own fors bind their element name and `loop`; an
// include inherits the roots of the template it includes). Computed to a
// fixpoint so include cycles are handled.
function collectRoots(nodes, bound, out, roots) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
    }
    if (n.kind === 'if') {
      collectRoots(n.then, bound, out, roots);
      if (n.else !== null) collectRoots(n.else, bound, out, roots);
    } else if (n.kind === 'for') {
      // The array's own path is a root too (it was missed before: a template
      // like `{% for t in p.tags %}` with no other use of `p` must still key
      // on `p`, or every render reuses the first one).
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      collectRoots(n.body, b2, out, roots);
    } else if (n.kind === 'include') {
      const sub = roots.get(n.name);
      if (sub !== undefined) for (const r of sub) if (!bound.has(r)) out.add(r);
    }
  }
}

function computeFreeRoots(templates) {
  const roots = new Map();
  for (const name of templates.keys()) roots.set(name, new Set());
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of templates) {
      const set = roots.get(name);
      const before = set.size;
      collectRoots(nodes, new Set(), set, roots);
      if (set.size !== before) changed = true;
    }
  }
  const out = new Map();
  for (const [name, set] of roots) out.set(name, [...set].sort());
  return out;
}

const MEMO_VAL = {};

/* ---------------- build ---------------- */

const RESERVED = ['posts', 'tags', 'page'];

function build(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const slugCache = new Map();
  const slug = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) { s = slugifyRaw(t); slugCache.set(t, s); }
    return s;
  };
  const base = input.site.base_url.replace(/\/+$/, '');
  // 1. Sources, sorted by path; .md sources have line ends made '\n'.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  // 2. Front matter, in source order; first failing check is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  // 3. Permalinks: slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) { set = new Set(dir === '' ? RESERVED : []); taken.set(dir, set); }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const sl = uniqueSlug(s.data.slug ?? slug(s.data.title), takenIn(dir));
    s.slug = sl;
    s.outDir = dir === '' ? sl : `${dir}/${sl}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  // 4. Markdown, links resolved to pages and static files. The resolution of
  // a (directory, relative target) is the same for every source in that
  // directory, so it is cached per case; the broken-link report still names
  // each source, so it is added per source, not per cache entry.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkRes = new Map();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      slug,
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const key = `${dir}\n${rel}`;
        let res = linkRes.get(key);
        if (res === undefined) {
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) res = bySource.get(path).url;
          else if (path !== null && staticPaths.has(path)) res = `${base}/${path}`;
          else res = null;
          linkRes.set(key, res);
        }
        if (res !== null) return `${res}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.reading = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }
  // 5. Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const sl = slug(name);
      if (!seen.has(sl)) { seen.add(sl); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slug(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) { tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] }; bySlug.set(sl, tag); }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slug(name)) ?? { name, slug: slug(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  // 7. Layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.reading,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  // A post's neighbour links are fixed for the case; build them once.
  for (const p of posts) {
    p.newerLink = linkOf(p.newer);
    p.olderLink = linkOf(p.older);
  }
  // A page reuses its post's card (same fields) instead of rebuilding it, and
  // shares its toc array: templates only read these, never mutate them.
  const pageOf = (s) => ({
    ...(s.post ? cards.get(s) : cardOf(s)),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: s.post ? s.newerLink : null,
    older: s.post ? s.olderLink : null,
    is_post: s.post,
  });
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const C = { fns: new Map(), ast: templates, roots: computeFreeRoots(templates), memo: new Map() };
  for (const [name, nodes] of templates) C.fns.set(name, compileTemplate(nodes));
  const render = (name, vars) => {
    const fn = C.fns.get(name);
    if (fn === undefined) return null;
    const out = [];
    if (fn === null) {
      renderNodes(templates.get(name), { vars: { site, tags: allTags, recent, ...vars }, parent: null }, { templates }, 0, out);
    } else {
      fn(H, C, [{ site, tags: allTags, recent, ...vars }], 0, out);
    }
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  // 8. The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

export function run(input) {
  return build(input);
}
