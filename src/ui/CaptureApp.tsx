import { useEffect, useRef, useState } from "react";
import { getPopupContext, saveAnkiSettings, sendRuntimeMessage } from "../shared/chromeApi";
import type { AnkiSettings, CaptureData, PopupContext, SentenceDraft } from "../shared/types";
import { PopupLauncher } from "./studio/PopupLauncher";
import type { StudioStep } from "./studio/types";
import "./styles.css";

const STUDIO_STEP_KEY = "inoriginal-capture-active-step";

type CaptureAppProps = {
  mode: "popup" | "sidepanel";
};

type FlowStatus = "Idle" | "Rewinding" | "Recording subtitle audio" | "Ready to review" | "Sending to Anki" | "Created" | "Failed" | "Cancelled";
type TrimSuggestion = {
  start: number;
  end: number;
};
type SmartAction = "capture" | "stop-recording" | "pick-word" | "define-word" | "translate" | "fix-audio" | "open-settings" | "send";
type QualityTone = "required" | "recommended" | "risk";
type QualityItem = {
  action?: SmartAction;
  actionLabel?: string;
  label: string;
  done: boolean;
  detail: string;
  tone: QualityTone;
};
type CardQuality = {
  cta: string;
  disabled: boolean;
  footerCopy: string;
  items: QualityItem[];
  nextAction: SmartAction;
  score: number;
  status: "Blocked" | "Needs review" | "Ready";
};
type HealthIssue = {
  detail: string;
  fix: string;
  title: string;
  tone: "error" | "warning" | "info";
};

