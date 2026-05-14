const mangadex     = require('./mangadex');
const comixto      = require('./comixto');
const mangakakalot = require('./mangakakalot');
const mangafire    = require('./mangafire');
const weebcentral  = require('./weebcentral');
const mangaball    = require('./mangaball');
const mangataro    = require('./mangataro');
const mangadotnet  = require('./mangadotnet');
const comikuro     = require('./comikuro');

// Registry of available third-party download sources. Look up an adapter by
// its string id; throws if the id is unknown so callers can map that to a
// 400 response instead of a 500.
const SOURCES = {
  [mangadex.id]:     mangadex,
  [comixto.id]:      comixto,
  [mangakakalot.id]: mangakakalot,
  [mangafire.id]:    mangafire,
  [weebcentral.id]:  weebcentral,
  [mangaball.id]:    mangaball,
  [mangataro.id]:    mangataro,
  [mangadotnet.id]:  mangadotnet,
  [comikuro.id]:     comikuro,
};

function getSource(id) {
  const src = SOURCES[id];
  if (!src) {
    const available = Object.keys(SOURCES).join(', ');
    const err = new Error(`Unknown source "${id}". Available: ${available}`);
    err.statusCode = 400;
    throw err;
  }
  return src;
}

function listSources() {
  return Object.values(SOURCES).map(s => ({
    id:       s.id,
    label:    s.label,
    homepage: s.homepage,
  }));
}

module.exports = { getSource, listSources };
