(function initContentScript() {
  if (window.__inoriginalCaptureInstalled) {
    return;
  }

  window.__inoriginalCaptureInstalled = true;

  /** Один граф Web Audio на каждый элемент video (повторный createMediaElementSource вызывает ошибку). */
  const videoElementAudioRoutes = new WeakMap();

  const state = {
    entries: [],
    isRecording: false,
    observer: null,
    subtitleElement: null,
    startedAt: 0,
    pollTimer: null,
    clipPollTimer: null,
    clipFallbackTimer: null,
    clipMaxTimer: null,
    rangeTimer: null,
    lastText: "",
    clipMode: null,
    timeline: null,
    timelinePromise: null,
    // URL страницы + активный эпизод (SPA: path не меняется при смене серии).
    timelinePageSignature: null,
    /** Запись аудио с graph video→MediaStreamDestination (не захват всей вкладки). */
    elementAudioSession: null,
    episodeKeyPollTimer: null,
    lastTrackedEpisodeKey: "",
    /** Увеличивается при сбросе кэша — отменяет запись результата от устаревшего запроса loadSubtitleTimeline. */
    subtitleTimelineEpoch: 0
  };

  /** Сброс кэша таймлайна при навигации без полной перезагрузки (другой сериал/эпизод). */
  function clearSubtitleTimelineCache() {
    state.subtitleTimelineEpoch += 1;
    state.timeline = null;
    state.timelinePageSignature = null;
    state.timelinePromise = null;
  }

  if (typeof window !== "undefined") {
    window.addEventListener("popstate", clearSubtitleTimelineCache);
    window.addEventListener("hashchange", clearSubtitleTimelineCache);
    watchActiveEpisodeKey();
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "start-subtitle-capture") {
      startCapture(message.startedAt);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "stop-subtitle-capture") {
      stopCapture(message.stoppedAt);
      void getSubtitleContext()
        .then((context) => sendResponse({
          entries: state.entries,
          ...context
        }))
        .catch(() => sendResponse({
          entries: state.entries,
          ...getDomSubtitleContext()
        }));
      return true;
    }

    if (message?.type === "get-current-subtitle") {
      sendResponse({ currentSubtitle: getCurrentSubtitle() });
      return;
    }

    if (message?.type === "get-current-subtitle-context") {
      if (message.captureMode === "dom-fallback") {
        sendResponse(getDomSubtitleContext());
        return;
      }

      void getSubtitleContext()
        .then((context) => sendResponse(context))
        .catch(() => sendResponse(getDomSubtitleContext()));
      return true;
    }

    if (message?.type === "start-subtitle-clip") {
      startSubtitleClip(message.startedAt, message.targetSubtitle, message.rewindMs || 0, message.maxClipMs || 8000, message.cue || null, message.captureMode || "dom-fallback");
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "select-subtitle-cue") {
      void selectSubtitleCue(message.index)
        .then((context) => sendResponse({ ok: true, ...context }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "prepare-audio-range") {
      void prepareAudioRange(message.startSeconds, message.endSeconds)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error.message }));
      return true;
    }

    if (message?.type === "play-prepared-audio-range") {
      playPreparedAudioRange(message.endSeconds);
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "pause-video-playback") {
      pauseVideoPlayback();
      sendResponse({ ok: true });
    }

    if (message?.type === "clear-subtitle-timeline-cache") {
      state.lastTrackedEpisodeKey = getActiveEpisodeKeyFromDom() || "";
      clearSubtitleTimelineCache();
      sendResponse({ ok: true });
      return;
    }

    if (message?.type === "start-video-element-audio-recording") {
      void startVideoElementAudioRecording(message.startedAt, message.metadata || {})
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }

    if (message?.type === "stop-video-element-audio-recording") {
      void stopVideoElementAudioRecording(message.metadata || {})
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
  });

  function startCapture(startedAt) {
    stopCapture(startedAt);

    state.isRecording = true;
    state.entries = [];
    state.startedAt = startedAt;
    state.lastText = "";
    state.subtitleElement = findSubtitleSpan();

    observeSubtitle();
    state.pollTimer = window.setInterval(refreshSubtitleTarget, 1000);
    captureCurrentText();
  }

  function stopCapture(stoppedAt) {
    state.isRecording = false;
    if (state.clipMode?.retryRecordingTimer) {
      clearTimeout(state.clipMode.retryRecordingTimer);
    }
    detachCueClipTimeupdateListener();
    state.clipMode = null;

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }

    if (state.clipPollTimer) {
      clearInterval(state.clipPollTimer);
      state.clipPollTimer = null;
    }

    if (state.clipFallbackTimer) {
      clearTimeout(state.clipFallbackTimer);
      state.clipFallbackTimer = null;
    }

    if (state.clipMaxTimer) {
      clearTimeout(state.clipMaxTimer);
      state.clipMaxTimer = null;
    }

    if (state.rangeTimer) {
      clearTimeout(state.rangeTimer);
      state.rangeTimer = null;
    }

    if (state.entries.length > 0) {
      state.entries[state.entries.length - 1].endMs = stoppedAt - state.startedAt;
    }
  }

  /** Клип по VTT: без DOM/MutationObserver, синхронизация только с video.currentTime. */
  function startClipTimelineSession(startedAt) {
    stopCapture(startedAt);
    state.isRecording = true;
    state.entries = [];
    state.startedAt = startedAt;
    state.lastText = "";
    state.subtitleElement = null;
  }

  function detachCueClipTimeupdateListener() {
    const cm = state.clipMode;
    if (!cm) {
      return;
    }
    const video = cm.clipVideoRef;
    const handler = cm.cueClipTimeupdateHandler;
    if (video && handler) {
      video.removeEventListener("timeupdate", handler);
    }
    cm.clipVideoRef = null;
    cm.cueClipTimeupdateHandler = null;
  }

  function refreshSubtitleTarget() {
    const nextElement = findSubtitleSpan();
    if (nextElement === state.subtitleElement) {
      captureCurrentText();
      return;
    }

    state.subtitleElement = nextElement;
    observeSubtitle();
    captureCurrentText();
  }

