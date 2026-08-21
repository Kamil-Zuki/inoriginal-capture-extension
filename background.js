const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const SESSION_KEY = "recordingSession";
const CAPTURE_KEY = "latestCapture";
const DRAFT_KEY = "sentenceDraft";
const ANKI_SETTINGS_KEY = "ankiSettings";
const CARD_HISTORY_KEY = "cardHistory";
const LAST_UNDOABLE_CARD_KEY = "lastUndoableCard";

const DEFAULT_ANKI_SETTINGS = {
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

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getAnkiSettings();
  await chrome.storage.local.set({
    [ANKI_SETTINGS_KEY]: settings
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "take-screenshot") {
      await takeScreenshot();
      return;
    }

    if (command === "toggle-recording") {
      await toggleRecording();
      return;
    }

    if (command === "capture-subtitle-clip") {
      await captureSubtitleClip();
      await openSidePanelForActiveWindow().catch(() => null);
      return;
    }

    if (command === "create-anki-card") {
      await createAnkiCardFromActiveTab();
    }
  } catch (error) {
    console.error(`Command ${command} failed`, error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "audio-recording-ready") {
    void handleAudioReady(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "recording-error") {
    void handleRecordingError(message.error)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "subtitle-clip-complete") {
    void finalizeSubtitleClip(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "audio-range-complete") {
    void stopCurrentCapture("range")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "subtitle-clip-start-recording") {
    void startSubtitleClipRecording(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-latest-capture") {
    void getLatestCapture()
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "get-popup-context") {
    void buildPopupContext()
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "clear-draft") {
    void clearDraft()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "clear-subtitle-cache") {
    void clearSubtitleTimelineCacheOnActiveTab()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "save-sentence-draft") {
    void saveSentenceDraft(message.draft || {})
      .then((draft) => sendResponse({ ok: true, result: draft }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "cancel-capture") {
    void cancelCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "stop-current-capture") {
    void stopCurrentCapture("manual")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "open-anki-note") {
    void openAnkiNote(message.noteId)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "undo-last-anki-card") {
    void undoLastAnkiCard(message.noteId)
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "take-screenshot") {
    void takeScreenshot()
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "toggle-recording") {
    void toggleRecording()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "capture-subtitle-clip") {
    void captureSubtitleClip()
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "recapture-subtitle-audio") {
    void captureSubtitleClip({ takeScreenshot: false })
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "record-audio-range") {
    void recordAudioRange(message.payload || {})
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "select-subtitle-cue") {
    void selectSubtitleCue(message.index)
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "create-anki-card") {
    void createAnkiCardFromActiveTab(message.payload || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "anki-action") {
    void handleAnkiAction(message.action, message.payload || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "save-anki-settings") {
    void saveAnkiSettings(message.settings || {})
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "translate-text") {
    void translateText(message.text || "", message.options || {})
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "lookup-word") {
    void lookupWord(message.word || "")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "find-duplicate-expression") {
    void findDuplicateExpression(message.expression || "")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

async function handleAnkiAction(action, payload) {
  const endpoint = payload.endpoint || null;

  if (action === "ping") {
    await invokeAnki("version", {}, endpoint);
    return { message: "Connected to AnkiConnect." };
  }

  if (action === "deckNames") {
    return { values: await invokeAnki("deckNames", {}, endpoint) };
  }

  if (action === "modelNames") {
    return { values: await invokeAnki("modelNames", {}, endpoint) };
  }

  if (action === "modelFieldNames") {
    if (!payload.modelName) {
      throw new Error("A note type is required.");
    }

    return {
      values: await invokeAnki("modelFieldNames", {
        modelName: payload.modelName
      }, endpoint)
    };
  }

  if (action === "popupChoices") {
    const settings = await getAnkiSettings();
    const resolvedEndpoint = endpoint || settings.endpoint;
    const modelName = payload.modelName || settings.modelName;
    const [deckNames, modelNames, modelFieldNames] = await Promise.all([
      invokeAnki("deckNames", {}, resolvedEndpoint),
      invokeAnki("modelNames", {}, resolvedEndpoint),
      modelName
        ? invokeAnki("modelFieldNames", { modelName }, resolvedEndpoint).catch(() => [])
        : Promise.resolve([])
    ]);

    return {
      deckNames,
      modelNames,
      modelFieldNames
    };
  }

  throw new Error(`Unsupported action: ${action}`);
}

async function toggleRecording() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId) {
    throw new Error("No active tab available.");
  }

  const session = await getSession();
  if (session?.tabId === tab.id) {
    await stopRecording(tab.id);
    return;
  }

  if (session?.tabId) {
    await stopRecording(session.tabId);
  }

  await startRecording(tab);
}

async function captureSubtitleClip(options = {}) {
  const { takeScreenshot = true } = options;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId || !tab.url?.startsWith("https://inoriginal.cc/")) {
    throw new Error("Open a page on https://inoriginal.cc/ before capturing a subtitle clip.");
  }

  const existingSession = await getSession();
  if (existingSession?.tabId) {
    await stopRecording(existingSession.tabId);
  }

  const settings = await getAnkiSettings();
  const captureMode = options.captureMode || settings.captureMode || "dom-fallback";
  const subtitleContext = await sendMessageToTab(tab.id, {
    type: "get-current-subtitle-context",
    captureMode
  });

  if (!subtitleContext?.currentSubtitle) {
    throw new Error("No active subtitle found to capture.");
  }

  const startedAt = Date.now();
  const selectedCue = captureMode === "dom-fallback" ? null : subtitleContext.cue;
  if (captureMode === "manual-range" && !selectedCue) {
    throw new Error("Manual range mode needs a VTT subtitle cue. Select a cue in the timeline or switch to DOM fallback.");
  }
  const draft = normalizeSentenceDraft({
    expression: subtitleContext.currentSubtitle,
    example: buildContextText({
      subtitle: subtitleContext.currentSubtitle,
      previousSubtitle: subtitleContext.previousSubtitle || "",
      nextSubtitle: subtitleContext.nextSubtitle || ""
    }),
    source: tab.title || "inoriginal",
    url: tab.url || ""
  });
  await saveSentenceDraft(draft);

  const previousCapture = takeScreenshot ? null : await getLatestCapture();
  const keptScreenshot = !takeScreenshot && previousCapture?.screenshot?.dataUrl
    ? previousCapture.screenshot
    : undefined;

  await chrome.storage.local.remove(CAPTURE_KEY);

  await mergeLatestCapture({
    capturedAt: startedAt,
    pageTitle: tab.title || "inoriginal",
    pageUrl: tab.url || "",
    subtitle: subtitleContext.currentSubtitle,
    previousSubtitle: subtitleContext.previousSubtitle || "",
    nextSubtitle: subtitleContext.nextSubtitle || "",
    subtitleCue: selectedCue,
    subtitleTimeline: subtitleContext.timeline,
    captureMode,
    cardState: "capturing",
    captureStep: takeScreenshot ? "screenshot" : "rewinding",
    error: "",
    audio: {},
    subtitles: {},
    ...(keptScreenshot ? { screenshot: keptScreenshot } : {}),
    captureEvents: [
      buildCaptureEvent(
        takeScreenshot ? "screenshot" : "rewinding",
        takeScreenshot ? "Capture started. Taking screenshot." : "Re-record started. Keeping existing screenshot."
      )
    ]
  });

  const screenshotCapture = takeScreenshot ? await takeScreenshotForTab(tab) : null;

  await chrome.storage.local.set({
    [SESSION_KEY]: {
      mode: "clip-waiting",
      requestedAt: startedAt,
      tabId: tab.id,
      pageTitle: tab.title || "inoriginal",
      pageUrl: tab.url || "",
      targetSubtitle: subtitleContext.currentSubtitle,
      previousSubtitle: subtitleContext.previousSubtitle || "",
      subtitleCue: selectedCue,
      subtitleTimeline: subtitleContext.timeline,
      captureMode
    }
  });

  await mergeLatestCapture({
    capturedAt: startedAt,
    pageTitle: tab.title || "inoriginal",
    pageUrl: tab.url || "",
    subtitle: subtitleContext.currentSubtitle,
    previousSubtitle: subtitleContext.previousSubtitle || "",
    nextSubtitle: subtitleContext.nextSubtitle || "",
    subtitleCue: selectedCue,
    subtitleTimeline: subtitleContext.timeline,
    captureMode,
    cardState: "capturing",
    captureStep: "rewinding",
    ...(screenshotCapture ? { screenshot: screenshotCapture.screenshot } : {})
  });
  await addCaptureEvent("rewinding", "Video rewind requested. Waiting for subtitle audio start.");

  try {
    await sendMessageToTab(tab.id, {
      type: "start-subtitle-clip",
      startedAt,
      targetSubtitle: subtitleContext.currentSubtitle,
      cue: selectedCue,
      captureMode,
      rewindMs: settings.rewindMs,
      maxClipMs: settings.maxClipMs
    });
  } catch (error) {
    await chrome.storage.local.remove(SESSION_KEY);
    await mergeLatestCapture({
      cardState: "review",
      captureStep: "failed",
      error: error.message || "Could not start subtitle capture in the page."
    });
    await addCaptureEvent("failed", error.message || "Could not start subtitle capture in the page.", "error");
    throw error;
  }

  return getLatestCapture();
}

async function stopClipAudioRecording(session, metadata = {}) {
  if (!session?.tabId) {
    return;
  }
  if (session.audioSource === "video-element") {
    await sendMessageToTab(session.tabId, {
      type: "stop-video-element-audio-recording",
      metadata
    }).catch(() => null);
    return;
  }
  await chrome.runtime.sendMessage({
    type: "stop-audio-recording",
    tabId: session.tabId,
    metadata
  }).catch(() => null);
}

async function startSubtitleClipRecording(message = {}) {
  const session = await getSession();
  if (!session?.tabId || !["clip-waiting", "clip"].includes(session.mode)) {
    throw new Error("There is no subtitle clip waiting to record.");
  }

  if (session.mode === "clip") {
    return;
  }

  const startedAt = Date.now();
  const videoStartTime = Number.isFinite(message.videoStartTime)
    ? message.videoStartTime
    : Number.isFinite(message.videoTime)
      ? message.videoTime
      : session.videoStartTime;
  const videoEndTime = Number.isFinite(message.videoEndTime)
    ? message.videoEndTime
    : session.videoEndTime;
  const plannedDurationMs = Number.isFinite(message.plannedDurationMs)
    ? message.plannedDurationMs
    : session.plannedDurationMs;
  const captureMode = session.captureMode || "dom-fallback";

  const baseSession = {
    ...session,
    captureMode,
    mode: "clip",
    plannedDurationMs,
    startedAt,
    videoEndTime,
    videoStartTime
  };

  const tryElementAudio = captureMode !== "dom-fallback";

  if (tryElementAudio) {
    const tabResponse = await sendMessageToTab(session.tabId, {
      type: "start-video-element-audio-recording",
      metadata: {
        captureMode,
        mode: "clip",
        videoEndTime,
        videoStartTime
      },
      startedAt
    }).catch(() => ({ ok: false, error: "Content script did not respond." }));

    if (tabResponse?.ok) {
      await chrome.storage.local.set({
        [SESSION_KEY]: {
          ...baseSession,
          audioSource: "video-element"
        }
      });
      await addCaptureEvent("recording-audio", "Recording audio from the video element (Web Audio API).");
      await mergeLatestCapture({
        cardState: "capturing",
        captureStep: "recording-audio"
      });
      if (Number.isFinite(plannedDurationMs) || Number.isFinite(videoStartTime) || Number.isFinite(videoEndTime)) {
        await addCaptureEvent(
          "recording-audio",
          `VTT plan: ${formatSeconds(videoStartTime || 0)} — ${formatSeconds(videoEndTime || 0)} (${((plannedDurationMs || 0) / 1000).toFixed(1)} s).`
        );
      }
      await addCaptureEvent("recording-audio", "Video-element recording started.", "success");
      return;
    }
    await addCaptureEvent(
      "recording-audio",
      `Web Audio from video unavailable (${tabResponse?.error || "error"}); falling back to tab capture.`,
      "warning"
    );
  }

  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: session.tabId
  });

  await chrome.storage.local.set({
    [SESSION_KEY]: {
      ...baseSession,
      audioSource: "tab"
    }
  });
  await addCaptureEvent("recording-audio", "Starting tab audio capture (tabCapture).");
  await mergeLatestCapture({
    cardState: "capturing",
    captureStep: "recording-audio"
  });
  if (Number.isFinite(message.plannedDurationMs) || Number.isFinite(videoStartTime) || Number.isFinite(videoEndTime)) {
    await addCaptureEvent(
      "recording-audio",
      `Cue-aware plan: ${formatSeconds(videoStartTime || 0)} to ${formatSeconds(videoEndTime || 0)} (${((message.plannedDurationMs || 0) / 1000).toFixed(1)}s).`
    );
  }

  const response = await chrome.runtime.sendMessage({
    type: "start-audio-recording",
    streamId,
    tabId: session.tabId,
    startedAt,
    metadata: {
      mode: "clip",
      captureMode,
      videoEndTime,
      videoStartTime
    }
  });

  if (!response?.ok) {
    await chrome.storage.local.remove(SESSION_KEY);
    await mergeLatestCapture({
      cardState: "review",
      captureStep: "failed",
      error: response?.error || "Chrome could not start tab audio capture."
    });
    await addCaptureEvent("failed", response?.error || "Chrome could not start tab audio capture.", "error");
    throw new Error(response?.error || "Chrome could not start tab audio capture.");
  }

  await addCaptureEvent("recording-audio", "Tab audio recording started.", "success");
}

async function takeScreenshot() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.windowId) {
    throw new Error("No active tab available.");
  }

  await takeScreenshotForTab(tab);
  return getLatestCapture();
}

async function takeScreenshotForTab(tab) {
  const capturedAt = Date.now();
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png"
  });
  const filename = buildFileName("screenshot", "png", capturedAt);

  await mergeLatestCapture({
    capturedAt,
    pageTitle: tab.title || "inoriginal",
    pageUrl: tab.url || "",
    screenshot: {
      dataUrl,
      filename
    }
  });

  return {
    capturedAt,
    screenshot: {
      dataUrl,
      filename
    }
  };
}

async function startRecording(tab) {
  if (!tab.id || !tab.url?.startsWith("https://inoriginal.cc/")) {
    throw new Error("Open a page on https://inoriginal.cc/ before recording.");
  }

  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  const startedAt = Date.now();
  await chrome.storage.local.set({
    [SESSION_KEY]: {
      startedAt,
      tabId: tab.id,
      pageTitle: tab.title || "inoriginal",
      pageUrl: tab.url || ""
    }
  });

  await chrome.runtime.sendMessage({
    type: "start-audio-recording",
    streamId,
    tabId: tab.id,
    startedAt
  });

  await sendMessageToTab(tab.id, {
    type: "start-subtitle-capture",
    startedAt
  });
}

async function stopRecording(tabId) {
  const session = await getSession();
  const stoppedAt = Date.now();

  if (tabId) {
    const subtitles = await sendMessageToTab(tabId, {
      type: "stop-subtitle-capture",
      stoppedAt
    }).catch(() => ({ entries: [], currentSubtitle: "", previousSubtitle: "", nextSubtitle: "" }));

    if (subtitles?.entries?.length) {
      const srtContent = toSrt(subtitles.entries, stoppedAt);
      const srtFilename = buildFileName("subtitles", "srt", session?.startedAt || stoppedAt);

      await mergeLatestCapture({
        capturedAt: stoppedAt,
        pageTitle: session?.pageTitle || "inoriginal",
        pageUrl: session?.pageUrl || "",
        subtitle: subtitles.currentSubtitle || subtitles.entries[subtitles.entries.length - 1]?.text || "",
        previousSubtitle: subtitles.previousSubtitle || "",
        nextSubtitle: subtitles.nextSubtitle || "",
        subtitles: {
          entries: subtitles.entries,
          srt: srtContent,
          filename: srtFilename,
          dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(srtContent)}`
        }
      });
    }
  }

  await chrome.runtime.sendMessage({
    type: "stop-audio-recording",
    tabId
  });

  await chrome.storage.local.remove(SESSION_KEY);
}

async function finalizeSubtitleClip(message) {
  const session = await getSession();
  if (!session?.tabId || session.mode !== "clip") {
    return;
  }

  const stoppedAt = Date.now();
  const subtitle = message.subtitle || session.targetSubtitle || "";
  const stopReason = message.stopReason || "subtitle-change";
  const cue = message.cue || session.subtitleCue;
  const plannedDurationMs = Number.isFinite(session.plannedDurationMs)
    ? session.plannedDurationMs
    : cue
      ? Math.max(500, Math.round((cue.end - cue.start) * 1000))
      : Math.max(500, stoppedAt - session.startedAt);
  const rawVideoStartTime = Number.isFinite(message.videoStartTime) ? message.videoStartTime : session.videoStartTime;
  const rawVideoEndTime = Number.isFinite(message.videoEndTime) ? message.videoEndTime : session.videoEndTime ?? cue?.end;
  const safeVideoStartTime = Number.isFinite(rawVideoStartTime) ? rawVideoStartTime : undefined;
  const safeVideoEndTime = Number.isFinite(rawVideoEndTime) && (!Number.isFinite(safeVideoStartTime) || rawVideoEndTime > safeVideoStartTime)
    ? rawVideoEndTime
    : Number.isFinite(safeVideoStartTime)
      ? safeVideoStartTime + plannedDurationMs / 1000
      : undefined;
  // Для режима next-cue-start и ручной остановки важнее фактическая длительность,
  // иначе UI/диагностика показывают "план", который может отличаться от реального конца.
  const effectiveDurationMs = Number.isFinite(safeVideoStartTime) && Number.isFinite(safeVideoEndTime)
    ? Math.max(250, Math.round((safeVideoEndTime - safeVideoStartTime) * 1000))
    : plannedDurationMs;
  const subtitleEntry = {
    atMs: 0,
    endMs: effectiveDurationMs,
    sessionStartedAt: session.startedAt,
    text: subtitle
  };

  await mergeLatestCapture({
    capturedAt: stoppedAt,
    pageTitle: session.pageTitle || "inoriginal",
    pageUrl: session.pageUrl || "",
    subtitle,
    previousSubtitle: message.previousSubtitle || session.previousSubtitle || "",
    nextSubtitle: message.nextSubtitle || "",
    subtitleCue: cue,
    subtitleTimeline: session.subtitleTimeline,
    cardState: "review",
    captureStep: "stopping",
    stopReason,
    subtitles: {
      entries: [subtitleEntry],
      srt: toSrt([subtitleEntry], stoppedAt),
      filename: buildFileName("subtitles", "srt", session.startedAt),
      dataUrl: `data:text/plain;charset=utf-8,${encodeURIComponent(toSrt([subtitleEntry], stoppedAt))}`
    }
  });
  await saveSentenceDraft({
    expression: subtitle,
    example: buildContextText({
      subtitle,
      previousSubtitle: message.previousSubtitle || session.previousSubtitle || "",
      nextSubtitle: message.nextSubtitle || ""
    }),
    source: session.pageTitle || "inoriginal",
    url: session.pageUrl || ""
  });
  await addCaptureEvent(
    "stopping",
    stopReason === "cue-end"
      ? "Subtitle cue ended. Stopping audio and pausing video."
      : stopReason === "max-duration"
      ? "Max clip length reached. Stopping audio and pausing video."
      : stopReason === "next-cue-start"
      ? "Next subtitle cue started. Stopping audio and pausing video."
      : stopReason === "subtitle-ended"
      ? "Subtitle disappeared from the screen. Stopping audio and pausing video."
      : "Subtitle changed. Stopping audio and pausing video.",
    stopReason === "max-duration" ? "warning" : "info"
  );

  await stopClipAudioRecording(session, {
    captureMode: session.captureMode || "dom-fallback",
    durationMs: effectiveDurationMs,
    stopReason,
    videoEndTime: safeVideoEndTime,
    videoStartTime: safeVideoStartTime
  });

  await sendMessageToTab(session.tabId, {
    type: "stop-subtitle-capture",
    stoppedAt
  }).catch(() => null);

  await chrome.storage.local.remove(SESSION_KEY);
}

async function recordAudioRange(payload) {
  const startOffsetMs = Math.max(-5000, Number(payload.startOffsetMs) || 0);
  const endOffsetMs = Math.max(startOffsetMs + 250, Number(payload.endOffsetMs) || 0);
  const latestCapture = await getLatestCapture();
  const audio = latestCapture?.audio;

  if (!audio?.videoStartTime && audio?.videoStartTime !== 0) {
    throw new Error("This audio clip has no video timing metadata yet. Capture again once, then range re-record will be available.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.windowId || !tab.url?.startsWith("https://inoriginal.cc/")) {
    throw new Error("Open the original InOriginal tab before re-recording a range.");
  }

  const startSeconds = Math.max(0, audio.videoStartTime + startOffsetMs / 1000);
  const endSeconds = Math.max(startSeconds + 0.25, audio.videoStartTime + endOffsetMs / 1000);
  const prepared = await sendMessageToTab(tab.id, {
    type: "prepare-audio-range",
    startSeconds,
    endSeconds
  });

  if (!prepared?.ok) {
    throw new Error(prepared?.error || "Could not prepare the video range.");
  }

  const startedAt = Date.now();
  await ensureOffscreenDocument();
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id
  });

  await chrome.storage.local.set({
    [SESSION_KEY]: {
      mode: "range",
      captureMode: "manual-range",
      requestedAt: startedAt,
      startedAt,
      tabId: tab.id,
      pageTitle: latestCapture?.pageTitle || tab.title || "inoriginal",
      pageUrl: latestCapture?.pageUrl || tab.url || "",
      targetSubtitle: latestCapture?.subtitle || "",
      videoStartTime: startSeconds,
      videoEndTime: endSeconds
    }
  });

  await mergeLatestCapture({
    cardState: "capturing",
    captureStep: "recording-audio",
    error: ""
  });
  await addCaptureEvent("recording-audio", `Re-recording selected audio range: ${formatSeconds(startOffsetMs / 1000)} to ${formatSeconds(endOffsetMs / 1000)}.`);

  const response = await chrome.runtime.sendMessage({
    type: "start-audio-recording",
    streamId,
    tabId: tab.id,
    startedAt,
    metadata: {
      mode: "range",
      captureMode: "manual-range",
      stopReason: "range",
      videoStartTime: startSeconds,
      videoEndTime: endSeconds
    }
  });

  if (!response?.ok) {
    await chrome.storage.local.remove(SESSION_KEY);
    throw new Error(response?.error || "Chrome could not start tab audio capture.");
  }

  await sendMessageToTab(tab.id, {
    type: "play-prepared-audio-range",
    endSeconds
  });

  const durationMs = Math.ceil((endSeconds - startSeconds) * 1000);
  setTimeout(() => {
    void stopCurrentCapture("range").catch(() => null);
  }, durationMs + 500);

  return getLatestCapture();
}

async function selectSubtitleCue(index) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://inoriginal.cc/")) {
    throw new Error("Open the original InOriginal tab before selecting a subtitle.");
  }

  const context = await sendMessageToTab(tab.id, {
    type: "select-subtitle-cue",
    index
  });

  if (!context?.currentSubtitle) {
    throw new Error("Could not select subtitle cue.");
  }

  const latestCapture = await getLatestCapture();
  await mergeLatestCapture({
    capturedAt: Date.now(),
    pageTitle: latestCapture?.pageTitle || tab.title || "inoriginal",
    pageUrl: latestCapture?.pageUrl || tab.url || "",
    subtitle: context.currentSubtitle,
    previousSubtitle: context.previousSubtitle || "",
    nextSubtitle: context.nextSubtitle || "",
    subtitleCue: context.cue,
    subtitleTimeline: context.timeline,
    error: ""
  });
  await saveSentenceDraft({
    expression: context.currentSubtitle,
    example: buildContextText({
      subtitle: context.currentSubtitle,
      previousSubtitle: context.previousSubtitle || "",
      nextSubtitle: context.nextSubtitle || ""
    }),
    source: latestCapture?.pageTitle || tab.title || "inoriginal",
    url: latestCapture?.pageUrl || tab.url || ""
  });

  return getLatestCapture();
}

async function stopCurrentCapture(stopReason = "manual") {
  const session = await getSession();
  if (!session?.tabId) {
    throw new Error("There is no active audio capture to stop.");
  }

  const stoppedAt = Date.now();
  const subtitles = await sendMessageToTab(session.tabId, {
    type: "stop-subtitle-capture",
    stoppedAt
  }).catch(() => ({ currentSubtitle: session.targetSubtitle || "", previousSubtitle: "", nextSubtitle: "", videoTime: undefined }));
  await sendMessageToTab(session.tabId, {
    type: "pause-video-playback"
  }).catch(() => null);

  await mergeLatestCapture({
    capturedAt: stoppedAt,
    pageTitle: session.pageTitle || "inoriginal",
    pageUrl: session.pageUrl || "",
    subtitle: session.targetSubtitle || subtitles.currentSubtitle || "",
    previousSubtitle: subtitles.previousSubtitle || "",
    nextSubtitle: subtitles.nextSubtitle || "",
    cardState: "review",
    captureStep: "stopping",
    error: ""
  });
  await addCaptureEvent("stopping", stopReason === "range" ? "Selected audio range finished." : "Audio recording stopped manually.", "success");

  await stopClipAudioRecording(session, {
    captureMode: session.captureMode || (session.mode === "range" ? "manual-range" : undefined),
    durationMs: session.startedAt ? stoppedAt - session.startedAt : undefined,
    stopReason,
    videoEndTime: session.videoEndTime ?? subtitles.videoTime,
    videoStartTime: session.videoStartTime
  });

  await chrome.storage.local.remove(SESSION_KEY);
}

async function createAnkiCardFromActiveTab(overrides = {}) {
  const session = await getSession();
  if (session?.tabId) {
    throw new Error("Wait until audio capture finishes before creating the card.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab available.");
  }

  const subtitlePayload = await sendMessageToTab(tab.id, {
    type: "get-current-subtitle-context"
  }).catch(() => ({
    currentSubtitle: "",
    previousSubtitle: "",
    nextSubtitle: ""
  }));

  let latestCapture = await getLatestCapture();
  if (!latestCapture?.screenshot?.dataUrl) {
    latestCapture = await takeScreenshot();
  }

  const storedDraft = await getSentenceDraft();
  const draft = normalizeSentenceDraft({
    ...storedDraft,
    ...(overrides.draft || {})
  });
  const draftExpression = draft.expression.trim();
  const subtitle = overrides.subtitle || draftExpression || latestCapture?.subtitle || subtitlePayload.currentSubtitle || "";
  if (!subtitle) {
    throw new Error("No subtitle text found in #pjs_playerjs_subtitle > span.");
  }

  await mergeLatestCapture({
    capturedAt: Date.now(),
    pageTitle: draft.source || latestCapture?.pageTitle || tab.title || "inoriginal",
    pageUrl: draft.url || latestCapture?.pageUrl || tab.url || "",
    subtitle,
    previousSubtitle: latestCapture?.previousSubtitle || subtitlePayload.previousSubtitle || "",
    nextSubtitle: latestCapture?.nextSubtitle || subtitlePayload.nextSubtitle || ""
  });

  await mergeLatestCapture({
    captureStep: "sending-anki"
  });
  await addCaptureEvent("sending-anki", "Sending note payload to AnkiConnect.");

  latestCapture = await getLatestCapture();
  let noteId;
  try {
    noteId = await createAnkiNote(latestCapture, {
      ...overrides,
      draft
    });
  } catch (error) {
    await mergeLatestCapture({
      cardState: "review",
      captureStep: "failed",
      error: error.message || "Failed to create Anki note."
    });
    await addCaptureEvent("failed", error.message || "Failed to create Anki note.", "error");
    throw error;
  }

  const createdAt = Date.now();
  await mergeLatestCapture({
    cardState: "created",
    captureStep: "created",
    noteId,
    createdAt
  });
  await addCaptureEvent("created", `Anki note created: ${noteId}.`, "success");
  latestCapture = await getLatestCapture();
  await saveLastUndoableCard({
    noteId,
    createdAt,
    capture: latestCapture,
    sentenceDraft: draft
  });
  await addCardHistory({
    noteId,
    subtitle,
    pageTitle: latestCapture?.pageTitle || "",
    pageUrl: latestCapture?.pageUrl || "",
    createdAt
  });
  return { noteId };
}

async function createAnkiNote(capture, overrides = {}) {
  if (!capture) {
    throw new Error("There is no capture data available yet.");
  }

  const settings = await getMergedAnkiSettings(overrides.settings || {});
  await validateFieldMapping(settings);
  const draft = buildSentenceMiningDraft(capture, overrides.draft || {});

  const fields = {};
  setFieldValue(fields, settings.fieldMapping.expression, draft.expression);
  setFieldValue(fields, settings.fieldMapping.word, draft.word);
  setFieldValue(fields, settings.fieldMapping.transcription, draft.transcription);
  setFieldValue(fields, settings.fieldMapping.source, draft.source);
  setFieldValue(fields, settings.fieldMapping.wordTypes, draft.wordTypes);
  setFieldValue(fields, settings.fieldMapping.definition, draft.definition);
  setFieldValue(fields, settings.fieldMapping.translation, draft.translation);
  setFieldValue(fields, settings.fieldMapping.mnemonic, draft.mnemonic);
  setFieldValue(fields, settings.fieldMapping.example, draft.example);
  setFieldValue(fields, settings.fieldMapping.antonyms, draft.antonyms);
  setFieldValue(fields, settings.fieldMapping.synonyms, draft.synonyms);
  setFieldValue(fields, settings.fieldMapping.url, draft.url);

  if (capture.screenshot?.dataUrl && settings.fieldMapping.image) {
    const imageFileName = await storeMediaFromDataUrl(
      capture.screenshot.dataUrl,
      ensureExtension(capture.screenshot.filename, "png")
    );
    setFieldValue(fields, settings.fieldMapping.image, `<img src="${imageFileName}">`);
  }

  if (capture.audio?.dataUrl && settings.fieldMapping.audio) {
    const audioFileName = await storeMediaFromDataUrl(
      capture.audio.dataUrl,
      ensureExtension(capture.audio.filename, "webm")
    );
    setFieldValue(fields, settings.fieldMapping.audio, `[sound:${audioFileName}]`);
  }

  const note = {
    deckName: settings.deckName,
    modelName: settings.modelName,
    fields,
    tags: parseTags(settings.tags)
  };

  return invokeAnki("addNote", { note });
}

async function validateFieldMapping(settings) {
  const availableFields = await invokeAnki("modelFieldNames", {
    modelName: settings.modelName
  });
  const available = new Set(availableFields);
  const mappings = settings.fieldMapping || {};
  const requiredMappings = [
    ["Expression", mappings.expression]
  ];
  const optionalMappings = [
    ["Word", mappings.word],
    ["Image", mappings.image],
    ["Audio", mappings.audio],
    ["Transcription", mappings.transcription],
    ["Source", mappings.source],
    ["Word Types", mappings.wordTypes],
    ["Definition", mappings.definition],
    ["Translation", mappings.translation],
    ["Mnemonic", mappings.mnemonic],
    ["Example", mappings.example],
    ["Antonyms", mappings.antonyms],
    ["Synonyms", mappings.synonyms],
    ["Url", mappings.url]
  ];

  const missingRequired = requiredMappings
    .filter(([, fieldName]) => !fieldName || !available.has(fieldName))
    .map(([label, fieldName]) => `${label} -> ${fieldName || "not selected"}`);
  const missingOptional = optionalMappings
    .filter(([, fieldName]) => fieldName && !available.has(fieldName))
    .map(([label, fieldName]) => `${label} -> ${fieldName}`);

  if (missingRequired.length || missingOptional.length) {
    throw new Error(
      `Field mapping does not match note type "${settings.modelName}". Missing: ${[
        ...missingRequired,
        ...missingOptional
      ].join(", ")}. Open Bind Anki template fields and choose fields from this note type.`
    );
  }
}

async function handleAudioReady(message) {
  const filename = buildFileName("audio", "webm", message.startedAt);
  const currentCapture = await getLatestCapture();
  await mergeLatestCapture({
    capturedAt: Date.now(),
    cardState: "review",
    captureStep: "review-ready",
    error: "",
    audio: {
      dataUrl: message.dataUrl,
      filename,
      durationMs: message.metadata?.durationMs,
      stopReason: message.metadata?.stopReason,
      videoStartTime: message.metadata?.videoStartTime,
      videoEndTime: message.metadata?.videoEndTime,
      recordingStartedAt: message.metadata?.recordingStartedAt,
      recordingStoppedAt: message.metadata?.recordingStoppedAt
    },
    captureMode: message.metadata?.captureMode || currentCapture?.captureMode || "dom-fallback"
  });
  await addCaptureEvent("review-ready", "Audio saved. Draft is ready to review.", "success");
}

async function handleRecordingError(error) {
  const session = await getSession();
  if (session?.tabId) {
    await stopClipAudioRecording(session, { discard: true }).catch(() => null);
    await sendMessageToTab(session.tabId, {
      type: "stop-subtitle-capture",
      stoppedAt: Date.now()
    }).catch(() => null);
  }

  await chrome.storage.local.remove(SESSION_KEY);
  await mergeLatestCapture({
    cardState: "review",
    captureStep: "failed",
    error: error || "Audio recording failed."
  });
  await addCaptureEvent("failed", error || "Audio recording failed.", "error");
}

async function cancelCapture() {
  const session = await getSession();
  if (session?.tabId) {
    await stopClipAudioRecording(session, { discard: true }).catch(() => null);
    await sendMessageToTab(session.tabId, {
      type: "stop-subtitle-capture",
      stoppedAt: Date.now()
    }).catch(() => null);
  }

  await chrome.storage.local.remove(SESSION_KEY);
  await mergeLatestCapture({
    cardState: "review",
    captureStep: "cancelled",
    error: "Capture cancelled."
  });
  await addCaptureEvent("cancelled", "Capture cancelled by user.", "warning");
}

async function storeMediaFromDataUrl(dataUrl, filename) {
  const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
  await invokeAnki("storeMediaFile", {
    filename,
    data: base64
  });
  return filename;
}

async function translateText(text, options = {}) {
  const value = text.trim();
  if (!value) {
    throw new Error("No text to translate.");
  }

  const settings = await getAnkiSettings();
  const sourceLang = options.sourceLang || settings.translationSourceLang || "en";
  const targetLang = options.targetLang || settings.translationTargetLang || "ru";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(value)}&langpair=${encodeURIComponent(`${sourceLang}|${targetLang}`)}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Translation request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  const translatedText = payload?.responseData?.translatedText || "";
  if (!translatedText) {
    throw new Error("Translator returned an empty result.");
  }

  return {
    provider: "MyMemory",
    sourceLang,
    targetLang,
    translatedText
  };
}

async function lookupWord(word) {
  const value = word.trim();
  if (!value) {
    throw new Error("No word selected.");
  }

  const candidates = buildDictionaryCandidates(value);
  let payload = null;
  let resolvedWord = value;
  for (const candidate of candidates) {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(candidate)}`);
    if (response.ok) {
      payload = await response.json();
      resolvedWord = candidate;
      break;
    }
  }

  if (!payload) {
    throw new Error(`No dictionary entry found for "${value}".`);
  }

  const entry = Array.isArray(payload) ? payload[0] : null;
  const phonetic = entry?.phonetic || entry?.phonetics?.find((item) => item.text)?.text || "";
  const meaning = entry?.meanings?.find((item) => item.definitions?.length);
  const definition = meaning?.definitions?.[0]?.definition || "";
  const example = meaning?.definitions?.[0]?.example || "";
  const partOfSpeech = meaning?.partOfSpeech || "";
  const wordTypes = [...new Set((entry?.meanings || []).map((item) => item.partOfSpeech).filter(Boolean))];
  const synonyms = [...new Set((entry?.meanings || []).flatMap((item) => [
    ...(item.synonyms || []),
    ...((item.definitions || []).flatMap((definitionItem) => definitionItem.synonyms || []))
  ]).filter(Boolean))].slice(0, 8);
  const antonyms = [...new Set((entry?.meanings || []).flatMap((item) => [
    ...(item.antonyms || []),
    ...((item.definitions || []).flatMap((definitionItem) => definitionItem.antonyms || []))
  ]).filter(Boolean))].slice(0, 8);

  if (!definition) {
    throw new Error(`No usable definition found for "${value}".`);
  }

  return {
    antonyms: antonyms.join(", "),
    definition,
    example,
    partOfSpeech,
    phonetic,
    provider: "Free Dictionary API",
    synonyms: synonyms.join(", "),
    wordTypes: wordTypes.join(", "),
    word: resolvedWord
  };
}

function buildDictionaryCandidates(value) {
  const lower = value.toLowerCase().replace(/[’`]/g, "'");
  const stripped = lower.replace(/'s$/, "");
  const candidates = [
    value,
    lower,
    stripped
  ];

  if (stripped.endsWith("ies") && stripped.length > 4) {
    candidates.push(`${stripped.slice(0, -3)}y`);
  }
  if (stripped.endsWith("ing") && stripped.length > 5) {
    candidates.push(stripped.slice(0, -3));
    candidates.push(`${stripped.slice(0, -3)}e`);
  }
  if (stripped.endsWith("ed") && stripped.length > 4) {
    candidates.push(stripped.slice(0, -2));
    candidates.push(`${stripped.slice(0, -1)}`);
  }
  if (stripped.endsWith("s") && stripped.length > 3) {
    candidates.push(stripped.slice(0, -1));
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function findDuplicateExpression(expression) {
  const value = expression.trim();
  if (!value) {
    return { count: 0, noteIds: [] };
  }

  const settings = await getAnkiSettings();
  const query = `deck:${quoteAnkiQuery(settings.deckName)} ${quoteAnkiQuery(value)}`;
  const noteIds = await invokeAnki("findNotes", {
    query
  }).catch(() => []);

  return {
    count: noteIds.length,
    noteIds
  };
}

async function invokeAnki(action, params, endpointOverride = null) {
  const settings = await getAnkiSettings();
  const endpoint = endpointOverride || settings.endpoint;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      action,
      version: 6,
      params
    })
  });

  if (!response.ok) {
    throw new Error(`AnkiConnect request failed with status ${response.status}.`);
  }

  const payload = await response.json();
  if (payload.error) {
    throw new Error(payload.error);
  }

  return payload.result;
}

async function buildPopupContext() {
  const [capture, settings, session, activeTabContext, cardHistory, sentenceDraft] = await Promise.all([
    getLatestCapture(),
    getAnkiSettings(),
    getSession(),
    getActiveTabSubtitleContext(),
    getCardHistory(),
    getSentenceDraft()
  ]);

  const choices = await handleAnkiAction("popupChoices", {});
  // Живые субтитры вкладки — только во время активного захвата, не после clear / в review.
  const isActiveCapture = Boolean(session) || capture?.cardState === "capturing";
  const shouldUseLiveSubtitle = isActiveCapture && capture?.cardState !== "created";
  let mergedCapture = capture || undefined;
  if (shouldUseLiveSubtitle && activeTabContext) {
    mergedCapture = {
      ...(capture || {}),
      ...activeTabContext
    };
  }

  return {
    capture: mergedCapture,
    sentenceDraft,
    settings,
    choices,
    cardHistory,
    isRecording: Boolean(session),
    sessionMode: session?.mode || null
  };
}

async function getActiveTabSubtitleContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://inoriginal.cc/")) {
    return null;
  }

  const context = await sendMessageToTab(tab.id, {
    type: "get-current-subtitle-context"
  }).catch(() => null);

  if (!context) {
    return null;
  }

  return {
    subtitle: context.currentSubtitle || "",
    previousSubtitle: context.previousSubtitle || "",
    nextSubtitle: context.nextSubtitle || "",
    subtitleCue: context.cue,
    subtitleTimeline: context.timeline,
    currentVideoTime: context.videoTime
  };
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const contexts = typeof chrome.runtime.getContexts === "function"
    ? await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl]
      })
    : [];

  if (contexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA"],
    justification: "Record tab audio while the extension service worker stays lightweight."
  });
}

async function sendMessageToTab(tabId, message) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  return chrome.tabs.sendMessage(tabId, message);
}

/** Сброс закэшированного VTT-таймлайна во вкладке с плеером (SPA без смены URL). */
async function clearSubtitleTimelineCacheOnActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab.");
  }

  try {
    await sendMessageToTab(tab.id, { type: "clear-subtitle-timeline-cache" });
  } catch (_) {
    /* Страница без нашего content script — тихо игнорируем. */
  }

  const capture = await getLatestCapture();
  if (capture?.subtitleTimeline || capture?.subtitleCue) {
    await mergeLatestCapture({
      subtitleCue: undefined,
      subtitleTimeline: undefined
    });
  }
}

async function getSession() {
  const data = await chrome.storage.local.get(SESSION_KEY);
  return data[SESSION_KEY];
}

async function getLatestCapture() {
  const data = await chrome.storage.local.get(CAPTURE_KEY);
  return data[CAPTURE_KEY];
}

async function getSentenceDraft() {
  const data = await chrome.storage.local.get(DRAFT_KEY);
  return normalizeSentenceDraft(data[DRAFT_KEY] || {});
}

async function getAnkiSettings() {
  const data = await chrome.storage.local.get(ANKI_SETTINGS_KEY);
  return normalizeAnkiSettings(data[ANKI_SETTINGS_KEY] || {});
}

async function getCardHistory() {
  const data = await chrome.storage.local.get(CARD_HISTORY_KEY);
  return data[CARD_HISTORY_KEY] || [];
}

async function getLastUndoableCard() {
  const data = await chrome.storage.local.get(LAST_UNDOABLE_CARD_KEY);
  return data[LAST_UNDOABLE_CARD_KEY] || null;
}

async function getMergedAnkiSettings(partialSettings) {
  const stored = await getAnkiSettings();
  return normalizeAnkiSettings({
    ...stored,
    ...partialSettings,
    fieldMapping: {
      ...stored.fieldMapping,
      ...(partialSettings.fieldMapping || {})
    }
  });
}

async function saveAnkiSettings(settings) {
  const merged = await getMergedAnkiSettings(settings);
  await chrome.storage.local.set({
    [ANKI_SETTINGS_KEY]: merged
  });
  return merged;
}

async function saveSentenceDraft(draft) {
  const previous = await getSentenceDraft();
  const nextDraft = normalizeSentenceDraft({
    ...previous,
    ...draft
  });

  await chrome.storage.local.set({
    [DRAFT_KEY]: nextDraft
  });
  return nextDraft;
}

async function clearDraft() {
  const session = await getSession();
  if (session?.tabId) {
    await stopClipAudioRecording(session, { discard: true }).catch(() => null);
    await sendMessageToTab(session.tabId, {
      type: "stop-subtitle-capture",
      stoppedAt: Date.now()
    }).catch(() => null);
  }

  await chrome.storage.local.remove([SESSION_KEY, CAPTURE_KEY, DRAFT_KEY, LAST_UNDOABLE_CARD_KEY]);
}

async function addCardHistory(entry) {
  const previous = await getCardHistory();
  await chrome.storage.local.set({
    [CARD_HISTORY_KEY]: [entry, ...previous].slice(0, 3)
  });
}

async function saveLastUndoableCard(entry) {
  await chrome.storage.local.set({
    [LAST_UNDOABLE_CARD_KEY]: entry
  });
}

async function removeCardHistoryItem(noteId) {
  const previous = await getCardHistory();
  await chrome.storage.local.set({
    [CARD_HISTORY_KEY]: previous.filter((entry) => entry.noteId !== noteId)
  });
}

async function openAnkiNote(noteId) {
  if (!noteId) {
    throw new Error("No Anki note id is available.");
  }

  return invokeAnki("guiBrowse", {
    query: `nid:${noteId}`
  });
}

async function undoLastAnkiCard(noteIdOverride) {
  const capture = await getLatestCapture();
  const undoableCard = await getLastUndoableCard();
  const noteId = Number(noteIdOverride || capture?.noteId || undoableCard?.noteId);
  if (!noteId) {
    throw new Error("No created Anki note is available to undo.");
  }

  await invokeAnki("deleteNotes", {
    notes: [noteId]
  });
  await removeCardHistoryItem(noteId);

  const snapshot = undoableCard?.noteId === noteId ? undoableCard : null;
  const captureToRestore = snapshot?.capture || capture || {};
  const restoredCapture = {
    ...captureToRestore,
    cardState: "review",
    captureStep: "review-ready",
    error: "",
    captureEvents: [
      buildCaptureEvent("review-ready", `Deleted Anki note ${noteId}. Draft restored for editing.`, "warning"),
      ...((captureToRestore.captureEvents || []).filter((event) => event.step !== "created"))
    ].slice(0, 8)
  };
  delete restoredCapture.noteId;
  delete restoredCapture.createdAt;

  const storageUpdate = {
    [CAPTURE_KEY]: restoredCapture
  };
  if (snapshot?.sentenceDraft) {
    storageUpdate[DRAFT_KEY] = normalizeSentenceDraft(snapshot.sentenceDraft);
  }

  await chrome.storage.local.set(storageUpdate);
  await chrome.storage.local.remove(LAST_UNDOABLE_CARD_KEY);
  return restoredCapture;
}

async function openSidePanelForActiveWindow() {
  if (typeof chrome.sidePanel?.open !== "function") {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.windowId) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

async function addCaptureEvent(step, message, level = "info") {
  const previous = (await getLatestCapture()) || {};
  await mergeLatestCapture({
    captureStep: step,
    captureEvents: [
      buildCaptureEvent(step, message, level),
      ...(previous.captureEvents || [])
    ].slice(0, 8)
  });
}

function buildCaptureEvent(step, message, level = "info") {
  return {
    at: Date.now(),
    level,
    message,
    step
  };
}

async function mergeLatestCapture(partialCapture) {
  const previous = (await getLatestCapture()) || {};
  const nextCapture = {
    ...previous,
    ...partialCapture,
    screenshot: {
      ...(previous.screenshot || {}),
      ...(partialCapture.screenshot || {})
    },
    audio: {
      ...(previous.audio || {}),
      ...(partialCapture.audio || {})
    },
    subtitles: {
      ...(previous.subtitles || {}),
      ...(partialCapture.subtitles || {})
    }
  };

  await chrome.storage.local.set({
    [CAPTURE_KEY]: nextCapture
  });
}

function normalizeAnkiSettings(value) {
  const storedVersion = Number(value?.settingsVersion) || 0;
  const storedCaptureMode = value?.captureMode;
  const captureMode = ["auto-vtt", "manual-range", "dom-fallback"].includes(storedCaptureMode)
    ? storedVersion < 2 && storedCaptureMode === "auto-vtt"
      ? "dom-fallback"
      : storedCaptureMode
    : DEFAULT_ANKI_SETTINGS.captureMode;

  return {
    ...DEFAULT_ANKI_SETTINGS,
    ...value,
    settingsVersion: DEFAULT_ANKI_SETTINGS.settingsVersion,
    captureMode,
    qualityRules: {
      ...DEFAULT_ANKI_SETTINGS.qualityRules,
      ...(value.qualityRules || {})
    },
    fieldMapping: {
      ...DEFAULT_ANKI_SETTINGS.fieldMapping,
      ...(value.fieldMapping || {})
    }
  };
}

function normalizeSentenceDraft(value = {}) {
  return {
    expression: value.expression || "",
    word: value.word || "",
    transcription: value.transcription || "",
    wordTypes: value.wordTypes || "",
    translation: value.translation || "",
    definition: value.definition || "",
    example: value.example || "",
    synonyms: value.synonyms || "",
    antonyms: value.antonyms || "",
    source: value.source || "",
    url: value.url || ""
  };
}

function setFieldValue(fields, fieldName, value) {
  if (!fieldName) {
    return;
  }

  fields[fieldName] = value || "";
}

function parseTags(tags) {
  return tags
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function buildContextText(capture) {
  const lines = [];

  if (capture.previousSubtitle) {
    lines.push(`Previous: ${capture.previousSubtitle}`);
  }

  if (capture.subtitle) {
    lines.push(`Current: ${capture.subtitle}`);
  }

  if (capture.nextSubtitle) {
    lines.push(`Next: ${capture.nextSubtitle}`);
  }

  if (capture.subtitles?.srt) {
    lines.push("");
    lines.push(capture.subtitles.srt);
  }

  return lines.join("\n");
}

function buildSentenceMiningDraft(capture, draftOverrides) {
  return {
    expression: draftOverrides.expression ?? capture.subtitle ?? "",
    word: draftOverrides.word ?? "",
    transcription: draftOverrides.transcription ?? "",
    source: draftOverrides.source ?? capture.pageTitle ?? "",
    wordTypes: draftOverrides.wordTypes ?? "",
    definition: draftOverrides.definition ?? "",
    translation: draftOverrides.translation ?? "",
    mnemonic: draftOverrides.mnemonic ?? "",
    example: draftOverrides.example ?? buildContextText(capture),
    antonyms: draftOverrides.antonyms ?? "",
    synonyms: draftOverrides.synonyms ?? "",
    url: draftOverrides.url ?? capture.pageUrl ?? ""
  };
}

function buildFileName(prefix, extension, timestamp) {
  const stamp = new Date(timestamp)
    .toISOString()
    .replace(/[:.]/g, "-");
  return `${prefix}-${stamp}.${extension}`;
}

function ensureExtension(filename, extension) {
  return filename.endsWith(`.${extension}`) ? filename : `${filename}.${extension}`;
}

function formatSeconds(value) {
  return `${value.toFixed(1)}s`;
}

function quoteAnkiQuery(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function toSrt(entries, stoppedAt) {
  return entries
    .map((entry, index) => {
      const next = entries[index + 1];
      const sessionStartMs = entry.sessionStartedAt || 0;
      const fallbackEndMs = stoppedAt - sessionStartMs;
      const start = formatSrtTime(entry.atMs);
      const end = formatSrtTime(
        Math.max(entry.atMs + 500, next?.atMs ?? entry.endMs ?? fallbackEndMs)
      );

      return `${index + 1}\n${start} --> ${end}\n${entry.text}\n`;
    })
    .join("\n");
}

function formatSrtTime(totalMs) {
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = Math.floor(totalMs % 1000);

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":") + `,${String(milliseconds).padStart(3, "0")}`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
