import type { AppDb } from './db';
export interface SecretCodec { encrypt(value:string):Buffer; decrypt(value:Buffer):string; }
/** OS-encrypted durable storage, with an explicit session-only fallback. Never writes plaintext. */
export class SecretStore {
  private session = new Map<string,string>();
  constructor(private db:AppDb, private codec?:SecretCodec) {}
  get persistent():boolean { return !!this.codec; }
  get(key:string):string|undefined {
    if(this.session.has(key)) return this.session.get(key);
    const row=this.db.get<{value:string}>('SELECT value FROM meta WHERE key = ?',[`secret:${key}`]);
    if(!row || !this.codec) return undefined;
    try { return this.codec.decrypt(Buffer.from(row.value,'base64')); } catch { return undefined; }
  }
  set(key:string,value:string):void {
    this.session.set(key,value);
    if(this.codec) this.db.run('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)',[`secret:${key}`,this.codec.encrypt(value).toString('base64')]);
  }
  delete(key:string):void { this.session.delete(key);this.db.run('DELETE FROM meta WHERE key = ?',[`secret:${key}`]); }
}
