import { globalShortcut, type MenuItem } from 'electron';
import prompt, { type KeybindOptions } from 'custom-electron-prompt';

import hudStyle from './volume-hud.css?inline';
import { createPlugin } from '@/utils';

import promptOptions from '@/providers/prompt-options';
import { overrideListener } from './override';
import { onConfigChange, onPlayerApiReady } from './renderer';
import { t } from '@/i18n';

export type PreciseVolumePluginConfig = {
  enabled: boolean;
  /**
   * Percentage of volume to change
   */
  steps: number;
  /**
   * Enable ArrowUp + ArrowDown local shortcuts
   */
  arrowsShortcut: boolean;
  globalShortcuts: {
    volumeUp: string;
    volumeDown: string;
  };
  /**
   * Plugin save volume between session here
   */
  savedVolume: number | undefined;
};

let registeredShortcuts: {
  volumeUp?: string;
  volumeDown?: string;
} = {};

let currentIpc: BackendContext<PreciseVolumePluginConfig>['ipc'] | null = null;

// Helper function to normalize accelerator strings
// Electron's globalShortcut on Linux has issues with numpad keys
function normalizeAccelerator(accelerator: string): string {
  // On Linux, global shortcuts need a modifier key (Ctrl, Alt, Shift, etc.)
  // Convert "Num8" -> "8", but bare number keys won't work as global shortcuts
  // They need modifiers like "Ctrl+8" or "Alt+8"
  const normalized = accelerator.replace(/num(\d)/gi, '$1');
  
  // Check if there's already a modifier (contains +)
  if (!normalized.includes('+')) {
    console.warn('[PreciseVolume] Global shortcut without modifier detected:', accelerator, 
                 '- On Linux, global shortcuts require a modifier key (Ctrl, Alt, Shift, etc.)');
  }
  
  return normalized;
}

