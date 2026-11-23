// solve.js — a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns makefun-site 1.0.0's exact answer for the case: the
// output tree as a JSON object {path: text}, byte for byte. The work is the
// same build the reference does — front matter, permalinks, markdown,
// templates, collections, the build report — written to run leaner: one-pass
// escaping with a no-special-character fast path, a memoised ASCII-fast
// slugify, line-gated block classification, and segment-flushed inline
// rendering. Nothing is cached from one case to the next: every memo lives
// for exactly one run() call.

// ---------------------------------------------------------------- text ----

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// escapeHtml: & < > " ' become &amp; &lt; &gt; &quot; &#39;. One pass; a
// string holding no special character is returned as it stands.
function escapeHtml(s) {
  let out = null;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out = out === null ? s.slice(0, i) + rep : out + s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return out === null ? s : out + s.slice(last);
}

// Slugify memo, reset by every run() call: titles, tag names and headings
// repeat across a site, and each slug is computed once per case.
let slugCache = new Map();

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const slug = slugifyRaw(text);
  slugCache.set(text, slug);
  return slug;
}

function slugifyRaw(text) {
  // Pure ASCII has no compatibility decomposition and no combining marks,
  // so the normalise-and-strip step is the identity there and is skipped.
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep < 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

// The first of slug, slug-2, slug-3, ... not already in taken.
function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const candidate = `${slug}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// '2026-03-05' -> '5 March 2026'.
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// --------------------------------------------------------- front matter ----

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

// A front-matter problem: {error} with the generator's own words.
class FrontMatterError extends Error {}
function fmFail(message) {
  throw new FrontMatterError(message);
}

function isLeap(y) {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysIn(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// A title, layout or summary value: a double-quoted string or a bare one.
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) fmFail('a quoted string is not closed');
    const inner = raw.slice(1, -1);
    let out = '';
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i];
      if (c === '\\') {
        const next = inner[i + 1];
        if (next === '"' || next === '\\') { out += next; i++; }
        else fmFail('a quoted string holds an escape other than \\" or \\\\');
      } else if (c === '"') fmFail('a quoted string holds a stray quote');
      else out += c;
    }
    return out;
  }
  if (raw.startsWith('[')) fmFail('a bare string opens on [');
  return raw;
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return fmString(raw);
    case 'layout':
      if (!FM_NAME.test(raw)) fmFail('not a template name');
      return raw;
    case 'slug':
      if (!FM_SLUG.test(raw) || raw.length > 64) fmFail('not a slug');
      return raw;
    case 'date': {
      if (!FM_DATE.test(raw)) fmFail('not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
      const y = Number(raw.slice(0, 4));
      const m = Number(raw.slice(5, 7));
      const d = Number(raw.slice(8, 10));
      if (y < 1970 || y > 2099 || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) {
        fmFail('not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)');
      }
      return raw;
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) fmFail('not a list [a, b]');
      const inner = raw.slice(1, -1).trim();
      if (inner === '') return [];
      return inner.split(',').map((part) => {
        const tag = part.trim();
        if (tag === '' || tag.includes('"') || tag.includes('[') || tag.includes(']')) {
          fmFail('an empty tag, or one holding " [ or ]');
        }
        return tag;
      });
    }
    case 'draft':
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      fmFail('true or false');
      return undefined;
    default:
      return undefined;
  }
}

// The front matter of one source: {data, body}, or throws FrontMatterError.
// The text is scanned line by line without splitting the whole body: the
// body is the slice past the closing line, exactly the lines after it
// joined with '\n'.
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first !== '---') fmFail('no front matter');
  const fmLines = [];
  let pos = firstNl === -1 ? text.length : firstNl + 1;
  let closeEnd = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    if (line === '---') {
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (closeEnd === -1) fmFail('the front matter is not closed');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (m === null) fmFail(`line ${j + 2} is not "key: value"`);
    const key = m[1];
    if (!FM_KEYS.has(key)) fmFail(`unknown key "${key}"`);
    if (Object.hasOwn(data, key)) fmFail(`key "${key}" is given twice`);
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (raw === '') fmFail(`key "${key}" has no value`);
    try {
      data[key] = fmValue(key, raw);
    } catch (err) {
      if (err instanceof FrontMatterError) fmFail(`key "${key}": ${err.message}`);
      throw err;
    }
  }
  if (typeof data.title !== 'string' || data.title === '') fmFail('no title');
  return { data, body: text.slice(closeEnd) };
}

// ------------------------------------------------------------- markdown ----

// The characters a backslash escapes: \ ` * _ [ ] ( ) # + - . ! >
const ESCAPABLE_CC = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) {
  ESCAPABLE_CC[ch.charCodeAt(0)] = 1;
}
function isEscapable(ch) {
  const code = ch.charCodeAt(0);
  return code < 128 && ESCAPABLE_CC[code] === 1;
}

