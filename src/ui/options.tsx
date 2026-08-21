import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { saveAnkiSettings, sendRuntimeMessage } from "../shared/chromeApi";
import type { AnkiSettings, FieldMapping, QualityRules } from "../shared/types";
import "./styles.css";

const QUALITY_PRESETS: Array<{
  description: string;
  label: string;
  rules: QualityRules;
}> = [
  {
    label: "Fast capture",
    description: "Let cards send quickly; use quality panel as advice.",
    rules: {
      requireWord: false,
      requireDefinition: false,
      requireTranslation: false,
      maxRecommendedAudioMs: 10000
    }
  },
  {
    label: "Balanced mining",
    description: "Require word and definition, keep translation optional.",
    rules: {
      requireWord: true,
      requireDefinition: true,
      requireTranslation: false,
      maxRecommendedAudioMs: 8500
    }
  },
  {
    label: "Strict mining",
    description: "Require word, definition, and translation before sending.",
    rules: {
      requireWord: true,
      requireDefinition: true,
      requireTranslation: true,
      maxRecommendedAudioMs: 6500
    }
  }
];

const DEFAULT_SETTINGS: AnkiSettings = {
  settingsVersion: 2,
  captureMode: "dom-fallback",
  endpoint: "http://127.0.0.1:8765",
  deckName: "Default",
  modelName: "Basic",
  rewindMs: 1200,
  maxClipMs: 8000,
  qualityRules: {
    requireWord: true,
    requireDefinition: true,
    requireTranslation: false,
    maxRecommendedAudioMs: 8500
  },
  translationMode: "after-capture",
  translationSourceLang: "en",
  translationTargetLang: "ru",
  tags: "inoriginal",
  fieldMapping: {
    expression: "Expression",
    word: "Word",
    image: "Image",
    audio: "Audio",
    transcription: "Transcription",
    source: "Source field",
    wordTypes: "Word Types",
    definition: "Definition",
    translation: "Translation",
    mnemonic: "Mnemonic",
    example: "Example",
    antonyms: "Antonyms",
    synonyms: "Synonyms",
    url: "Url field"
  }
};