export default createPlugin({
  name: () => t('plugins.precise-volume.name'),
  description: () => t('plugins.precise-volume.description'),
  restartNeeded: true,
  config: {
    enabled: false,
    steps: 1,
    arrowsShortcut: true,
    globalShortcuts: {
      volumeUp: '',
      volumeDown: '',
    },
    savedVolume: undefined,
  } as PreciseVolumePluginConfig,
  stylesheets: [hudStyle],
  menu: async ({ setConfig, getConfig, window }) => {
    const config = await getConfig();

    function changeOptions(
      changedOptions: Partial<PreciseVolumePluginConfig>,
      options: PreciseVolumePluginConfig,
    ) {
      for (const option in changedOptions) {
        // HACK: Weird TypeScript error
        (options as Record<string, unknown>)[option] = (
          changedOptions as Record<string, unknown>
        )[option];
      }

      setConfig(options);
    }

    // Helper function for globalShortcuts prompt
    const kb = (
      label_: string,
      value_: string,
      default_: string,
    ): KeybindOptions => ({
      value: value_,
      label: label_,
      default: default_ || undefined,
    });

    async function promptVolumeSteps(options: PreciseVolumePluginConfig) {
      const output = await prompt(
        {
          title: t('plugins.precise-volume.prompt.volume-steps.title'),
          label: t('plugins.precise-volume.prompt.volume-steps.label'),
          value: options.steps || 1,
          type: 'counter',
          counterOptions: { minimum: 0, maximum: 100, multiFire: true },
          width: 380,
          ...promptOptions(),
        },
        window,
      );

      if (output || output === 0) {
        // 0 is somewhat valid
        changeOptions({ steps: output }, options);
      }
    }

    async function promptGlobalShortcuts(
      options: PreciseVolumePluginConfig,
      item: MenuItem,
    ) {
      const output = await prompt(
        {
          title: t('plugins.precise-volume.prompt.global-shortcuts.title'),
          label: t('plugins.precise-volume.prompt.global-shortcuts.label'),
          type: 'keybind',
          keybindOptions: [
            kb(
              t(
                'plugins.precise-volume.prompt.global-shortcuts.keybind-options.increase',
              ),
              'volumeUp',
              options.globalShortcuts?.volumeUp,
            ),
            kb(
              t(
                'plugins.precise-volume.prompt.global-shortcuts.keybind-options.decrease',
              ),
              'volumeDown',
              options.globalShortcuts?.volumeDown,
            ),
          ],
          ...promptOptions(),
        },
        window,
      );

      if (output) {
        const newGlobalShortcuts: {
          volumeUp: string;
          volumeDown: string;
        } = { volumeUp: '', volumeDown: '' };
        for (const { value, accelerator } of output) {
          newGlobalShortcuts[value as keyof typeof newGlobalShortcuts] =
            accelerator;
        }

        console.log('[PreciseVolume] Setting new global shortcuts:', newGlobalShortcuts);
        changeOptions({ globalShortcuts: newGlobalShortcuts }, options);

        item.checked =
          Boolean(newGlobalShortcuts.volumeUp) ||
          Boolean(newGlobalShortcuts.volumeDown);
      } else {
        // Reset checkbox if prompt was canceled
        item.checked = !item.checked;
      }
    }

    return [
      {
        label: t('plugins.precise-volume.menu.arrows-shortcuts'),
        type: 'checkbox',
        checked: Boolean(config.arrowsShortcut),
        click(item) {
          changeOptions({ arrowsShortcut: item.checked }, config);
        },
      },
      {
        label: t('plugins.precise-volume.menu.global-shortcuts'),
        type: 'checkbox',
        checked: Boolean(
          config.globalShortcuts?.volumeUp ??
            config.globalShortcuts?.volumeDown,
        ),
        click: (item) => promptGlobalShortcuts(config, item),
      },
      {
        label: t('plugins.precise-volume.menu.custom-volume-steps'),
        click: () => promptVolumeSteps(config),
      },
    ];
  },

  backend: {
    async start({ getConfig, ipc }) {
      const config = await getConfig();
      currentIpc = ipc;

      console.log('[PreciseVolume] Starting backend with config:', config.globalShortcuts);

      if (config.globalShortcuts?.volumeUp) {
        const accelerator = normalizeAccelerator(config.globalShortcuts.volumeUp);
        console.log('[PreciseVolume] Normalized volumeUp accelerator:', config.globalShortcuts.volumeUp, '->', accelerator);
        try {
          const success = globalShortcut.register(
            accelerator,
            () => {
              console.log('[PreciseVolume] Volume Up shortcut triggered');
              ipc.send('changeVolume', true);
            },
          );
          if (success) {
            registeredShortcuts.volumeUp = accelerator;
            console.log('[PreciseVolume] Successfully registered volumeUp:', accelerator);
          } else {
            console.error('[PreciseVolume] Failed to register volumeUp (already in use?):', accelerator);
          }
        } catch (error) {
          console.error('[PreciseVolume] Error registering volumeUp:', accelerator, error);
        }
      }

      if (config.globalShortcuts?.volumeDown) {
        const accelerator = normalizeAccelerator(config.globalShortcuts.volumeDown);
        console.log('[PreciseVolume] Normalized volumeDown accelerator:', config.globalShortcuts.volumeDown, '->', accelerator);
        try {
          const success = globalShortcut.register(
            accelerator,
            () => {
              console.log('[PreciseVolume] Volume Down shortcut triggered');
              ipc.send('changeVolume', false);
            },
          );
          if (success) {
            registeredShortcuts.volumeDown = accelerator;
            console.log('[PreciseVolume] Successfully registered volumeDown:', accelerator);
          } else {
            console.error('[PreciseVolume] Failed to register volumeDown (already in use?):', accelerator);
          }
        } catch (error) {
          console.error('[PreciseVolume] Error registering volumeDown:', accelerator, error);
        }
      }

      console.log('[PreciseVolume] All registered global shortcuts:', globalShortcut.isRegistered(config.globalShortcuts?.volumeUp || ''), globalShortcut.isRegistered(config.globalShortcuts?.volumeDown || ''));
    },

    async onConfigChange(newConfig) {
      if (!currentIpc) {
        console.warn('[PreciseVolume] onConfigChange called but no IPC available');
        return;
      }

      console.log('[PreciseVolume] Config changed:', newConfig.globalShortcuts);

      // Unregister old shortcuts
      if (registeredShortcuts.volumeUp) {
        globalShortcut.unregister(registeredShortcuts.volumeUp);
        console.log('[PreciseVolume] Unregistered old volumeUp:', registeredShortcuts.volumeUp);
      }
      if (registeredShortcuts.volumeDown) {
        globalShortcut.unregister(registeredShortcuts.volumeDown);
        console.log('[PreciseVolume] Unregistered old volumeDown:', registeredShortcuts.volumeDown);
      }
      registeredShortcuts = {};

      // Register new shortcuts
      if (newConfig.globalShortcuts?.volumeUp) {
        const accelerator = normalizeAccelerator(newConfig.globalShortcuts.volumeUp);
        console.log('[PreciseVolume] Normalized new volumeUp accelerator:', newConfig.globalShortcuts.volumeUp, '->', accelerator);
        try {
          const success = globalShortcut.register(
            accelerator,
            () => {
              console.log('[PreciseVolume] Volume Up shortcut triggered');
              currentIpc!.send('changeVolume', true);
            },
          );
          if (success) {
            registeredShortcuts.volumeUp = accelerator;
            console.log('[PreciseVolume] Registered new volumeUp:', accelerator);
          }
        } catch (error) {
          console.error('[PreciseVolume] Error registering new volumeUp:', accelerator, error);
        }
      }

      if (newConfig.globalShortcuts?.volumeDown) {
        const accelerator = normalizeAccelerator(newConfig.globalShortcuts.volumeDown);
        console.log('[PreciseVolume] Normalized new volumeDown accelerator:', newConfig.globalShortcuts.volumeDown, '->', accelerator);
        try {
          const success = globalShortcut.register(
            accelerator,
            () => {
              console.log('[PreciseVolume] Volume Down shortcut triggered');
              currentIpc!.send('changeVolume', false);
            },
          );
          if (success) {
            registeredShortcuts.volumeDown = accelerator;
            console.log('[PreciseVolume] Registered new volumeDown:', accelerator);
          }
        } catch (error) {
          console.error('[PreciseVolume] Error registering new volumeDown:', accelerator, error);
        }
      }
    },

    stop() {
      console.log('[PreciseVolume] Stopping backend');
      if (registeredShortcuts.volumeUp) {
        globalShortcut.unregister(registeredShortcuts.volumeUp);
      }
      if (registeredShortcuts.volumeDown) {
        globalShortcut.unregister(registeredShortcuts.volumeDown);
      }
      registeredShortcuts = {};
      currentIpc = null;
    },
  },

  renderer: {
    start() {
      overrideListener();
    },
    onPlayerApiReady,
    onConfigChange,
  },
});
