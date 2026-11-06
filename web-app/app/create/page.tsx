'use client';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { browserSb } from '@/lib/supabaseBrowser';

export default function CreatePage() {
  const sb = browserSb();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => { if (!data.session) router.replace('/login'); else setChecked(true); });
  }, [sb, router]);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const u = URL.createObjectURL(file);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { setErr('Please choose an image.'); return; }
    if (f.size > 15 * 1024 * 1024) { setErr('That image is too large (max 15MB).'); return; }
    setErr(null);
    setFile(f);
  }

  function aspectOf(f: File): Promise<string> {
    return new Promise((resolve) => {
      const img = new Image();
      const u = URL.createObjectURL(f);
      img.onload = () => { resolve((img.naturalWidth / Math.max(1, img.naturalHeight)).toFixed(4)); URL.revokeObjectURL(u); };
      img.onerror = () => { resolve('1'); URL.revokeObjectURL(u); };
      img.src = u;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true); setErr(null);
    try {
      const { data: { session } } = await sb.auth.getSession();
      if (!session) { router.replace('/login'); return; }
      const uid = session.user.id;
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const up = await sb.storage.from('posts').upload(path, file, { contentType: file.type, upsert: false });
      if (up.error) throw up.error;
      const publicUrl = sb.storage.from('posts').getPublicUrl(path).data.publicUrl;
      const ratio = await aspectOf(file);
      const { data: np, error } = await sb.from('posts')
        .insert({ user_id: uid, type: 'image', media_url: publicUrl, caption: caption.trim(), is_public: true, aspect_ratio: ratio })
        .select('id').single();
      if (error) throw error;
      router.replace(`/p/${(np as any).id}`);
    } catch (e: any) {
      setErr(e?.message || 'Could not post. Please try again.');
      setBusy(false);
    }
  }

  if (!checked) return <main className="create"><div className="feed-empty">Loading…</div></main>;

  return (
    <main className="create">
      <h1>Create a post</h1>
      <form onSubmit={submit}>
        {preview ? (
          <div className="cprev">
            <img src={preview} alt="Preview" />
            <button type="button" className="icon-btn rm" onClick={() => { setFile(null); if (fileRef.current) fileRef.current.value = ''; }} aria-label="Remove photo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
        ) : (
          <label className="cpick">
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pick} />
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="9" r="1.6" /><path d="m4 18 5-5 4 3 3-3 4 4" /></svg>
            <b>Choose a photo</b><span>JPG, PNG or WebP · up to 15MB</span>
          </label>
        )}
        <textarea className="ccap" value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Write a caption…" maxLength={2200} />
        {err ? <div className="authmsg err">{err}</div> : null}
        <button className="btn btn-primary submit" type="submit" disabled={!file || busy}>{busy ? 'Posting…' : 'Share'}</button>
        <p className="cnote">Posts publicly to your profile. Video &amp; audio upload coming soon.</p>
      </form>
    </main>
  );
}
