import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Notifications } from '@paradocs/shared';

/**
 * The desktop app's bridge, present only when the client runs inside it.
 * Everything desktop-specific checks for it first, so in a browser none of it
 * appears.
 */

export interface DesktopConnection {
  id: string;
  label: string;
  kind: 'local' | 'remote';
  url: string | null;
  /** The connection this page belongs to. */
  active: boolean;
}

export interface DesktopWorkspace {
  id: string;
  name: string;
  icon: string | null;
  /** A data URL, since the picture lives on that connection's server. */
  picture: string | null;
}

export type WorkspaceListing =
  | { status: 'ok'; workspaces: DesktopWorkspace[] }
  | { status: 'signed-out' }
  | { status: 'unavailable'; workspaces: DesktopWorkspace[] };

/** Another connection's notifications. Pictures in them arrive as data URLs. */
export type NotificationsListing = { connection: DesktopConnection } & (
  | { status: 'ok'; notifications: Notifications }
  | { status: 'signed-out' }
  | { status: 'unavailable' }
);

export interface ServerCheck {
  ok: boolean;
  origin?: string;
  version?: string;
  error?: string;
}

export type Outcome = { ok: true } | { ok: false; error: string };

export type UpdatePhase = 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion?: string;
  releaseDate?: string;
  percent?: number;
  message?: string;
  reason?: string;
  checkedAt?: string;
  autoDownload: boolean;
  checkOnLaunch: boolean;
}

export type DesktopCommand =
  | { type: 'navigate'; path: string }
  | { type: 'open-settings'; section: string }
  | { type: 'connect-server' }
  /**
   * This page is now the one holding a channel: sent to the main window when a
   * pop-out hands one back, and to a pop-out that is already open when the main
   * window hands a call over to it. `join` is set when a call came with it.
   */
  | { type: 'take-call'; workspaceId: string; channelId: string; join: boolean }
  /** The main window is asking a pop-out for its channel back, call and all. */
  | { type: 'hand-back'; channelId: string };

/** A channel of this connection that is open in a window of its own. */
export interface PoppedOut {
  workspaceId: string;
  channelId: string;
  kind: 'text' | 'voice';
  title: string;
  /** Whether the call is running in that window rather than this one. */
  inCall: boolean;
}

export type DesktopPreferenceKey = 'theme' | 'media' | 'callLayout' | 'openNotifications';

export interface DesktopBridge {
  connections: {
    list(): Promise<DesktopConnection[]>;
    workspaces(id: string): Promise<WorkspaceListing>;
    /** Switches the window to a connection, optionally at a path within it. */
    open(id: string, path?: string): Promise<Outcome>;
    test(url: string): Promise<ServerCheck>;
    connect(input: { url: string; label?: string }): Promise<Outcome>;
    rename(id: string, label: string): Promise<Outcome>;
    remove(id: string): Promise<Outcome>;
    onChanged(handler: () => void): () => void;
  };
  /**
   * Channels of this connection living in windows of their own. A page can
   * only ever pop out, focus or close its own connection's channels, so none
   * of these name a connection.
   */
  popouts: {
    list(): Promise<PoppedOut[]>;
    /** Opens a window for a channel, or brings the one it has to the front. */
    open(input: {
      workspaceId: string;
      channelId: string;
      kind: 'text' | 'voice';
      /** For the title bar: "#general", or the name of the person. */
      title: string;
      /** This window has just left the call, and the new one should join it. */
      withCall?: boolean;
    }): Promise<Outcome>;
    focus(channelId: string): Promise<Outcome>;
    close(channelId: string): Promise<Outcome>;
    /**
     * Gives a channel back to the main window and closes this one. Called from
     * a pop-out; `withCall` hands the call over with it.
     */
    handBack(channelId: string, withCall: boolean): Promise<Outcome>;
    /**
     * Asks a pop-out for its channel back. Unlike `close`, a call in that
     * window is handed over rather than ending with it.
     */
    recall(channelId: string): Promise<Outcome>;
    /** Called from a pop-out as it joins or leaves, so the main window can say where the call is. */
    callState(channelId: string, inCall: boolean): Promise<Outcome>;
    /**
     * Opens a path in the main window. A pop-out holds one conversation, so a
     * document or another channel linked from inside it belongs back there.
     */
    showInMain(path: string): Promise<Outcome>;
    onChanged(handler: () => void): () => void;
  };
  notifications: {
    /** Every connection except this page's own. */
    list(): Promise<NotificationsListing[]>;
    markRead(connectionId: string, channelIds?: string[]): Promise<Outcome>;
    /** Clears tags in the given documents, or in all of them. */
    markMentionsRead(connectionId: string, documentIds?: string[]): Promise<Outcome>;
    declineInvite(connectionId: string, inviteId: string): Promise<Outcome>;
  };
  /** App-wide preferences, shared by every connection's page. */
  preferences: {
    /** As they were when this page started, read before its first script ran. */
    initial: Partial<Record<DesktopPreferenceKey, unknown>>;
    set(key: DesktopPreferenceKey, value: unknown): Promise<boolean>;
    onChanged(handler: (key: string, value: unknown) => void): () => void;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    download(): Promise<UpdateStatus>;
    install(): Promise<void>;
    setAutoDownload(enabled: boolean): Promise<UpdateStatus>;
    setCheckOnLaunch(enabled: boolean): Promise<UpdateStatus>;
    onChanged(handler: (status: UpdateStatus) => void): () => void;
  };
  info(): Promise<{ version: string; platform: string }>;
  onCommand(handler: (command: DesktopCommand) => void): () => void;
}

