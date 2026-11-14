import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import BrandMark from '../components/BrandMark';
import EventList from '../components/EventList';
import HoldButton from '../components/HoldButton';
import Joystick from '../components/Joystick';
import LatencyPanel from '../components/LatencyPanel';
import ModeHero from '../components/ModeHero';
import Segmented, { type SegmentOption } from '../components/Segmented';
import StatusStrip from '../components/StatusStrip';
import TopDownMap from '../components/TopDownMap';
import { statsFromSamples } from '../net/stats';
import { buildLinkUrl, type RejectReason } from '../net/teleopLink';
import { useTeleopLink } from '../net/useTeleopLink';
import { colors, font, radius, space, touchSecondary } from '../theme';

const STATS_POLL_MS = 2000;
/** Below this window height (iPhone SE: 667) the layout tightens. */
const COMPACT_H = 720;

type Panel = 'map' | 'latency' | 'events';

interface TeleopScreenProps {
  /** host:port of teleopd. */
  address: string;
  /** 6-digit pairing token printed by teleopd. */
  token: string;
  onExit: () => void;
  /** First connection attempt never opened (bad token / robot in use / unreachable). */
  onRejected: (reason: RejectReason) => void;
}

export default function TeleopScreen({ address, token, onExit, onRejected }: TeleopScreenProps) {
  const { snap, link } = useTeleopLink(buildLinkUrl(address, token));
  const everOpened = useRef(false);

  useEffect(() => {
    if (snap.status === 'open') everOpened.current = true;
    else if (snap.status === 'rejected' && !everOpened.current) onRejected(snap.rejectReason ?? 'unknown');
  }, [snap.status, snap.rejectReason, onRejected]);
  const { width, height } = useWindowDimensions();
  const compact = height < COMPACT_H;
  const [mapSize, setMapSize] = useState(0);

  const open = snap.status === 'open';
  const st = snap.state;
  const mode = st?.mode ?? null;
  const joySize = Math.round(Math.min(200, Math.max(128, (width - space.lg * 3) * (compact ? 0.42 : 0.48))));

  const onMapLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setMapSize(Math.floor(Math.min(w, h)));
  }, []);

  const onAxis = useCallback((v: number, w: number) => link.setAxis(v, w), [link]);
  const onArm = useCallback(() => link.arm(), [link]);
  const onEstop = useCallback(() => {
    link.estop();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => {});
  }, [link]);
  const onReconnect = useCallback(() => link.connect(), [link]);
  const onLinkLoss = useCallback((on: boolean) => link.setLinkLossSim(on), [link]);

  const [panel, setPanel] = useState<Panel>('map');
  // Poll teleopd for its histogram every 2 s while the latency tab is visible.
  useEffect(() => {
    if (panel !== 'latency' || !open) return;
    link.requestStats();
    const id = setInterval(() => link.requestStats(), STATS_POLL_MS);
    return () => clearInterval(id);
  }, [panel, open, link]);
  const latency = useMemo(
    () => snap.serverStats ?? statsFromSamples(snap.hbTimeoutUs),
    [snap.serverStats, snap.hbTimeoutUs],
  );
  const plantDown = open && !snap.stale && st?.plant_ok === false;

  const driveDisabled = !open || snap.stale || mode !== 'ARMED';
  const joyHint = !open ? 'Not connected' : snap.stale ? 'Waiting for robot' : 'Hold RE-ARM to drive';
  const eventCount = snap.events.length;
  const tabs = useMemo<readonly SegmentOption<Panel>[]>(
    () => [
      { key: 'map', label: 'Map' },
      { key: 'latency', label: 'Latency' },
      { key: 'events', label: 'Events', badge: eventCount },
    ],
    [eventCount],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <BrandMark size={26} />
        <View style={styles.headerText}>
          <Text style={styles.title}>SafeStop Teleop</Text>
          <Text style={styles.host} numberOfLines={1}>
            {address}
          </Text>
        </View>
        {!open && (
          <Pressable
            onPress={onReconnect}
            accessibilityRole="button"
            accessibilityLabel="Reconnect"
            style={({ pressed }) => [styles.headerBtn, styles.accentBtn, pressed && styles.pressed]}
          >
            <Text style={styles.accentBtnText}>
              {snap.status === 'connecting' ? 'Connecting…' : 'Reconnect'}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={onExit}
          accessibilityRole="button"
          accessibilityLabel="Disconnect and go back"
          style={({ pressed }) => [styles.headerBtn, pressed && styles.pressed]}
        >
          <Text style={styles.headerBtnText}>Exit</Text>
        </Pressable>
      </View>

      <ModeHero
        status={snap.status}
        stale={snap.stale}
        mode={mode}
        lastEvent={snap.events[0] ?? null}
        linkLossSim={snap.linkLossSim}
        compact={compact}
      />

      {plantDown && (
        <View style={styles.plantBanner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text style={styles.plantBannerText}>PLANT DOWN — restarting</Text>
          <Text style={styles.plantBannerSub}>HAM is restarting the robot process. Motion is held.</Text>
        </View>
      )}

      <StatusStrip
        rttMs={snap.rttMs}
        hbAgeMs={st && st.hb_age_ms >= 0 ? st.hb_age_ms : null}
        plantOk={st?.plant_ok}
        p99Us={latency.n ? latency.p99Us : null}
      />

      <Segmented options={tabs} value={panel} onChange={setPanel} accessibilityLabel="Detail view" />

      <View style={styles.panel}>
        {panel === 'map' && (
          <View style={styles.mapBox} onLayout={onMapLayout}>
            {mapSize > 0 && <TopDownMap size={mapSize} pose={st?.pose ?? null} trail={snap.trail} />}
            {st && (
              <Text style={styles.mapReadout} accessible={false}>
                v {st.vel.v.toFixed(2)} m/s · ω {st.vel.w.toFixed(2)} rad/s
              </Text>
            )}
          </View>
        )}
        {panel === 'latency' && <LatencyPanel stats={latency} waitingForServer={!snap.serverStats} />}
        {panel === 'events' && <EventList events={snap.events} max={8} />}
      </View>

      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel} nativeID="linkLossLabel">
            Simulate link loss
          </Text>
          <Text style={styles.switchSub} numberOfLines={1}>
            Stops heartbeat + commands, socket stays open
          </Text>
        </View>
        <Switch
          value={snap.linkLossSim}
          onValueChange={onLinkLoss}
          accessibilityLabel="Simulate link loss"
          accessibilityHint="Stops heartbeat and commands without closing the connection"
          trackColor={{ false: colors.border, true: colors.warn }}
          thumbColor={colors.text}
        />
      </View>

      <View style={styles.controls}>
        <Joystick size={joySize} onChange={onAxis} disabled={driveDisabled} hint={joyHint} />
        <View style={[styles.actions, { height: joySize }]}>
          <Pressable
            // Fire on touch-down: no wait for release, no cancel on finger slide.
            onPressIn={onEstop}
            accessibilityRole="button"
            accessibilityLabel="Emergency stop"
            accessibilityHint="Immediately forces safe stop"
            accessibilityActions={[{ name: 'activate' }]}
            onAccessibilityAction={(e) => e.nativeEvent.actionName === 'activate' && onEstop()}
            style={({ pressed }) => [styles.estop, pressed && styles.estopPressed]}
          >
            <Text style={styles.estopText}>E-STOP</Text>
            <Text style={styles.estopSub}>tap to stop now</Text>
          </Pressable>
          <HoldButton
            label="RE-ARM"
            onConfirm={onArm}
            disabled={!open}
            emphasis={open && !snap.stale && mode !== 'ARMED'}
            accessibilityHint="Press and hold for 1 second to re-enable motion"
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
    gap: space.sm,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.xs },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: font.md, fontWeight: '800' },
  host: { color: colors.textMuted, fontSize: font.sm, fontVariant: ['tabular-nums'] },
  headerBtn: {
    minHeight: touchSecondary,
    minWidth: touchSecondary,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerBtnText: { color: colors.text, fontSize: font.md, fontWeight: '700' },
  accentBtn: { backgroundColor: colors.accent, borderColor: colors.accent },
  accentBtnText: { color: colors.onAccent, fontSize: font.md, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  plantBanner: {
    backgroundColor: colors.dangerFill,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  plantBannerText: { color: colors.onDanger, fontSize: font.lg, fontWeight: '900', letterSpacing: 1 },
  plantBannerSub: { color: colors.onDanger, fontSize: font.sm, fontWeight: '600' },
  panel: { flex: 1, minHeight: 120 },
  mapBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  mapReadout: {
    position: 'absolute',
    bottom: space.xs,
    left: space.xs,
    color: colors.textMuted,
    backgroundColor: colors.bg,
    paddingHorizontal: space.xs,
    borderRadius: 4,
    overflow: 'hidden',
    fontSize: font.sm,
    fontVariant: ['tabular-nums'],
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchSecondary,
    gap: space.md,
  },
  switchText: { flex: 1, minWidth: 0 },
  switchLabel: { color: colors.text, fontSize: font.md, fontWeight: '700' },
  switchSub: { color: colors.textMuted, fontSize: font.xs },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  actions: { flex: 1, gap: space.sm },
  estop: {
    flex: 1,
    borderRadius: radius.xl,
    backgroundColor: colors.dangerFill,
    borderWidth: 3,
    borderColor: colors.onDanger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  estopPressed: { backgroundColor: colors.dangerPressed },
  estopText: { color: colors.onDanger, fontSize: font.xxl, fontWeight: '900', letterSpacing: 2 },
  estopSub: { color: colors.onDanger, fontSize: font.xs, fontWeight: '700' },
});
