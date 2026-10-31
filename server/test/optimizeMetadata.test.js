/**
 * Optimize Chapters — metadata files inside chapter folders. Packing a folder
 * into a CBZ used to keep only the images and delete the folder, destroying
 * ComicInfo.xml / *.json sidecars. They're now moved to the series folder
 * first (per-chapter variants under metadata/<chapter>/), and moved back if
 * packing fails.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):
 *
 *   node test/optimizeMetadata.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const AdmZip = require('adm-zip');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-optmeta-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb } = require('../src/db/database');
const { scanMangaDirectory } = require('../src/scanner/libraryScanner');
const { findLocalMetadata } = require('../src/scanner/localMetadata');
const optimizeRoutes = require('../src/routes/optimize');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

// A chapter folder: one page (padded to `padBytes` so duplicate sizes differ)
// plus the given metadata files.
function writeChapterFolder(dir, files = {}, padBytes = 0) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '001.png'), padBytes ? Buffer.concat([PNG, Buffer.alloc(padBytes)]) : PNG);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
}

const read = (p) => fs.readFileSync(p, 'utf8');
const comicInfo = (n) => `<?xml version="1.0"?><ComicInfo><Series>Meta</Series><Number>${n}</Number></ComicInfo>`;
const INFO_JSON = JSON.stringify({ title: 'Meta Title', description: 'Series blurb' });

async function main() {
  const db = getDb();
  const app = express();
  app.use(express.json());
  app.use('/api', optimizeRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  async function runOptimize(mangaId) {
    assert.equal((await fetch(`${base}/api/manga/${mangaId}/optimize`, { method: 'POST' })).status, 202);
    let st;
    for (let i = 0; i < 100; i++) {
      st = (await (await fetch(`${base}/api/manga/${mangaId}/optimize/status`)).json()).data;
      if (st.status !== 'running') break;
      await wait(50);
    }
    assert.equal(st.status, 'done', JSON.stringify(st));
    return st.result;
  }

  try {
    // ── Moves, clashes and duplicate folders ────────────────────────────────
    const dir = path.join(tmp, 'lib', 'Meta');
    writeChapterFolder(path.join(dir, 'Meta c01'), { 'ComicInfo.xml': comicInfo(1), 'info.json': INFO_JSON });
    writeChapterFolder(path.join(dir, 'Meta c02'), { 'ComicInfo.xml': comicInfo(2), 'info.json': INFO_JSON });  // info.json identical
    writeChapterFolder(path.join(dir, 'Meta c03'), { 'ComicInfo.xml': comicInfo(1) });                         // identical to c01's
    writeChapterFolder(path.join(dir, 'Meta c04'), {}, 5_000);                                                 // kept
    writeChapterFolder(path.join(dir, 'Meta c04 alt'), { 'ComicInfo.xml': comicInfo('4 alt') });               // smaller duplicate
    await scanMangaDirectory(dir, 'Meta', null);
    const m = db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Meta');

    const r = await runOptimize(m.id);
    assert.deepEqual(r.errors, []);
    assert.equal(r.converted, 4);
    assert.deepEqual(r.duplicatesRemoved.map(d => d.name), ['Meta c04 alt']);

    assert.deepEqual(fs.readdirSync(dir).sort(),
      ['Ch 1.cbz', 'Ch 2.cbz', 'Ch 3.cbz', 'Ch 4.cbz', 'ComicInfo.xml', 'info.json', 'metadata']);
    // First copy of each name becomes the series-level file …
    assert.equal(read(path.join(dir, 'ComicInfo.xml')), comicInfo(1));
    assert.equal(read(path.join(dir, 'info.json')), INFO_JSON);
    // … differing per-chapter copies keep their names under metadata/<chapter>/,
    // identical copies aren't duplicated anywhere.
    assert.equal(read(path.join(dir, 'metadata', 'Ch 2', 'ComicInfo.xml')), comicInfo(2));
    assert.equal(read(path.join(dir, 'metadata', 'Meta c04 alt', 'ComicInfo.xml')), comicInfo('4 alt'));
    assert.deepEqual(fs.readdirSync(path.join(dir, 'metadata')).sort(), ['Ch 2', 'Meta c04 alt']);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'metadata', 'Ch 2')), ['ComicInfo.xml']);

    assert.deepEqual(r.metadataMoved.map(x => [x.name, x.movedTo]).sort(), [
      ['Meta c01/ComicInfo.xml', 'ComicInfo.xml'],
      ['Meta c01/info.json', 'info.json'],
      ['Meta c02/ComicInfo.xml', 'metadata/Ch 2/ComicInfo.xml'],
      ['Meta c04 alt/ComicInfo.xml', 'metadata/Meta c04 alt/ComicInfo.xml'],
    ].sort());

    // The packed CBZs hold only the pages.
    assert.deepEqual(new AdmZip(path.join(dir, 'Ch 2.cbz')).getEntries().map(e => e.entryName), ['001.png']);
    // metadata/ isn't a chapter, and the series metadata still resolves.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chapters WHERE manga_id = ?').get(m.id).n, 4);
    assert.equal(findLocalMetadata(dir)?.title, 'Meta Title');

    // ── Packing fails → metadata moved back, folder untouched ───────────────
    const fDir = path.join(tmp, 'lib', 'Fail');
    writeChapterFolder(path.join(fDir, 'Ch 1'));
    writeChapterFolder(path.join(fDir, 'Fail c02'), { 'ComicInfo.xml': comicInfo(2) });
    fs.writeFileSync(path.join(fDir, 'ComicInfo.xml'), comicInfo('series'));   // forces the archive-dir path
    await scanMangaDirectory(fDir, 'Fail', null);
    const f = db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Fail');

    // Fail while packing Fail c02 — after its metadata has been moved out.
    // (adm-zip builds its methods per instance, so patch the page read instead.)
    const realRead = fs.readFileSync;
    const failingPage = path.join(fDir, 'Fail c02', '001.png');
    fs.readFileSync = function (p, ...rest) {
      if (String(p) === failingPage) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
      return realRead.call(fs, p, ...rest);
    };
    let fr;
    try { fr = await runOptimize(f.id); } finally { fs.readFileSync = realRead; }

    assert.deepEqual(fr.errors.map(e => e.name), ['Fail c02']);
    assert.deepEqual(fr.metadataMoved, [], 'a failed conversion reports no moves');
    assert.equal(read(path.join(fDir, 'Fail c02', 'ComicInfo.xml')), comicInfo(2), 'metadata moved back');
    assert.deepEqual(fs.readdirSync(path.join(fDir, 'Fail c02')).sort(), ['001.png', 'ComicInfo.xml']);
    assert.ok(!fs.existsSync(path.join(fDir, 'metadata')), 'empty archive dir removed');
    assert.ok(!fs.existsSync(path.join(fDir, 'Ch 2.cbz')));
    assert.equal(read(path.join(fDir, 'ComicInfo.xml')), comicInfo('series'), 'series-level file untouched');

    const setup = async (folder) => {
      const d = path.join(tmp, 'lib', folder);
      return { d, id: async () => {
        await scanMangaDirectory(d, folder, null);
        return db.prepare('SELECT id FROM manga WHERE folder_name = ?').get(folder).id;
      } };
    };
    const writeCbz = (p, pages, padBytes = 0) => {
      const z = new AdmZip();
      for (let i = 1; i <= pages; i++) z.addFile(`${String(i).padStart(3, '0')}.png`, Buffer.concat([PNG, Buffer.alloc(padBytes)]));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      z.writeZip(p);
    };

    // ── 2. Deleted duplicate held the only metadata → promoted afterwards ───
    {
      const { d, id } = await setup('Promo');
      writeCbz(path.join(d, 'Ch 1.cbz'), 3, 5_000);                         // kept
      writeChapterFolder(path.join(d, 'Promo c01'), { 'info.json': INFO_JSON }); // smaller → deleted
      const pr = await runOptimize(await id());
      assert.deepEqual(pr.duplicatesRemoved.map(x => x.name), ['Promo c01']);
      assert.deepEqual(fs.readdirSync(d).sort(), ['Ch 1.cbz', 'info.json'], 'promoted; empty archive dir removed');
      assert.deepEqual(pr.metadataMoved, [{ name: 'Promo c01/info.json', movedTo: 'info.json' }], 'log shows the final place');
      assert.equal(findLocalMetadata(d)?.title, 'Meta Title', 'series metadata still resolves');
    }

    // ── 3. Write fails mid-way → no truncated .cbz, folder intact; stale
    //       .partial files from an earlier crash are cleared ────────────────
    {
      const { d, id } = await setup('Partial');
      writeChapterFolder(path.join(d, 'Ch 1'), { 'ComicInfo.xml': comicInfo(1) });
      fs.writeFileSync(path.join(d, 'Ch 7.cbz.partial'), 'leftover from a crash');
      const mid = await id();
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = function (p, data, ...rest) {
        if (String(p).endsWith('.cbz.partial')) {
          realWrite.call(fs, p, data.subarray(0, 10));                       // half-written …
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        return realWrite.call(fs, p, data, ...rest);
      };
      let pr;
      try { pr = await runOptimize(mid); } finally { fs.writeFileSync = realWrite; }
      assert.deepEqual(pr.errors.map(e => e.name), ['Ch 1']);
      assert.deepEqual(fs.readdirSync(d).sort(), ['Ch 1'], 'no .cbz, no .partial, stale partial removed');
      assert.deepEqual(fs.readdirSync(path.join(d, 'Ch 1')).sort(), ['001.png', 'ComicInfo.xml'], 'metadata moved back');
    }

    // ── 4. Folder delete fails after a successful pack → reported, not lost ─
    {
      const { d, id } = await setup('Locked');
      writeChapterFolder(path.join(d, 'Locked c01'), { 'ComicInfo.xml': comicInfo(1) });
      const mid = await id();
      const folder = path.join(d, 'Locked c01');
      const realRm = fs.rmSync;
      fs.rmSync = function (p, ...rest) {
        if (String(p) === folder) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        return realRm.call(fs, p, ...rest);
      };
      let pr;
      try { pr = await runOptimize(mid); } finally { fs.rmSync = realRm; }
      assert.equal(pr.converted, 1);
      assert.deepEqual(pr.metadataMoved, [{ name: 'Locked c01/ComicInfo.xml', movedTo: 'ComicInfo.xml' }]);
      assert.equal(pr.errors.length, 1);
      assert.match(pr.errors[0].error, /^Packed to "Ch 1\.cbz", but the original folder couldn't be removed: EBUSY/);
      assert.ok(fs.existsSync(path.join(d, 'Ch 1.cbz')));
      assert.equal(read(path.join(d, 'ComicInfo.xml')), comicInfo(1));
    }

    // ── 5. A real chapter folder named "metadata" → archive uses _metadata ──
    {
      const { d, id } = await setup('Named');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'ComicInfo.xml'), comicInfo('series'));
      writeChapterFolder(path.join(d, 'metadata'));                              // a chapter, not an archive
      writeChapterFolder(path.join(d, 'Named c02'), { 'ComicInfo.xml': comicInfo(2) });
      const pr = await runOptimize(await id());
      assert.deepEqual(pr.errors, []);
      assert.deepEqual(pr.metadataMoved, [{ name: 'Named c02/ComicInfo.xml', movedTo: '_metadata/Ch 2/ComicInfo.xml' }]);
      assert.deepEqual(fs.readdirSync(d).sort(), ['Ch 2.cbz', 'ComicInfo.xml', '_metadata', 'metadata.cbz']);
      assert.equal(read(path.join(d, '_metadata', 'Ch 2', 'ComicInfo.xml')), comicInfo(2));

      // Next run: "metadata" is free again (that chapter is now metadata.cbz),
      // but the archive must stay in the existing "_metadata" — not split.
      writeChapterFolder(path.join(d, 'Named c03'), { 'ComicInfo.xml': comicInfo(3) });
      await scanMangaDirectory(d, 'Named', null);
      const pr2 = await runOptimize(db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Named').id);
      assert.deepEqual(pr2.metadataMoved, [{ name: 'Named c03/ComicInfo.xml', movedTo: '_metadata/Ch 3/ComicInfo.xml' }]);
      assert.deepEqual(fs.readdirSync(d).sort(), ['Ch 2.cbz', 'Ch 3.cbz', 'ComicInfo.xml', '_metadata', 'metadata.cbz']);
    }

    // ── Promotion uses the ORIGINAL name, not a numbered archive name ───────
    {
      const { d, id } = await setup('Renum');
      writeCbz(path.join(d, 'Ch 1.cbz'), 3, 5_000);                                   // kept
      writeChapterFolder(path.join(d, 'Renum c01'), { 'info.json': INFO_JSON });       // smaller → deleted
      // An earlier run already archived a different info.json for this folder
      // name, so this run's copy is archived as "info (2).json".
      fs.mkdirSync(path.join(d, 'metadata', 'Renum c01'), { recursive: true });
      fs.writeFileSync(path.join(d, 'metadata', 'Renum c01', 'info.json'), '{"title":"Old"}');
      const pr = await runOptimize(await id());
      assert.deepEqual(pr.metadataMoved, [{ name: 'Renum c01/info.json', movedTo: 'info.json' }]);
      assert.deepEqual(fs.readdirSync(d).sort(), ['Ch 1.cbz', 'info.json', 'metadata']);
      assert.equal(read(path.join(d, 'info.json')), INFO_JSON);
      assert.deepEqual(fs.readdirSync(path.join(d, 'metadata', 'Renum c01')), ['info.json'], 'older archived copy untouched');
      assert.equal(findLocalMetadata(d)?.title, 'Meta Title');
    }

    // ── 6. Case-variant name counts as taken on every platform ──────────────
    {
      const { d, id } = await setup('Cased');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'ComicInfo.xml'), comicInfo('series'));
      writeChapterFolder(path.join(d, 'Cased c01'), { 'comicinfo.xml': comicInfo(1) });
      const pr = await runOptimize(await id());
      assert.deepEqual(pr.metadataMoved, [{ name: 'Cased c01/comicinfo.xml', movedTo: 'metadata/Ch 1/comicinfo.xml' }]);
      assert.deepEqual(fs.readdirSync(d).sort(), ['Ch 1.cbz', 'ComicInfo.xml', 'metadata']);
      assert.equal(read(path.join(d, 'ComicInfo.xml')), comicInfo('series'), 'series-level file untouched');
    }

    console.log('optimizeMetadata: all assertions passed');
  } finally {
    srv.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