function observeSubtitle() {
  if (state.observer) {
    state.observer.disconnect();
  }

  if (!state.subtitleElement) return;

  state.observer = new MutationObserver(() => {
    const text = normalizeText(state.subtitleElement.textContent || "");
    
    // If we are recording a clip and the subtitle vanishes, stop immediately
    if (state.clipMode?.active && state.clipMode.recordingStarted && text === "") {
        completeClip("", "subtitle-ended");
        return;
    }
    
    captureCurrentText();
  });
  
  state.observer.observe(state.subtitleElement, {
    childList: true,
    characterData: true,
    subtree: true
  });
}

  function captureCurrentText() {
    if (!state.isRecording || !state.subtitleElement) {
      return;
    }

    const text = normalizeText(state.subtitleElement.textContent || "");
    if (!text || text === state.lastText) {
      return;
    }

    const previousText = state.lastText;
    const now = Date.now();
    const atMs = now - state.startedAt;

    if (state.entries.length > 0) {
      state.entries[state.entries.length - 1].endMs = atMs;
    }

    state.entries.push({
      atMs,
      endMs: atMs + 1500,
      sessionStartedAt: state.startedAt,
      text
    });
    state.lastText = text;

    maybeRequestClipRecording(text);

    maybeCompleteClip(text, previousText);
  }

  function findSubtitleSpan() {
    // Прямой потомок или вложенный span (у плеера часто обёртка + стилизованный span с текстом)
    return (
      document.querySelector("#pjs_playerjs_subtitle span")
      || document.querySelector("#pjs_playerjs_subtitle > span")
    );
  }

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getCurrentSubtitle() {
    const element = findSubtitleSpan();
    return normalizeText(element?.textContent || "") || state.lastText || "";
  }

  function getDisplayedSubtitle() {
    const element = findSubtitleSpan();
    return normalizeText(element?.textContent || "");
  }

  async function getSubtitleContext() {
    const timeline = await getSubtitleTimeline().catch(() => null);
    const cueContext = timeline ? getCueContext(timeline) : null;
    return cueContext || getDomSubtitleContext();
  }

  function getDomSubtitleContext() {
    const currentSubtitle = getCurrentSubtitle();
    const currentIndex = state.entries.findIndex((entry) => entry.text === currentSubtitle);
    const fallbackIndex = state.entries.length - 1;
    const resolvedIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;

    return {
      currentSubtitle,
      previousSubtitle: resolvedIndex > 0 ? state.entries[resolvedIndex - 1]?.text || "" : "",
      nextSubtitle: resolvedIndex >= 0 && resolvedIndex < state.entries.length - 1
        ? state.entries[resolvedIndex + 1]?.text || ""
        : "",
      videoTime: getVideoTime()
    };
  }

  function startSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs, cue, captureMode) {
    if (captureMode === "dom-fallback") {
      startDomSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs);
      return;
    }

    if (cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start) {
      void startCueAwareSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs, cue)
        .catch(() => {
          if (captureMode === "manual-range") {
            chrome.runtime.sendMessage({
              type: "recording-error",
              error: "Manual range capture could not seek to the selected VTT cue."
            });
            return;
          }

          startDomSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs);
        });
      return;
    }

    if (captureMode === "manual-range") {
      chrome.runtime.sendMessage({
        type: "recording-error",
        error: "Manual range mode needs a selected VTT cue."
      });
      return;
    }

    startDomSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs);
  }

  async function startCueAwareSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs, cue) {
    startClipTimelineSession(startedAt);
    const timeline = state.timeline;
    const nextCue = timeline?.cues?.[cue.index + 1];
    const nextCueStart = nextCue && Number.isFinite(nextCue.start) ? nextCue.start : null;

    state.clipMode = {
      active: true,
      cue,
      cueAware: true,
      clipVideoRef: null,
      cueClipTimeupdateHandler: null,
      plannedVideoEndTime: 0,
      plannedVideoStartTime: 0,
      targetSubtitle,
      recordingRequested: true,
      recordingStarted: false,
      forcedStart: true,
      nextCueStart,
      targetNormalized: normalizeText(targetSubtitle)
    };

    const mediaElement = getVideoElement();
    if (!mediaElement) {
      throw new Error("No video element found for cue-aware capture.");
    }

    const rewindSeconds = Math.max(0, Number(rewindMs) || 0) / 1000;
    const startSeconds = Math.max(0, cue.start - rewindSeconds);
    const recorderWarmupMs = 300;
    const minCueClipMs = 2500;
    const tailPaddingSeconds = 0.85;
    const naturalEndSeconds = Math.max(cue.end + tailPaddingSeconds, startSeconds + minCueClipMs / 1000);
    const maxEndSeconds = startSeconds + Math.max(0.5, Number(maxClipMs) || 8000) / 1000;
    const endSeconds = Math.min(naturalEndSeconds, maxEndSeconds);
    const plannedDurationMs = Math.max(minCueClipMs, Math.round((endSeconds - startSeconds) * 1000));
    const safetyCapMs = Math.max(3000, Number(maxClipMs) || 8000);

    state.clipMode.plannedVideoStartTime = startSeconds;
    state.clipMode.plannedVideoEndTime = endSeconds;
    mediaElement.pause();
    await seekVideo(mediaElement, startSeconds);

    chrome.runtime.sendMessage({
      type: "subtitle-clip-start-recording",
      plannedDurationMs,
      videoEndTime: endSeconds,
      videoStartTime: startSeconds,
      videoTime: startSeconds
    }, (response) => {
      if (chrome.runtime.lastError || !response?.ok || !state.clipMode?.active) {
        startDomSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs);
        return;
      }

      state.clipMode.recordingStarted = true;
      state.startedAt = Date.now();
      state.entries = [{
        atMs: 0,
        endMs: plannedDurationMs,
        sessionStartedAt: state.startedAt,
        text: targetSubtitle
      }];
      state.lastText = targetSubtitle;

      state.clipFallbackTimer = window.setTimeout(() => {
        if (!state.clipMode?.active) {
          return;
        }

        void mediaElement.play().catch(() => {});

        // Как ASBPlayer: границы реплики по VTT и video.currentTime, без MutationObserver/DOM.
        attachCueClipTimeupdateListener(mediaElement, cue, timeline);

        // Нет следующего куя — как раньше: обрезка по рассчитанному концу реплики
        // Есть следующий — верхняя граница только safetyCap (если не сработала смена реплики)
        const timerMs = nextCueStart != null ? safetyCapMs : plannedDurationMs;
        const stopReason = nextCueStart != null ? "max-duration" : "cue-end";

        state.clipMaxTimer = window.setTimeout(() => {
          if (!state.clipMode?.active) {
            return;
          }
          completeClipByCue(cue, stopReason);
        }, timerMs);
      }, recorderWarmupMs);
    });
  }

  function startDomSubtitleClip(startedAt, targetSubtitle, rewindMs, maxClipMs) {
    startCapture(startedAt);
    const rewound = rewindVideoPlayback(rewindMs);
    const normalizedTarget = normalizeText(targetSubtitle);
    state.clipMode = {
      active: true,
      targetSubtitle,
      targetNormalized: normalizedTarget,
      targetWasVisible: false,
      recordingRequested: false,
      recordingStarted: false,
      forcedStart: false,
      recordingStartAttempts: 0
    };

    maybeRequestClipRecording(getDisplayedSubtitle());

    state.clipPollTimer = window.setInterval(() => {
      const displayedText = getDisplayedSubtitle();
      const displayedNormalized = normalizeText(displayedText);

      if (displayedNormalized === state.clipMode?.targetNormalized) {
        state.clipMode.targetWasVisible = true;
        maybeRequestClipRecording(displayedText);
      }

      // Для аудио важен не "последний известный текст", а реальный конец реплики на экране:
      // как только текущий DOM-субтитр исчез или сменился после старта записи — останавливаем запись и player.
      if (
        state.clipMode?.recordingStarted
        && state.clipMode.targetWasVisible
        && displayedNormalized !== state.clipMode.targetNormalized
      ) {
        completeClip(displayedText, displayedNormalized ? "subtitle-change" : "subtitle-ended");
        return;
      }
    }, 100);

    state.clipFallbackTimer = window.setTimeout(() => {
      if (!state.clipMode?.active || state.clipMode.recordingStarted) {
        return;
      }

      state.clipMode.forcedStart = true;
      maybeRequestClipRecording(state.clipMode.targetSubtitle, true);
    }, rewound ? 1800 : 350);

    state.clipMaxTimer = window.setTimeout(() => {
      if (!state.clipMode?.active || !state.clipMode.recordingStarted) {
        return;
      }

      completeClip(getCurrentSubtitle(), "max-duration");
    }, Math.max(3000, Number(maxClipMs) || 8000));
  }

  /**
   * Слушатель timeupdate: активная реплика по таймкодам VTT (не по DOM).
   */
  function attachCueClipTimeupdateListener(mediaElement, cue, timeline) {
    detachCueClipTimeupdateListener();
    const handler = () => {
      if (!state.clipMode?.active || !state.clipMode.cueAware) {
        return;
      }
      const t = mediaElement.currentTime;
      const nextAt = state.clipMode.nextCueStart;
      const activeCue = timeline?.cues?.find((item) => t >= item.start && t <= item.end + 0.03) || null;
      if (activeCue && activeCue.index > cue.index) {
        completeClipByCue(cue, "next-cue-start", getVideoTime());
        return;
      }
      if (nextAt != null && t >= nextAt - 0.03) {
        completeClipByCue(cue, "next-cue-start", getVideoTime());
      }
    };
    mediaElement.addEventListener("timeupdate", handler);
    if (state.clipMode) {
      state.clipMode.clipVideoRef = mediaElement;
      state.clipMode.cueClipTimeupdateHandler = handler;
    }
  }

  /**
   * @param {number} [videoEndTimeOverride] — фактическое время остановки (следующая реплика / смена DOM)
   */
  function completeClipByCue(cue, stopReason, videoEndTimeOverride) {
    if (!state.clipMode?.active) {
      return;
    }

    const timeline = state.timeline;
    state.clipMode.active = false;
    detachCueClipTimeupdateListener();

    if (state.clipPollTimer) {
      clearInterval(state.clipPollTimer);
      state.clipPollTimer = null;
    }

    if (state.clipFallbackTimer) {
      clearTimeout(state.clipFallbackTimer);
      state.clipFallbackTimer = null;
    }

    if (state.clipMaxTimer) {
      clearTimeout(state.clipMaxTimer);
      state.clipMaxTimer = null;
    }

    if (state.clipMode?.retryRecordingTimer) {
      clearTimeout(state.clipMode.retryRecordingTimer);
      state.clipMode.retryRecordingTimer = null;
    }

    pauseVideoPlayback();
    const endT =
      Number.isFinite(videoEndTimeOverride)
        ? videoEndTimeOverride
        : state.clipMode.plannedVideoEndTime || cue.end;

    void chrome.runtime.sendMessage({
      type: "subtitle-clip-complete",
      subtitle: cue.text,
      previousSubtitle: timeline?.cues?.[cue.index - 1]?.text || "",
      nextSubtitle: timeline?.cues?.[cue.index + 1]?.text || "",
      stopReason,
      cue,
      videoEndTime: endT,
      videoStartTime: state.clipMode.plannedVideoStartTime
    });
  }

  function getPreviousSubtitleFor(text) {
    const index = state.entries.findIndex((entry) => entry.text === text);
    return index > 0 ? state.entries[index - 1]?.text || "" : "";
  }

  function pauseVideoPlayback() {
    const mediaElement = getVideoElement();
    if (mediaElement && !mediaElement.paused) {
      mediaElement.pause();
      return;
    }

    const control = findPlaybackToggle();
    if (control instanceof HTMLElement) {
      control.click();
    }
  }

  function getVideoElement() {
    return document.querySelector("#playerjs video") || document.querySelector("video");
  }

  function getVideoTime() {
    const mediaElement = getVideoElement();
    return mediaElement && Number.isFinite(mediaElement.currentTime)
      ? mediaElement.currentTime
      : undefined;
  }

  function pickRecorderMimeType() {
    if (typeof MediaRecorder === "undefined") {
      return "";
    }
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      return "audio/webm;codecs=opus";
    }
    if (MediaRecorder.isTypeSupported("audio/webm")) {
      return "audio/webm";
    }
    return "";
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error("FileReader failed."));
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Подключает звук видео к выходу и к MediaStreamDestination для записи только этой дорожки.
   */
  async function ensureRoutedVideoAudio(video) {
    const existing = videoElementAudioRoutes.get(video);
    if (existing) {
      await existing.ctx.resume().catch(() => {});
      return existing;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error("AudioContext is not available in this page.");
    }
    const ctx = new AudioCtx();
    let source;
    try {
      source = ctx.createMediaElementSource(video);
    } catch (err) {
      await ctx.close().catch(() => {});
      throw new Error(
        `Could not attach audio from the video element (${err?.message || err}). Often caused by CORS or a second capture on the same element.`
      );
    }
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    source.connect(ctx.destination);
    const route = { ctx, dest, source };
    videoElementAudioRoutes.set(video, route);
    await ctx.resume().catch(() => {});
    return route;
  }

  async function startVideoElementAudioRecording(startedAt, metadata) {
    if (state.elementAudioSession?.recorder?.state === "recording") {
      await stopVideoElementAudioRecording({ discard: true }).catch(() => {});
    }
    const video = getVideoElement();
    if (!video) {
      throw new Error("No video element found.");
    }
    const route = await ensureRoutedVideoAudio(video);
    const mimeType = pickRecorderMimeType();
    const chunks = [];
    const outStream = route.dest.stream;
    const options = mimeType ? { mimeType } : {};
    const recorder = new MediaRecorder(outStream, options);
    const session = {
      chunks,
      discard: false,
      metadata: metadata || {},
      recorder,
      startedAt: startedAt || Date.now()
    };
    state.elementAudioSession = session;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    recorder.start(500);
  }

  async function stopVideoElementAudioRecording(metadata = {}) {
    const session = state.elementAudioSession;
    if (!session?.recorder) {
      return;
    }
    if (metadata.discard) {
      session.discard = true;
    }
    const rec = session.recorder;
    const chunks = session.chunks;
    const startedAt = session.startedAt;
    const discard = session.discard;
    const metaBase = { ...session.metadata, ...metadata };
    state.elementAudioSession = null;

    await new Promise((resolve) => {
      rec.onstop = resolve;
      if (rec.state === "recording") {
        rec.stop();
      } else {
        resolve();
      }
    });

    const blob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
    if (discard || metaBase.discard) {
      return;
    }

    const dataUrl = await blobToDataUrl(blob);
    await chrome.runtime.sendMessage({
      type: "audio-recording-ready",
      dataUrl,
      metadata: {
        ...metaBase,
        captureMode: metaBase.captureMode || "auto-vtt",
        recordingStartedAt: startedAt,
        recordingStoppedAt: Date.now()
      },
      startedAt
    });
  }

  function seekVideo(mediaElement, targetSeconds) {
    return new Promise((resolve, reject) => {
      if (!mediaElement || !Number.isFinite(mediaElement.duration)) {
        reject(new Error("No seekable video element found."));
        return;
      }

      const duration = mediaElement.duration || targetSeconds;
      const nextTime = Math.max(0, Math.min(targetSeconds, duration));
      const finish = () => resolve({ currentTime: mediaElement.currentTime, duration });
      const timeout = window.setTimeout(finish, 1200);

      mediaElement.addEventListener("seeked", () => {
        clearTimeout(timeout);
        finish();
      }, { once: true });
      mediaElement.currentTime = nextTime;
    });
  }

  async function prepareAudioRange(startSeconds, endSeconds) {
    const mediaElement = getVideoElement();
    if (!mediaElement) {
      throw new Error("No video element found in #playerjs.");
    }

    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
      throw new Error("Invalid audio range.");
    }

    mediaElement.pause();
    const result = await seekVideo(mediaElement, startSeconds);
    return {
      currentTime: result.currentTime,
      duration: result.duration
    };
  }

  function playPreparedAudioRange(endSeconds) {
    const mediaElement = getVideoElement();
    if (!mediaElement) {
      return;
    }

    if (state.rangeTimer) {
      clearTimeout(state.rangeTimer);
      state.rangeTimer = null;
    }

    const durationMs = Math.max(250, (endSeconds - mediaElement.currentTime) * 1000);
    void mediaElement.play().catch(() => {});
    state.rangeTimer = window.setTimeout(() => {
      pauseVideoPlayback();
      void chrome.runtime.sendMessage({
        type: "audio-range-complete"
      });
    }, durationMs);
  }

  function rewindVideoPlayback(rewindMs) {
    const mediaElement = getVideoElement();
    if (!mediaElement || !Number.isFinite(mediaElement.currentTime)) {
      return false;
    }

    const rewindSeconds = Math.max(0, rewindMs) / 1000;
    if (rewindSeconds <= 0) {
      return false;
    }

    mediaElement.currentTime = Math.max(0, mediaElement.currentTime - rewindSeconds);

    // Некоторые HLS/PlayerJS не всегда шлют seeked — дублируем запуск опроса по таймауту
    let seekHandled = false;
    const afterSeek = () => {
      if (seekHandled) {
        return;
      }
      seekHandled = true;
      clearTimeout(seekFallbackTimer);
      state.lastText = "";
      maybeRequestClipRecording(getDisplayedSubtitle());
    };
    const seekFallbackTimer = window.setTimeout(afterSeek, 700);
    mediaElement.addEventListener("seeked", afterSeek, { once: true });

    if (mediaElement.paused) {
      void mediaElement.play().catch(() => {});
    }

    return true;
  }

  function maybeRequestClipRecording(text, force = false) {
    const displayedNorm = normalizeText(text || "");
    if (
      !state.clipMode?.active
      || state.clipMode.cueAware
      || state.clipMode.recordingRequested
      || (!force && displayedNorm !== state.clipMode.targetNormalized)
    ) {
      return;
    }

    state.clipMode.recordingRequested = true;
    chrome.runtime.sendMessage({
      type: "subtitle-clip-start-recording",
      videoTime: getVideoTime()
    }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        state.clipMode.recordingRequested = false;
        // Повтор через 2 с при временном сбое tabCapture (не более 4 попыток)
        const attempts = (state.clipMode.recordingStartAttempts || 0) + 1;
        if (state.clipMode) {
          state.clipMode.recordingStartAttempts = attempts;
        }
        if (
          state.clipMode?.active
          && !state.clipMode.recordingStarted
          && !state.clipMode.retryRecordingTimer
          && attempts <= 4
        ) {
          state.clipMode.retryRecordingTimer = window.setTimeout(() => {
            if (!state.clipMode?.active) {
              return;
            }
            state.clipMode.retryRecordingTimer = null;
            maybeRequestClipRecording(state.clipMode.targetSubtitle, true);
          }, 2000);
        }
        return;
      }

      if (state.clipMode.retryRecordingTimer) {
        clearTimeout(state.clipMode.retryRecordingTimer);
        state.clipMode.retryRecordingTimer = null;
      }
      state.clipMode.recordingStarted = true;
      state.clipMode.targetWasVisible = true;
      state.startedAt = Date.now();
      state.entries = [{
        atMs: 0,
        endMs: 1500,
        sessionStartedAt: state.startedAt,
        text: state.clipMode.targetSubtitle
      }];
      state.lastText = state.clipMode.targetSubtitle;
    });
  }

