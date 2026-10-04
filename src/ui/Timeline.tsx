import { useSyncExternalStore } from 'react';
import { useStore } from '../state/useEditor';

export function Timeline() {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const doc = state.history.present;
  const selId = state.selection;
  const track = selId ? doc.tracks[selId] ?? [] : [];

  const pct = (t: number) => `${(t / doc.duration) * 100}%`;

  const onTrackClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * doc.duration;
    store.seek(Math.max(0, Math.min(doc.duration, t)));
  };

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <button
          className="primary"
          onClick={() => (state.playing ? store.pause() : store.play())}
        >
          {state.playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <button onClick={() => store.seek(0)}>⏮</button>
        <span className="time">
          {state.time.toFixed(2)} / {doc.duration.toFixed(2)} s
        </span>
        <label style={{ color: 'var(--text-dim)' }}>时长</label>
        <input
          type="number"
          min={0.1}
          step={0.1}
          value={doc.duration}
          style={{ width: 70, background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 5, padding: '4px 6px' }}
          onChange={(e) => store.setDuration(Number(e.target.value))}
        />
        <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>秒</span>
        {selId && (
          <span style={{ marginLeft: 12, color: 'var(--text-dim)' }}>
            「{doc.bones[selId]?.name}」关键帧 {track.length} 个（点击轨道跳转，点击圆点跳到该帧）
          </span>
        )}
      </div>
      <div className="track-area" onClick={onTrackClick}>
        <div className="playhead" style={{ left: pct(state.time) }} />
        {track.map((kf) => (
          <div
            key={kf.time}
            className={`kf-dot ${Math.abs(kf.time - state.time) < 1e-6 ? 'current' : ''}`}
            style={{ left: pct(kf.time) }}
            title={`${kf.time.toFixed(2)}s`}
            onClick={(e) => {
              e.stopPropagation();
              store.seek(kf.time);
            }}
          />
        ))}
      </div>
    </div>
  );
}
