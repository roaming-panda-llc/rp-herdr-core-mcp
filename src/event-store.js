import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const MAX_STORE_BYTES = 32 * 1024 * 1024;
// One adapter process owns a state directory. Deployments must not share this
// directory between concurrently running adapters. Secrets never enter plaintext
// snapshots; the wrapping key is owner-only and must be backed up separately.
export class EventStore {
  constructor(directory) {
    if (!isAbsolute(directory)) throw new Error('Event state directory must be absolute');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('Event state directory must be owner-only');
    this.directory = directory;
    this.path = join(directory, 'events.enc');
    const keyPath = join(directory, 'events.key');
    try {
      const fd = openSync(keyPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    this.key = this.readPrivate(keyPath, 32);
    if (this.key.length !== 32) throw new Error('Invalid event storage key');
  }
  readPrivate(path, limit) {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid?.() || stat.size > limit) throw new Error('Unsafe event storage file');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { return readFileSync(fd); } finally { closeSync(fd); }
  }
  load() {
    let bytes;
    try { bytes = this.readPrivate(this.path, MAX_STORE_BYTES + 28); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (bytes.length < 28) throw new Error('Invalid event storage');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  }
  save(state) {
    const plain = Buffer.from(JSON.stringify(state));
    if (plain.length > MAX_STORE_BYTES) throw new Error('Event storage capacity exceeded');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const temp = join(this.directory, `events-${randomBytes(12).toString('hex')}.tmp`);
    try {
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, Buffer.concat([iv, cipher.getAuthTag(), ciphertext])); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, this.path);
      const directoryFd = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