// The next index of a one-character delimiter at or after from, skipping
// backslash-escaped characters; -1 when there is none.
function findUnescapedChar(s, ch, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) { j++; continue; }
    if (s[j] === ch) return j;
  }
  return -1;
}

// The next index of the two stars of a strong close at or after from.
function findUnescapedPair(s, from) {
  const last = s.length - 2;
  for (let j = from; j <= last; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) { j++; continue; }
    if (s[j] === '*' && s[j + 1] === '*') return j;
  }
  return -1;
}

// The next index of a single * that closes an emphasis: a star not escaped
// and not one of a pair.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

// Inline markup to HTML. Plain runs between constructs are escaped in one
// escapeHtml call each; a construct that does not close stays in the plain
// run, exactly where the reference leaves it.
function inline(s, link) {
  const n = s.length;
  let out = '';
  let seg = 0;
  let i = 0;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && isEscapable(s[i + 1])) {
        out += escapeHtml(s.slice(seg, i)) + escapeHtml(s[i + 1]);
        i += 2;
        seg = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += escapeHtml(s.slice(seg, i)) + '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
        seg = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescapedPair(s, i + 2);
        if (j > i + 2) {
          out += escapeHtml(s.slice(seg, i)) + '<strong>' + inline(s.slice(i + 2, j), link) + '</strong>';
          i = j + 2;
          seg = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += escapeHtml(s.slice(seg, i)) + '<em>' + inline(s.slice(i + 1, j), link) + '</em>';
          i = j + 1;
          seg = i;
        } else i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescapedChar(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !WS_RE.test(target)) {
        out += escapeHtml(s.slice(seg, i)) +
          '<a href="' + escapeHtml(link(target)) + '">' + inline(s.slice(i + 1, k), link) + '</a>';
        i = m + 1;
        seg = i;
      } else i++;
      continue;
    }
    i++;
  }
  return out + escapeHtml(s.slice(seg));
}

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const CONTINUED_RE = /^ {2,}\S/;

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

// The heading on a line, or null: {level, text}, the text non-empty.
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  const m = HEADING_RE.exec(line);
  if (m === null || m[2] === '') return null;
  return { level: m[1].length, text: m[2] };
}

// An ordered-list marker on a line, or null: {start, text}.
function orderedOf(line) {
  let d = 0;
  while (d < line.length && d < 10) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}

function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  const m = FENCE_OPEN.exec(line);
  return m === null ? null : m[1];
}

function isFenceClose(line) {
  return line.startsWith('```') && FENCE_CLOSE.test(line);
}

function isHr(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && HR_RE.test(line);
}