export const desktop = (window as unknown as { paradocsDesktop?: DesktopBridge }).paradocsDesktop;

/** For handlers that only run where the desktop UI is shown. */
export function requireDesktop(): DesktopBridge {
  if (!desktop) throw new Error('This is only available in the desktop app.');
  return desktop;
}

/** Every connection in the desktop app, kept current as they change. */
export function useDesktopConnections(): DesktopConnection[] {
  const [connections, setConnections] = useState<DesktopConnection[]>([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    const bridge = desktop;
    if (!bridge) return;
    let live = true;
    const refresh = () => {
      void bridge.connections.list().then((next) => {
        if (live) setConnections(next);
      });
    };
    refresh();
    const stop = bridge.connections.onChanged(() => {
      refresh();
      // Signing in or out somewhere changes what the other lists hold.
      void queryClient.invalidateQueries({ queryKey: ['desktopWorkspaces'] });
      void queryClient.invalidateQueries({ queryKey: ['desktopNotifications'] });
    });
    return () => {
      live = false;
      stop();
    };
  }, [queryClient]);

  return connections;
}

/**
 * The channels this connection has in windows of their own, kept current as
 * they open and close. Empty in a browser, where there is only ever one window.
 */
export function usePoppedOut(): PoppedOut[] {
  const [poppedOut, setPoppedOut] = useState<PoppedOut[]>([]);

  useEffect(() => {
    const bridge = desktop;
    if (!bridge) return;
    let live = true;
    const refresh = () => {
      void bridge.popouts.list().then((next) => {
        if (live) setPoppedOut(next);
      });
    };
    refresh();
    const stop = bridge.popouts.onChanged(refresh);
    return () => {
      live = false;
      stop();
    };
  }, []);

  return poppedOut;
}

/** The workspaces on another connection, asked for through the desktop app. */
export function useDesktopWorkspaces(connectionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['desktopWorkspaces', connectionId],
    queryFn: () => requireDesktop().connections.workspaces(connectionId),
    enabled: Boolean(desktop) && enabled,
    staleTime: 10_000,
  });
}

/** Notifications from the desktop app's other connections. Empty outside it. */
export function useDesktopNotifications() {
  return useQuery({
    queryKey: ['desktopNotifications'],
    queryFn: () => requireDesktop().notifications.list(),
    enabled: Boolean(desktop),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** The update state, pushed from the desktop app as it changes. */
export function useDesktopUpdates(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    const bridge = desktop;
    if (!bridge) return;
    let live = true;
    void bridge.updates.status().then((next) => {
      if (live) setStatus(next);
    });
    const stop = bridge.updates.onChanged(setStatus);
    return () => {
      live = false;
      stop();
    };
  }, []);

  return status;
}