function OptionsApp() {
  const [settings, setSettings] = useState<AnkiSettings>(DEFAULT_SETTINGS);
  const [deckNames, setDeckNames] = useState<string[]>([]);
  const [modelNames, setModelNames] = useState<string[]>([]);
  const [fieldNames, setFieldNames] = useState<string[]>([]);
  const [status, setStatus] = useState("Idle.");

  useEffect(() => {
    void initialize();
  }, []);

  async function initialize() {
    const { ankiSettings } = await chrome.storage.local.get("ankiSettings");
    const nextSettings = normalizeSettings(ankiSettings || {});
    setSettings(nextSettings);
    await refreshChoices(nextSettings);
  }

  async function testConnection() {
    setStatus("Testing AnkiConnect...");
    const response = await sendRuntimeMessage({
      type: "anki-action",
      action: "ping",
      payload: { endpoint: settings.endpoint }
    });
    setStatus(response.ok ? "Connected to AnkiConnect." : response.error || "Connection failed.");
  }

  async function refreshChoices(baseSettings = settings) {
    setStatus("Loading decks and note types...");
    const response = await sendRuntimeMessage<{
      deckNames: string[];
      modelNames: string[];
      modelFieldNames: string[];
    }>({
      type: "anki-action",
      action: "popupChoices",
      payload: {
        endpoint: baseSettings.endpoint,
        modelName: baseSettings.modelName
      }
    });

    if (!response.ok || !response.result) {
      setStatus(response.error || "Failed to load choices.");
      return;
    }

    setDeckNames(response.result.deckNames || []);
    setModelNames(response.result.modelNames || []);
    setFieldNames(response.result.modelFieldNames || []);
    setStatus("Loaded decks and note types.");
  }

  async function refreshFields(modelName: string) {
    const response = await sendRuntimeMessage<{ values: string[] }>({
      type: "anki-action",
      action: "modelFieldNames",
      payload: {
        endpoint: settings.endpoint,
        modelName
      }
    });

    if (response.ok && response.result?.values) {
      setFieldNames(response.result.values);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    try {
      const saved = await saveAnkiSettings(settings);
      setSettings(saved);
      setStatus("Settings saved.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save settings.");
    }
  }

  function updateFieldMapping(key: keyof FieldMapping, value: string) {
    setSettings({
      ...settings,
      fieldMapping: {
        ...settings.fieldMapping,
        [key]: value
      }
    });
  }

  function applyQualityPreset(rules: QualityRules) {
    setSettings({
      ...settings,
      qualityRules: rules
    });
  }

  return (
    <main className="panel panel--wide">
      <h1>InOriginal Capture Helper</h1>
      <p className="muted">Configure AnkiConnect, the target deck, the note type, and which note fields receive subtitle, screenshot, and audio content.</p>

      <form className="form-grid" onSubmit={handleSubmit}>
        <label>
          <span>Capture mode</span>
          <select value={settings.captureMode} onChange={(event) => setSettings({ ...settings, captureMode: event.target.value as AnkiSettings["captureMode"] })}>
            <option value="auto-vtt">Auto by VTT</option>
            <option value="manual-range">Manual range</option>
            <option value="dom-fallback">DOM subtitle fallback</option>
          </select>
        </label>

        <label>
          <span>AnkiConnect URL</span>
          <input value={settings.endpoint} onChange={(event) => setSettings({ ...settings, endpoint: event.target.value })} />
        </label>

        <div className="split-grid">
          <label>
            <span>Deck name</span>
            <select value={settings.deckName} onChange={(event) => setSettings({ ...settings, deckName: event.target.value })}>
              {renderOptions(deckNames, settings.deckName)}
            </select>
          </label>
          <label>
            <span>Note type</span>
            <select value={settings.modelName} onChange={(event) => {
              const modelName = event.target.value;
              setSettings({ ...settings, modelName });
              void refreshFields(modelName);
            }}>
              {renderOptions(modelNames, settings.modelName)}
            </select>
          </label>
        </div>

        <label>
          <span>Tags</span>
          <input value={settings.tags} onChange={(event) => setSettings({ ...settings, tags: event.target.value })} />
        </label>

        <label>
          <span>Rewind before recording: {(settings.rewindMs / 1000).toFixed(1)}s</span>
          <input
            max={2000}
            min={500}
            step={100}
            type="range"
            value={settings.rewindMs}
            onChange={(event) => setSettings({ ...settings, rewindMs: Number(event.target.value) })}
          />
        </label>

        <label>
          <span>Max audio clip length: {(settings.maxClipMs / 1000).toFixed(1)}s</span>
          <input
            max={15000}
            min={3000}
            step={500}
            type="range"
            value={settings.maxClipMs}
            onChange={(event) => setSettings({ ...settings, maxClipMs: Number(event.target.value) })}
          />
        </label>

        <h2>Smart Send / Card Quality</h2>
        <p className="muted">Choose how strict the Send button should be before a card is allowed into Anki.</p>
        <div className="quality-presets">
          {QUALITY_PRESETS.map((preset) => {
            const isActive = isSameQualityRules(settings.qualityRules, preset.rules);
            return (
              <button
                className={isActive ? "quality-preset quality-preset--active" : "quality-preset"}
                key={preset.label}
                onClick={() => applyQualityPreset(preset.rules)}
                type="button"
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            );
          })}
        </div>
        <div className="split-grid">
          <label className="toggle-row">
            <input
              checked={settings.qualityRules.requireWord}
              type="checkbox"
              onChange={(event) => setSettings({
                ...settings,
                qualityRules: {
                  ...settings.qualityRules,
                  requireWord: event.target.checked
                }
              })}
            />
            <span>Require target word</span>
          </label>
          <label className="toggle-row">
            <input
              checked={settings.qualityRules.requireDefinition}
              type="checkbox"
              onChange={(event) => setSettings({
                ...settings,
                qualityRules: {
                  ...settings.qualityRules,
                  requireDefinition: event.target.checked
                }
              })}
            />
            <span>Require definition</span>
          </label>
          <label className="toggle-row">
            <input
              checked={settings.qualityRules.requireTranslation}
              type="checkbox"
              onChange={(event) => setSettings({
                ...settings,
                qualityRules: {
                  ...settings.qualityRules,
                  requireTranslation: event.target.checked
                }
              })}
            />
            <span>Require translation</span>
          </label>
          <label>
            <span>Recommended max audio: {(settings.qualityRules.maxRecommendedAudioMs / 1000).toFixed(1)}s</span>
            <input
              max={15000}
              min={3000}
              step={500}
              type="range"
              value={settings.qualityRules.maxRecommendedAudioMs}
              onChange={(event) => setSettings({
                ...settings,
                qualityRules: {
                  ...settings.qualityRules,
                  maxRecommendedAudioMs: Number(event.target.value)
                }
              })}
            />
          </label>
        </div>

        <h2>Translation</h2>
        <label>
          <span>Translation mode</span>
          <select value={settings.translationMode} onChange={(event) => setSettings({ ...settings, translationMode: event.target.value as AnkiSettings["translationMode"] })}>
            <option value="after-capture">Auto after Capture</option>
            <option value="before-send">Auto before Send</option>
            <option value="manual">Manual only</option>
          </select>
        </label>
        <div className="split-grid">
          <label>
            <span>Subtitle language</span>
            <select value={settings.translationSourceLang} onChange={(event) => setSettings({ ...settings, translationSourceLang: event.target.value })}>
              {languageOptions(settings.translationSourceLang)}
            </select>
          </label>
          <label>
            <span>Translation language</span>
            <select value={settings.translationTargetLang} onChange={(event) => setSettings({ ...settings, translationTargetLang: event.target.value })}>
              {languageOptions(settings.translationTargetLang)}
            </select>
          </label>
        </div>

        <div className="actions">
          <button type="button" className="secondary" onClick={testConnection}>Test AnkiConnect</button>
          <button type="button" className="secondary" onClick={() => refreshChoices()}>Refresh decks and note types</button>
        </div>

        <h2>Field Mapping</h2>
        <div className="split-grid">
          {fieldSelector("Expression field", "expression", false)}
          {fieldSelector("Word field", "word", true)}
          {fieldSelector("Image field", "image", true)}
          {fieldSelector("Audio field", "audio", true)}
          {fieldSelector("Transcription field", "transcription", true)}
          {fieldSelector("Source field", "source", true)}
          {fieldSelector("Word Types field", "wordTypes", true)}
          {fieldSelector("Definition field", "definition", true)}
          {fieldSelector("Translation field", "translation", true)}
          {fieldSelector("Mnemonic field", "mnemonic", true)}
          {fieldSelector("Example field", "example", true)}
          {fieldSelector("Antonyms field", "antonyms", true)}
          {fieldSelector("Synonyms field", "synonyms", true)}
          {fieldSelector("Url field", "url", true)}
        </div>

        <div className="actions">
          <button type="submit">Save settings</button>
        </div>
      </form>

      <section className="troubleshooting-panel">
        <h2>Troubleshooting</h2>
        <p className="muted">
          Use when the VTT subtitle timeline is stale after changing episode, or cues no longer match the video.
        </p>
        <button
          className="secondary"
          onClick={() => void clearSubtitleCache()}
          type="button"
        >
          Clear subtitle cache
        </button>
      </section>

      <section>
        <h2>Status</h2>
        <p className="status">{status}</p>
      </section>
    </main>
  );

  async function clearSubtitleCache() {
    setStatus("Clearing subtitle cache…");
    const response = await sendRuntimeMessage({ type: "clear-subtitle-cache" });
    setStatus(
      response.ok
        ? "Subtitle cache cleared. Reload the InOriginal tab or capture again."
        : response.error || "Could not clear cache. Focus the InOriginal tab and try again."
    );
  }

  function fieldSelector(label: string, key: keyof FieldMapping, allowEmpty: boolean) {
    return (
      <label>
        <span>{label}</span>
        <select value={settings.fieldMapping[key]} onChange={(event) => updateFieldMapping(key, event.target.value)}>
          {allowEmpty && <option value="">Not used</option>}
          {renderOptions(fieldNames, settings.fieldMapping[key])}
        </select>
      </label>
    );
  }
}

function renderOptions(values: string[], selectedValue: string) {
  const options = values.includes(selectedValue) || !selectedValue
    ? values
    : [...values, selectedValue];

  return options.map((value) => (
    <option key={value} value={value}>{value}</option>
  ));
}

function languageOptions(selectedValue: string) {
  const languages = [
    ["en", "English"],
    ["ru", "Russian"],
    ["es", "Spanish"],
    ["fr", "French"],
    ["de", "German"],
    ["it", "Italian"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["zh", "Chinese"],
    ["uk", "Ukrainian"],
    ["pl", "Polish"],
    ["pt", "Portuguese"]
  ];
  const hasSelected = languages.some(([value]) => value === selectedValue);
  const options = hasSelected ? languages : [[selectedValue, selectedValue], ...languages];

  return options.map(([value, label]) => (
    <option key={value} value={value}>{label}</option>
  ));
}

function normalizeSettings(value: Partial<AnkiSettings>): AnkiSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    qualityRules: {
      ...DEFAULT_SETTINGS.qualityRules,
      ...(value.qualityRules || {})
    },
    fieldMapping: {
      ...DEFAULT_SETTINGS.fieldMapping,
      ...(value.fieldMapping || {})
    }
  };
}

function isSameQualityRules(left: QualityRules, right: QualityRules) {
  return left.requireWord === right.requireWord
    && left.requireDefinition === right.requireDefinition
    && left.requireTranslation === right.requireTranslation
    && left.maxRecommendedAudioMs === right.maxRecommendedAudioMs;
}

createRoot(document.getElementById("root")!).render(<OptionsApp />);
