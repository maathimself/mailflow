import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { ZipArchive } from 'archiver';

// Reads a ZIP's entries through its central directory, which carries the final sizes
// even when the local headers defer them to data descriptors, and inflates each one.
function readZipEntries(zip) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = zip.subarray(dataStart, dataStart + compressedSize);
    entries[name] = method === 8 ? inflateRawSync(data).toString('utf8') : data.toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// Mirrors the attachments.zip route: buffers appended by name into a streamed ZIP.
describe('archiver ZipArchive', () => {
  it('streams appended buffers into a readable ZIP', async () => {
    const archive = new ZipArchive({ zlib: { level: 6 } });
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', chunk => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
      sink.on('end', resolve);
      archive.on('error', reject);
    });
    archive.pipe(sink);
    archive.append(Buffer.from('invoice body'), { name: 'invoice.pdf' });
    archive.append(Buffer.from('second copy'), { name: 'invoice (2).pdf' });
    archive.finalize();
    await done;

    expect(readZipEntries(Buffer.concat(chunks))).toEqual({
      'invoice.pdf': 'invoice body',
      'invoice (2).pdf': 'second copy',
    });
  });
});