export function CaptureApp({ mode }: CaptureAppProps) {
  const [context, setContext] = useState<PopupContext | null>(null);
  const [flowStatus, setFlowStatus] = useState<FlowStatus>("Idle");
  const [message, setMessage] = useState("Loading...");
  const [expression, setExpression] = useState("");
  const [word, setWord] = useState("");
  const [transcription, setTranscription] = useState("");
  const [wordTypes, setWordTypes] = useState("");
  const [translation, setTranslation] = useState("");
  const [definition, setDefinition] = useState("");
  const [example, setExample] = useState("");
  const [synonyms, setSynonyms] = useState("");
  const [antonyms, setAntonyms] = useState("");
  const [source, setSource] = useState("");
  const [url, setUrl] = useState("");
  const [isTranslating, setIsTranslating] = useState(false);
  const [isLookingUpWord, setIsLookingUpWord] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState("");
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [audioRangeStart, setAudioRangeStart] = useState(0);
  const [audioRangeEnd, setAudioRangeEnd] = useState(0);
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([]);
  const [trimSuggestion, setTrimSuggestion] = useState<TrimSuggestion | null>(null);
  const [isAnalyzingAudio, setIsAnalyzingAudio] = useState(false);
  const [waveformError, setWaveformError] = useState("");
  const [showAudioAdvanced, setShowAudioAdvanced] = useState(false);
  const lastCaptureSignature = useRef("");
  const lastSavedDraftSignature = useRef("");
  const lastAutoTranslateSignature = useRef("");
  const lastAudioRangeFile = useRef("");
  const lastAutoTrimFile = useRef("");
  const hasHydratedEditor = useRef(false);
  const expressionRef = useRef<HTMLTextAreaElement | null>(null);
  const confirmedDuplicateExpression = useRef("");
  const lastReviewReadyStep = useRef("");
  const cardPreviewRef = useRef<HTMLDivElement | null>(null);
  const pendingScrollToPreview = useRef(false);
  const [activeStep, setActiveStep] = useState<StudioStep>(() => {
    const stored = sessionStorage.getItem(STUDIO_STEP_KEY);
    return stored === "edit" || stored === "send" ? stored : "capture";
  });
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh(false);
    }, 1500);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    sessionStorage.setItem(STUDIO_STEP_KEY, activeStep);
  }, [activeStep]);

  useEffect(() => {
    const captureStep = context?.capture?.captureStep;
    if (captureStep === "review-ready" && lastReviewReadyStep.current !== "review-ready") {
      setActiveStep("edit");
      pendingScrollToPreview.current = true;
    }
    lastReviewReadyStep.current = captureStep || "";
  }, [context?.capture?.captureStep]);

  useEffect(() => {
    if (!pendingScrollToPreview.current || activeStep !== "edit") {
      return;
    }

    const capture = context?.capture;
    const hasPreviewContent = Boolean(
      capture?.subtitle ||
      capture?.audio?.dataUrl ||
      capture?.screenshot?.dataUrl ||
      expression.trim() ||
      word.trim() ||
      translation.trim()
    );

    if (!hasPreviewContent) {
      return;
    }

    pendingScrollToPreview.current = false;
    window.requestAnimationFrame(() => {
      cardPreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [activeStep, context?.capture, expression, word, translation]);

  useEffect(() => {
    if (!hasHydratedEditor.current) {
      return;
    }

    const draft = buildSentenceDraft({
      expression,
      word,
      transcription,
      wordTypes,
      translation,
      definition,
      example,
      synonyms,
      antonyms,
      source,
      url
    });
    const signature = buildDraftSignature(draft);
    if (signature === lastSavedDraftSignature.current) {
      return;
    }

    lastSavedDraftSignature.current = signature;
    void sendRuntimeMessage({
      type: "save-sentence-draft",
      draft
    });
  }, [expression, word, transcription, wordTypes, translation, definition, example, synonyms, antonyms, source, url]);

  useEffect(() => {
    if (
      context?.settings.translationMode !== "after-capture"
      || !context.capture?.audio?.dataUrl
      || !expression.trim()
      || translation.trim()
      || isTranslating
    ) {
      return;
    }

    const signature = `${context.capture.audio.filename || ""}|${expression}|${context.settings.translationSourceLang}|${context.settings.translationTargetLang}`;
    if (signature === lastAutoTranslateSignature.current) {
      return;
    }

    lastAutoTranslateSignature.current = signature;
    void translateSubtitle({ silent: true });
  }, [context, expression, translation, isTranslating]);

  useEffect(() => {
    const duration = getEffectiveAudioDuration(context?.capture, audioDuration);
    const filename = context?.capture?.audio?.filename || "";
    if (!duration || !filename || lastAudioRangeFile.current === filename) {
      return;
    }

    lastAudioRangeFile.current = filename;
    setAudioRangeStart(0);
    setAudioRangeEnd(Number(duration.toFixed(2)));
  }, [context?.capture, audioDuration]);

  useEffect(() => {
    const audio = context?.capture?.audio;
    const filename = audio?.filename || "";
    if (!audio?.dataUrl || !filename) {
      setWaveformPeaks([]);
      setTrimSuggestion(null);
      setWaveformError("");
      return;
    }

    let cancelled = false;
    setIsAnalyzingAudio(true);
    setWaveformError("");

    analyzeAudioDataUrl(audio.dataUrl)
      .then((analysis) => {
        if (cancelled) {
          return;
        }

        setWaveformPeaks(analysis.peaks);
        setTrimSuggestion(analysis.trim);
        setAudioDuration((current) => current || analysis.duration);

        if (analysis.trim && lastAutoTrimFile.current !== filename) {
          lastAutoTrimFile.current = filename;
          setAudioRangeStart(analysis.trim.start);
          setAudioRangeEnd(analysis.trim.end);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setWaveformPeaks([]);
          setTrimSuggestion(null);
          setWaveformError(error instanceof Error ? error.message : "Could not analyze audio waveform.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsAnalyzingAudio(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [context?.capture?.audio?.dataUrl, context?.capture?.audio?.filename]);

  async function refresh(showLoading = true) {
    if (showLoading) {
      setMessage("Loading...");
    }

    try {
      const nextContext = await getPopupContext();
      setContext(nextContext);
      hydrateEditor(nextContext.capture, nextContext.sentenceDraft);
      setFlowStatus(deriveFlowStatus(nextContext));
      setMessage(buildMessage(nextContext));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load extension UI.");
    }
  }

  function hydrateEditor(capture?: CaptureData, storedDraft?: SentenceDraft) {
    const signature = buildCaptureSignature(capture);
    if (hasHydratedEditor.current && signature === lastCaptureSignature.current) {
      return;
    }

    const nextDraft = buildSentenceDraft({
      ...storedDraft,
      expression: storedDraft?.expression || capture?.subtitle || "",
      example: storedDraft?.example || buildExampleText(capture),
      source: storedDraft?.source || capture?.pageTitle || "",
      url: storedDraft?.url || capture?.pageUrl || ""
    });

    setExpression(nextDraft.expression);
    setWord(nextDraft.word);
    setTranscription(nextDraft.transcription);
    setWordTypes(nextDraft.wordTypes);
    setTranslation(nextDraft.translation);
    setDefinition(nextDraft.definition);
    setExample(nextDraft.example);
    setSynonyms(nextDraft.synonyms);
    setAntonyms(nextDraft.antonyms);
    setSource(nextDraft.source);
    setUrl(nextDraft.url);
    setDuplicateWarning("");
    setAudioDuration(null);
    lastCaptureSignature.current = signature;
    lastSavedDraftSignature.current = buildDraftSignature(nextDraft);
    hasHydratedEditor.current = true;
  }

  async function captureSubtitleClip() {
    setFlowStatus("Rewinding");
    setMessage("Preparing subtitle capture...");
    const response = await sendRuntimeMessage({ type: "capture-subtitle-clip" });
    if (!response.ok) {
      await refresh(false);
      setFlowStatus("Failed");
      setMessage(response.error || "Capture failed.");
      return;
    }

    await refresh(false);
  }

  async function retakeScreenshot() {
    setMessage("Retaking screenshot...");
    const response = await sendRuntimeMessage({ type: "take-screenshot" });
    if (!response.ok) {
      setMessage(response.error || "Screenshot failed.");
      return;
    }

    await refresh();
  }

  async function recaptureAudio() {
    setFlowStatus("Rewinding");
    setMessage("Re-recording subtitle audio...");
    const response = await sendRuntimeMessage({ type: "recapture-subtitle-audio" });
    if (!response.ok) {
      await refresh(false);
      setFlowStatus("Failed");
      setMessage(response.error || "Audio re-record failed.");
      return;
    }

    await refresh(false);
  }

  async function cancelCapture() {
    setMessage("Cancelling capture...");
    const response = await sendRuntimeMessage({ type: "cancel-capture" });
    if (!response.ok) {
      setMessage(response.error || "Could not cancel capture.");
      return;
    }

    await refresh(false);
  }

  async function stopRecording() {
    setMessage("Stopping audio recording...");
    const response = await sendRuntimeMessage({ type: "stop-current-capture" });
    if (!response.ok) {
      await refresh(false);
      setFlowStatus("Failed");
      setMessage(response.error || "Could not stop recording.");
      return;
    }

    await refresh(false);
  }

  async function recaptureSelectedAudioRange() {
    const effectiveDuration = getEffectiveAudioDuration(context?.capture, audioDuration);
    const rangeEnd = effectiveDuration
      ? Math.min(audioRangeEnd || effectiveDuration, effectiveDuration)
      : audioRangeEnd;

    if (!effectiveDuration || rangeEnd <= audioRangeStart) {
      setMessage("Choose a valid audio range first.");
      return;
    }

    setFlowStatus("Recording subtitle audio");
    setMessage("Re-recording selected range...");
    const response = await sendRuntimeMessage({
      type: "record-audio-range",
      payload: {
        startOffsetMs: Math.round(audioRangeStart * 1000),
        endOffsetMs: Math.round(rangeEnd * 1000)
      }
    });

    if (!response.ok) {
      await refresh(false);
      setFlowStatus("Failed");
      setMessage(response.error || "Selected range re-record failed.");
      return;
    }

    await refresh(false);
  }

  function applyTrimSuggestion() {
    if (!trimSuggestion) {
      setMessage("No speech range found to auto-trim.");
      return;
    }

    setAudioRangeStart(trimSuggestion.start);
    setAudioRangeEnd(trimSuggestion.end);
    setMessage(`Auto-trim applied: ${trimSuggestion.start.toFixed(1)}s to ${trimSuggestion.end.toFixed(1)}s.`);
  }

  function resetAudioRange() {
    const effectiveDuration = getEffectiveAudioDuration(context?.capture, audioDuration);
    if (!effectiveDuration) {
      return;
    }

    setAudioRangeStart(0);
    setAudioRangeEnd(Number(effectiveDuration.toFixed(2)));
    setMessage("Audio range reset to the full clip.");
  }

  async function createCard() {
    if (!canSendToAnki(context, expression)) {
      setMessage("Capture subtitle, screenshot, audio, deck, and note type first.");
      return;
    }

    const plannedDuration = getPlannedAudioDuration(context?.capture);
    const effectiveDuration = getEffectiveAudioDuration(context?.capture, audioDuration);
    if (plannedDuration && effectiveDuration && effectiveDuration < plannedDuration * 0.65) {
      setShowAudioAdvanced(true);
      setMessage(`Audio looks too short (${effectiveDuration.toFixed(1)}s vs planned ${plannedDuration.toFixed(1)}s). Re-record selected range before sending.`);
      return;
    }

    let finalTranslation = translation;
    if (context?.settings.translationMode === "before-send" && !finalTranslation.trim()) {
      const translatedText = await translateSubtitle({ silent: true });
      if (!translatedText) {
        setMessage("Translation failed. You can edit Translation manually or switch translation mode to Manual.");
        return;
      }
      finalTranslation = translatedText;
    }

    const duplicateOk = await warnIfDuplicateExpression();
    if (!duplicateOk) {
      return;
    }

    setFlowStatus("Sending to Anki");
    setMessage("Sending card to Anki...");
    const response = await sendRuntimeMessage<{ noteId: number }>({
      type: "create-anki-card",
      payload: {
        subtitle: expression || context?.capture?.subtitle,
        draft: {
          expression,
          word,
          transcription,
          wordTypes,
          translation: finalTranslation,
          definition,
          example,
          synonyms,
          antonyms,
          source,
          url
        },
        settings: {
          deckName: context?.settings.deckName,
          modelName: context?.settings.modelName
        }
      }
    });

    if (!response.ok) {
      await refresh(false);
      setFlowStatus("Failed");
      setMessage(response.error || "Failed to create card.");
      return;
    }

    await refresh(false);
    setFlowStatus("Created");
    setMessage(`Card created: ${response.result?.noteId}`);
  }

  async function translateSubtitle(options: { silent?: boolean } = {}) {
    const text = expression || context?.capture?.subtitle || "";
    if (!text.trim()) {
      if (!options.silent) {
        setMessage("No subtitle text to translate.");
      }
      return "";
    }

    setIsTranslating(true);
    if (!options.silent) {
      setMessage("Translating subtitle...");
    }
    const response = await sendRuntimeMessage<{ translatedText: string; provider: string }>({
      type: "translate-text",
      text,
      options: {
        sourceLang: context?.settings.translationSourceLang,
        targetLang: context?.settings.translationTargetLang
      }
    });
    setIsTranslating(false);

    if (!response.ok || !response.result?.translatedText) {
      setMessage(response.error || "Translation failed.");
      return "";
    }

    const translatedText = response.result.translatedText;
    setTranslation(translatedText);
    setMessage(options.silent ? "Translation added." : `Translated with ${response.result.provider}.`);
    return translatedText;
  }

  function useSelectedWord() {
    const input = expressionRef.current;
    const selectedText = input
      ? expression.slice(input.selectionStart, input.selectionEnd).trim()
      : "";
    const fallback = selectedText || expression.split(/\s+/).find(Boolean) || "";
    const normalized = normalizeWord(fallback);

    if (!normalized) {
      setMessage("Select a word in Expression first.");
      return;
    }

    setWord(normalized);
    setMessage(`Word set: ${normalized}`);
  }

  async function lookupDefinition() {
    const targetWord = word.trim();
    if (!targetWord) {
      setMessage("Set Word before dictionary lookup.");
      return;
    }

    setIsLookingUpWord(true);
    setMessage("Looking up definition...");
    const response = await sendRuntimeMessage<{
      antonyms?: string;
      definition: string;
      example?: string;
      partOfSpeech?: string;
      phonetic?: string;
      provider: string;
      synonyms?: string;
      word?: string;
      wordTypes?: string;
    }>({
      type: "lookup-word",
      word: targetWord
    });
    setIsLookingUpWord(false);

    if (!response.ok || !response.result?.definition) {
      setMessage(response.error || "Dictionary lookup failed.");
      return;
    }

    const dictionaryDraft = buildDictionaryDraft(response.result);
    const resolvedWord = response.result.word || targetWord;
    setWord(resolvedWord);
    applyDictionaryDraft(dictionaryDraft);
    void persistCurrentDraft({
      word: resolvedWord,
      ...dictionaryDraft
    });
    setMessage(`Definition added from ${response.result.provider}.`);
  }

  async function chooseWordFromExpression(targetWord: string) {
    const normalized = normalizeWord(targetWord);
    if (!normalized) {
      return;
    }

    setWord(normalized);
    void persistCurrentDraft({ word: normalized });
    setIsLookingUpWord(true);
    setMessage(`Looking up "${normalized}"...`);
    const response = await sendRuntimeMessage<{
      antonyms?: string;
      definition: string;
      example?: string;
      partOfSpeech?: string;
      phonetic?: string;
      provider: string;
      synonyms?: string;
      word?: string;
      wordTypes?: string;
    }>({
      type: "lookup-word",
      word: normalized
    });
    setIsLookingUpWord(false);

    if (!response.ok || !response.result?.definition) {
      setMessage(response.error || `Could not auto-fill "${normalized}".`);
      return;
    }

    const dictionaryDraft = buildDictionaryDraft(response.result);
    const resolvedWord = response.result.word || normalized;
    setWord(resolvedWord);
    applyDictionaryDraft(dictionaryDraft);
    void persistCurrentDraft({
      word: resolvedWord,
      ...dictionaryDraft
    });
    setMessage(`Word picked: ${resolvedWord}. Dictionary fields filled.`);
  }

  function buildDictionaryDraft(result: {
    antonyms?: string;
    definition: string;
    example?: string;
    partOfSpeech?: string;
    phonetic?: string;
    synonyms?: string;
    wordTypes?: string;
  }) {
    const parts = [
      result.partOfSpeech ? `(${result.partOfSpeech}) ${result.definition}` : result.definition,
      result.example ? `Example: ${result.example}` : ""
    ].filter(Boolean);

    return {
      antonyms: result.antonyms || "",
      definition: parts.join("\n"),
      synonyms: result.synonyms || "",
      transcription: result.phonetic || "",
      wordTypes: result.wordTypes || result.partOfSpeech || ""
    };
  }

  function applyDictionaryDraft(draft: Pick<SentenceDraft, "antonyms" | "definition" | "synonyms" | "transcription" | "wordTypes">) {
    setDefinition(draft.definition);
    setTranscription(draft.transcription);
    setWordTypes(draft.wordTypes);
    setSynonyms(draft.synonyms);
    setAntonyms(draft.antonyms);
  }

  function applyDictionaryResult(result: {
    antonyms?: string;
    definition: string;
    example?: string;
    partOfSpeech?: string;
    phonetic?: string;
    synonyms?: string;
    wordTypes?: string;
  }) {
    applyDictionaryDraft(buildDictionaryDraft(result));
  }

  async function persistCurrentDraft(overrides: Partial<SentenceDraft>) {
    const draft = buildSentenceDraft({
      expression,
      word,
      transcription,
      wordTypes,
      translation,
      definition,
      example,
      synonyms,
      antonyms,
      source,
      url,
      ...overrides
    });
    lastSavedDraftSignature.current = buildDraftSignature(draft);
    await sendRuntimeMessage({
      type: "save-sentence-draft",
      draft
    });
  }

  async function warnIfDuplicateExpression() {
    const value = expression.trim();
    if (!value || confirmedDuplicateExpression.current === value) {
      return true;
    }

    const response = await sendRuntimeMessage<{ count: number; noteIds: number[] }>({
      type: "find-duplicate-expression",
      expression: value
    });

    if (!response.ok || !response.result?.count) {
      setDuplicateWarning("");
      return true;
    }

    setDuplicateWarning(`Possible duplicate: ${response.result.count} note(s) already contain this expression. Click Send to Anki again to send anyway.`);
    confirmedDuplicateExpression.current = value;
    setMessage("Possible duplicate found.");
    return false;
  }

  function resetEditorFields() {
    setExpression("");
    setWord("");
    setTranscription("");
    setWordTypes("");
    setTranslation("");
    setDefinition("");
    setExample("");
    setSynonyms("");
    setAntonyms("");
    setSource("");
    setUrl("");
    setDuplicateWarning("");
    setAudioDuration(null);
    setAudioRangeStart(0);
    setAudioRangeEnd(0);
    setWaveformPeaks([]);
    setTrimSuggestion(null);
    setWaveformError("");
    setShowAudioAdvanced(false);
    lastCaptureSignature.current = "";
    lastSavedDraftSignature.current = "";
    lastAutoTranslateSignature.current = "";
    lastAudioRangeFile.current = "";
    lastAutoTrimFile.current = "";
    hasHydratedEditor.current = false;
  }

  async function clearCapture() {
    setMessage("Clearing capture…");
    const response = await sendRuntimeMessage({ type: "clear-draft" });
    if (!response.ok) {
      setMessage(response.error || "Could not clear capture.");
      return;
    }

    resetEditorFields();
    setContext(null);
    setFlowStatus("Idle");
    setActiveStep("capture");
    setOverflowOpen(false);
    setMessage("Capture cleared. Screenshot, audio, subtitles, and draft fields were reset.");
    await refresh(false);
  }

  async function makeAnother() {
    await clearCapture();
  }

  async function openInAnki() {
    const noteId = context?.capture?.noteId;
    if (!noteId) {
      setMessage("No created Anki note is available.");
      return;
    }

    const response = await sendRuntimeMessage({
      type: "open-anki-note",
      noteId
    });
    setMessage(response.ok ? "Opened in Anki." : response.error || "Could not open Anki.");
  }

  async function undoLastCard() {
    const noteId = context?.capture?.noteId;
    if (!noteId) {
      setMessage("No created Anki note is available to undo.");
      return;
    }

    const confirmed = window.confirm(`Delete Anki note ${noteId} and restore this draft for editing?`);
    if (!confirmed) {
      return;
    }

    setMessage("Deleting last Anki card...");
    const response = await sendRuntimeMessage({
      type: "undo-last-anki-card",
      noteId
    });
    if (!response.ok) {
      setMessage(response.error || "Could not undo the last Anki card.");
      return;
    }

    setFlowStatus("Ready to review");
    setMessage("Last Anki card deleted. Draft restored for editing.");
    await refresh(false);
  }

  async function openSidePanel() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.windowId) {
      setMessage("No active window available for the side panel.");
      return;
    }

    if (typeof chrome.sidePanel?.open !== "function") {
      setMessage("This Chrome version does not support side panel opening.");
      return;
    }

    await chrome.sidePanel.open({ windowId: tab.windowId });
  }

  async function selectSubtitleCue(index: number) {
    setMessage("Selecting subtitle from timeline...");
    const response = await sendRuntimeMessage({ type: "select-subtitle-cue", index });
    if (!response.ok) {
      setMessage(response.error || "Could not select subtitle cue.");
      return;
    }

    await refresh(false);
  }

  async function copyDiagnostics() {
    const report = buildDiagnosticsReport(capture, effectiveAudioDuration);
    if (!report) {
      setMessage("No diagnostics available yet.");
      return;
    }

    await navigator.clipboard.writeText(report);
    setMessage("Diagnostics copied.");
  }

  async function runSmartAction(action: SmartAction) {
    if (action === "capture") {
      setActiveStep("capture");
      await captureSubtitleClip();
      return;
    }

    if (action === "stop-recording") {
      await stopRecording();
      return;
    }

    if (action === "pick-word") {
      setActiveStep("edit");
      expressionRef.current?.focus();
      setMessage("Click a word under Expression to fill dictionary fields.");
      return;
    }

    if (action === "define-word") {
      setActiveStep("edit");
      await lookupDefinition();
      return;
    }

    if (action === "translate") {
      setActiveStep("edit");
      await translateSubtitle();
      return;
    }

    if (action === "fix-audio") {
      setActiveStep("capture");
      setShowAudioAdvanced(true);
      setMessage("Adjust the audio range or re-record the clean range before sending.");
      return;
    }

    if (action === "open-settings") {
      setActiveStep("send");
      chrome.runtime.openOptionsPage();
      return;
    }

    setActiveStep("send");
    await createCard();
  }

  async function updateDeck(deckName: string) {
    if (!context) {
      return;
    }

    const settings = await saveAnkiSettings({ deckName });
    setContext({ ...context, settings });
  }

  async function updateModel(modelName: string) {
    if (!context) {
      return;
    }

    const settings = await saveAnkiSettings({ modelName });
    setContext({ ...context, settings });
    await refresh(false);
  }

  async function updateCaptureMode(captureMode: AnkiSettings["captureMode"]) {
    if (!context) {
      return;
    }

    const settings = await saveAnkiSettings({ captureMode });
    setContext({ ...context, settings });
  }

  const capture = context?.capture;
  const draft = { expression, word, transcription, wordTypes, translation, definition, example, synonyms, antonyms, source, url };
  const ready = canSendToAnki(context, expression);
  const isRecording = Boolean(context?.isRecording);
  const canStopRecording = context?.sessionMode === "clip" || context?.sessionMode === "range";
  const effectiveAudioDuration = getEffectiveAudioDuration(capture, audioDuration);
  const cardQuality = buildCardQuality({
    context,
    draft,
    duplicateWarning,
    effectiveAudioDuration,
    isRecording
  });
  const audioRangeStartMin = getAudioRangeStartMin(capture);
  const normalizedAudioRangeEnd = effectiveAudioDuration
    ? Math.min(audioRangeEnd || effectiveAudioDuration, effectiveAudioDuration)
    : audioRangeEnd;
  const plannedAudioDuration = getPlannedAudioDuration(capture);
  const audioHealthIssues = capture ? buildCaptureHealthIssues(capture, effectiveAudioDuration, plannedAudioDuration) : [];
  const blockingAudioIssue = audioHealthIssues.find((issue) => issue.tone === "error" && /Audio|Recorder|range/i.test(issue.title));
  const hasDraft = Boolean(capture?.subtitle || capture?.audio?.dataUrl || capture?.screenshot?.dataUrl);
  const showCardPreview =
    (activeStep === "edit" || activeStep === "send") &&
    (hasDraft || Boolean(expression.trim()) || Boolean(word.trim()) || Boolean(translation.trim()));

  if (mode === "popup") {
    return (
      <PopupLauncher
        capture={capture}
        flowStatus={flowStatus}
        isRecording={isRecording}
        message={message}
        onCancelCapture={() => void cancelCapture()}
        onCapture={() => void captureSubtitleClip()}
        onOpenWorkspace={() => void openSidePanel()}
        onStopRecording={() => void stopRecording()}
      />
    );
  }

  return (
    <main className="studio-shell studio-shell--workspace">
      <header className="studio-topbar studio-topbar--sticky">
        <div className="studio-topbar__brand">
          <p className="eyebrow">Subtitle Studio</p>
          <h1>InOriginal Capture</h1>
        </div>
        <WorkflowTabs activeStep={activeStep} onChange={setActiveStep} />
        <div className="studio-topbar__actions">
          <StatusPill status={flowStatus} />
          <div className="overflow-menu">
            <button
              aria-expanded={overflowOpen}
              aria-label="More actions"
              className="secondary ghost-button overflow-menu__trigger"
              onClick={() => setOverflowOpen((open) => !open)}
              type="button"
            >
              ⋯
            </button>
            {overflowOpen && (
              <div className="overflow-menu__panel">
                <button
                  onClick={() => {
                    setOverflowOpen(false);
                    chrome.runtime.openOptionsPage();
                  }}
                  type="button"
                >
                  Settings
                </button>
                {hasDraft && !isRecording && (
                  <button
                    onClick={() => {
                      setOverflowOpen(false);
                      void clearCapture();
                    }}
                    type="button"
                  >
                    Discard draft
                  </button>
                )}
                {isRecording && (
                  <button
                    onClick={() => {
                      setOverflowOpen(false);
                      void cancelCapture();
                    }}
                    type="button"
                  >
                    Cancel capture
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="studio-body">
        {activeStep === "capture" && (
          <section className="studio-step studio-step--capture">
            <div className="section-head">
              <h2>Capture</h2>
              <p className="status">{message}</p>
            </div>
            <p className="subtitle subtitle--muted subtitle--context">{capture?.previousSubtitle || "No previous subtitle."}</p>
            <p className="subtitle subtitle--current subtitle--hero">{capture?.subtitle || "No current subtitle yet."}</p>
            <p className="subtitle subtitle--muted subtitle--context">{capture?.nextSubtitle || "No next subtitle."}</p>
            <TimelineReview capture={capture} onSelect={selectSubtitleCue} />
            <section className="studio-grid">
              <article className="media-tile">
                <div className="section-head">
                  <h3>Screenshot</h3>
                  <button className="secondary inline-action" disabled={isRecording} onClick={retakeScreenshot} type="button">Retake</button>
                </div>
                {capture?.screenshot?.dataUrl ? (
                  <img className="media-preview media-preview--image" alt="Screenshot preview" src={capture.screenshot.dataUrl} />
                ) : (
                  <p className="muted media-empty">No screenshot yet.</p>
                )}
              </article>
              <article className="media-tile">
                <div className="section-head">
                  <h3>Audio clip</h3>
                  <button className="secondary inline-action" disabled={isRecording} onClick={recaptureAudio} type="button">Re-record</button>
                </div>
                {capture?.audio?.dataUrl ? (
                  <>
                    <audio className="media-preview media-preview--audio" controls src={capture.audio.dataUrl} onLoadedMetadata={(event) => {
                      const duration = event.currentTarget.duration;
                      setAudioDuration(Number.isFinite(duration) ? duration : null);
                    }} />
                    <p className="status">{formatAudioStatus(capture, effectiveAudioDuration)}</p>
                    {blockingAudioIssue && (
                      <AudioQualityGuard
                        disabled={isRecording || capture.audio.videoStartTime === undefined}
                        issue={blockingAudioIssue}
                        onRepair={recaptureSelectedAudioRange}
                        onSwitchMode={() => updateCaptureMode("manual-range")}
                      />
                    )}
                    {effectiveAudioDuration && (
                      <div className="range-editor">
                        <div>
                          <h4>{trimSuggestion ? "Clean range ready" : isAnalyzingAudio ? "Finding clean range..." : "Clean range"}</h4>
                          <p className="muted">{buildAudioGuidance(trimSuggestion, isAnalyzingAudio)}</p>
                        </div>
                        <WaveformPreview
                          duration={effectiveAudioDuration}
                          peaks={waveformPeaks}
                          rangeEnd={normalizedAudioRangeEnd}
                          rangeStart={audioRangeStart}
                          trimSuggestion={trimSuggestion}
                        />
                        <div className="range-editor__actions">
                          <button
                            className="primary-action inline-action"
                            disabled={isRecording || capture.audio.videoStartTime === undefined}
                            onClick={recaptureSelectedAudioRange}
                            type="button"
                          >
                            Re-record selected range
                          </button>
                          <button className="secondary inline-action" onClick={() => setShowAudioAdvanced(!showAudioAdvanced)} type="button">
                            {showAudioAdvanced ? "Hide manual controls" : "Adjust manually"}
                          </button>
                        </div>
                        {waveformError && <p className="muted media-empty">{waveformError}</p>}
                        {showAudioAdvanced && (
                          <div className="range-editor__advanced">
                            <div className="range-editor__labels">
                              <span>Start: {audioRangeStart.toFixed(1)}s</span>
                              <span>End: {normalizedAudioRangeEnd.toFixed(1)}s</span>
                            </div>
                            <input
                              aria-label="Audio range start"
                              max={Math.max(0, normalizedAudioRangeEnd - 0.1)}
                              min={audioRangeStartMin}
                              step={0.1}
                              type="range"
                              value={audioRangeStart}
                              onChange={(event) => {
                                const nextStart = Math.min(Number(event.target.value), normalizedAudioRangeEnd - 0.1);
                                setAudioRangeStart(Math.max(audioRangeStartMin, nextStart));
                              }}
                            />
                            <input
                              aria-label="Audio range end"
                              max={effectiveAudioDuration}
                              min={Math.min(effectiveAudioDuration, audioRangeStart + 0.1)}
                              step={0.1}
                              type="range"
                              value={normalizedAudioRangeEnd}
                              onChange={(event) => setAudioRangeEnd(Math.max(Number(event.target.value), audioRangeStart + 0.1))}
                            />
                            <div className="range-editor__actions">
                              <button className="secondary inline-action" disabled={!trimSuggestion || isAnalyzingAudio} onClick={applyTrimSuggestion} type="button">
                                Apply auto-trim
                              </button>
                              <button className="secondary inline-action" disabled={isRecording} onClick={resetAudioRange} type="button">Reset full clip</button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="muted media-empty">No audio yet.</p>
                )}
              </article>
            </section>
            <div className="capture-step__settings">
              <CaptureModeSelect mode={context?.settings.captureMode || "auto-vtt"} onChange={updateCaptureMode} compact />
              <button className="secondary inline-action" onClick={() => chrome.runtime.openOptionsPage()} type="button">
                Capture settings…
              </button>
            </div>
            <CaptureDiagnostics capture={capture} effectiveAudioDuration={effectiveAudioDuration} onCopy={copyDiagnostics} />
            <CaptureTimeline capture={capture} />
          </section>
        )}

        {showCardPreview && activeStep === "edit" && (
          <div ref={cardPreviewRef} className="studio-card-preview-anchor">
            <StudioCardPreview context={context} draft={draft} />
          </div>
        )}

        {activeStep === "edit" && (
          <section className="studio-step studio-step--edit">
            <div className="section-head">
              <h2>Edit card</h2>
              <p className="status">{message}</p>
            </div>
            <section className="editor-grid editor-grid--focused">
              <div className="editor-card">
                <span>Expression</span>
                <textarea ref={expressionRef} rows={3} value={expression} onChange={(event) => {
                  setExpression(event.target.value);
                  setDuplicateWarning("");
                }} />
                <WordPicker expression={expression} isLoading={isLookingUpWord} selectedWord={word} onPick={chooseWordFromExpression} />
              </div>
              <label className="editor-card">
                <span>Word</span>
                <input value={word} onChange={(event) => setWord(event.target.value)} placeholder="Target word" />
                <div className="field-actions">
                  <button type="button" className="secondary inline-action" onClick={useSelectedWord}>Use selected word</button>
                  <button type="button" className="secondary inline-action" disabled={isLookingUpWord || !word.trim()} onClick={lookupDefinition}>
                    {isLookingUpWord ? "Looking up..." : "Define word"}
                  </button>
                </div>
              </label>
              <label className="editor-card">
                <span>Translation</span>
                <textarea rows={3} value={translation} onChange={(event) => setTranslation(event.target.value)} />
              </label>
              <label className="editor-card">
                <span>Definition</span>
                <textarea rows={3} value={definition} onChange={(event) => setDefinition(event.target.value)} />
              </label>
              <label className="editor-card editor-card--wide">
                <span>Example / Context</span>
                <textarea rows={4} value={example} onChange={(event) => setExample(event.target.value)} />
              </label>
            </section>
            <details className="editor-advanced">
              <summary>Advanced fields</summary>
              <section className="editor-grid">
                <label className="editor-card">
                  <span>Transcription</span>
                  <input value={transcription} onChange={(event) => setTranscription(event.target.value)} />
                </label>
                <label className="editor-card">
                  <span>Word Types</span>
                  <input value={wordTypes} onChange={(event) => setWordTypes(event.target.value)} />
                </label>
                <label className="editor-card">
                  <span>Synonyms</span>
                  <input value={synonyms} onChange={(event) => setSynonyms(event.target.value)} />
                </label>
                <label className="editor-card">
                  <span>Antonyms</span>
                  <input value={antonyms} onChange={(event) => setAntonyms(event.target.value)} />
                </label>
                <label className="editor-card">
                  <span>Source</span>
                  <input value={source} onChange={(event) => setSource(event.target.value)} />
                </label>
                <label className="editor-card">
                  <span>Url</span>
                  <input value={url} onChange={(event) => setUrl(event.target.value)} />
                </label>
              </section>
            </details>
            <section className="translator-panel">
              <div>
                <h3>Translator</h3>
                <p className="muted">
                  {formatTranslationMode(context?.settings.translationMode)} | {context?.settings.translationSourceLang || "en"} to {context?.settings.translationTargetLang || "ru"}
                </p>
              </div>
              <button className="secondary inline-action" disabled={isTranslating || !expression.trim()} onClick={() => translateSubtitle()} type="button">
                {isTranslating ? "Translating..." : "Translate subtitle"}
              </button>
            </section>
          </section>
        )}

        {showCardPreview && activeStep === "send" && (
          <StudioCardPreview context={context} draft={draft} />
        )}

        {activeStep === "send" && (
          <section className="studio-step studio-step--send">
            <div className="section-head">
              <h2>Send to Anki</h2>
              <p className="status">{message}</p>
            </div>
            <Checklist context={context} expression={expression} translation={translation} />
            <div className="compact-toolbar">
              <label>
                <span>Deck</span>
                <select value={context?.settings.deckName || ""} onChange={(event) => updateDeck(event.target.value)}>
                  {renderOptions(context?.choices.deckNames, context?.settings.deckName)}
                </select>
              </label>
              <label>
                <span>Note type</span>
                <select value={context?.settings.modelName || ""} onChange={(event) => updateModel(event.target.value)}>
                  {renderOptions(context?.choices.modelNames, context?.settings.modelName)}
                </select>
              </label>
            </div>
            <p className="muted">Field mapping is configured in extension Settings.</p>
            <CardQualityPanel quality={cardQuality} onAction={runSmartAction} />
            <details className="history-pane history-pane--inline">
              <summary>Recent cards</summary>
              {(context?.cardHistory || []).length === 0 ? (
                <p className="muted">No cards created yet.</p>
              ) : (
                <div className="history-list">
                  {(context?.cardHistory || []).map((item) => (
                    <button key={`${item.noteId}-${item.createdAt}`} className="history-item" onClick={() => sendRuntimeMessage({ type: "open-anki-note", noteId: item.noteId })} type="button">
                      <span>{item.subtitle}</span>
                      <small>{new Date(item.createdAt).toLocaleTimeString()}</small>
                    </button>
                  ))}
                </div>
              )}
            </details>
            {duplicateWarning && <p className="warning-banner">{duplicateWarning}</p>}
          </section>
        )}
      </div>

      <footer className="footer-bar footer-bar--sticky">
        {flowStatus === "Created" ? (
          <div className="created-actions">
            <span className="created-label">Card created</span>
            <button className="secondary" onClick={makeAnother} type="button">Make another</button>
            <button className="secondary danger-action" onClick={undoLastCard} type="button">Undo last card</button>
            <button className="secondary" onClick={openInAnki} type="button">Open in Anki</button>
          </div>
        ) : (
          <>
            <p className="muted footer-copy">{cardQuality.footerCopy}</p>
            {canStopRecording && (
              <button className="secondary" onClick={stopRecording} type="button">Stop recording</button>
            )}
            <button className="primary-action" disabled={cardQuality.disabled} onClick={() => runSmartAction(cardQuality.nextAction)} type="button">{cardQuality.cta}</button>
          </>
        )}
      </footer>
    </main>
  );
}

function CaptureTimeline({ capture }: { capture?: CaptureData }) {
  const events = capture?.captureEvents || [];
  if (events.length === 0) {
    return null;
  }

  return (
    <details className="capture-debug">
      <summary>Capture details</summary>
      <ol>
        {events.map((event) => (
          <li key={`${event.at}-${event.step}-${event.message}`} className={`capture-debug__event capture-debug__event--${event.level}`}>
            <span>{event.step}</span>
            <p>{event.message}</p>
            <small>{new Date(event.at).toLocaleTimeString()}</small>
          </li>
        ))}
      </ol>
    </details>
  );
}

function TimelineReview({ capture, onSelect }: { capture?: CaptureData; onSelect: (index: number) => void }) {
  const cues = capture?.subtitleTimeline?.cues || [];
  if (cues.length === 0) {
    return null;
  }

  const currentIndex = capture?.subtitleCue?.index;
  return (
    <div className="timeline-review">
      <div className="timeline-review__head">
        <span>VTT timeline</span>
        <small>{capture?.subtitleTimeline?.sourceLabel || "Subtitles"}</small>
      </div>
      <div className="timeline-review__list">
        {cues.map((cue) => (
          <button
            className={cue.index === currentIndex ? "timeline-cue timeline-cue--current" : "timeline-cue"}
            key={`${cue.index}-${cue.start}`}
            onClick={() => onSelect(cue.index)}
            type="button"
          >
            <small>{formatCueTime(cue.start)} - {formatCueTime(cue.end)}</small>
            <span>{cue.text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function CaptureDiagnostics({
  capture,
  effectiveAudioDuration,
  onCopy
}: {
  capture?: CaptureData;
  effectiveAudioDuration: number | null;
  onCopy: () => void;
}) {
  if (!capture) {
    return null;
  }

  const cue = capture.subtitleCue;
  const audio = capture.audio;
  const plannedDuration = getPlannedAudioDuration(capture);
  const timelineMode = cue ? "VTT cue-aware" : capture.subtitleTimeline?.cues?.length ? "VTT loaded" : "DOM fallback";
  const healthIssues = buildCaptureHealthIssues(capture, effectiveAudioDuration, plannedDuration);
  const rows = [
    ["Capture mode", formatCaptureMode(capture.captureMode)],
    ["Mode", timelineMode],
    ["Step", capture.captureStep || "unknown"],
    ["Stop reason", audio?.stopReason || "not recorded"],
    ["VTT source", capture.subtitleTimeline?.sourceLabel || "not loaded"],
    ["Cue", cue ? `#${cue.index} ${formatCueTime(cue.start)} - ${formatCueTime(cue.end)}` : "none"],
    ["Video now", capture.currentVideoTime !== undefined ? formatSecondsForUi(capture.currentVideoTime) : "unknown"],
    ["Recording started", audio?.recordingStartedAt ? new Date(audio.recordingStartedAt).toLocaleTimeString() : "none"],
    ["Recording stopped", audio?.recordingStoppedAt ? new Date(audio.recordingStoppedAt).toLocaleTimeString() : "none"],
    ["Planned audio", plannedDuration !== null ? `${formatSecondsForUi(audio?.videoStartTime || 0)} - ${formatSecondsForUi(audio?.videoEndTime || 0)} (${plannedDuration.toFixed(2)}s)` : "none"],
    ["Recorder metadata", audio?.durationMs ? `${(audio.durationMs / 1000).toFixed(2)}s` : "none"],
    ["Decoded audio", effectiveAudioDuration ? `${effectiveAudioDuration.toFixed(2)}s` : "not decoded"],
    ["Audio file", audio?.filename || "none"],
    ["Timeline cues", capture.subtitleTimeline?.cues?.length ? `${capture.subtitleTimeline.cues.length} visible` : "none"],
    ["Error", capture.error || "none"]
  ];

  return (
    <details className="diagnostics-panel">
      <summary>
        <span>Capture diagnostics</span>
        <button className="secondary inline-action" onClick={(event) => {
          event.preventDefault();
          onCopy();
        }} type="button">
          Copy debug report
        </button>
      </summary>
      <div className="diagnostics-health">
        {healthIssues.length === 0 ? (
          <div className="health-issue health-issue--ok">
            <strong>Capture health looks good</strong>
            <p>No obvious timing or metadata issues detected.</p>
          </div>
        ) : healthIssues.map((issue) => (
          <div className={`health-issue health-issue--${issue.tone}`} key={`${issue.tone}-${issue.title}`}>
            <strong>{issue.title}</strong>
            <p>{issue.detail}</p>
            <small>{issue.fix}</small>
          </div>
        ))}
      </div>
      <div className="diagnostics-grid">
        {rows.map(([label, value]) => (
          <div className="diagnostics-row" key={label}>
            <span>{label}</span>
            <p>{value}</p>
          </div>
        ))}
      </div>
      {capture.subtitleTimeline?.sourceUrl && (
        <p className="diagnostics-url">{capture.subtitleTimeline.sourceUrl}</p>
      )}
    </details>
  );
}

function CaptureModeSelect({
  compact = false,
  mode,
  onChange
}: {
  compact?: boolean;
  mode: AnkiSettings["captureMode"];
  onChange: (mode: AnkiSettings["captureMode"]) => void;
}) {
  return (
    <label className={compact ? "capture-mode capture-mode--compact" : "capture-mode"}>
      <span>Capture mode</span>
      <select value={mode} onChange={(event) => onChange(event.target.value as AnkiSettings["captureMode"])}>
        <option value="auto-vtt">Auto by VTT</option>
        <option value="manual-range">Manual range</option>
        <option value="dom-fallback">DOM subtitle fallback</option>
      </select>
    </label>
  );
}

function AudioQualityGuard({
  disabled,
  issue,
  onRepair,
  onSwitchMode
}: {
  disabled: boolean;
  issue: HealthIssue;
  onRepair: () => void;
  onSwitchMode: () => void;
}) {
  return (
    <div className="audio-guard">
      <div>
        <strong>Audio looks suspicious</strong>
        <p>{issue.detail}</p>
        <small>{issue.fix}</small>
      </div>
      <div className="audio-guard__actions">
        <button className="primary-action inline-action" disabled={disabled} onClick={onRepair} type="button">
          Re-record selected range
        </button>
        <button className="secondary inline-action" onClick={onSwitchMode} type="button">
          Use manual range mode
        </button>
      </div>
    </div>
  );
}

function WorkflowTabs({
  activeStep,
  onChange
}: {
  activeStep: StudioStep;
  onChange: (step: StudioStep) => void;
}) {
  const steps: Array<{ id: StudioStep; label: string; hint: string }> = [
    { id: "capture", label: "1 Capture", hint: "Subtitle, screenshot, audio" },
    { id: "edit", label: "2 Edit", hint: "Expression and dictionary fields" },
    { id: "send", label: "3 Send", hint: "Deck and Anki export" }
  ];

  return (
    <nav aria-label="Workflow steps" className="workflow-tabs">
      {steps.map((step) => (
        <button
          aria-current={activeStep === step.id ? "step" : undefined}
          className={activeStep === step.id ? "workflow-tab workflow-tab--active" : "workflow-tab"}
          key={step.id}
          onClick={() => onChange(step.id)}
          title={step.hint}
          type="button"
        >
          {step.label}
        </button>
      ))}
    </nav>
  );
}

function StatusPill({ status }: { status: FlowStatus }) {
  return <span className={`status-pill status-pill--${status.toLowerCase().replaceAll(" ", "-")}`}>{status}</span>;
}

function WordPicker({
  expression,
  isLoading,
  onPick,
  selectedWord
}: {
  expression: string;
  isLoading: boolean;
  onPick: (word: string) => void;
  selectedWord: string;
}) {
  const tokens = tokenizeExpression(expression);
  if (tokens.length === 0) {
    return <p className="muted word-picker__hint">Capture or type an expression, then click a word to auto-fill dictionary fields.</p>;
  }

  return (
    <div className="word-picker" aria-label="Clickable words from expression">
      <p className="word-picker__hint">Click a word to fill Word, Definition, Transcription, Word Types, Synonyms, and Antonyms.</p>
      <div className="word-picker__tokens">
        {tokens.map((token, index) => token.isWord ? (
          <button
            className={normalizeWord(token.value).toLowerCase() === selectedWord.toLowerCase() ? "word-token word-token--selected" : "word-token"}
            disabled={isLoading}
            key={`${token.value}-${index}`}
            onClick={() => onPick(token.value)}
            type="button"
          >
            {token.value}
          </button>
        ) : (
          <span className="word-token__punctuation" key={`${token.value}-${index}`}>{token.value}</span>
        ))}
      </div>
    </div>
  );
}

function WaveformPreview({
  duration,
  peaks,
  rangeEnd,
  rangeStart,
  trimSuggestion
}: {
  duration: number;
  peaks: number[];
  rangeEnd: number;
  rangeStart: number;
  trimSuggestion: TrimSuggestion | null;
}) {
  if (peaks.length === 0) {
    return <div className="waveform waveform--empty"><span>Waveform is loading...</span></div>;
  }

  const visibleStart = Math.max(0, rangeStart);
  const visibleEnd = Math.min(duration, rangeEnd);
  return (
    <div className="waveform" aria-label="Audio waveform preview">
      {peaks.map((peak, index) => {
        const pointTime = duration * ((index + 0.5) / peaks.length);
        const isSelected = pointTime >= visibleStart && pointTime <= visibleEnd;
        const isSuggested = Boolean(trimSuggestion && pointTime >= trimSuggestion.start && pointTime <= trimSuggestion.end);
        return (
          <span
            className={[
              "waveform__bar",
              isSuggested ? "waveform__bar--suggested" : "",
              isSelected ? "waveform__bar--selected" : ""
            ].filter(Boolean).join(" ")}
            key={`${index}-${peak.toFixed(3)}`}
            style={{ height: `${Math.max(8, Math.round(peak * 100))}%` }}
          />
        );
      })}
    </div>
  );
}

function Checklist({ context, expression, translation }: { context: PopupContext | null; expression: string; translation: string }) {
  const capture = context?.capture;
  const items = [
    ["Expression", Boolean(capture?.subtitle || expression)],
    ["Translation", Boolean(translation) || context?.settings.translationMode === "manual"],
    ["Screenshot", Boolean(capture?.screenshot?.dataUrl)],
    ["Audio", Boolean(capture?.audio?.dataUrl)],
    ["Deck", Boolean(context?.settings.deckName)],
    ["Note type", Boolean(context?.settings.modelName)],
    ["Mapping", Boolean(context?.settings.fieldMapping.expression)]
  ] as const;

  return (
    <div className="checklist">
      {items.map(([label, done]) => (
        <span key={label} className={done ? "checklist-item checklist-item--done" : "checklist-item"}>{label}</span>
      ))}
    </div>
  );
}

function CardQualityPanel({ onAction, quality }: { onAction: (action: SmartAction) => void; quality: CardQuality }) {
  return (
    <section className={`quality-panel quality-panel--${quality.status.toLowerCase().replace(" ", "-")}`}>
      <div className="quality-panel__head">
        <div>
          <p className="eyebrow">Smart Send</p>
          <h2>Card quality</h2>
        </div>
        <div className="quality-score" aria-label={`Card quality score ${quality.score}`}>
          <strong>{quality.score}</strong>
          <span>{quality.status}</span>
        </div>
      </div>
      <div className="quality-list">
        {quality.items.map((item) => (
          <div
            className={[
              "quality-item",
              item.done ? "quality-item--done" : "",
              `quality-item--${item.tone}`
            ].filter(Boolean).join(" ")}
            key={`${item.tone}-${item.label}`}
          >
            <span>{item.done ? "Ready" : item.tone === "risk" ? "Check" : "Missing"}</span>
            <strong>{item.label}</strong>
            <p>{item.detail}</p>
            {!item.done && item.action && (
              <button className="secondary inline-action quality-item__action" onClick={() => onAction(item.action as SmartAction)} type="button">
                {item.actionLabel || "Fix"}
              </button>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function StudioCardPreview({
  context,
  draft,
  collapsible = false,
  defaultOpen = true
}: {
  context: PopupContext | null;
  draft: SentenceDraft;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const preview = (
    <>
      <CardPreview context={context} draft={draft} />
      <AnkiFieldPreview context={context} draft={draft} />
    </>
  );

  if (collapsible) {
    return (
      <details className="studio-card-preview studio-card-preview--collapsible" open={defaultOpen}>
        <summary>Card preview</summary>
        {preview}
      </details>
    );
  }

  return <div className="studio-card-preview">{preview}</div>;
}

function CardPreview({ context, draft }: { context: PopupContext | null; draft: SentenceDraft }) {
  const capture = context?.capture;
  const mapping = context?.settings.fieldMapping;
  const warnings = [
    capture?.screenshot?.dataUrl && !mapping?.image ? "Image exists, but Image field is not mapped." : "",
    capture?.audio?.dataUrl && !mapping?.audio ? "Audio exists, but Audio field is not mapped." : "",
    draft.word && !mapping?.word ? "Word is filled, but Word field is not mapped." : "",
    draft.definition && !mapping?.definition ? "Definition is filled, but Definition field is not mapped." : "",
    draft.translation && !mapping?.translation ? "Translation is filled, but Translation field is not mapped." : ""
  ].filter(Boolean);

  const backRows = [
    ["Word", draft.word],
    ["Transcription", draft.transcription],
    ["Word Types", draft.wordTypes],
    ["Translation", draft.translation],
    ["Definition", draft.definition],
    ["Example", draft.example],
    ["Synonyms", draft.synonyms],
    ["Antonyms", draft.antonyms]
  ].filter(([, value]) => Boolean(value));

  return (
    <section className="card-preview" aria-label="Final Anki card preview">
      <div className="card-preview__head">
        <div>
          <p className="eyebrow">Final Preview</p>
          <h2>Card preview</h2>
        </div>
        <span>{context?.settings.deckName || "No deck"} / {context?.settings.modelName || "No note type"}</span>
      </div>

      <div className="card-preview__grid">
        <article className="card-face card-face--front">
          <span>Front</span>
          <p>{draft.expression || capture?.subtitle || "No expression yet."}</p>
        </article>

        <article className="card-face card-face--back">
          <span>Back</span>
          {backRows.length > 0 ? (
            <dl>
              {backRows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="muted">No Back fields yet.</p>
          )}
        </article>
      </div>

      <div className="card-preview__media">
        {capture?.screenshot?.dataUrl ? (
          <img alt="Card image preview" src={capture.screenshot.dataUrl} />
        ) : (
          <p className="muted media-empty">No image attached.</p>
        )}
        {capture?.audio?.dataUrl ? (
          <audio controls src={capture.audio.dataUrl} />
        ) : (
          <p className="muted media-empty">No audio attached.</p>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="card-preview__warnings">
          {warnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
    </section>
  );
}

function AnkiFieldPreview({ context, draft }: { context: PopupContext | null; draft: SentenceDraft }) {
  const mapping = context?.settings.fieldMapping;
  if (!mapping) {
    return null;
  }

  const rows = [
    ["Expression", mapping.expression, draft.expression],
    ["Word", mapping.word, draft.word],
    ["Transcription", mapping.transcription, draft.transcription],
    ["Word Types", mapping.wordTypes, draft.wordTypes],
    ["Translation", mapping.translation, draft.translation],
    ["Definition", mapping.definition, draft.definition],
    ["Example", mapping.example, draft.example],
    ["Synonyms", mapping.synonyms, draft.synonyms],
    ["Antonyms", mapping.antonyms, draft.antonyms],
    ["Source", mapping.source, draft.source],
    ["Url", mapping.url, draft.url],
    ["Image", mapping.image, context?.capture?.screenshot?.dataUrl ? "Screenshot media" : ""],
    ["Audio", mapping.audio, context?.capture?.audio?.dataUrl ? "Audio media" : ""]
  ].filter(([, fieldName]) => Boolean(fieldName));

  if (rows.length === 0) {
    return null;
  }

  return (
    <details className="anki-preview">
      <summary>Anki field preview</summary>
      <div className="anki-preview__grid">
        {rows.map(([label, fieldName, value]) => (
          <div className="anki-preview__row" key={`${label}-${fieldName}`}>
            <span>{label} {"->"} {fieldName}</span>
            <p>{value || "Empty"}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function renderOptions(values: string[] = [], selectedValue = "") {
  const options = values.includes(selectedValue) || !selectedValue
    ? values
    : [...values, selectedValue];

  return options.map((value) => (
    <option key={value} value={value}>{value}</option>
  ));
}

function formatTranslationMode(mode?: string) {
  if (mode === "before-send") {
    return "Auto before Send";
  }
  if (mode === "manual") {
    return "Manual";
  }
  return "Auto after Capture";
}

function buildCardQuality({
  context,
  draft,
  duplicateWarning,
  effectiveAudioDuration,
  isRecording
}: {
  context: PopupContext | null;
  draft: SentenceDraft;
  duplicateWarning: string;
  effectiveAudioDuration: number | null;
  isRecording: boolean;
}): CardQuality {
  const capture = context?.capture;
  const hasExpression = Boolean(draft.expression.trim() || capture?.subtitle);
  const hasScreenshot = Boolean(capture?.screenshot?.dataUrl);
  const hasAudio = Boolean(capture?.audio?.dataUrl);
  const hasDeck = Boolean(context?.settings.deckName);
  const hasModel = Boolean(context?.settings.modelName);
  const hasExpressionMapping = Boolean(context?.settings.fieldMapping.expression);
  const hasTranslation = Boolean(draft.translation.trim()) || context?.settings.translationMode === "manual";
  const hasWord = Boolean(draft.word.trim());
  const hasDefinition = Boolean(draft.definition.trim());
  const qualityRules = context?.settings.qualityRules;
  const requireWord = qualityRules?.requireWord ?? true;
  const requireDefinition = qualityRules?.requireDefinition ?? true;
  const requireTranslation = qualityRules?.requireTranslation ?? false;
  const maxRecommendedAudioMs = qualityRules?.maxRecommendedAudioMs ?? 8500;
  const audioTooLong = Boolean(effectiveAudioDuration && effectiveAudioDuration * 1000 > maxRecommendedAudioMs);
  const plannedDuration = getPlannedAudioDuration(capture);
  const audioTooShort = Boolean(plannedDuration && effectiveAudioDuration && effectiveAudioDuration < plannedDuration * 0.65);
  const hasDuplicateWarning = Boolean(duplicateWarning);
  const captureAction: QualityItem["action"] = "capture";
  const settingsAction: QualityItem["action"] = "open-settings";

  const required: QualityItem[] = [
    { action: captureAction, actionLabel: "Capture", label: "Expression", done: hasExpression, detail: "Subtitle or edited sentence is required.", tone: "required" },
    { action: captureAction, actionLabel: "Capture", label: "Screenshot", done: hasScreenshot, detail: "Image context should be attached to the card.", tone: "required" },
    { action: captureAction, actionLabel: "Capture audio", label: "Audio", done: hasAudio, detail: "Audio clip should be attached before sending.", tone: "required" },
    { action: settingsAction, actionLabel: "Choose deck", label: "Deck", done: hasDeck, detail: "Choose where Anki will save the card.", tone: "required" },
    { action: settingsAction, actionLabel: "Choose type", label: "Note type", done: hasModel, detail: "Choose the template used by Anki.", tone: "required" },
    { action: settingsAction, actionLabel: "Bind field", label: "Expression field", done: hasExpressionMapping, detail: "Bind the sentence to a real Anki field.", tone: "required" }
  ];

  const wordItem = {
    action: "pick-word" as const,
    actionLabel: "Pick word",
    label: "Target word",
    done: hasWord,
    detail: requireWord ? "Required by your quality rules." : "Pick the mined word so the card has a clear learning target.",
    tone: requireWord ? "required" as const : "recommended" as const
  };
  const definitionItem = {
    action: "define-word" as const,
    actionLabel: "Define",
    label: "Definition",
    done: hasDefinition,
    detail: requireDefinition ? "Required by your quality rules." : "Dictionary data makes the Back side useful for review.",
    tone: requireDefinition ? "required" as const : "recommended" as const
  };
  const translationItem = {
    action: "translate" as const,
    actionLabel: "Translate",
    label: "Translation",
    done: hasTranslation,
    detail: requireTranslation ? "Required by your quality rules." : "Translation helps quick comprehension during reviews.",
    tone: requireTranslation ? "required" as const : "recommended" as const
  };

  const requiredByRules = [wordItem, definitionItem, translationItem].filter((item) => item.tone === "required");
  const recommended = [wordItem, definitionItem, translationItem].filter((item) => item.tone === "recommended");
  const allRequired = [...required, ...requiredByRules];

  const risks: QualityItem[] = [
    { action: "fix-audio", actionLabel: "Re-record", label: "Audio timing", done: !audioTooShort, detail: audioTooShort && plannedDuration && effectiveAudioDuration ? `Audio is ${effectiveAudioDuration.toFixed(1)}s, but the planned subtitle range is ${plannedDuration.toFixed(1)}s.` : "Audio timing matches the planned range.", tone: "risk" },
    { action: "fix-audio", actionLabel: "Fix audio", label: "Audio length", done: !audioTooLong, detail: audioTooLong ? `Clip is longer than ${(maxRecommendedAudioMs / 1000).toFixed(1)}s. Trim or re-record the clean range.` : "Clip length looks focused.", tone: "risk" },
    { action: "send", actionLabel: "Send anyway", label: "Duplicate", done: !hasDuplicateWarning, detail: hasDuplicateWarning ? "This expression may already exist in Anki." : "No duplicate warning for this draft.", tone: "risk" }
  ];

  const requiredMissing = allRequired.filter((item) => !item.done);
  const recommendedMissing = recommended.filter((item) => !item.done);
  const activeRisks = risks.filter((item) => !item.done);
  const positiveItems = [...allRequired, ...recommended];
  const baseScore = Math.round((positiveItems.filter((item) => item.done).length / positiveItems.length) * 100);
  const score = Math.max(0, Math.min(100, baseScore - activeRisks.length * 8));
  const hasCriticalAudioRisk = audioTooShort;
  const status = requiredMissing.length > 0 || hasCriticalAudioRisk ? "Blocked" : recommendedMissing.length > 0 || activeRisks.length > 0 ? "Needs review" : "Ready";
  const qualityItems = [...allRequired, ...recommended, ...risks];

  if (isRecording) {
    return {
      cta: "Stop recording",
      disabled: false,
      footerCopy: "Recording is still running. Stop it to review the final clip.",
      items: qualityItems,
      nextAction: "stop-recording",
      score,
      status
    };
  }

  let nextAction: SmartAction = "send";
  let cta = hasDuplicateWarning ? "Send anyway" : "Send to Anki";
  let footerCopy = status === "Ready"
    ? "Looks ready. Send the final card to Anki."
    : "Smart Send found the next best fix before sending.";

  if (!hasExpression || !hasScreenshot || !hasAudio) {
    nextAction = "capture";
    cta = "Capture";
    footerCopy = "Capture will collect subtitle, screenshot, and audio first.";
  } else if (!hasDeck || !hasModel || !hasExpressionMapping) {
    nextAction = "open-settings";
    cta = "Open settings";
    footerCopy = "Finish deck, note type, and field mapping before sending.";
  } else if (requireWord && !hasWord) {
    nextAction = "pick-word";
    cta = "Pick a word";
    footerCopy = "Your quality rules require a target word before sending.";
  } else if (requireDefinition && !hasDefinition) {
    nextAction = "define-word";
    cta = "Define word";
    footerCopy = "Your quality rules require a definition before sending.";
  } else if (requireTranslation && !hasTranslation) {
    nextAction = "translate";
    cta = "Translate";
    footerCopy = "Your quality rules require translation before sending.";
  } else if (audioTooShort) {
    nextAction = "fix-audio";
    cta = "Re-record selected range";
    footerCopy = "Audio looks too short for the subtitle range. Repair it before sending.";
  } else if (recommendedMissing.length > 0 || audioTooLong) {
    footerCopy = "Optional improvements are available, but this card can be sent.";
  }

  return {
    cta,
    disabled: false,
    footerCopy,
    items: qualityItems,
    nextAction,
    score,
    status
  };
}

function buildAudioGuidance(trimSuggestion: TrimSuggestion | null, isAnalyzingAudio: boolean) {
  if (isAnalyzingAudio) {
    return "Analyzing silence and speech in the clip.";
  }

  if (trimSuggestion) {
    return `Suggested clean range: ${trimSuggestion.start.toFixed(1)}s to ${trimSuggestion.end.toFixed(1)}s. Preview it, then re-record only that part if the clip needs cleanup.`;
  }

  return "Preview the clip. If it has extra silence or missed speech, adjust manually or re-record from the subtitle.";
}

function getEffectiveAudioDuration(capture: CaptureData | undefined, metadataDuration: number | null) {
  if (metadataDuration && Number.isFinite(metadataDuration)) {
    return metadataDuration;
  }

  const durationFromCapture = capture?.audio?.durationMs ? capture.audio.durationMs / 1000 : null;
  if (durationFromCapture && Number.isFinite(durationFromCapture)) {
    return durationFromCapture;
  }

  const videoStart = capture?.audio?.videoStartTime;
  const videoEnd = capture?.audio?.videoEndTime;
  if (videoStart !== undefined && videoEnd !== undefined && videoEnd > videoStart) {
    return videoEnd - videoStart;
  }

  return null;
}

function getPlannedAudioDuration(capture: CaptureData | undefined) {
  const videoStart = capture?.audio?.videoStartTime;
  const videoEnd = capture?.audio?.videoEndTime;
  return videoStart !== undefined && videoEnd !== undefined && videoEnd > videoStart
    ? videoEnd - videoStart
    : null;
}

function formatCaptureMode(mode?: AnkiSettings["captureMode"]) {
  if (mode === "manual-range") {
    return "Manual range";
  }
  if (mode === "dom-fallback") {
    return "DOM subtitle fallback";
  }
  return "Auto by VTT";
}

function getAudioRangeStartMin(capture: CaptureData | undefined) {
  const videoStartTime = capture?.audio?.videoStartTime;
  if (videoStartTime === undefined) {
    return 0;
  }

  return -Math.min(5, videoStartTime);
}

async function analyzeAudioDataUrl(dataUrl: string): Promise<{
  duration: number;
  peaks: number[];
  trim: TrimSuggestion | null;
}> {
  const response = await fetch(dataUrl);
  const audioData = await response.arrayBuffer();
  const AudioContextConstructor = window.AudioContext
    || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) {
    throw new Error("This browser cannot analyze audio waveforms.");
  }

  const audioContext = new AudioContextConstructor();
  try {
    const audioBuffer = await audioContext.decodeAudioData(audioData.slice(0));
    const channel = audioBuffer.getChannelData(0);
    const duration = audioBuffer.duration;
    const peaks = buildWaveformPeaks(channel, 96);
    const trim = detectSpeechRange(channel, audioBuffer.sampleRate, duration);
    return { duration, peaks, trim };
  } finally {
    await audioContext.close().catch(() => {});
  }
}

function buildWaveformPeaks(channel: Float32Array, segmentCount: number) {
  const segmentSize = Math.max(1, Math.floor(channel.length / segmentCount));
  const peaks = Array.from({ length: segmentCount }, (_, index) => {
    const start = index * segmentSize;
    const end = Math.min(channel.length, start + segmentSize);
    let max = 0;

    for (let cursor = start; cursor < end; cursor += 1) {
      max = Math.max(max, Math.abs(channel[cursor]));
    }

    return max;
  });
  const maxPeak = Math.max(...peaks, 0.001);
  return peaks.map((peak) => peak / maxPeak);
}

function detectSpeechRange(channel: Float32Array, sampleRate: number, duration: number): TrimSuggestion | null {
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.05));
  const frameCount = Math.ceil(channel.length / frameSize);
  const rmsFrames = Array.from({ length: frameCount }, (_, frameIndex) => {
    const start = frameIndex * frameSize;
    const end = Math.min(channel.length, start + frameSize);
    let sum = 0;

    for (let cursor = start; cursor < end; cursor += 1) {
      sum += channel[cursor] * channel[cursor];
    }

    return Math.sqrt(sum / Math.max(1, end - start));
  });

  const maxRms = Math.max(...rmsFrames, 0);
  if (maxRms <= 0.003) {
    return null;
  }

  const threshold = Math.max(0.01, maxRms * 0.12);
  const firstSpeechFrame = rmsFrames.findIndex((value) => value >= threshold);
  const lastSpeechFrame = rmsFrames.length - 1 - [...rmsFrames].reverse().findIndex((value) => value >= threshold);

  if (firstSpeechFrame < 0 || lastSpeechFrame < firstSpeechFrame) {
    return null;
  }

  const padSeconds = 0.12;
  const start = Math.max(0, firstSpeechFrame * 0.05 - padSeconds);
  const end = Math.min(duration, (lastSpeechFrame + 1) * 0.05 + padSeconds);
  if (end - start < 0.25) {
    return null;
  }

  return {
    start: Number(start.toFixed(2)),
    end: Number(end.toFixed(2))
  };
}

function formatAudioStatus(capture: CaptureData, audioDuration: number | null) {
  const parts = [audioDuration ? `Audio: ${audioDuration.toFixed(1)}s` : "Audio ready"];
  if (capture.audio?.stopReason === "cue-end") {
    parts.push("stopped at subtitle cue end");
  }
  if (capture.audio?.stopReason === "max-duration") {
    parts.push("stopped at max length");
  }
  if (capture.audio?.stopReason === "manual") {
    parts.push("stopped manually");
  }
  if (capture.audio?.stopReason === "range") {
    parts.push("selected range");
  }
  return parts.join(" | ");
}

function formatCueTime(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatSecondsForUi(value: number) {
  return `${value.toFixed(2)}s`;
}

function buildCaptureHealthIssues(capture: CaptureData, effectiveAudioDuration: number | null, plannedDuration: number | null): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const audio = capture.audio;
  const cue = capture.subtitleCue;
  const hasTimeline = Boolean(capture.subtitleTimeline?.cues?.length);

  if (capture.error) {
    issues.push({
      detail: capture.error,
      fix: "Try Capture again. If it repeats, copy diagnostics.",
      title: "Capture reported an error",
      tone: "error"
    });
  }

  if (!hasTimeline) {
    issues.push({
      detail: "The extension could not load a VTT timeline and may rely on DOM subtitle changes.",
      fix: "Reload the InOriginal page. If VTT still does not load, use DOM fallback diagnostics.",
      title: "VTT timeline not loaded",
      tone: "warning"
    });
  } else if (!cue) {
    issues.push({
      detail: "A timeline is visible, but no selected cue is attached to this capture.",
      fix: "Click the desired subtitle in VTT timeline, then Capture again.",
      title: "No selected VTT cue",
      tone: "warning"
    });
  }

  if (audio?.videoStartTime !== undefined && audio.videoEndTime !== undefined && audio.videoEndTime <= audio.videoStartTime) {
    issues.push({
      detail: `Audio range is invalid: ${formatSecondsForUi(audio.videoStartTime)} to ${formatSecondsForUi(audio.videoEndTime)}.`,
      fix: "Recapture after selecting a VTT cue. If it repeats, copy diagnostics.",
      title: "Invalid audio range",
      tone: "error"
    });
  }

  if (cue && cue.end - cue.start < 0.8) {
    issues.push({
      detail: `The selected VTT cue is very short: ${(cue.end - cue.start).toFixed(2)}s.`,
      fix: "This is okay if the line is short. Use audio trim/range controls if the clip needs more context.",
      title: "Very short subtitle cue",
      tone: "info"
    });
  }

  if (audio?.dataUrl && !audio.durationMs) {
    issues.push({
      detail: "The audio file exists, but recorder duration metadata is missing.",
      fix: "Play the audio preview. If it sounds wrong, recapture and copy diagnostics.",
      title: "Missing recorder duration",
      tone: "warning"
    });
  }

  if (audio?.dataUrl && !effectiveAudioDuration) {
    issues.push({
      detail: "The audio file exists, but the browser has not decoded its duration yet.",
      fix: "Wait for the audio preview to load, or play it once.",
      title: "Decoded duration unavailable",
      tone: "info"
    });
  }

  if (plannedDuration && effectiveAudioDuration && effectiveAudioDuration < plannedDuration * 0.65) {
    issues.push({
      detail: `Decoded audio is ${effectiveAudioDuration.toFixed(2)}s, planned range was ${plannedDuration.toFixed(2)}s.`,
      fix: "Recapture. If it repeats, the recorder is stopping early; copy diagnostics.",
      title: "Audio shorter than planned",
      tone: "error"
    });
  }

  if (plannedDuration && audio?.durationMs && audio.durationMs / 1000 < plannedDuration * 0.65) {
    issues.push({
      detail: `Recorder metadata is ${(audio.durationMs / 1000).toFixed(2)}s, planned range was ${plannedDuration.toFixed(2)}s.`,
      fix: "Recapture after reloading the page. If it repeats, copy diagnostics.",
      title: "Recorder stopped early",
      tone: "error"
    });
  }

  if (audio?.stopReason && cue && !["cue-end", "range", "next-cue-start"].includes(audio.stopReason)) {
    issues.push({
      detail: `Stop reason was "${audio.stopReason}" even though a VTT cue was selected.`,
      fix: "DOM fallback or manual stop may have interrupted capture. Recapture and inspect events.",
      title: "Unexpected stop reason",
      tone: "warning"
    });
  }

  if (
    cue
    && audio?.videoStartTime !== undefined
    && Number.isFinite(cue.start)
  ) {
    const leadInSeconds = cue.start - audio.videoStartTime;
    if (leadInSeconds > 3 || leadInSeconds < -0.5) {
      issues.push({
        detail: `Cue starts at ${cue.start.toFixed(2)}s but recording began near ${audio.videoStartTime.toFixed(2)}s (lead-in ${leadInSeconds.toFixed(2)}s).`,
        fix: "VTT shift may be wrong or cue selection mismatched the video. Recapture and check diagnostics VTT shift.",
        title: "Recording start far from cue",
        tone: "warning"
      });
    }
  }

  return issues;
}

function buildDiagnosticsReport(capture: CaptureData | undefined, effectiveAudioDuration: number | null) {
  if (!capture) {
    return "";
  }

  const audio = capture.audio;
  const cue = capture.subtitleCue;
  const plannedDuration = audio?.videoStartTime !== undefined && audio.videoEndTime !== undefined
    ? Math.max(0, audio.videoEndTime - audio.videoStartTime)
    : null;
  const healthIssues = buildCaptureHealthIssues(capture, effectiveAudioDuration, plannedDuration);
  const lines = [
    "InOriginal Capture Diagnostics",
    `Generated: ${new Date().toISOString()}`,
    `Page: ${capture.pageTitle || ""}`,
    `URL: ${capture.pageUrl || ""}`,
    `Capture step: ${capture.captureStep || "unknown"}`,
    `Card state: ${capture.cardState || "unknown"}`,
    `Capture mode: ${formatCaptureMode(capture.captureMode)}`,
    `Subtitle: ${capture.subtitle || ""}`,
    `Previous: ${capture.previousSubtitle || ""}`,
    `Next: ${capture.nextSubtitle || ""}`,
    `Timeline mode: ${cue ? "VTT cue-aware" : capture.subtitleTimeline?.cues?.length ? "VTT loaded" : "DOM fallback"}`,
    `VTT label: ${capture.subtitleTimeline?.sourceLabel || ""}`,
    `VTT URL: ${capture.subtitleTimeline?.sourceUrl || ""}`,
    `VTT shift: ${capture.subtitleTimeline?.shiftSeconds != null && capture.subtitleTimeline.shiftSeconds !== 0
      ? `${capture.subtitleTimeline.shiftSeconds >= 0 ? "+" : ""}${capture.subtitleTimeline.shiftSeconds.toFixed(1)}s`
      : "none"}`,
    `Cue index: ${cue?.index ?? ""}`,
    `Cue start: ${cue?.start ?? ""}`,
    `Cue end: ${cue?.end ?? ""}`,
    `Current video time: ${capture.currentVideoTime ?? ""}`,
    `Audio filename: ${audio?.filename || ""}`,
    `Stop reason: ${audio?.stopReason || ""}`,
    `Video start: ${audio?.videoStartTime ?? ""}`,
    `Video end: ${audio?.videoEndTime ?? ""}`,
    `Planned duration: ${plannedDuration ?? ""}`,
    `Recorder durationMs: ${audio?.durationMs ?? ""}`,
    `Recording started at: ${audio?.recordingStartedAt ?? ""}`,
    `Recording stopped at: ${audio?.recordingStoppedAt ?? ""}`,
    `Decoded audio seconds: ${effectiveAudioDuration ?? ""}`,
    `Error: ${capture.error || ""}`,
    "",
    "Health:",
    ...(healthIssues.length
      ? healthIssues.map((issue) => `[${issue.tone}] ${issue.title}: ${issue.detail} Fix: ${issue.fix}`)
      : ["No obvious timing or metadata issues detected."]),
    "",
    "Events:",
    ...(capture.captureEvents || []).map((event) => `${new Date(event.at).toISOString()} [${event.level}] ${event.step}: ${event.message}`)
  ];

  return lines.join("\n");
}

function canSendToAnki(context: PopupContext | null, expression: string) {
  const capture = context?.capture;
  return Boolean(
    (capture?.subtitle || expression)
    && capture?.screenshot?.dataUrl
    && capture?.audio?.dataUrl
    && context?.settings.deckName
    && context?.settings.modelName
    && context?.settings.fieldMapping.expression
    && !context?.isRecording
  );
}

function buildExampleText(capture?: CaptureData) {
  if (!capture) {
    return "";
  }

  return [
    capture.previousSubtitle ? `Previous: ${capture.previousSubtitle}` : "",
    capture.subtitle ? `Current: ${capture.subtitle}` : "",
    capture.nextSubtitle ? `Next: ${capture.nextSubtitle}` : ""
  ].filter(Boolean).join("\n");
}

function buildSentenceDraft(value: Partial<SentenceDraft> = {}): SentenceDraft {
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

function buildDraftSignature(draft: SentenceDraft) {
  return [
    draft.expression,
    draft.word,
    draft.transcription,
    draft.wordTypes,
    draft.translation,
    draft.definition,
    draft.example,
    draft.synonyms,
    draft.antonyms,
    draft.source,
    draft.url
  ].join("|");
}

function normalizeWord(value: string) {
  return value.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, "");
}

function tokenizeExpression(value: string) {
  const matches = value.match(/[\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+/gu) || [];
  return matches
    .map((token) => ({
      isWord: Boolean(normalizeWord(token)),
      value: token
    }))
    .filter((token) => token.value.trim() || token.isWord);
}

function buildCaptureSignature(capture?: CaptureData) {
  if (!capture) {
    return "";
  }

  return [
    capture.subtitle || "",
    capture.previousSubtitle || "",
    capture.nextSubtitle || "",
    capture.screenshot?.filename || "",
    capture.audio?.filename || "",
    capture.pageUrl || "",
    capture.cardState || "",
    capture.captureStep || "",
    capture.error || "",
    capture.noteId || ""
  ].join("|");
}

function deriveFlowStatus(context: PopupContext): FlowStatus {
  if (context.isRecording && context.sessionMode === "clip-waiting") {
    return "Rewinding";
  }
  if (context.isRecording && context.sessionMode === "clip") {
    return "Recording subtitle audio";
  }
  if (context.capture?.cardState === "created") {
    return "Created";
  }
  if (context.capture?.captureStep === "failed") {
    return "Failed";
  }
  if (context.capture?.captureStep === "cancelled") {
    return "Cancelled";
  }
  if (context.capture?.error) {
    return "Ready to review";
  }
  if (context.capture?.subtitle && context.capture?.screenshot?.dataUrl && context.capture?.audio?.dataUrl) {
    return "Ready to review";
  }
  return "Idle";
}

function buildMessage(context: PopupContext) {
  if (context.isRecording && context.sessionMode === "clip-waiting") {
    return "Rewinding to catch the start of the subtitle.";
  }
  if (context.isRecording && context.sessionMode === "clip") {
    return "Recording subtitle audio.";
  }
  if (context.capture?.cardState === "created") {
    return `Card created${context.capture.noteId ? `: ${context.capture.noteId}` : ""}.`;
  }
  if (context.capture?.captureStep === "failed" && context.capture.error) {
    return context.capture.error;
  }
  if (context.capture?.captureStep === "cancelled") {
    return "Capture cancelled. You can capture again or keep editing the draft.";
  }
  if (context.capture?.error) {
    return context.capture.error;
  }
  if (context.capture?.subtitle && context.capture?.screenshot?.dataUrl && context.capture?.audio?.dataUrl) {
    return "Ready to review.";
  }
  return "Capture a subtitle to start a draft.";
}
