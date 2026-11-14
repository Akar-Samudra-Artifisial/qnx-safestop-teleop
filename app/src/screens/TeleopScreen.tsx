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

import EventList from '../components/EventList';
import HoldButton from '../components/HoldButton';
import Joystick from '../components/Joystick';
import LatencyPanel from '../components/LatencyPanel';
import StatusStrip from '../components/StatusStrip';
import TopDownMap from '../components/TopDownMap';
import { statsFromSamples } from '../net/stats';
import { buildLinkUrl, type RejectReason } from '../net/teleopLink';
import { useTeleopLink } from '../net/useTeleopLink';
import { colors, font, radius, space, touchMin } from '../theme';

const STATS_POLL_MS = 2000;

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
  const { width } = useWindowDimensions();
  const [mapSize, setMapSize] = useState(0);

  const open = snap.status === 'open';
  const st = snap.state;
  const joySize = Math.min(220, Math.max(150, (width - space.lg * 3) * 0.5));

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

  const [showLatency, setShowLatency] = useState(false);
  const toggleLatency = useCallback(() => setShowLatency((s) => !s), []);
  // Poll teleopd for its histogram every 2 s while the panel is visible.
  useEffect(() => {
    if (!showLatency || !open) return;
    link.requestStats();
    const id = setInterval(() => link.requestStats(), STATS_POLL_MS);
    return () => clearInterval(id);
  }, [showLatency, open, link]);
  const latency = useMemo(
    () => snap.serverStats ?? statsFromSamples(snap.hbTimeoutUs),
    [snap.serverStats, snap.hbTimeoutUs],
  );
  const plantDown = open && !snap.stale && st?.plant_ok === false;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Teleop</Text>
          <Text style={styles.host} numberOfLines={1}>
            {address}
          </Text>
        </View>
        {!open && (
          <Pressable
            onPress={onReconnect}
            accessibilityRole="button"
            accessibilityLabel="Reconnect"
            style={({ pressed }) => [styles.ghostBtn, styles.accentBtn, pressed && styles.pressed]}
          >
            <Text style={styles.accentBtnText}>
              {snap.status === 'connecting' ? 'Connecting…' : 'Reconnect'}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={toggleLatency}
          accessibilityRole="button"
          accessibilityLabel={showLatency ? 'Show map' : 'Show latency histogram'}
          accessibilityState={{ selected: showLatency }}
          style={({ pressed }) => [styles.ghostBtn, showLatency && styles.ghostBtnOn, pressed && styles.pressed]}
        >
          <Text style={styles.ghostBtnText}>{showLatency ? 'Peta' : 'Latency'}</Text>
        </Pressable>
        <Pressable
          onPress={onExit}
          accessibilityRole="button"
          accessibilityLabel="Disconnect and go back"
          style={({ pressed }) => [styles.ghostBtn, pressed && styles.pressed]}
        >
          <Text style={styles.ghostBtnText}>Exit</Text>
        </Pressable>
      </View>

      <StatusStrip
        status={snap.status}
        mode={st?.mode ?? null}
        rttMs={snap.rttMs}
        hbAgeMs={st && st.hb_age_ms >= 0 ? st.hb_age_ms : null}
        plantOk={st?.plant_ok}
        stale={snap.stale}
      />

      {plantDown && (
        <View style={styles.plantBanner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
          <Text style={styles.plantBannerText}>PLANT DOWN — restarting</Text>
          <Text style={styles.plantBannerSub}>HAM is restarting simplant; motion is held.</Text>
        </View>
      )}

      {showLatency ? (
        <LatencyPanel stats={latency} waitingForServer={!snap.serverStats} />
      ) : (
        <>
          <View style={styles.mapBox} onLayout={onMapLayout}>
            {mapSize > 0 && <TopDownMap size={mapSize} pose={st?.pose ?? null} trail={snap.trail} />}
            {st && (
              <Text style={styles.mapReadout} accessible={false}>
                v {st.vel.v.toFixed(2)} m/s · w {st.vel.w.toFixed(2)} rad/s
              </Text>
            )}
          </View>
          <EventList events={snap.events} />
        </>
      )}

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel} nativeID="linkLossLabel">
          Simulate link loss
          <Text style={styles.switchSub}>{'  '}stops hb + cmd, socket stays open</Text>
        </Text>
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
        <Joystick
          size={joySize}
          onChange={onAxis}
          disabled={!open || snap.stale || st?.mode !== 'ARMED'}
        />
        <View style={styles.actions}>
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
          </Pressable>
          <HoldButton
            label="RE-ARM"
            onConfirm={onArm}
            disabled={!open}
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
  header: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.sm },
  headerText: { flex: 1 },
  title: { color: colors.text, fontSize: font.xl, fontWeight: '800' },
  host: { color: colors.textMuted, fontSize: font.sm, fontVariant: ['tabular-nums'] },
  ghostBtn: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ghostBtnText: { color: colors.text, fontSize: font.md, fontWeight: '700' },
  accentBtn: { backgroundColor: colors.accent, borderColor: colors.accent },
  accentBtnText: { color: colors.onAccent, fontSize: font.md, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  ghostBtnOn: { borderColor: colors.accent, backgroundColor: colors.surfaceRaised },
  plantBanner: {
    backgroundColor: colors.danger,
    borderRadius: radius.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  plantBannerText: { color: colors.onDanger, fontSize: font.lg, fontWeight: '900', letterSpacing: 1 },
  plantBannerSub: { color: colors.onDanger, fontSize: font.sm, fontWeight: '600' },
  mapBox: { flex: 1, minHeight: 140, alignItems: 'center', justifyContent: 'center' },
  mapReadout: {
    position: 'absolute',
    bottom: space.xs,
    left: space.xs,
    color: colors.textMuted,
    fontSize: font.sm,
    fontVariant: ['tabular-nums'],
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    gap: space.md,
  },
  switchLabel: { flex: 1, color: colors.text, fontSize: font.md, fontWeight: '700' },
  switchSub: { color: colors.textMuted, fontSize: font.sm, fontWeight: '400' },
  controls: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  actions: { flex: 1, gap: space.md },
  estop: {
    minHeight: touchMin * 2,
    borderRadius: radius.lg,
    backgroundColor: colors.danger,
    borderWidth: 3,
    borderColor: colors.onDanger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  estopPressed: { backgroundColor: colors.dangerPressed },
  estopText: { color: colors.onDanger, fontSize: font.xxl, fontWeight: '900', letterSpacing: 2 },
});
