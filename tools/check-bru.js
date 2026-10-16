#!/usr/bin/env node
// Bruno .bru grammar linter.
//
// The .bru format allows exactly ONE request per file. Documentation must
// live in a `docs { }` block with plain text — a bare `###` line after the
// request block (markdown style) is NOT valid and makes Bruno fail to parse
// the whole file. Same for `---` separators: they silently turn a 5-request
// scratchpad into 5 unparseable files' worth of garbage.
//
// Usage: node tools/check-bru.js [dir ...]
const fs = require("fs");
const path = require("path");

const HTTP = new Set(["get", "post", "put", "delete", "patch", "head", "options"]);
const BLOCKS = new Set([
  "meta", "headers", "params", "params:query", "params:path", "params:url",
  "body:json", "body:form-urlencoded", "body:multipart-form", "body:file",
  "body:graphql", "body:text", "auth:basic", "auth:bearer", "auth:oauth2",
  "auth:inherit", "auth:oauth1", "auth:apikey",
  "script:pre-request", "script:post-response", "tests", "assert",
  "vars:pre-request", "vars:post-response", "docs", "settings", "vars",
]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === ".pio") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".bru")) out.push(p);
  }
  return out;
}

function check(file) {
  const problems = [];
  const text = fs.readFileSync(file, "utf8");
  // Environment files legitimately hold only vars, no request.
  const isEnv = /[\\/]environments[\\/]/.test(file);
  if (text.charCodeAt(0) === 0xfeff) problems.push("has a UTF-8 BOM (Bruno chokes on it)");
  if (Buffer.compare(Buffer.from(text, "utf8"), fs.readFileSync(file)) !== 0) {
    problems.push("is not valid UTF-8");
  }
  const lines = text.split(/\r?\n/);
  let depth = 0, methodCount = 0, urlInMethod = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (depth === 0) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Bruno env files use // comments; tolerate them.
      if (trimmed.startsWith("//")) continue;

      // one-line form: `auth: none`
      const oneLine = trimmed.match(/^([a-z][a-z0-9:._-]*)\s*:\s*(\S+)\s*$/i);
      if (oneLine && !trimmed.includes("{")) {
        if (oneLine[1] === "auth" && oneLine[2] === "none") continue;
        problems.push(`L${n}: stray "${trimmed}" outside any block`);
        continue;
      }

      const start = trimmed.match(/^([a-z][a-z0-9:._-]*)\s*\{/i);
      if (!start) {
        if (/^---+$/.test(trimmed)) {
          problems.push(`L${n}: "---" separator — .bru holds ONE request; split into separate files`);
        } else if (trimmed.startsWith("#")) {
          problems.push(`L${n}: bare "${trimmed.slice(0, 24)}" — put docs inside a docs { } block`);
        } else {
          problems.push(`L${n}: loose text "${trimmed.slice(0, 30)}" outside any block`);
        }
        continue;
      }

      const name = start[1];
      if (HTTP.has(name)) {
        methodCount++;
        urlInMethod = false;
        if (methodCount > 1) {
          problems.push(`L${n}: second "${name} {" block — .bru holds ONE request`);
        }
      } else if (!BLOCKS.has(name)) {
        problems.push(`L${n}: unknown block "${name} {"`);
      }
    } else if (/^\s*url\s*:/i.test(line)) {
      urlInMethod = true;
    }

    depth += opens - closes;
    if (depth < 0) { problems.push(`L${n}: unbalanced "}"`); depth = 0; }
  }
  if (depth !== 0) problems.push(`unclosed "{" (depth ${depth} at EOF)`);
  if (!isEnv) {
    if (methodCount === 0) problems.push("no HTTP method block (get/post/put/...)");
    if (methodCount === 1 && !urlInMethod) problems.push("method block has no url:");
  }
  return problems;
}

const roots = process.argv.slice(2);
const files = roots.flatMap(r => walk(r));
let bad = 0;
for (const f of files.sort()) {
  const p = check(f);
  if (p.length) {
    bad++;
    console.log(`\n${f}`);
    p.forEach(x => console.log(`   ${x}`));
  }
}
console.log(`\nchecked ${files.length} .bru file(s) across ${roots.length} root(s), ${bad} with problems`);
process.exit(bad ? 1 : 0);
