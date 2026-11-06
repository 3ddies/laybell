'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function SearchBox() {
  const router = useRouter();
  const [q, setQ] = useState('');
  return (
    <form
      className="searchbox"
      onSubmit={(e) => { e.preventDefault(); const t = q.trim(); if (t) router.push('/search?q=' + encodeURIComponent(t)); }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3-3"/></svg>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Laybell" aria-label="Search" />
    </form>
  );
}
