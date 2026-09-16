// Run with: node --test src/utils/attachmentRisk.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttachmentRisk } from './attachmentRisk.js';

describe('classifyAttachmentRisk', () => {
  it('blocks executables, scripts, installers, images and shortcuts by extension', () => {
    for (const f of ['setup.exe', 'run.bat', 'thing.js', 'x.lnk', 'disk.iso', 'app.msi', 'macro.hta', 'lib.dll']) {
      assert.equal(classifyAttachmentRisk(f, 'application/octet-stream').level, 'block', f);
    }
  });

  it('warns on macro-enabled Office and web pages', () => {
    assert.equal(classifyAttachmentRisk('report.docm').level, 'warn');
    assert.equal(classifyAttachmentRisk('login.html', 'text/html').level, 'warn');
    assert.equal(classifyAttachmentRisk('logo.svg', 'image/svg+xml').level, 'warn');
  });

  it('notices archives, which cannot be inspected', () => {
    assert.equal(classifyAttachmentRisk('google.com!example.com!1.zip', 'application/zip').level, 'notice');
    assert.equal(classifyAttachmentRisk('backup.tar.gz').level, 'notice');
  });

  it('leaves ordinary documents alone', () => {
    for (const f of ['invoice.pdf', 'photo.jpg', 'notes.docx', 'sheet.xlsx', 'readme.txt', 'noext']) {
      assert.equal(classifyAttachmentRisk(f).level, 'ok', f);
    }
  });

  it('classifies by the real extension and exposes a disguising double extension', () => {
    const r = classifyAttachmentRisk('invoice.pdf.exe', 'application/pdf');
    assert.equal(r.level, 'block');
    assert.equal(r.doubleExt, 'pdf.exe');
    // A legitimate compound extension is not a disguise.
    assert.equal(classifyAttachmentRisk('backup.tar.gz').doubleExt, null);
    assert.equal(classifyAttachmentRisk('report.docm').doubleExt, null);
  });

  it('does not mistake a dotted date or version number for a hidden extension', () => {
    // Only a real document or media type counts as the fake half of a disguise.
    const statement = classifyAttachmentRisk('Statement 09.15.2026.html', 'text/html');
    assert.equal(statement.level, 'warn');
    assert.equal(statement.doubleExt, null);
    const workbook = classifyAttachmentRisk('Rink P&L v2.1.xlsm');
    assert.equal(workbook.level, 'warn');
    assert.equal(workbook.doubleExt, null);
    assert.equal(classifyAttachmentRisk('holiday.jpg.scr').doubleExt, 'jpg.scr');
  });

  it('falls back to the declared MIME type when the extension is missing', () => {
    assert.equal(classifyAttachmentRisk('payload', 'application/x-msdownload').level, 'block');
    assert.equal(classifyAttachmentRisk('page', 'text/html').level, 'warn');
  });

  it('is case-insensitive', () => {
    assert.equal(classifyAttachmentRisk('SETUP.EXE').level, 'block');
  });
});
