/**
 * Optimize Chapters — duplicate collapse. When several entries in a manga
 * folder resolve to the same standard name (two copies of "Vol 1"), optimize
 * keeps the larger file, deletes the smaller one, and carries read-state on
 * the deleted copy over to the survivor.
 *
 * Requires a working better-sqlite3 binding (run in the server's normal
 * runtime / Docker):
 *
 *   node test/optimizeDuplicates.test.js
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const express = require('express');
const AdmZip = require('adm-zip');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momotaro-optdup-'));
process.env.DB_PATH = path.join(tmp, 'app.db');
process.env.SCAN_ON_STARTUP = 'false';

const { getDb } = require('../src/db/database');
const { scanMangaDirectory } = require('../src/scanner/libraryScanner');
const optimizeRoutes = require('../src/routes/optimize');
const { chapterOrderSql } = require('../src/utils');

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// A CBZ whose size is driven by `padBytes` of incompressible page data.
function writeCbz(dest, padBytes) {
  const zip = new AdmZip();
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
  zip.addFile('001.png', png);
  if (padBytes) zip.addFile('002.jpg', require('crypto').randomBytes(padBytes));
  zip.writeZip(dest);
}

async function main() {
  const mangaDir = path.join(tmp, 'lib', 'Series');
  fs.mkdirSync(mangaDir, { recursive: true });
  writeCbz(path.join(mangaDir, 'Vol 1.cbz'), 0);                 // small, already at target name
  writeCbz(path.join(mangaDir, 'Series v01 [HQ].cbz'), 50_000);  // large duplicate
  writeCbz(path.join(mangaDir, 'Series v02.cbz'), 0);            // unique, just renamed
  writeCbz(path.join(mangaDir, 'Series v01 Omake.cbz'), 0);      // extra — smaller than Vol 1, must survive
  writeCbz(path.join(mangaDir, 'Vol 3 Bonus.cbz'), 0);           // two extras sharing a name: no dedupe,
  fs.mkdirSync(path.join(mangaDir, 'Vol 3 - Bonus'));            //   both left alone by the name-conflict skip
  fs.writeFileSync(path.join(mangaDir, 'Vol 3 - Bonus', '001.png'), Buffer.alloc(80_000));

  await scanMangaDirectory(mangaDir, 'Series', null);
  const db = getDb();
  const manga = db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Series');
  const idOf = (name) => db.prepare('SELECT id FROM chapters WHERE manga_id = ? AND folder_name = ?').get(manga.id, name).id;
  const smallId = idOf('Vol 1.cbz');
  const omakeId = idOf('Series v01 Omake.cbz');
  assert.equal(db.prepare('SELECT extra_label FROM chapters WHERE id = ?').get(omakeId).extra_label, 'Omake');
  db.prepare('INSERT INTO progress (user_id, manga_id, current_chapter_id, current_page, completed_chapters) VALUES (1, ?, ?, 0, ?)')
    .run(manga.id, smallId, JSON.stringify([smallId, omakeId]));

  const app = express();
  app.use(express.json());
  app.use('/api', optimizeRoutes);
  const srv = app.listen(0);
  await new Promise(r => srv.once('listening', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  try {
    const res = await fetch(`${base}/api/manga/${manga.id}/optimize`, { method: 'POST' });
    assert.equal(res.status, 202);

    let status;
    for (let i = 0; i < 100; i++) {
      status = (await (await fetch(`${base}/api/manga/${manga.id}/optimize/status`)).json()).data;
      if (status.status !== 'running') break;
      await wait(50);
    }
    assert.equal(status.status, 'done', `optimize finished: ${JSON.stringify(status)}`);
    const result = status.result;

    assert.equal(result.duplicatesRemoved.length, 1);
    assert.equal(result.duplicatesRemoved[0].name, 'Vol 1.cbz');
    assert.equal(result.duplicatesRemoved[0].keptName, 'Series v01 [HQ].cbz');
    assert.deepEqual(result.skipped.map(s => s.name).sort(), ['Vol 3 - Bonus', 'Vol 3 Bonus.cbz'],
      'only the two same-named extras hit the name-conflict skip');
    assert.equal(result.errors.length, 0);

    const files = fs.readdirSync(mangaDir).sort();
    assert.deepEqual(files, ['Vol 1 Omake.cbz', 'Vol 1.cbz', 'Vol 2.cbz', 'Vol 3 - Bonus', 'Vol 3 Bonus.cbz']);
    assert.ok(fs.statSync(path.join(mangaDir, 'Vol 1.cbz')).size > 50_000, 'kept the larger copy');

    const vol1 = idOf('Vol 1.cbz');
    const omake = db.prepare('SELECT id, extra_label FROM chapters WHERE manga_id = ? AND folder_name = ?').get(manga.id, 'Vol 1 Omake.cbz');
    assert.equal(omake.extra_label, 'Omake', 'label survives the standardizing rename');
    const p = db.prepare('SELECT current_chapter_id, completed_chapters FROM progress WHERE manga_id = ? AND user_id = 1').get(manga.id);
    assert.equal(p.current_chapter_id, vol1, 'current chapter follows the survivor');
    assert.deepEqual(JSON.parse(p.completed_chapters).sort(), [vol1, omake.id].sort(),
      'completed state follows the survivor and the renamed omake separately');

    // Reading order: each extra sorts right after the regular entry sharing its
    // number (by name alone "Vol 1 Omake.cbz" < "Vol 1.cbz", space before dot).
    const ordered = db.prepare(`SELECT folder_name FROM chapters WHERE manga_id = ? ORDER BY ${chapterOrderSql()}`)
      .all(manga.id).map(r => r.folder_name);
    assert.deepEqual(ordered, ['Vol 1.cbz', 'Vol 1 Omake.cbz', 'Vol 2.cbz', 'Vol 3 - Bonus', 'Vol 3 Bonus.cbz']);

    // ── Series name inside the file names, folder named differently ──────────
    const gDir = path.join(tmp, 'lib', 'Kingdom Gaiden (2015)');
    fs.mkdirSync(gDir, { recursive: true });
    writeCbz(path.join(gDir, 'Kingdom Gaiden c1.cbz'), 0);
    writeCbz(path.join(gDir, 'Kingdom Gaiden c1 [HQ].cbz'), 20_000);  // "Gaiden" is the series name → real duplicate
    writeCbz(path.join(gDir, 'Kingdom Gaiden c2.cbz'), 0);
    writeCbz(path.join(gDir, 'Kingdom Gaiden c2 Omake.cbz'), 0);
    writeCbz(path.join(gDir, 'Kingdom Gaiden v01 Yonkoma.cbz'), 0);
    await scanMangaDirectory(gDir, 'Kingdom Gaiden (2015)', null);
    const g = db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Kingdom Gaiden (2015)');
    const gLabels = Object.fromEntries(db.prepare('SELECT folder_name, extra_label FROM chapters WHERE manga_id = ?')
      .all(g.id).map(r => [r.folder_name, r.extra_label]));
    assert.deepEqual(gLabels, {
      'Kingdom Gaiden c1.cbz': null, 'Kingdom Gaiden c1 [HQ].cbz': null, 'Kingdom Gaiden c2.cbz': null,
      'Kingdom Gaiden c2 Omake.cbz': 'Omake', 'Kingdom Gaiden v01 Yonkoma.cbz': '4-Koma',
    }, 'shared title prefix is series naming; only real extras are labelled');

    assert.equal((await fetch(`${base}/api/manga/${g.id}/optimize`, { method: 'POST' })).status, 202);
    let gStatus;
    for (let i = 0; i < 100; i++) {
      gStatus = (await (await fetch(`${base}/api/manga/${g.id}/optimize/status`)).json()).data;
      if (gStatus.status !== 'running') break;
      await wait(50);
    }
    assert.equal(gStatus.status, 'done');
    // Folder name minus "(2015)" matches the series name in the files, so
    // "Gaiden" there is series naming: the c1 pair is a real duplicate.
    assert.deepEqual(gStatus.result.duplicatesRemoved.map(d => [d.name, d.keptName]),
      [['Kingdom Gaiden c1.cbz', 'Kingdom Gaiden c1 [HQ].cbz']]);
    assert.deepEqual(fs.readdirSync(gDir).sort(), ['Ch 1.cbz', 'Ch 2 Omake.cbz', 'Ch 2.cbz', 'Vol 1 4-Koma.cbz']);
    const gAfter = Object.fromEntries(db.prepare('SELECT folder_name, extra_label FROM chapters WHERE manga_id = ?')
      .all(g.id).map(r => [r.folder_name, r.extra_label]));
    assert.deepEqual(gAfter, { 'Ch 1.cbz': null, 'Ch 2.cbz': null, 'Ch 2 Omake.cbz': 'Omake', 'Vol 1 4-Koma.cbz': '4-Koma' },
      'labels are the same before and after the rename');
    const yonkoma = db.prepare('SELECT number, volume, extra_label FROM chapters WHERE manga_id = ? AND folder_name = ?')
      .get(g.id, 'Vol 1 4-Koma.cbz');
    assert.deepEqual({ ...yonkoma }, { number: null, volume: 1, extra_label: '4-Koma' },
      '"Vol 1 4-Koma" keeps volume 1 — the 4 is not read as a chapter');

    // ── A delete fails in a 3-copy group ─────────────────────────────────────
    // Largest copy kept; one smaller copy deleted; the other's delete fails.
    // Survivor + failed copy hit the name-conflict skip and keep their names,
    // so read-state on the deleted copy must land on the survivor's (unchanged) id.
    const fDir = path.join(tmp, 'lib', 'Partial');
    fs.mkdirSync(fDir, { recursive: true });
    writeCbz(path.join(fDir, 'Vol 5.cbz'), 30_000);           // kept
    writeCbz(path.join(fDir, 'Partial v05 a.cbz'), 10_000);   // delete fails
    writeCbz(path.join(fDir, 'Partial v05 b.cbz'), 0);        // deleted
    await scanMangaDirectory(fDir, 'Partial', null);
    const f = db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Partial');
    const fId = (name) => db.prepare('SELECT id FROM chapters WHERE manga_id = ? AND folder_name = ?').get(f.id, name).id;
    const keptId = fId('Vol 5.cbz');
    const failedId = fId('Partial v05 a.cbz');
    const deletedId = fId('Partial v05 b.cbz');
    db.prepare('INSERT INTO progress (user_id, manga_id, current_chapter_id, current_page, completed_chapters) VALUES (1, ?, ?, 0, ?)')
      .run(f.id, deletedId, JSON.stringify([deletedId, failedId]));

    const realUnlink = fs.unlinkSync;
    fs.unlinkSync = (p, ...rest) => {
      if (path.basename(String(p)) === 'Partial v05 a.cbz') {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return realUnlink.call(fs, p, ...rest);
    };
    let fStatus;
    try {
      assert.equal((await fetch(`${base}/api/manga/${f.id}/optimize`, { method: 'POST' })).status, 202);
      for (let i = 0; i < 100; i++) {
        fStatus = (await (await fetch(`${base}/api/manga/${f.id}/optimize/status`)).json()).data;
        if (fStatus.status !== 'running') break;
        await wait(50);
      }
    } finally {
      fs.unlinkSync = realUnlink;
    }
    assert.equal(fStatus.status, 'done');
    assert.deepEqual(fStatus.result.duplicatesRemoved.map(d => d.name), ['Partial v05 b.cbz']);
    assert.deepEqual(fStatus.result.errors.map(e => e.name), ['Partial v05 a.cbz']);
    assert.deepEqual(fStatus.result.skipped.map(s => s.name).sort(), ['Partial v05 a.cbz', 'Vol 5.cbz']);
    assert.deepEqual(fs.readdirSync(fDir).sort(), ['Partial v05 a.cbz', 'Vol 5.cbz']);

    assert.equal(fId('Vol 5.cbz'), keptId, 'survivor kept its row');
    const fp = db.prepare('SELECT current_chapter_id, completed_chapters FROM progress WHERE manga_id = ? AND user_id = 1').get(f.id);
    assert.equal(fp.current_chapter_id, keptId, 'current chapter moved from the deleted copy to the survivor');
    assert.deepEqual(JSON.parse(fp.completed_chapters).sort(), [keptId, failedId].sort(),
      'deleted copy\'s completed state moved to the survivor; the failed copy keeps its own');

    // ── Keyword suppressed as series naming → file left exactly as it is ─────
    // "Side Story" sits before the number on 3 of 5 entries, so the majority
    // rule drops the label. Renaming "Side Story 2" to a bare "Ch 2.cbz" would
    // make it look like the main chapter 2 (and deletable as its duplicate),
    // so those entries must keep their names — across repeated runs.
    async function runOptimize(mangaId) {
      assert.equal((await fetch(`${base}/api/manga/${mangaId}/optimize`, { method: 'POST' })).status, 202);
      let st;
      for (let i = 0; i < 100; i++) {
        st = (await (await fetch(`${base}/api/manga/${mangaId}/optimize/status`)).json()).data;
        if (st.status !== 'running') break;
        await wait(50);
      }
      assert.equal(st.status, 'done');
      return st.result;
    }
    const sDir = path.join(tmp, 'lib', 'Sides');
    fs.mkdirSync(sDir, { recursive: true });
    for (const n of ['Side Story 1.cbz', 'Side Story 2.cbz', 'Side Story 3.cbz', 'Ch 1.cbz']) writeCbz(path.join(sDir, n), 0);
    writeCbz(path.join(sDir, 'Sides c02 [HQ].cbz'), 40_000);   // main chapter 2, larger than Side Story 2
    await scanMangaDirectory(sDir, 'Sides', null);
    const s = db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Sides');

    for (let run = 1; run <= 2; run++) {
      const r = await runOptimize(s.id);
      assert.equal(r.duplicatesRemoved.length, 0, `run ${run}: nothing deleted`);
      assert.equal(r.errors.length, 0);
      assert.deepEqual(
        r.skipped.filter(x => /series title/.test(x.reason)).map(x => x.name).sort(),
        ['Side Story 1.cbz', 'Side Story 2.cbz', 'Side Story 3.cbz'], `run ${run}: side stories left unchanged`);
      assert.deepEqual(fs.readdirSync(sDir).sort(),
        ['Ch 1.cbz', 'Ch 2.cbz', 'Side Story 1.cbz', 'Side Story 2.cbz', 'Side Story 3.cbz'],
        `run ${run}: main chapters standardized, side stories keep their names`);
    }

    // ── Never overwrite an existing file ─────────────────────────────────────
    // An unnumbered folder keeps its base name, so it can target a .cbz that
    // already exists; writeZip would silently replace it. (An unnumbered .zip
    // never reaches the rename — it's skipped as unparseable — but the .cbz
    // next to it must survive either way.)
    const oDir = path.join(tmp, 'lib', 'Overwrite');
    fs.mkdirSync(path.join(oDir, 'Artbook'), { recursive: true });
    fs.writeFileSync(path.join(oDir, 'Artbook', '001.png'), Buffer.alloc(10));
    const bigZip = new AdmZip();
    for (let i = 1; i <= 40; i++) bigZip.addFile(`p${String(i).padStart(3, '0')}.png`, Buffer.alloc(10));
    bigZip.writeZip(path.join(oDir, 'Artbook.cbz'));
    fs.copyFileSync(path.join(oDir, 'Artbook.cbz'), path.join(oDir, 'Pinups.cbz'));
    writeCbz(path.join(oDir, 'Pinups.zip'), 0);
    writeCbz(path.join(oDir, 'ch 3.cbz'), 0);                   // case-only rename must still work
    await scanMangaDirectory(oDir, 'Overwrite', null);
    const o = db.prepare('SELECT id FROM manga WHERE folder_name = ?').get('Overwrite');

    const or = await runOptimize(o.id);
    assert.deepEqual(or.errors, []);
    assert.deepEqual(or.skipped.filter(x => /already exists/.test(x.reason)).map(x => x.name), ['Artbook']);
    assert.equal(new AdmZip(path.join(oDir, 'Artbook.cbz')).getEntries().length, 40, 'Artbook.cbz not overwritten by the folder');
    assert.equal(new AdmZip(path.join(oDir, 'Pinups.cbz')).getEntries().length, 40, 'Pinups.cbz untouched');
    assert.ok(fs.existsSync(path.join(oDir, 'Artbook', '001.png')), 'folder left in place');
    assert.deepEqual(fs.readdirSync(oDir).sort(), ['Artbook', 'Artbook.cbz', 'Ch 3.cbz', 'Pinups.cbz', 'Pinups.zip']);

    console.log('optimizeDuplicates: all assertions passed');
  } finally {
    srv.close();
  }
}

main().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
