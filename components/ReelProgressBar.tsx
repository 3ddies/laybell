import { forwardRef, useImperativeHandle, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import Scrubber from './Scrubber';

export type ReelProgressHandle = { set: (ratio: number) => void };

// A thin video scrubber for the reel. Updated imperatively (set) from the
// player's status callback so the reel's video list never re-renders on a tick.
const ReelProgressBar = forwardRef<ReelProgressHandle, { onSeek: (ratio: number) => void }>(
  function ReelProgressBar({ onSeek }, ref) {
    const [progress, setProgress] = useState(0);
    useImperativeHandle(ref, () => ({ set: setProgress }), []);
    return (
      <View style={styles.wrap}>
        <Scrubber progress={progress} onSeek={onSeek} height={24} trackHeight={3} thumbSize={12} />
      </View>
    );
  },
);

export default ReelProgressBar;

const styles = StyleSheet.create({
  wrap: { width: '100%' },
});
