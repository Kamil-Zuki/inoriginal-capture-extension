import type { AnkiSettings, PopupContext, RuntimeResponse } from "./types";

export function sendRuntimeMessage<T>(message: unknown): Promise<RuntimeResponse<T>> {
  return chrome.runtime.sendMessage(message);
}

export async function getPopupContext(): Promise<PopupContext> {
  const response = await sendRuntimeMessage<never>({ type: "get-popup-context" });
  if (!response.ok || !response.context) {
    throw new Error(response.error || "Failed to load extension context.");
  }

  return response.context;
}

export async function saveAnkiSettings(settings: Partial<AnkiSettings>): Promise<AnkiSettings> {
  const response = await sendRuntimeMessage<never>({
    type: "save-anki-settings",
    settings
  });

  if (!response.ok || !response.settings) {
    throw new Error(response.error || "Failed to save settings.");
  }

  return response.settings;
}
