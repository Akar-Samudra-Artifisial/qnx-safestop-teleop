import * as Haptics from 'expo-haptics';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { TeleopLink, type LinkSnapshot } from './teleopLink';

export interface TeleopLinkApi {
  snap: LinkSnapshot;
  link: TeleopLink;
}

/** Owns one TeleopLink for `url`; connects on mount, closes on unmount. */
export function useTeleopLink(url: string): TeleopLinkApi {
  const [link] = useState(
    () =>
      new TeleopLink(url, {
        onSafeStop: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        },
      }),
  );

  useEffect(() => {
    link.connect();
    return () => link.disconnect();
  }, [link]);

  const snap = useSyncExternalStore(link.subscribe, link.getSnapshot, link.getSnapshot);
  return { snap, link };
}