function maybeCompleteClip(text, previousText) {
  const normText = normalizeText(text);
  const normPrev = normalizeText(previousText);

  if (
    !state.clipMode?.active ||
    state.clipMode.cueAware ||
    !state.clipMode.recordingStarted
  ) {
    return;
  }

  // STOP CONDITION:
  // 1. Text is different from what we captured (change)
  // 2. Text is empty (subtitle disappeared)
  if (normPrev === state.clipMode.targetNormalized && 
     (normText !== state.clipMode.targetNormalized || normText === "")) {
    completeClip(text, normText === "" ? "subtitle-ended" : "subtitle-change");
  }
}

  function completeClip(nextSubtitle, stopReason = "subtitle-change") {
    if (!state.clipMode?.active) {
      return;
    }

    state.clipMode.active = false;
    const videoEndTime = getVideoTime();

    if (state.clipPollTimer) {
      clearInterval(state.clipPollTimer);
      state.clipPollTimer = null;
    }

    if (state.clipFallbackTimer) {
      clearTimeout(state.clipFallbackTimer);
      state.clipFallbackTimer = null;
    }

    if (state.clipMaxTimer) {
      clearTimeout(state.clipMaxTimer);
      state.clipMaxTimer = null;
    }

    if (state.clipMode?.retryRecordingTimer) {
      clearTimeout(state.clipMode.retryRecordingTimer);
      state.clipMode.retryRecordingTimer = null;
    }

    pauseVideoPlayback();
    void chrome.runtime.sendMessage({
      type: "subtitle-clip-complete",
      subtitle: state.clipMode.targetSubtitle,
      previousSubtitle: getPreviousSubtitleFor(state.clipMode.targetSubtitle),
      nextSubtitle: nextSubtitle && nextSubtitle !== state.clipMode.targetSubtitle ? nextSubtitle : "",
      stopReason,
      cue: state.clipMode.cue || null,
      videoEndTime
    });
  }

  async function selectSubtitleCue(index) {
    const timeline = await getSubtitleTimeline();
    const cue = timeline.cues.find((item) => item.index === index);
    if (!cue) {
      throw new Error("Subtitle cue was not found.");
    }

    const mediaElement = getVideoElement();
    if (mediaElement) {
      await seekVideo(mediaElement, cue.start);
      mediaElement.pause();
    }

    return getCueContext(timeline, cue);
  }

  /** Смена эпизода на SPA обычно меняет path/search/hash; этого достаточно, чтобы сбросить кэш VTT. */
  function getPageLocationSignature() {
    return `${location.pathname}${location.search}${location.hash}`;
  }

  /**
   * Сигнатура кэша таймлайна: для одностраничных сериалов добавляем активный data-episode-key,
   * иначе при смене серии без смены URL остаётся старый VTT.
   */
  function getTimelineCacheSignature() {
    const loc = getPageLocationSignature();
    const ep = getActiveEpisodeKeyFromDom();
    return ep ? `${loc}|ep:${ep}` : loc;
  }

  /** data-episode-key на узле или у предка (SPA: активная серия помечена классом, ключ — у обёртки). */
  function readEpisodeKeyFromActiveElement(el) {
    if (!el?.getAttribute) {
      return "";
    }
    const direct = el.getAttribute("data-episode-key")?.trim();
    if (direct) {
      return direct;
    }
    const ancestor = el.closest("[data-episode-key]");
    return ancestor?.getAttribute("data-episode-key")?.trim() || "";
  }

  /**
   * Активный ключ эпизода в DOM (URL страницы для сериала один — ориентируемся на классы списка серий, кнопки и текст плеера).
   * Приоритет:
   * 1. Живой бейдж серии внутри PlayerJS (#playerjs "1 сезон 2 серия")
   * 2. Активный пункт плейлиста PlayerJS (.pjs-playerjs-active-pl) + активный сезон
   * 3. Активные элементы каталога серий с data-episode-key
   * 4. Кнопка «Продолжить» / resume (только как fallback до старта плеера)
   */
  function getActiveEpisodeKeyFromDom() {
    // 1. Текстовый бейдж серии внутри плеера PlayerJS (наивысший приоритет, отражает реально идущую серию)
    const playerRoots = document.querySelectorAll("#playerjs, #pjs_playerjs, [id*='playerjs' i]");
    for (const root of playerRoots) {
      const candidates = root.querySelectorAll("div, span, center, noindex, pjsdiv, b");
      for (const el of candidates) {
        const text = el.textContent?.trim() || "";
        if (!text || text.length > 80) {
          continue;
        }
        const m = text.match(/(\d+)\s*(?:сезон|season)[^\d]+(\d+)\s*(?:сери[яие]|episode|ep)/i);
        if (m) {
          return `s${m[1]}e${m[2]}`;
        }
      }
    }

    // 2. Активный элемент плейлиста PlayerJS (.pjs-playerjs-active-pl)
    const activePl = document.querySelector(".pjs-playerjs-active-pl, [class*='playerjs-active-pl']");
    if (activePl) {
      const plText = activePl.textContent?.trim() || "";
      const epMatch = plText.match(/(\d+)\s*(?:сери[яие]|ep|episode)/i);
      if (epMatch) {
        const epNum = epMatch[1];
        let seasonNum = "";
        const plParent = activePl.closest("#playerjs_playlist, [id*='playlist' i]");
        if (plParent) {
          const folderText = plParent.querySelector("[fid]:not(.pjs-playerjs-active-pl)")?.textContent?.trim() || "";
          const folderMatch = folderText.match(/(\d+)\s*(?:сезон|season)/i);
          if (folderMatch) {
            seasonNum = folderMatch[1];
          }
        }
        if (!seasonNum) {
          const activeTab = document.querySelector(".s-tabs-active, [data-season-num].ui-tabs-active, [data-season-num].active");
          seasonNum = activeTab?.getAttribute("data-season-num") || "";
        }
        if (seasonNum) {
          return `s${seasonNum}e${epNum}`;
        }
        return `s1e${epNum}`;
      }
    }

    // 3. Активные элементы каталога с data-episode-key
    const activeSelectors = [
      ".series-mob-item.active[data-episode-key]",
      ".series-mob-item.is-active[data-episode-key]",
      ".series-mob-item.swiper-slide-active[data-episode-key]",
      ".series-item.active[data-episode-key]",
      ".active[data-episode-key]",
      ".is-active[data-episode-key]",
      "[data-episode-key][aria-current='true']"
    ];
    for (const sel of activeSelectors) {
      const el = document.querySelector(sel);
      const key = readEpisodeKeyFromActiveElement(el);
      if (key) {
        return key;
      }
    }

    // 4. Текстовые бейджи вне плеера (не включаем .head-block-btn — это resume-кнопка, обрабатывается в шаге 5)
    const titleCandidates = document.querySelectorAll(".title-head, .series-title, .player-title");
    for (const el of titleCandidates) {
      const text = el.textContent?.trim() || "";
      if (text && text.length <= 80) {
        const m = text.match(/(\d+)\s*(?:сезон|season)[^\d]+(\d+)\s*(?:сери[яие]|episode|ep)/i);
        if (m) {
          return `s${m[1]}e${m[2]}`;
        }
      }
    }

    // 5. Запасной вариант: кнопка резюме DLE (актуальна только до начала воспроизведения)
    const resumeEl = document.querySelector(".dleplayerjs-watch-button.is-resume, .dleplayerjs-watch-button");
    const resumeKey = readEpisodeKeyFromActiveElement(resumeEl);
    if (resumeKey) {
      return resumeKey;
    }

    return "";
  }

  /** Расширяем s3e4 → фрагменты пути в типичных именах VTT (без одиночных цифр). */
  function expandDataEpisodeKeyToHints(raw) {
    if (!raw || typeof raw !== "string") {
      return [];
    }
    const key = raw.trim().toLowerCase();
    if (!key) {
      return [];
    }
    const hints = [key];
    const compact = key.replace(/\s+/g, "");
    const m = compact.match(/^s(\d+)e(\d+)$/i);
    if (m) {
      const sNum = m[1];
      const eNum = m[2];
      hints.push(`s${sNum}e${eNum}`, `s${sNum}`, `e${eNum}`, `season${sNum}`, `episode${eNum}`, `ep${eNum}`);
      hints.push(`rus${eNum}`, `eng${eNum}`, `ru${eNum}`, `en${eNum}`);
    }
    return [...new Set(hints.filter(Boolean))];
  }

  /** Опрос DOM: смена data-episode-key при переключении серии без изменения URL. */
  function watchActiveEpisodeKey() {
    if (state.episodeKeyPollTimer) {
      clearInterval(state.episodeKeyPollTimer);
    }
    state.lastTrackedEpisodeKey = getActiveEpisodeKeyFromDom() || "";
    state.episodeKeyPollTimer = window.setInterval(() => {
      const current = getActiveEpisodeKeyFromDom() || "";
      if (current !== state.lastTrackedEpisodeKey) {
        state.lastTrackedEpisodeKey = current;
        clearSubtitleTimelineCache();
      }
    }, 2000);
  }

  function buildCombinedEpisodeHints() {
    const fromUrl = buildEpisodeHintsFromLocation();
    const fromDom = expandDataEpisodeKeyToHints(getActiveEpisodeKeyFromDom());
    return [...new Set([...fromUrl, ...fromDom])];
  }

  /** Сильный бонус, если в URL целиком попал ключ s3e4. */
  function scoreVttAgainstDataEpisodeKey(vttUrl, episodeKey) {
    if (!episodeKey || !vttUrl) {
      return 0;
    }
    const k = episodeKey.trim().toLowerCase();
    if (!k) {
      return 0;
    }
    return vttUrl.toLowerCase().includes(k) ? 120 : 0;
  }

  /**
   * Если хотя бы один кандидат содержит ключ эпизода — отбрасываем остальные (иначе остаётся общий скоринг).
   */
  function preferCandidatesMatchingEpisodeKey(candidates, episodeKey) {
    const k = episodeKey?.trim().toLowerCase();
    if (!k || !candidates?.length) {
      return candidates;
    }
    const hints = expandDataEpisodeKeyToHints(k);
    const withKey = candidates.filter((c) => {
      const u = c.url.toLowerCase();
      if (u.includes(k)) {
        return true;
      }
      return hints.some((h) => h.length >= 3 && u.includes(h.toLowerCase()));
    });
    return withKey.length ? withKey : candidates;
  }

  async function getSubtitleTimeline() {
    const cacheSig = getTimelineCacheSignature();
    if (state.timeline?.cues?.length && state.timelinePageSignature === cacheSig) {
      return state.timeline;
    }

    state.timeline = null;

    if (state.timelinePromise) {
      return state.timelinePromise;
    }

    const loadStartedSig = cacheSig;
    const epochAtLoad = state.subtitleTimelineEpoch;
    state.timelinePromise = loadSubtitleTimeline()
      .then((timeline) => {
        if (state.subtitleTimelineEpoch !== epochAtLoad) {
          throw new Error("Subtitle timeline cache was cleared while loading.");
        }
        if (getTimelineCacheSignature() !== loadStartedSig) {
          clearSubtitleTimelineCache();
          throw new Error("Page or episode context changed while subtitles were loading.");
        }
        state.timeline = timeline;
        state.timelinePageSignature = loadStartedSig;
        return timeline;
      })
      .finally(() => {
        state.timelinePromise = null;
      });

    return state.timelinePromise;
  }

  async function loadSubtitleTimeline() {
    const episodeKeyDom = getActiveEpisodeKeyFromDom();
    let source = tryPickVttFromPlayerjsApi();
    if (!source?.url) {
      const candidates = collectVttCandidatesSync();
      const narrowed = preferCandidatesMatchingEpisodeKey(candidates, episodeKeyDom);
      source = pickPreferredVttSource(narrowed, episodeKeyDom);
    }
    if (!source?.url) {
      source = await tryPickVttFromHlsManifest();
    }
    if (!source?.url) {
      throw new Error(
        "No VTT URL on the page: checked PlayerJS API, inline scripts, #playerjs markup, <track>, bare .vtt URLs, and HLS master playlist."
      );
    }

    const response = await fetch(source.url, { credentials: "include" });
    if (!response.ok) {
      throw new Error(`Could not load subtitles: ${response.status}`);
    }

    const cues = parseVtt(await response.text());
    if (cues.length === 0) {
      throw new Error("Subtitle file has no cues.");
    }

    const shiftSeconds = parsePlayerJsShiftSeconds(source.url);
    const shiftedCues = applyShiftToCues(cues, shiftSeconds);

    return {
      cues: shiftedCues,
      shiftSeconds,
      sourceLabel: source.label,
      sourceUrl: source.url
    };
  }

  /**
   * PlayerJS: ?shift=+35 в URL субтитров — сдвиг в десятых долях секунды (+3.5 с).
   * Сервер отдаёт тот же VTT; сдвиг применяет плеер на клиенте.
   */
  function parsePlayerJsShiftSeconds(vttUrl) {
    try {
      const url = new URL(vttUrl, window.location.href);
      const raw = url.searchParams.get("shift");
      if (raw != null && raw !== "") {
        const parsed = Number(String(raw).replace(/^\+/, ""));
        if (Number.isFinite(parsed)) {
          return parsed / 10;
        }
      }
    } catch (_) {
      /* ignore */
    }

    return findSubshiftFromPlayerjsConfig();
  }

  /** Запасной источник сдвига из inline-конфига Playerjs (subshift). */
  function findSubshiftFromPlayerjsConfig() {
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!/subshift/i.test(text)) {
        continue;
      }
      const match = /["']subshift["']\s*:\s*(-?\d+)/i.exec(text);
      if (match) {
        const parsed = Number(match[1]);
        if (Number.isFinite(parsed)) {
          return parsed / 10;
        }
      }
    }
    return 0;
  }

  function applyShiftToCues(cues, shiftSeconds) {
    if (!shiftSeconds || !cues?.length) {
      return cues;
    }

    return cues.map((cue) => ({
      ...cue,
      end: cue.end + shiftSeconds,
      start: cue.start + shiftSeconds
    }));
  }

  /** Нормализация строки с .vtt в абсолютный URL. */
  function toAbsoluteVttUrl(raw) {
    if (!raw || typeof raw !== "string") {
      return null;
    }
    const trimmed = raw.trim();
    if (!/\.vtt(\?|#|$)/i.test(trimmed)) {
      return null;
    }
    try {
      return new URL(trimmed, window.location.href).href;
    } catch (_) {
      return null;
    }
  }

  /**
   * Разбор строки вида "[En]//host/a.vtt,[Ru]//host/b.vtt" из api("subtitles").
   */
  function parseBracketSubtitleListing(listRaw) {
    /** @type {{ label: string, url: string }[]} */
    const out = [];
    if (listRaw == null || listRaw === "") {
      return out;
    }
    const s = String(listRaw);
    const re = /\[([^\]]*)]\s*(\S+\.vtt[^\s,]*)/gi;
    let m = re.exec(s);
    while (m) {
      const url = toAbsoluteVttUrl(m[2]);
      if (url) {
        out.push({ label: (m[1] || "").trim() || "Subtitles", url });
      }
      m = re.exec(s);
    }
    return out;
  }

  /**
   * Из значения api("subtitle"): URL, либо null если это только название языка или индекс.
   */
  function extractVttUrlFromSubtitleApiValue(cur) {
    if (cur == null || cur === "") {
      return null;
    }
    if (typeof cur === "number") {
      return null;
    }
    const s = String(cur).trim();
    const bracket = /\[([^\]]*)]\s*(\S+\.vtt[^\s,]*)/i.exec(s);
    if (bracket) {
      return toAbsoluteVttUrl(bracket[2]);
    }
    const bare = /(\S+\.vtt[^\s,]*)/i.exec(s);
    if (bare) {
      return toAbsoluteVttUrl(bare[1]);
    }
    return null;
  }

  /** Подбор инстансов с методом api() как у PlayerJS. */
  function collectProbablePlayerjsInstances() {
    /** @type {object[]} */
    const out = [];
    const seen = new Set();
    const tryAdd = (obj) => {
      if (!obj || typeof obj.api !== "function") {
        return;
      }
      if (seen.has(obj)) {
        return;
      }
      seen.add(obj);
      out.push(obj);
    };

    for (const name of ["playerjs", "player3js", "player", "pjs"]) {
      try {
        const v = window[name];
        if (Array.isArray(v)) {
          v.forEach(tryAdd);
        } else {
          tryAdd(v);
        }
      } catch (_) {
        /* ignore */
      }
    }

    const roots = document.querySelectorAll("#playerjs, #pjs_playerjs, [id^='pjs_']");
    for (const el of roots) {
      tryAdd(el.player);
      tryAdd(el.playerjs);
      for (const k of Object.keys(el)) {
        try {
          const v = el[k];
          if (v && typeof v === "object") {
            tryAdd(v);
          }
        } catch (_) {
          /* ignore */
        }
      }
    }

    return out;
  }

  /**
   * Актуальный URL субтитров из PlayerJS (api «subtitle» / «subtitles»), без скана всех серий в скрипте.
   */
  function tryPickVttFromPlayerjsApi() {
    const players = collectProbablePlayerjsInstances();
    for (const player of players) {
      try {
        const cur = player.api("subtitle");
        const direct = extractVttUrlFromSubtitleApiValue(cur);
        if (direct) {
          return { label: "PlayerJS (subtitle)", url: direct };
        }

        let listingRaw = "";
        try {
          listingRaw = player.api("subtitles");
        } catch (_) {
          listingRaw = "";
        }
        const tracks = parseBracketSubtitleListing(listingRaw);

        if (typeof cur === "number" && Number.isFinite(cur) && cur >= 0 && tracks[cur]) {
          const t = tracks[cur];
          return { label: t.label, url: t.url };
        }

        if (typeof cur === "string" && tracks.length) {
          const needle = cur.trim().toLowerCase();
          const hit = tracks.find((t) => {
            const lab = t.label.toLowerCase();
            return lab === needle || lab.includes(needle) || needle.includes(lab);
          });
          if (hit) {
            return { label: hit.label, url: hit.url };
          }
        }
      } catch (_) {
        /* следующий инстанс */
      }
    }
    return null;
  }

  /** Подсказки из path страницы (s3, e4, rus4 …), чтобы не выбрать VTT другой серии при огромном списке кандидатов. */
  function buildEpisodeHintsFromLocation() {
    const segments = window.location.pathname.split("/").filter(Boolean);
    /** @type {string[]} */
    const hints = [];
    for (const seg of segments) {
      const lower = seg.toLowerCase();
      if (/^s\d+$/i.test(seg) || /^season[_-]?\d+$/i.test(seg)) {
        hints.push(lower);
      }
      if (/^e\d+$/i.test(seg) || /^ep\d+$/i.test(seg) || /^episode[_-]?\d+$/i.test(seg)) {
        hints.push(lower);
        const num = seg.match(/\d+/);
        if (num) {
          hints.push(num[0]);
        }
      }
      const langEp = seg.match(/^(rus|eng|en|ru)(\d+)$/i);
      if (langEp) {
        hints.push(lower, langEp[2]);
      }
    }
    return [...new Set(hints.filter(Boolean))];
  }

  function scoreVttAgainstEpisodeHints(vttUrl, hints) {
    if (!hints?.length || !vttUrl) {
      return 0;
    }
    let bonus = 0;
    const lower = vttUrl.toLowerCase();
    for (const h of hints) {
      if (h && lower.includes(String(h).toLowerCase())) {
        bonus += 35;
      }
    }
    return bonus;
  }

  /** Активный язык субтитров из меню настроек PlayerJS (например "Английские" / "Русские"). */
  function getActiveSubtitleLanguageFromDom() {
    const settingsRoots = document.querySelectorAll(
      "#playerjs_settings [fid], #playerjs [id*='settings'] [fid], #playerjs pjsdiv[fid]"
    );
    for (const root of settingsRoots) {
      const text = (root.textContent || "").toLowerCase();
      if (text.includes("субтитр") || text.includes("subtitle")) {
        const parts = Array.from(root.querySelectorAll("pjsdiv, div, span"))
          .map((el) => el.textContent?.trim())
          .filter(Boolean);
        for (const part of parts) {
          const low = part.toLowerCase();
          if (!low.includes("субтитр") && !low.includes("subtitle") && low.length >= 2) {
            return part;
          }
        }
      }
    }
    return "";
  }

  /** Собираем текст страницы, где часто лежит конфиг Playerjs / ссылки на VTT (внешние .js без доступа к телу не сканируем). */
  function getSubtitleScanText() {
    const parts = [];
    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (text) {
        parts.push(text);
      }
    }
    // Разметка и data-* контейнеров плеера (субтитры могут быть только в innerHTML, не в inline script).
    const roots = document.querySelectorAll(
      "#playerjs, #pjs_playerjs, [id*='playerjs' i], [id^='pjs_'], [class*='playerjs' i]"
    );
    for (const el of roots) {
      parts.push(el.innerHTML);
      for (const attr of el.attributes) {
        parts.push(attr.value);
      }
    }
    return parts.join("\n");
  }

  function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Разбор значения subtitle из конфига PlayerJS: "[Ru]a.vtt,[En]b.vtt" или список URL через запятую.
   */
  function parseSubtitleFieldToCandidates(subsRaw) {
    /** @type {{ label: string, url: string }[]} */
    const out = [];
    if (!subsRaw || typeof subsRaw !== "string") {
      return out;
    }
    const subs = subsRaw.trim();
    const bracket = /\[([^\]]*)]\s*(\S+?\.vtt[^\s",]*)/gi;
    let bm = bracket.exec(subs);
    while (bm) {
      const url = toAbsoluteVttUrl(bm[2]);
      if (url) {
        out.push({ label: (bm[1] || "").trim() || "Subtitles", url });
      }
      bm = bracket.exec(subs);
    }
    if (out.length) {
      return out;
    }
    for (const part of subs.split(",")) {
      const t = part.trim().replace(/^\[[^\]]*]\s*/, "");
      const url = toAbsoluteVttUrl(t);
      if (url) {
        out.push({ label: "Subtitles", url });
      }
    }
    return out;
  }

  /**
   * Вытаскивает VTT только для текущего эпизода из большого JSON (все сезоны в одном скрипте).
   * Ищем объект с "id":"s3e4", затем в том же фрагменте — "subtitle":"...".
   */
  function collectVttFromPlayerjsJsonByEpisodeId(episodeKey) {
    const key = (episodeKey || "").trim();
    if (!key) {
      return [];
    }
    const escaped = escapeRegExp(key);

    for (const script of document.scripts) {
      const text = script.textContent || "";
      if (!text.includes(key)) {
        continue;
      }

      // Один проход по полному тексту скрипта: id → subtitle (как в конфиге серии).
      const forward = new RegExp(
        `["']id["']\\s*:\\s*["']${escaped}["'][\\s\\S]{0,56000}?["']subtitle["']\\s*:\\s*["']([^"']+)["']`,
        "i"
      );
      const mf = text.match(forward);
      if (mf?.[1]) {
        const parsed = parseSubtitleFieldToCandidates(mf[1]);
        if (parsed.length) {
          return parsed;
        }
      }

      // subtitle может идти в объекте раньше id.
      const backward = new RegExp(
        `["']subtitle["']\\s*:\\s*["']([^"']+)["'][\\s\\S]{0,56000}?["']id["']\\s*:\\s*["']${escaped}["']`,
        "i"
      );
      const mb = text.match(backward);
      if (mb?.[1]) {
        const parsed = parseSubtitleFieldToCandidates(mb[1]);
        if (parsed.length) {
          return parsed;
        }
      }

      const idRe = new RegExp(`["']id["']\\s*:\\s*["']${escaped}["']`, "gi");
      let match = idRe.exec(text);
      while (match) {
        const slice = text.slice(match.index, match.index + 48000);
        const subM = slice.match(/["']subtitle["']\s*:\s*["']([^"']+)["']/i);
        if (subM?.[1]) {
          const parsed = parseSubtitleFieldToCandidates(subM[1]);
          if (parsed.length) {
            return parsed;
          }
        }
        match = idRe.exec(text);
      }
    }

    return [];
  }

  /**
   * Все обнаруженные пары label + url. При известном data-episode-key сначала берём subtitle из JSON объекта с этим id,
   * иначе «глобальный» сканер цепляется за первый .vtt из всего каталога серий.
   */
  function collectVttCandidatesSync() {
    const seen = new Set();
    /** @type {{ label: string, url: string }[]} */
    const list = [];

    function add(label, urlRaw) {
      if (!urlRaw || typeof urlRaw !== "string") {
        return;
      }
      const trimmed = urlRaw.trim();
      if (!/\.vtt(\?|#|$)/i.test(trimmed)) {
        return;
      }
      try {
        const url = new URL(trimmed, window.location.href).href;
        if (seen.has(url)) {
          return;
        }
        seen.add(url);
        list.push({ label: label || "Subtitles", url });
      } catch (_) {
        /* ignore */
      }
    }

    // Нативные дорожки у <video> — привязаны к текущему воспроизведению.
    for (const track of document.querySelectorAll("video track, track")) {
      const kind = (track.getAttribute("kind") || "").toLowerCase();
      if (kind && kind !== "subtitles" && kind !== "captions") {
        continue;
      }
      add(
        track.getAttribute("label") || track.getAttribute("srclang") || "track",
        track.getAttribute("src")
      );
    }

    const episodeKey = getActiveEpisodeKeyFromDom();
    let fromEpisodeJson = [];
    if (episodeKey) {
      fromEpisodeJson = collectVttFromPlayerjsJsonByEpisodeId(episodeKey);
      for (const item of fromEpisodeJson) {
        add(item.label, item.url);
      }
    }

    const needFallbackScan = !episodeKey || fromEpisodeJson.length === 0;

    if (!needFallbackScan) {
      return list;
    }

    const fullText = getSubtitleScanText();

    // Playerjs: subtitle: "[Label]url.vtt, ..." или отдельная строка только с квадратными скобками.
    const subtitleBlock =
      fullText.match(/["']subtitle["']\s*:\s*["']([^"']+)["']/i)?.[1]
      || fullText.match(/\bsubtitle\s*:\s*["']([^"']+)["']/i)?.[1]
      || "";
    const textsToScan = [subtitleBlock, fullText];

    for (const text of textsToScan) {
      if (!text) {
        continue;
      }
      const bracket = /\[([^\]]+)\]\s*([^\s,]+\.vtt[^\s,]*)/gi;
      let m = bracket.exec(text);
      while (m) {
        add(m[1], m[2]);
        m = bracket.exec(text);
      }
    }

    // JSON "file"|"src"|"url" -> *.vtt; при известном эпизоде не заливаем все подряд (избегаем s1e1).
    const jsonUrl = /"(?:file|src|url)"\s*:\s*"([^"]+\.vtt[^"]*)"/gi;
    const hintList = episodeKey ? expandDataEpisodeKeyToHints(episodeKey) : [];
    for (let jm = jsonUrl.exec(fullText); jm; jm = jsonUrl.exec(fullText)) {
      if (episodeKey && hintList.length) {
        const low = jm[1].toLowerCase();
        const ok = hintList.some((h) => h.length >= 2 && low.includes(h.toLowerCase()));
        if (!ok) {
          continue;
        }
      }
      add("Subtitles", jm[1]);
    }

    // Первый .vtt в тексте без привязки к эпизоду даёт «залипание» на чужой серии при SPA.
    if (!episodeKey) {
      const bare =
        fullText.match(/https?:\/\/[^\s"'<>]+\.vtt(?:\?[^\s"'<>]*)?/i)?.[0]
        || fullText.match(/\/[^\s"'<>]+\.vtt(?:\?[^\s"'<>]*)?/i)?.[0];
      if (bare) {
        add("Subtitles", bare);
      }
    }

    return list;
  }

  /** Чем ближе путь .vtt к пути текущего медиа, тем вероятнее это дорожка именно этого эпизода, а не чужой .vtt со страницы. */
  function scoreVttUrlAgainstVideo(vttUrl, videoSrc) {
    if (!videoSrc || !vttUrl) {
      return 0;
    }
    try {
      const v = new URL(videoSrc, window.location.href);
      const t = new URL(vttUrl, window.location.href);
      if (v.hostname !== t.hostname) {
        return 0;
      }
      const vParts = v.pathname.split("/").filter(Boolean);
      const tParts = t.pathname.split("/").filter(Boolean);
      let score = 0;
      for (let i = 0; i < Math.min(vParts.length, tParts.length); i++) {
        if (vParts[i] === tParts[i]) {
          score += 20;
        } else {
          break;
        }
      }
      return score;
    } catch (_) {
      return 0;
    }
  }

  function pickPreferredVttSource(candidates, dataEpisodeKey) {
    if (!candidates?.length) {
      return null;
    }
    const video = getVideoElement();
    const videoSrc = (video && (video.currentSrc || video.src)) || "";
    const episodeHints = buildCombinedEpisodeHints();
    const keyForScore = dataEpisodeKey ?? getActiveEpisodeKeyFromDom();
    const activeLang = getActiveSubtitleLanguageFromDom().toLowerCase();
    const isLangDisabled = /отключ|выкл|off|none|disable/i.test(activeLang);

    const ranked = candidates
      .map((c, index) => {
        let score = scoreVttUrlAgainstVideo(c.url, videoSrc);
        score += scoreVttAgainstEpisodeHints(c.url, episodeHints);
        score += scoreVttAgainstDataEpisodeKey(c.url, keyForScore);
        const lowerLabel = (c.label || "").toLowerCase();
        if (!isLangDisabled && activeLang) {
          if (lowerLabel.includes(activeLang) || activeLang.includes(lowerLabel)) {
            score += 200;
          }
        }
        if (/english|eng|англ/i.test(c.label)) {
          score += 15;
        }
        return { label: c.label, url: c.url, score, _order: index };
      })
      .sort((a, b) => b.score - a.score || a._order - b._order);
    const best = ranked[0];
    return { label: best.label, url: best.url };
  }

  function collectM3u8UrlsFromText(text) {
    const urls = [];
    const seen = new Set();
    const abs = /https?:\/\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/gi;
    let m = abs.exec(text);
    while (m) {
      const href = m[0];
      if (!seen.has(href)) {
        seen.add(href);
        urls.push(href);
      }
      m = abs.exec(text);
    }
    const rel = /\/[^\s"'<>]+\.m3u8(?:\?[^\s"'<>]*)?/gi;
    m = rel.exec(text);
    while (m) {
      try {
        const href = new URL(m[0], window.location.href).href;
        if (!seen.has(href)) {
          seen.add(href);
          urls.push(href);
        }
      } catch (_) {
        /* ignore */
      }
      m = rel.exec(text);
    }
    const video = getVideoElement();
    const videoSrc = (video && (video.currentSrc || video.src)) || "";
    return urls
      .map((u) => ({ url: u, score: scoreVttUrlAgainstVideo(u, videoSrc) }))
      .sort((a, b) => b.score - a.score)
      .map((x) => x.url);
  }

  /**
   * Если субтитры приходят из HLS: в master .m3u8 строка #EXT-X-MEDIA:TYPE=SUBTITLES,... URI="....vtt"
   * Несколько master на странице — берём manifest ближе к URL текущего видео.
   */
  async function tryPickVttFromHlsManifest() {
    const text = getSubtitleScanText();
    const orderedM3u8 = collectM3u8UrlsFromText(text);
    for (const m3u8Url of orderedM3u8) {
      try {
        const manifestUrl = new URL(m3u8Url, window.location.href).href;
        const res = await fetch(manifestUrl, { credentials: "include" });
        if (!res.ok) {
          continue;
        }
        const body = await res.text();
        /** @type {{ label: string, url: string }[]} */
        const out = [];
        for (const line of body.split(/\r?\n/)) {
          if (!/TYPE=SUBTITLES/i.test(line)) {
            continue;
          }
          const uri = line.match(/URI="([^"]+)"/i)?.[1];
          if (!uri || !/\.vtt/i.test(uri)) {
            continue;
          }
          const label =
            line.match(/NAME="([^"]+)"/i)?.[1]
            || line.match(/LANGUAGE="([^"]+)"/i)?.[1]
            || "Subtitles";
          out.push({ label, url: new URL(uri, manifestUrl).href });
        }
        const picked = pickPreferredVttSource(out, getActiveEpisodeKeyFromDom());
        if (picked) {
          return picked;
        }
      } catch (_) {
        /* следующий manifest */
      }
    }
    return null;
  }

  function parseVtt(value) {
    // BOM + CRLF: без нормализации первая строка может быть "\uFEFFWEBVTT"
    const normalized = value.replace(/^\uFEFF/, "").replace(/\r/g, "");
    const blocks = normalized.split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      let lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) {
        continue;
      }
      // Не отбрасывать блок целиком из‑за WEBVTT: при одном \n между заголовком и первой репликой
      // (без пустой строки) здесь же окажутся и куи — иначе файл парсился как пустой.
      while (lines.length) {
        const head = lines[0].replace(/^\uFEFF/, "");
        if (head === "WEBVTT") {
          lines.shift();
          continue;
        }
        if (/^(Kind|Language|Region):/i.test(head)) {
          lines.shift();
          continue;
        }
        if (/^X-TIMESTAMP-MAP=/i.test(head)) {
          lines.shift();
          continue;
        }
        break;
      }
      if (lines.length === 0) {
        continue;
      }

      const timeLineIndex = lines.findIndex((line) => line.includes("-->"));
      if (timeLineIndex < 0) {
        continue;
      }

      const [rawStart, rawEnd] = lines[timeLineIndex].split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const start = parseVttTime(rawStart);
      const end = parseVttTime(rawEnd);
      const text = normalizeText(lines.slice(timeLineIndex + 1).join(" ").replace(/<[^>]+>/g, ""));
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
        continue;
      }

      cues.push({
        end,
        index: cues.length,
        start,
        text
      });
    }

    return cues;
  }

  function parseVttTime(value) {
    const parts = value.split(":");
    const secondsPart = parts.pop() || "0";
    const seconds = Number(secondsPart.replace(",", "."));
    const minutes = Number(parts.pop() || 0);
    const hours = Number(parts.pop() || 0);
    return hours * 3600 + minutes * 60 + seconds;
  }

  function findCueByDisplayedText(cues, displayedText, videoTime) {
    const normalized = normalizeText(displayedText);
    if (!normalized || !cues?.length) {
      return null;
    }

    const matches = cues.filter((cue) => normalizeText(cue.text) === normalized);
    if (matches.length === 0) {
      return null;
    }
    if (matches.length === 1) {
      return matches[0];
    }
    if (!Number.isFinite(videoTime)) {
      return matches[0];
    }

    const inRange = matches.find((cue) => videoTime >= cue.start && videoTime <= cue.end + 0.03);
    if (inRange) {
      return inRange;
    }

    return findNearestCue(matches, videoTime) || matches[0];
  }

  function resolveCueFromTimeline(timeline, selectedCue, videoTime) {
    if (selectedCue) {
      return selectedCue;
    }

    const fromDom = findCueByDisplayedText(timeline.cues, getDisplayedSubtitle(), videoTime);
    if (fromDom) {
      return fromDom;
    }

    return timeline.cues.find((item) => videoTime !== undefined && videoTime >= item.start && videoTime <= item.end + 0.03)
      || findNearestCue(timeline.cues, videoTime);
  }

  function getCueContext(timeline, selectedCue) {
    const videoTime = getVideoTime();
    const cue = resolveCueFromTimeline(timeline, selectedCue, videoTime);
    if (!cue) {
      return null;
    }

    return {
      currentSubtitle: cue.text,
      previousSubtitle: timeline.cues[cue.index - 1]?.text || "",
      nextSubtitle: timeline.cues[cue.index + 1]?.text || "",
      cue,
      timeline: {
        cues: timeline.cues.slice(Math.max(0, cue.index - 4), Math.min(timeline.cues.length, cue.index + 5)),
        shiftSeconds: timeline.shiftSeconds,
        sourceLabel: timeline.sourceLabel,
        sourceUrl: timeline.sourceUrl
      },
      videoTime
    };
  }

  function findNearestCue(cues, videoTime) {
    if (!Number.isFinite(videoTime) || !cues?.length) {
      return null;
    }

    // Раньше: cues.find((cue) => videoTime < cue.start) — это ПЕРВЫЙ будущий куй.
    // В паузе между репликами показывался текст следующей фразы (иногда звуковые метки вроде [beeping]),
    // хотя на экране ещё предыдущая или пусто. В промежутке берём последний уже закончившийся куй.
    let lastBeforeOrInside = null;
    for (const cue of cues) {
      if (videoTime < cue.start) {
        return lastBeforeOrInside;
      }
      if (videoTime <= cue.end) {
        return cue;
      }
      lastBeforeOrInside = cue;
    }
    return lastBeforeOrInside;
  }

  function findPlaybackToggle() {
    const candidates = Array.from(document.querySelectorAll("div"));
    return candidates.find((element) => {
      const style = element.getAttribute("style") || "";
      return style.includes("cursor: pointer")
        && style.includes("pointer-events: auto")
        && style.includes("20px")
        && style.includes("transform: scale(1.8)");
    }) || null;
  }
})();
