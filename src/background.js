/**
 * Update extension icon based on enabled state
 * @param {boolean} enabled - Whether extension is enabled
 */
async function updateIcon(enabled) {
  try {
    const suffix = enabled ? '' : '_disabled';
    await chrome.action.setIcon({
      path: {
        19: `assets/icons/icon19${suffix}.png`,
        38: `assets/icons/icon38${suffix}.png`,
        48: `assets/icons/icon48${suffix}.png`,
      },
    });
    console.log(`Icon updated: ${enabled ? 'enabled' : 'disabled'}`);
  } catch (error) {
    console.error('Failed to update icon:', error);
  }
}

/**
 * Initialize icon state from storage
 */
async function initializeIcon() {
  try {
    const storage = await chrome.storage.sync.get({ enabled: true });
    await updateIcon(storage.enabled);
  } catch (error) {
    console.error('Failed to initialize icon:', error);
    // Default to enabled if storage read fails
    await updateIcon(true);
  }
}

/**
 * Migrate storage to current config version
 * Removes deprecated keys from older versions
 */
async function migrateConfig() {
  const DEPRECATED_KEYS = [
    // Removed in v0.9.x
    'speeds',
    'version',

    // Replaced by smarter fight-back defaults in event-manager.js
    'forceLastSavedSpeed',

    // Migrated to keyBindings array in v0.6.x
    'resetSpeed',
    'speedStep',
    'fastSpeed',
    'rewindTime',
    'advanceTime',
    'resetKeyCode',
    'slowerKeyCode',
    'fasterKeyCode',
    'rewindKeyCode',
    'advanceKeyCode',
    'fastKeyCode',
    'displayKeyCode',
  ];

  try {
    await chrome.storage.sync.remove(DEPRECATED_KEYS);
    console.log('[VSC] Config migrated to current version');
  } catch (error) {
    console.error('[VSC] Config migration failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Key-binding schema v2 migration: keyCode integers → event.code strings
// ---------------------------------------------------------------------------
// Runs in the background service worker (direct chrome.storage.sync access,
// guaranteed persistence). Content scripts that load before this completes
// use the legacy keyCode fallback path in event-manager.js.

import {
  PREDEFINED_CODE_MAP,
  KEYCODE_TO_CODE,
  displayKeyFromCode,
  PREDEFINED_ACTIONS,
  DEFAULT_BINDINGS,
} from './utils/key-maps.js';

// Keep media state per tab and frame; MV3 may suspend this worker between events.
const mediaByTab = new Map();
const badgeUpdates = new Map();
const mediaStateReady = chrome.storage.local
  .get({ badgeMediaByTab: {} })
  .then(({ badgeMediaByTab }) => {
    for (const [tabId, entries] of Object.entries(badgeMediaByTab)) {
      mediaByTab.set(Number(tabId), new Map(entries));
    }
  });
let mediaStateWrite = Promise.resolve();

function persistMediaState() {
  const badgeMediaByTab = Object.fromEntries(
    [...mediaByTab].map(([tabId, media]) => [tabId, [...media]])
  );
  mediaStateWrite = mediaStateWrite.then(() => chrome.storage.local.set({ badgeMediaByTab }));
  return mediaStateWrite;
}

function getTabMedia(tabId) {
  if (!mediaByTab.has(tabId)) {
    mediaByTab.set(tabId, new Map());
  }
  return mediaByTab.get(tabId);
}

function refreshSpeedBadge(tabId) {
  const previousUpdate = badgeUpdates.get(tabId) || Promise.resolve();
  const update = previousUpdate
    .catch(() => {})
    .then(async () => {
      try {
        const media = mediaByTab.get(tabId);
        const candidates = media ? [...media.values()] : [];
        candidates.sort(
          (a, b) =>
            Number(b.playing) - Number(a.playing) ||
            b.interactedAt - a.interactedAt ||
            b.updatedAt - a.updatedAt
        );
        const selected = candidates[0];
        const text =
          selected && selected.speed !== 1
            ? selected.speed % 1 === 0
              ? selected.speed.toFixed(0)
              : selected.speed.toFixed(1)
            : '';
        await chrome.action.setBadgeText({ text, tabId });
        await chrome.action.setBadgeBackgroundColor({ color: '#43464c', tabId });
      } catch (error) {
        console.error('Failed to update speed badge:', error);
      }
    });
  badgeUpdates.set(tabId, update);
  return update;
}

function clearTabMedia(tabId) {
  mediaByTab.delete(tabId);
  refreshSpeedBadge(tabId);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab || !Number.isInteger(sender.tab.id)) {
    return;
  }
  mediaStateReady
    .then(() => {
      const tabId = sender.tab.id;
      const frameId = Number.isInteger(sender.frameId) ? sender.frameId : 0;
      const media = mediaByTab.get(tabId);

      if (message.type === 'FRAME_RESET') {
        if (media) {
          for (const key of media.keys()) {
            if (key.startsWith(`${frameId}:`)) {
              media.delete(key);
            }
          }
        }
        if (!media?.size) {
          mediaByTab.delete(tabId);
        }
      } else if (
        message.type === 'MEDIA_STATE' &&
        typeof message.controllerId === 'string' &&
        Number.isFinite(message.speed)
      ) {
        const tabMedia = getTabMedia(tabId);
        const key = `${frameId}:${message.controllerId}`;
        const previous = tabMedia.get(key);
        const now = Date.now();
        if (message.removed) {
          tabMedia.delete(key);
        } else {
          tabMedia.set(key, {
            speed: message.speed,
            playing: message.playing === true,
            interactedAt: message.interacted === true ? now : previous?.interactedAt || 0,
            updatedAt: now,
          });
        }
        if (!tabMedia.size) {
          mediaByTab.delete(tabId);
        }
      } else {
        return;
      }

      refreshSpeedBadge(tabId);
      return persistMediaState();
    })
    .catch((error) => console.error('Failed to update badge media state:', error));
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  mediaStateReady.then(() => refreshSpeedBadge(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    mediaStateReady.then(() => {
      clearTabMedia(tabId);
      return persistMediaState();
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaStateReady.then(() => {
    clearTabMedia(tabId);
    return persistMediaState();
  });
});

/**
 * Migrate key bindings from v1 (keyCode integers) to v2 (event.code strings).
 *
 * Four phases:
 *   1. Predefined bindings — hardcoded map, zero ambiguity
 *   2. Custom bindings — KEYCODE_TO_CODE best-effort lookup
 *   3. Unmappable keyCodes — set code: null (already broken, user re-records)
 *   4. Ensure all 9 predefined actions exist (replaces ensureDisplayBinding)
 *
 * Single atomic chrome.storage.sync.set() call. Idempotent — safe to re-run.
 */
async function migrateKeyBindingsV2() {
  try {
    const storage = await chrome.storage.sync.get(null);
    const bindings = storage.keyBindings;

    // No bindings in storage → fresh install, v2 defaults applied directly
    if (!bindings || !Array.isArray(bindings) || bindings.length === 0) {
      console.log('[VSC] Migration: no keyBindings in storage, skipping (fresh install)');
      return;
    }

    // Idempotency: skip if already fully migrated.
    // Don't trust schemaVersion alone — verify bindings actually have code fields.
    if (storage.schemaVersion === 2 && bindings.every((b) => b.code !== undefined)) {
      console.log('[VSC] Migration: already at v2, skipping');
      return;
    }

    let predefinedCount = 0;
    let customCount = 0;
    let unmappableCount = 0;

    const migrated = bindings.map((binding) => {
      // Per-binding idempotency: skip if already has code field
      if (binding.code !== undefined) {
        return binding;
      }

      const legacyKey = binding.key;

      // Phase 1: Predefined bindings — hardcoded zero-ambiguity mapping
      if (binding.predefined && PREDEFINED_CODE_MAP[legacyKey]) {
        const mapped = PREDEFINED_CODE_MAP[legacyKey];
        predefinedCount++;
        return {
          ...binding,
          code: mapped.code,
          keyCode: legacyKey,
          displayKey: mapped.displayKey,
        };
      }

      // Phase 2: Custom bindings — best-effort KEYCODE_TO_CODE lookup
      const code = KEYCODE_TO_CODE[legacyKey];
      if (code) {
        customCount++;
        return {
          ...binding,
          code: code,
          keyCode: legacyKey,
          displayKey: displayKeyFromCode(code),
        };
      }

      // Phase 3: Unmappable keyCodes (0, null, 255, OEM-specific, etc.)
      unmappableCount++;
      console.info(
        `[VSC] Migration: unmappable keyCode ${legacyKey} for action "${binding.action}"`
      );
      return {
        ...binding,
        code: null,
        keyCode: legacyKey,
        displayKey: '',
      };
    });

    // Phase 4: Ensure all 9 predefined actions exist
    const existingActions = new Set(migrated.map((b) => b.action));
    for (const action of PREDEFINED_ACTIONS) {
      if (!existingActions.has(action)) {
        const defaults = DEFAULT_BINDINGS[action];
        migrated.push({
          action,
          ...defaults,
          predefined: true,
        });
        console.info(`[VSC] Migration: added missing predefined action "${action}"`);
      }
    }

    // Single atomic write
    await chrome.storage.sync.set({
      keyBindings: migrated,
      schemaVersion: 2,
    });

    console.log(
      `[VSC] Migration: ${predefinedCount} predefined, ${customCount} custom (${unmappableCount} unmappable)`
    );
  } catch (error) {
    console.error('[VSC] Key binding migration failed:', error);
  }
}

/**
 * Listen for storage changes (extension enabled/disabled)
 */
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.enabled) {
    updateIcon(changes.enabled.newValue !== false);
  }
});

/**
 * Initialize on install/update
 */
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Video Speed Controller installed/updated');
  await migrateConfig();
  await migrateKeyBindingsV2();
  await initializeIcon();
});

/**
 * Initialize on startup
 */
chrome.runtime.onStartup.addListener(async () => {
  console.log('Video Speed Controller started');
  await initializeIcon();
});

// Initialize immediately when service worker loads
initializeIcon();

console.log('Video Speed Controller background script loaded');
