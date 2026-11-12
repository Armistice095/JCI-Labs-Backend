/** Stockage Supabase simulé en mémoire (upload, download, URL signée, suppression). */
export function fakeStorage() {
  const buckets = new Map<string, Map<string, { data: Buffer; contentType?: string }>>();
  const bucket = (n: string) => buckets.get(n) ?? buckets.set(n, new Map()).get(n)!;
  const from = (name: string) => ({
    upload: async (path: string, data: Buffer | Uint8Array, opts?: { contentType?: string }) => {
      bucket(name).set(path, { data: Buffer.from(data), contentType: opts?.contentType });
      return { data: { path }, error: null };
    },
    download: async (path: string) => {
      const f = bucket(name).get(path);
      return f ? { data: new Blob([new Uint8Array(f.data)]), error: null } : { data: null, error: { message: 'Object not found' } };
    },
    createSignedUrl: async (path: string, _ttl: number, opts?: { download?: string }) =>
      bucket(name).has(path)
        ? { data: { signedUrl: `http://storage.test/${name}/${path}?token=${Math.random().toString(16).slice(2)}&download=${encodeURIComponent(opts?.download ?? '')}` }, error: null }
        : { data: null, error: { message: 'Object not found' } },
    remove: async (paths: string[]) => { paths.forEach((p) => bucket(name).delete(p)); return { data: [], error: null }; },
  });
  return { buckets, bucket, client: { storage: { from } } };
}
