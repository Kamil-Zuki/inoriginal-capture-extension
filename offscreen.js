const recordings = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "start-audio-recording") {
    void startRecording(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        chrome.runtime.sendMessage({
          type: "recording-error",
          error: error.message
        });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  if (message?.type === "stop-audio-recording") {
    void stopRecording(message.tabId, message.metadata || {})
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        chrome.runtime.sendMessage({
          type: "recording-error",
          error: error.message
        });
        sendResponse({ ok: false, error: error.message });
      });
    return true;
  }

  return false;
});

async function startRecording({ streamId, tabId, startedAt, metadata = {} }) {
  if (recordings.has(tabId)) {
    await stopRecording(tabId);
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const chunks = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm"
  });
  const monitor = await createAudioMonitor(stream).catch((error) => {
    console.warn("Could not route captured tab audio back to speakers.", error);
    return null;
  });

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recordings.set(tabId, {
    chunks,
    metadata,
    monitor,
    recorder,
    startedAt,
    stream
  });

  recorder.start(1000);
}

async function stopRecording(tabId, metadata = {}) {
  const entry = recordings.get(tabId);
  if (!entry) {
    return;
  }

  const blob = await new Promise((resolve) => {
    entry.recorder.onstop = () => resolve(new Blob(entry.chunks, { type: "audio/webm" }));
    entry.recorder.stop();
  });

  entry.stream.getTracks().forEach((track) => track.stop());
  await closeAudioMonitor(entry.monitor);
  recordings.delete(tabId);

  const dataUrl = await blobToDataUrl(blob);
  await chrome.runtime.sendMessage({
    type: "audio-recording-ready",
    dataUrl,
    metadata: {
      ...entry.metadata,
      ...metadata,
      recordingStartedAt: entry.startedAt,
      recordingStoppedAt: Date.now()
    },
    startedAt: entry.startedAt
  });
}

async function createAudioMonitor(stream) {
  const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextConstructor) {
    return null;
  }

  const audioContext = new AudioContextConstructor();
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioContext.destination);
  await audioContext.resume();

  return { audioContext, source };
}

async function closeAudioMonitor(monitor) {
  if (!monitor) {
    return;
  }

  monitor.source.disconnect();
  await monitor.audioContext.close().catch(() => {});
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read audio blob."));
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}