// What ends a paragraph: a blank line, a fence, a heading or a rule.
function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// One source's markdown to {html, toc, excerpt}, in a single pass over the
// lines: blocks are rendered as they are classified, headings take their
// ids in order, and the excerpt is the first paragraph's inline HTML.
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const ids = new Set();
  const toc = [];
  const parts = [];
  let excerpt = '';
  let excerptDone = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      i++;
      let body = '';
      while (i < lines.length && !isFenceClose(lines[i])) {
        body += escapeHtml(lines[i]) + '\n';
        i++;
      }
      i++;
      parts.push('<pre><code' + (lang === '' ? '' : ` class="language-${lang}"`) + '>' + body + '</code></pre>', '\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      i++;
      const id = uniqueSlug(slugify(heading.text), ids);
      ids.add(id);
      const html = inline(heading.text, link);
      if (heading.level === 2 || heading.level === 3) toc.push({ level: heading.level, id, html });
      parts.push(`<h${heading.level} id="${id}">${html}</h${heading.level}>`, '\n');
      continue;
    }
    if (isHr(line)) { i++; parts.push('<hr>', '\n'); continue; }
    if (line.charCodeAt(0) === 62) {
      const quoted = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const stripped = lines[i][1] === ' ' ? lines[i].slice(2) : lines[i].slice(1);
        const text = trimLine(stripped);
        if (text !== '') quoted.push(text);
        i++;
      }
      parts.push(quoted.length === 0
        ? '<blockquote>\n</blockquote>'
        : `<blockquote>\n<p>${inline(quoted.join('\n'), link)}</p>\n</blockquote>`, '\n');
      continue;
    }
    const bullet = (line.charCodeAt(0) === 45 || line.charCodeAt(0) === 42) && line[1] === ' ';
    const ordered = bullet ? null : orderedOf(line);
    if (bullet || ordered !== null) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (bullet) {
          if (!((l.charCodeAt(0) === 45 || l.charCodeAt(0) === 42) && l[1] === ' ')) break;
          items.push([trimLine(l.slice(2))]);
        } else {
          const o = orderedOf(l);
          if (o === null) break;
          items.push([trimLine(o.text)]);
        }
        i++;
        while (i < lines.length && CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        }
      }
      const open = bullet ? '<ul>' : ordered.start !== 1 ? `<ol start="${ordered.start}">` : '<ol>';
      const close = bullet ? '</ul>' : '</ol>';
      let html = open + '\n';
      for (const item of items) html += `<li>${inline(item.join('\n'), link)}</li>\n`;
      parts.push(html + close, '\n');
      continue;
    }
    const para = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      para.push(trimLine(lines[i]));
      i++;
    }
    const html = inline(para.join('\n'), link);
    if (!excerptDone) { excerpt = html; excerptDone = true; }
    parts.push(`<p>${html}</p>`, '\n');
  }
  return { html: parts.join(''), toc, excerpt };
}

// ------------------------------------------------------------ templates ----

class TemplateError extends Error {}

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function tplFail(name, reason) {
  throw new TemplateError(`template "${name}": ${reason}`);
}

function pathOf(name, text) {
  if (!TPL_PATH.test(text)) tplFail(name, `${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Tokenise a template source: text, {{ var }}, {{{ raw }}} and {% tag %}
// tokens. A {% %} tag alone on its line takes the whole line with it.
function tokenizeTemplate(name, src) {
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
      if (close === -1) tplFail(name, `a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') { tokens.push({ kind: 'text', text }); text = ''; }
      tokens.push({
        kind: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) tplFail(name, 'a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone =
      /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') { tokens.push({ kind: 'text', text }); text = ''; }
    tokens.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ kind: 'text', text });
  return tokens;
}

// Parse tokens into a node tree; throws TemplateError.
function parseTemplate(name, src) {
  const root = [];
  const stack = [{ kind: 'root', body: root }];
  let body = root;
  for (const token of tokenizeTemplate(name, src)) {
    if (token.kind !== 'tag') { body.push(token); continue; }
    const tag = token.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = TPL_FOR.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = TPL_IF.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) tplFail(name, 'an else outside an if');
      top.else = [];
      body = top.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      if (top.kind !== tag.slice(3)) tplFail(name, `an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' || parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
    } else if ((m = TPL_INCLUDE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      tplFail(name, `{% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) tplFail(name, `a ${stack[stack.length - 1].kind} is not closed`);
  return root;
}

// The first name is looked for from the innermost scope out; the rest of
// the path is then followed through own properties.
function tplLookup(scope, path) {
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

function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function tplTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) out += ', ';
      out += tplTextOf(v[k]);
    }
    return out;
  }
  return '';
}

