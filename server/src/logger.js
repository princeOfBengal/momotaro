const util = require('util');

const MAX_ENTRIES = 2000;
const buffer = [];

function formatArgs(args) {
  return args
    .map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 3, colors: false, breakLength: 120 })))
    .join(' ');
}

function record(level, args) {
  const message = formatArgs(args);
  buffer.push({ ts: new Date().toISOString(), level, message });
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
}

const original = {
  log:   console.log.bind(console),
  info:  console.info.bind(console),
  warn:  console.warn.bind(console),
  error: console.error.bind(console),
};

let installed = false;
function install() {
  if (installed) return;
  installed = true;
  console.log   = (...args) => { record('info',  args); original.log(...args); };
  console.info  = (...args) => { record('info',  args); original.info(...args); };
  console.warn  = (...args) => { record('warn',  args); original.warn(...args); };
  console.error = (...args) => { record('error', args); original.error(...args); };
}

function getEntries() {
  return buffer.slice();
}

function formatAsText(entries) {
  return entries
    .map(e => `[${e.ts}] [${e.level.toUpperCase()}] ${e.message}`)
    .join('\n');
}

module.exports = { install, getEntries, formatAsText, MAX_ENTRIES };
