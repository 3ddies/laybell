import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { cache } from 'react';
import { sb } from '@/lib/supabase';
import { formatCount, gradientFor, initial, timeAgo } from '@/lib/format';
import { OpenCTA, NotFoundState } from '../../components';
import PostInteractions from './PostInteractions';

export const revalidate = 60;

type Post = {
  id: string; user_id: string; type: string | null; caption: string | null;
  media_url: string | null; thumbnail_url: string | null; cover_url: string | null;
  like_count: number | null; comment_count: number | null; view_count: number | null;
  stream_count: number | null; mature: boolean | null; created_at: string;
};
type Author = { username: string; display_name: string | null; avatar_url: string | null; hidden: boolean | null };

const getPost = cache(async (id: string) => {
  const db = sb();
  // RLS already drops private posts and posts of hidden authors; we also filter
  // archived_at and mature ourselves (neither is policy-enforced for the web).
  const { data: post } = await db.from('posts')
    .select('id,user_id,type,caption,media_url,thumbnail_url,cover_url,like_count,comment_count,view_count,stream_count,mature,created_at')
    .eq('id', id).is('archived_at', null).maybeSingle();
  if (!post) return { post: null as Post | null, author: null as Author | null };
  const { data: author } = await db.from('profiles')
    .select('username,display_name,avatar_url,hidden').eq('id', (post as Post).user_id).maybeSingle();
  return { post: post as Post, author: (author as Author) ?? null };
});

const AUDIO = new Set(['audio', 'podcast', 'audiobook']);
const VIDEO = new Set(['video', 'reel']);

export async function generateMetadata({ params }: { params: { id: string } }): Promise<Metadata> {
  const { post, author } = await getPost(params.id);
  if (!post || !author || author.hidden || post.mature) return { title: 'Post not found' };
  const name = author.display_name || author.username;
  const desc = post.caption?.slice(0, 160) || `A post by ${name} on Laybell`;
  const img = post.cover_url || post.thumbnail_url || (post.type === 'image' ? post.media_url : null);
  return {
    title: `${name} on Laybell`,
    description: desc,
    openGraph: { title: `${name} on Laybell`, description: desc, images: img ? [{ url: img }] : [] },
    twitter: { card: img ? 'summary_large_image' : 'summary', title: `${name} on Laybell`, description: desc, images: img ? [img] : [] },
  };
}

export default async function PostPage({ params }: { params: { id: string } }) {
  const { post, author } = await getPost(params.id);
  if (!post) return <NotFoundState title="Post not found" body="This post was removed, made private, or doesn’t exist." />;
  if (!author || author.hidden || post.mature) return <NotFoundState title="Post unavailable" body="This post can’t be shown on the web." />;

  const name = author.display_name || author.username;
  const isAudio = post.type ? AUDIO.has(post.type) : false;
  const isVideo = post.type ? VIDEO.has(post.type) : false;
  const img = post.cover_url || post.thumbnail_url || post.media_url;

  return (
    <main className="postpage">
      <div className="wrap">
        <div className="postwrap">
          <div className="postmedia" style={!img || isAudio ? { background: gradientFor(post.id) } : undefined}>
            {isAudio ? (
              <>
                {post.cover_url ? <img className="cover-audio" src={post.cover_url} alt="" style={{ objectFit: 'cover', opacity: 0.9 }} /> : null}
                {post.media_url ? <audio className="audio-ctl" src={post.media_url} controls preload="none" /> : null}
              </>
            ) : isVideo ? (
              // HLS manifest — plays natively in Safari; Chrome support (hls.js) is a
              // fast follow. The poster always shows.
              <video src={post.media_url || undefined} poster={post.thumbnail_url || post.cover_url || undefined} controls playsInline preload="none" />
            ) : post.media_url ? (
              <img src={post.media_url} alt={post.caption || ''} />
            ) : null}
          </div>

          <div className="postside">
            <Link className="pt" href={`/@${author.username}`}>
              <span className="mini-av">{author.avatar_url ? <img src={author.avatar_url} alt="" /> : initial(name, author.username)}</span>
              <span><b>@{author.username}</b><div style={{ fontSize: 12, color: 'var(--muted)' }}>{timeAgo(post.created_at)}</div></span>
            </Link>
            <div className="pbody">
              {post.caption ? <div className="cap">{post.caption}</div> : null}
              <PostInteractions postId={post.id} initialLikes={post.like_count} initialComments={post.comment_count} />
            </div>
            <div className="pfoot"><OpenCTA label="Open in Laybell" wide /></div>
          </div>
        </div>
      </div>
    </main>
  );
}