function renderNodes(nodes, scope, templates, depth, out) {
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var':
        out.push(escapeHtml(tplTextOf(tplLookup(scope, node.path))));
        break;
      case 'raw':
        out.push(tplTextOf(tplLookup(scope, node.path)));
        break;
      case 'include': {
        const t = templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
      case 'if': {
        const branch = tplTruthy(tplLookup(scope, node.path)) !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = tplLookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = {};
          vars[node.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === len - 1, length: len };
          renderNodes(node.body, { vars, parent: scope }, templates, depth, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build ----

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

function dirOf(path) {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const step of rel.split('/')) {
    if (step === '' || step === '.') continue;
    if (step === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(step);
  }
  return parts.join('/');
}

// The directory's taken slugs, seeded with the root's reserved names.
function takenIn(taken, dir) {
  let set = taken.get(dir);
  if (set === undefined) {
    set = new Set();
    taken.set(dir, set);
  }
  return set;
}

function build(input) {
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Front matter: keep a source or record the refusal.
  const kept = [];
  for (const s of sources) {
    let parsed;
    try {
      parsed = parseFrontMatter(s.text);
    } catch (err) {
      if (err instanceof FrontMatterError) { report.push(`refused ${s.path}: ${err.message}`); continue; }
      throw err;
    }
    const data = parsed.data;
    s.data = data;
    s.body = parsed.body;
    s.post = s.path.startsWith('posts/');
    const dir = dirOf(s.path);
    if (dir === 'tags' || dir.startsWith('tags/') || dir === 'page' || dir.startsWith('page/')) {
      report.push(`refused ${s.path}: ${dir.split('/')[0]}/ is the generator's own`);
      continue;
    }
    if (s.post && data.date === undefined) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    s.layout = data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(s.layout)) {
      report.push(`refused ${s.path}: layout "${s.layout}" is no template that parses`);
      continue;
    }
    if (data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: a unique slug in each directory.
  const taken = new Map();
  takenIn(taken, '').add('posts').add('tags').add('page');
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(taken, dir));
    takenIn(taken, dir).add(s.slug);
    s.outDir = dir === '' ? s.slug : `${dir}/${s.slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: render each kept source, resolving links against the site.
  const broken = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (target.startsWith('/') || target.startsWith('#') || SCHEME_RE.test(target)) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const resolved = resolvePath(dir, rel);
      if (resolved === null) {
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      }
      const found = bySource.get(resolved);
      if (found !== undefined) return found.url + frag;
      if (staticPaths.has(resolved)) return `${base}/${resolved}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const rendered = renderMarkdown(s.body, link);
    s.content = rendered.html;
    s.toc = rendered.toc;
    s.excerpt = rendered.excerpt;
  }

  // Collections: posts newest first, slug ascending on a tie.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: a source's own tags, deduped by slug, first spelling kept.
  for (const s of kept) {
    const seen = new Set();
    const names = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      names.push(name);
    }
    s.tagNames = names;
  }
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = p.tagNames.map((name) => {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      return tag;
    });
  }
  const tags = [...bySlug.values()];
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = s.tagNames.map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  tags.sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, memoised per source: layouts ask for the same cards repeatedly.
  const cards = new Map();
  const cardOf = (s) => {
    let card = cards.get(s);
    if (card !== undefined) return card;
    const words = s.body.match(/\S+/g);
    card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil((words === null ? 0 : words.length) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cards.set(s, card);
    return card;
  };
  const refOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const pageOf = (s) => Object.assign(cardOf(s), {
    slug: s.slug,
    content: s.content,
    toc: s.toc,
    newer: refOf(s.post ? s.newer : null),
    older: refOf(s.post ? s.older : null),
    is_post: s.post,
  });

  // Layouts: every page, the paged index, the tag pages, the statics.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(cardOf);
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const perPage = input.site.per_page;
  const total = Math.max(1, Math.ceil(posts.length / perPage));
  for (let k = 0; k < total; k++) {
    const number = k + 1;
    const pager = {
      number,
      total,
      url: number === 1 ? `${base}/` : `${base}/page/${number}/`,
      newer_url: number === 1 ? '' : number === 2 ? `${base}/` : `${base}/page/${number - 1}/`,
      older_url: number === total ? '' : `${base}/page/${number + 1}/`,
    };
    const html = render('index', { posts: posts.slice(k * perPage, (k + 1) * perPage).map(cardOf), pager });
    if (html !== null) output[number === 1 ? 'index.html' : `page/${number}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map(cardOf) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line sorted, then the counts.
  const lines = report.concat([...broken]).sort(byCodeUnits);
  const pages = kept.reduce((n, s) => n + (s.post ? 0 : 1), 0);
  lines.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}

// makefun-site 1.0.0's answer for one case's input.
export function run(input) {
  slugCache = new Map();
  return build(input);
}
