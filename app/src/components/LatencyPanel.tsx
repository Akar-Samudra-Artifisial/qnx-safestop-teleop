import { useState } from 'react';
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';

import { fmtMs, fmtUsAsMs } from '../format';
import type { LatencyStats } from '../net/stats';
import { HEARTBEAT_DEADLINE_MS } from '../protocol';
import { colors, font, radius, space } from '../theme';

interface LatencyPanelProps {
  stats: LatencyStats;
  /** Server has not answered `stats_req` yet; showing local fallback. */
  waitingForServer: boolean;
}

/** SVG <text> on web falls back to the browser serif; native already uses the system face. */
const CHART_FONT = Platform.OS === 'web' ? 'system-ui, -apple-system, Helvetica, Arial, sans-serif' : undefined;
const AXIS_H = 18;
const TOP_PAD = 16;

const msLabel = (us: number) => {
  const ms = us / 1000;
  return Number.isInteger(ms) ? String(ms) : fmtMs(ms, 1);
};
const bucketLabel = (leUs: number, prevUs: number | undefined) =>
  Number.isFinite(leUs) ? `≤${msLabel(leUs)}` : `>${msLabel(prevUs ?? 0)}`;

function Metric({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.metric} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, strong && styles.metricStrong]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/** Histogram of SAFE_STOP hb_timeout detection latency (teleopd `stats`, or local fallback). */
export default function LatencyPanel({ stats, waitingForServer }: LatencyPanelProps) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox({ w: Math.floor(width), h: Math.floor(height) });
  };

  const maxCount = Math.max(1, ...stats.buckets.map((b) => b.count));
  const n = stats.buckets.length || 1;
  const slot = box.w / n;
  const barW = Math.max(4, slot * 0.68);
  const plotH = Math.max(20, box.h - AXIS_H - TOP_PAD);
  const ms = (us: number) => (stats.n ? `${fmtUsAsMs(us)} ms` : '—');

  const summary = stats.buckets
    .map((b, i) => `${bucketLabel(b.leUs, stats.buckets[i - 1]?.leUs)} ms: ${b.count}`)
    .join(', ');

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
          Link-loss stop time
        </Text>
        <Text style={[styles.source, stats.source === 'server' ? styles.sourceServer : styles.sourceLocal]}>
          {stats.source === 'server' ? 'from teleopd' : 'from app'}
        </Text>
      </View>
      <Text style={styles.note} numberOfLines={2}>
        {stats.source === 'local' && waitingForServer
          ? 'teleopd has not sent stats yet — built from stops this app received.'
          : `Last heartbeat → SAFE_STOP. Watchdog deadline ${HEARTBEAT_DEADLINE_MS} ms.`}
      </Text>

      <View style={styles.metrics}>
        <Metric label="samples" value={String(stats.n)} />
        <Metric label="p50" value={ms(stats.p50Us)} />
        <Metric label="p99" value={ms(stats.p99Us)} strong />
        <Metric label="max" value={ms(stats.maxUs)} />
      </View>

      <View style={styles.chart} onLayout={onLayout}>
        {stats.n === 0 ? (
          <View style={styles.emptyBox}>
            <Text style={styles.emptyTitle}>No samples yet</Text>
            <Text style={styles.empty}>
              While ARMED, switch on “Simulate link loss” to trip the watchdog.
            </Text>
          </View>
        ) : (
          box.w > 0 &&
          box.h > 0 && (
            <Svg width={box.w} height={box.h} accessibilityLabel={`Histogram, milliseconds: ${summary}`}>
              <Line x1={0} y1={TOP_PAD + plotH} x2={box.w} y2={TOP_PAD + plotH} stroke={colors.border} strokeWidth={1} />
              {stats.buckets.map((b, i) => {
                const h = (b.count / maxCount) * plotH;
                const x = i * slot + (slot - barW) / 2;
                const y = TOP_PAD + plotH - h;
                const open = !Number.isFinite(b.leUs);
                return [
                  <Rect
                    key={`r${i}`}
                    x={x}
                    y={y}
                    width={barW}
                    height={Math.max(h, b.count ? 2 : 0)}
                    rx={3}
                    fill={open ? colors.danger : colors.accent}
                  />,
                  b.count > 0 && (
                    <SvgText
                      key={`c${i}`}
                      x={x + barW / 2}
                      y={y - 4}
                      fill={colors.text}
                      fontSize={12}
                      fontFamily={CHART_FONT}
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {b.count}
                    </SvgText>
                  ),
                  <SvgText
                    key={`l${i}`}
                    x={i * slot + slot / 2}
                    y={box.h - 4}
                    fill={colors.textMuted}
                    fontSize={10}
                    fontFamily={CHART_FONT}
                    textAnchor="middle"
                  >
                    {bucketLabel(b.leUs, stats.buckets[i - 1]?.leUs)}
                  </SvgText>,
                ];
              })}
            </Svg>
          )
        )}
      </View>
      <Text style={styles.axisNote}>Bucket upper bound, ms · red = above the last bucket</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.sm,
  },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  title: { flex: 1, color: colors.text, fontSize: font.md, fontWeight: '800' },
  source: { fontSize: font.xs, fontWeight: '800', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.pill, overflow: 'hidden' },
  sourceServer: { color: colors.onOk, backgroundColor: colors.ok },
  sourceLocal: { color: colors.onAccent, backgroundColor: colors.warn },
  note: { color: colors.textMuted, fontSize: font.xs },
  metrics: { flexDirection: 'row', gap: space.xs },
  metric: { flex: 1, backgroundColor: colors.surfaceRaised, borderRadius: radius.sm, paddingVertical: space.xs, paddingHorizontal: space.sm },
  metricLabel: { color: colors.textMuted, fontSize: font.xs, fontWeight: '700' },
  metricValue: { color: colors.text, fontSize: font.sm, fontWeight: '800', fontVariant: ['tabular-nums'] },
  metricStrong: { color: colors.accent },
  chart: { flex: 1, minHeight: 60 },
  emptyBox: { flex: 1, justifyContent: 'center', gap: space.xs },
  emptyTitle: { color: colors.text, fontSize: font.md, fontWeight: '700', textAlign: 'center' },
  empty: { color: colors.textMuted, fontSize: font.sm, textAlign: 'center' },
  axisNote: { color: colors.textMuted, fontSize: font.xs },
});
