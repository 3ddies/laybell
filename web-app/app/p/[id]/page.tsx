import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { cache } from 'react';
import { sb } from '@/lib/supabase';
import { formatCount, gradientFor, initial, timeAgo, streamIframeSrc, streamThumb, aspectOf } from '@/lib/format';
import { OpenCTA, NotFoundState } from '../../components';
import PostInteractions from './PostInteractions';
import ProtectedAudio from '../../ProtectedAudio';
import StreamPlayer from '../../StreamPlayer';
import TvWatch from './TvWatch';
import { TV_WEB_PREROLL_MIN_SEC } from '@/lib/ads';

export const revalidate = 60;

type Post = {
  id: string; user_id: string; type: string | null; caption: string | null;
  media_url: string | null; thumbnail_url: string | null; cover_url: string | null;
  like_count: number | null; comment_count: number | null; view_count: number | null;
  stream_count: number | null; mature: boolean | null; created_at: string;
  aspect_ratio: string | null; duration_seconds: number | null;
  // Creator engagement privacy (post_privacy.sql), resolved server-side.
  hide_like_count_eff?: boolean | null; comments_disabled_eff?: boolean | null;
};
type Author = { username: string; display_name: string | null; avatar_url: string | null; hidden: boolean | null };

const getPost = cache(async (id: string) => {
  const db = sb();
  // RLS already drops private posts and posts of hidden authors; we also filter
  // archived_at and mature ourselves (neither is policy-enforced for the web).
  const { data: post } = await db.from('posts')
    .select('id,user_id,type,caption,media_url,thumbnail_url,cover_url,like_count,comment_count,view_count,stream_count,mature,aspect_ratio,duration_seconds,created_at')
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
  const streamSrc = isVideo ? streamIframeSrc(post.media_url, post.thumbnail_url || post.cover_url) : null;
  // Size the player to the video's real shape — vertical reels stay vertical,
  // landscape stays 16:9-ish — instead of forcing everything into 16:9.
  const videoAr = aspectOf(post.aspect_ratio) || 16 / 9;

  // Author header + caption + engagement, shared by both layouts.
  const authorLink = (
    <Link className="pt" href={`/@${author.username}`}>
      <span className="mini-av">{author.avatar_url ? <img src={author.avatar_url} alt="" /> : initial(name, author.username)}</span>
      <span><b>@{author.username}</b><div style={{ fontSize: 12, color: 'var(--muted)' }}>{timeAgo(post.created_at)}</div></span>
    </Link>
  );
  const interactions = (
    <PostInteractions postId={post.id} initialLikes={post.like_count} initialComments={post.comment_count} hideLikes={!!post.hide_like_count_eff} commentsDisabled={!!post.comments_disabled_eff} />
  );

  // VIDEO → YouTube-style "watch" layout: a 16:9 rectangle player on top, info
  // below. The Cloudflare Stream iframe plays in every browser, expands to
  // fullscreen, and offers no download.
  if (isVideo) {
    // Laybell TV pre-roll gate (owner spec): LANDSCAPE video over 2 minutes —
    // the same aspect>1 rule that puts a clip on /tv, plus a length floor. These
    // videos play a YouTube-style pre-roll ad on the first play click; TvWatch
    // handles the poster → ad → video flow. Everything else keeps StreamPlayer.
    const canPreroll = aspectOf(post.aspect_ratio) > 1 && (post.duration_seconds ?? 0) > TV_WEB_PREROLL_MIN_SEC;
    return (
      <main className="postpage">
        <div className="wrap watch">
          {streamSrc ? (
            canPreroll ? (
              <TvWatch src={streamSrc} thumb={streamThumb(post.media_url)} initialAr={videoAr} title={post.caption || undefined} />
            ) : (
              <StreamPlayer src={streamSrc} thumb={streamThumb(post.media_url)} initialAr={videoAr} title={post.caption || undefined} />
            )
          ) : (
            <div className="watch-player" style={{ ['--ar' as any]: videoAr }}>
              {post.media_url ? (
                // Non-Stream video (rare): native player, download affordance off.
                <video src={post.media_url} poster={post.thumbnail_url || post.cover_url || undefined} controls controlsList="nodownload noplaybackrate" disablePictureInPicture playsInline preload="none" />
              ) : (
                <div className="watch-noplayer" style={{ background: gradientFor(post.id) }} />
              )}
            </div>
          )}
          <div className="watch-meta">
            <div className="watch-row">{authorLink}<OpenCTA label="Open in Laybell" /></div>
            {post.caption ? <div className="cap watch-cap">{post.caption}</div> : null}
            {interactions}
          </div>
        </div>
      </main>
    );
  }

  // AUDIO / IMAGE → the compact two-column post card.
  return (
    <main className="postpage">
      <div className="wrap">
        <div className="postwrap">
          <div className="postmedia" style={!img || isAudio ? { background: gradientFor(post.id) } : undefined}>
            {isAudio ? (
              // Streams in-page over the cover; the raw file is not downloadable
              // from the player (controlsList + right-click blocked).
              <>
                {post.cover_url ? <img className="cover-audio" src={post.cover_url} alt="" /> : null}
                {post.media_url ? <ProtectedAudio className="audio-ctl" src={post.media_url} /> : null}
              </>
            ) : post.media_url ? (
              <img src={post.media_url} alt={post.caption || ''} />
            ) : null}
          </div>

          <div className="postside">
            {authorLink}
            <div className="pbody">
              {post.caption ? <div className="cap">{post.caption}</div> : null}
              {interactions}
            </div>
            <div className="pfoot"><OpenCTA label="Open in Laybell" wide /></div>
          </div>
        </div>
      </div>
    </main>
  );
}
