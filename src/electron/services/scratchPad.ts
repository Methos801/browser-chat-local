/**
 * Scratch pad: the app's local file store. Holds uploaded files and
 * downloaded outputs. All file access in the app is scoped here.
 *
 * - Path: <appDataDir>/scratch/<safe-name>-<counter><ext>
 * - Size/type limits, collision auto-suffix, cleanup.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

export interface FileMeta {
  name: string;
  size: number;
  type: string;
  mtime: string;
  path: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB upload/download cap.

export class ScratchPad {
  private dir: string;

  constructor(appDataDir: string) {
    this.dir = join(appDataDir, "scratch");
    mkdirSync(this.dir, { recursive: true });
  }

  /** Ensure a directory exists. */
  private ensureDir() {
    mkdirSync(this.dir, { recursive: true });
  }

  list(): FileMeta[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => !f.startsWith("."))
      .map((f) => this.meta(f))
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  /** Store raw bytes under the scratch pad; return metadata. */
  save(name: string, mimeType: string, data: ArrayBuffer): FileMeta {
    this.ensureDir();
    const ext = extname(name) || `.${mimeType.split("/")[1] ?? "bin"}`;
    const safe = sanitize(name.replace(/\.[^.]+$/, ""));
    const fullBase = join(this.dir, `${safe}${ext}`);

    // Collision auto-suffix.
    let path = fullBase;
    let n = 1;
    while (existsSync(path)) {
      const stem = fullBase.replace(new RegExp(`${escapeRe(ext)}$`), "");
      path = `${stem}_${n}${ext}`;
      n++;
    }

    const buf = Buffer.from(data);
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(`file exceeds ${MAX_FILE_BYTES} byte limit (${name})`);
    }
    writeFileSyncAtomic(path, buf);

    return this.meta(basename(path));
  }

  /** Fetch a URL into the scratch pad; return the stored path. */
  async fetchToScratch(url: string): Promise<string> {
    this.ensureDir();
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`download ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) {
      throw new Error(`downloaded file exceeds ${MAX_FILE_BYTES} byte limit`);
    }
    const name = sanitize(basename(new URL(url).pathname) || "download");
    const ext = extname(name) || ".bin";
    const path = join(this.dir, `${name}${ext}`);
    writeFileSyncAtomic(path, buf);
    return path;
  }

  read(name: string): Buffer {
    const p = this.resolve(name);
    return readFileSync(p);
  }

  delete(name: string): void {
    const p = this.resolve(name);
    try {
      unlinkSync(p);
    } catch {
      /* ignore missing */
    }
  }

  /** Full, resolved path for a scratch file (rejects path traversal). */
  private resolve(name: string): string {
    const base = basename(name);
    const full = resolve(join(this.dir, base));
    if (!full.startsWith(resolve(this.dir))) {
      throw new Error(`unsafe file name: ${name}`);
    }
    return full;
  }

  private meta(file: string): FileMeta {
    const path = join(this.dir, file);
    const st = statSync(path);
    return {
      name: file,
      size: st.size,
      type: mimeType(file),
      mtime: st.mtime.toISOString(),
      path,
    };
  }

  /** Expire files larger than a cap (used by cleanup). */
  async cleanup(maxBytes = 512 * 1024 * 1024) {
    const all = this.list();
    let total = all.reduce((s, f) => s + f.size, 0);
    for (const f of all.sort((a, b) => a.mtime.localeCompare(b.mtime))) {
      if (total > maxBytes) {
        this.delete(f.name);
        total -= f.size;
      }
    }
  }
}

/* ------------------------------ helpers ------------------------------- */

function basename(p: string): string {
  return p.replace(/.*[\\/]/, "");
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "file";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mimeType(file: string): string {
  const ext = extname(file).toLowerCase();
  return (
    {
      ".pdf": "application/pdf",
      ".md": "text/markdown",
      ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".txt": "text/plain",
    }[ext] || "application/octet-stream"
  );
}

function writeFileSyncAtomic(path: string, buf: Buffer) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, path);
}
