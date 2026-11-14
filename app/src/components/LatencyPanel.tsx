import { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';

import { fmtMs, fmtUsAsMs } from '../format';
import type { LatencyStats } from '../net/stats';
import { colors, font, radius, space } from '../theme';

interface LatencyPanelProps {
  stats: LatencyStats;
  /** Server has not answered `stats_req` yet; showing local fallback. */
  waitingForServer: boolean;
}

const CHART_H = 180;
const AXIS_H = 22;
const TOP_PAD = 18;

const msLabel = (us: number) => {
  const ms = us / 1000;
  return Number.isInteger(ms) ? String(ms) : fmtMs(ms, 1);
};
const bucketLabel = (leUs: number, prevUs: number | undefined) =>
  Number.isFinite(leUs) ? `≤${msLabel(leUs)}` : `>${msLabel(prevUs ?? 0)}`;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric} accessible accessibilityLabel={`${label} ${value}`}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={styles.metricValue}>{value}</Text>
    </View>
  );
}

/** Histogram of SAFE_STOP hb_timeout detection latency (teleopd `stats`, or local fallback). */
export default function LatencyPanel({ stats, waitingForServer }: LatencyPanelProps) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.floor(e.nativeEvent.layout.width));

  const maxCount = Math.max(1, ...stats.buckets.map((b) => b.count));
  const n = stats.buckets.length || 1;
  const slot = width / n;
  const barW = Math.max(4, slot * 0.7);
  const plotH = CHART_H - AXIS_H - TOP_PAD;

  const summary = stats.buckets
    .map((b, i) => `${bucketLabel(b.leUs, stats.buckets[i - 1]?.leUs)} ms: ${b.count}`)
    .join(', ');

  return (
    <View style={styles.wrap}>
      <View style={styles.headRow}>
        <Text style={styles.title} accessibilityRole="header">
          LATENCY · hb_timeout detect
        </Text>
        <Text style={[styles.source, stats.source === 'server' ? styles.sourceServer : styles.sourceLocal]}>
          {stats.source === 'server' ? 'teleopd' : 'lokal'}
        </Text>
      </View>
      {stats.source === 'local' && (
        <Text style={styles.note}>
          {waitingForServer
            ? 'Server belum mengirim stats — histogram dari event hb_timeout yang diterima app.'
            : 'Histogram dari event hb_timeout yang diterima app.'}
        </Text>
      )}

      <View style={styles.metrics}>
        <Metric label="n" value={String(stats.n)} />
        <Metric label="p50" value={stats.n ? `${fmtUsAsMs(stats.p50Us)} ms` : '—'} />
        <Metric label="p99" value={stats.n ? `${fmtUsAsMs(stats.p99Us)} ms` : '—'} />
        <Metric label="max" value={stats.n ? `${fmtUsAsMs(stats.maxUs)} ms` : '—'} />
      </View>

      <View style={styles.chart} onLayout={onLayout}>
        {stats.n === 0 ? (
          <Text style={styles.empty}>
            Belum ada sampel. Nyalakan &quot;Simulate link loss&quot; saat ARMED untuk memicu hb_timeout.
          </Text>
        ) : (
          width > 0 && (
            <Svg width={width} height={CHART_H} accessibilityLabel={`Histogram, milliseconds: ${summary}`}>
              <Line x1={0} y1={TOP_PAD + plotH} x2={width} y2={TOP_PAD + plotH} stroke={colors.border} strokeWidth={1} />
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
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      {b.count}
                    </SvgText>
                  ),
                  <SvgText
                    key={`l${i}`}
                    x={i * slot + slot / 2}
                    y={CHART_H - 6}
                    fill={colors.textMuted}
                    fontSize={11}
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
      <Text style={styles.axisNote}>batas bucket dalam ms · merah = di luar bucket terakhir</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: space.md, gap: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm },
  title: { color: colors.text, fontSize: font.md, fontWeight: '800', letterSpacing: 1 },
  source: { fontSize: font.sm, fontWeight: '800', paddingHorizontal: space.sm, paddingVertical: 2, borderRadius: radius.sm },
  sourceServer: { color: colors.onAccent, backgroundColor: colors.ok },
  sourceLocal: { color: colors.onAccent, backgroundColor: colors.warn },
  note: { color: colors.textMuted, fontSize: font.sm },
  metrics: { flexDirection: 'row', gap: space.sm },
  metric: { flex: 1, backgroundColor: colors.surfaceRaised, borderRadius: radius.sm, padding: space.sm },
  metricLabel: { color: colors.textMuted, fontSize: font.sm, fontWeight: '700' },
  metricValue: { color: colors.text, fontSize: font.md, fontWeight: '800', fontVariant: ['tabular-nums'] },
  chart: { flex: 1, minHeight: CHART_H, justifyContent: 'center' },
  empty: { color: colors.textMuted, fontSize: font.md, textAlign: 'center' },
  axisNote: { color: colors.textMuted, fontSize: 11 },
});
