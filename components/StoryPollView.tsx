import { useEffect, useState } from 'react';
import { PollStickerContent, type PollResults } from './PollSticker';
import { voteStoryPoll, fetchStoryPollResults, fetchMyStoryPollVote } from '../lib/stories';

// Interactive poll sticker in the story viewer: shows options until you vote, then
// swaps to live result bars. One vote per person (changeable isn't exposed here —
// first tap locks the result view, which matches how stories read).

async function loadResults(pollId: string, numOptions: number, myChoice: number): Promise<PollResults> {
  const rows = await fetchStoryPollResults(pollId);
  const counts = new Array(numOptions).fill(0) as number[];
  for (const r of rows) if (r.option_index >= 0 && r.option_index < numOptions) counts[r.option_index] = r.votes;
  const total = counts.reduce((a, b) => a + b, 0);
  return { counts, total, myChoice };
}

export function StoryPollView({ pollId, storyId, question, options }: {
  pollId: string;
  storyId: string;
  question: string;
  options: string[];
}) {
  const [results, setResults] = useState<PollResults | null>(null);

  // On open: if I already voted, show results straight away.
  useEffect(() => {
    let live = true;
    setResults(null);
    (async () => {
      const mine = await fetchMyStoryPollVote(pollId);
      if (!live || mine < 0) return;
      const r = await loadResults(pollId, options.length, mine);
      if (live) setResults(r);
    })();
    return () => { live = false; };
  }, [pollId, options.length]);

  const onVote = async (i: number) => {
    // Optimistic: show my pick immediately, then reconcile with the server tally.
    setResults({ counts: options.map((_, k) => (k === i ? 1 : 0)), total: 1, myChoice: i });
    try {
      await voteStoryPoll(pollId, storyId, i);
      setResults(await loadResults(pollId, options.length, i));
    } catch { /* keep the optimistic view */ }
  };

  return (
    <PollStickerContent
      question={question}
      options={options}
      results={results}
      onVote={results ? undefined : onVote}
    />
  );
}
