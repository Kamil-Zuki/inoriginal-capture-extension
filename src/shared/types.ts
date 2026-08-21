export type FieldMapping = {
  expression: string;
  word: string;
  image: string;
  audio: string;
  transcription: string;
  source: string;
  wordTypes: string;
  definition: string;
  translation: string;
  mnemonic: string;
  example: string;
  antonyms: string;
  synonyms: string;
  url: string;
};

export type QualityRules = {
  requireWord: boolean;
  requireDefinition: boolean;
  requireTranslation: boolean;
  maxRecommendedAudioMs: number;
};

export type AnkiSettings = {
  settingsVersion?: number;
  captureMode: "auto-vtt" | "manual-range" | "dom-fallback";
  endpoint: string;
  deckName: string;
  modelName: string;
  rewindMs: number;
  maxClipMs: number;
  qualityRules: QualityRules;
  translationMode: "manual" | "after-capture" | "before-send";
  translationSourceLang: string;
  translationTargetLang: string;
  tags: string;
  fieldMapping: FieldMapping;
};

export type CaptureData = {
  capturedAt?: number;
  pageTitle?: string;
  pageUrl?: string;
  subtitle?: string;
  previousSubtitle?: string;
  nextSubtitle?: string;
  subtitleCue?: SubtitleCue;
  subtitleTimeline?: {
    cues: SubtitleCue[];
    sourceLabel?: string;
    sourceUrl?: string;
    shiftSeconds?: number;
  };
  screenshot?: {
    dataUrl?: string;
    filename?: string;
  };
  audio?: {
    dataUrl?: string;
    filename?: string;
    durationMs?: number;
    stopReason?: "subtitle-change" | "subtitle-ended" | "manual" | "max-duration" | "range" | "cue-end" | "next-cue-start";
    videoStartTime?: number;
    videoEndTime?: number;
    recordingStartedAt?: number;
    recordingStoppedAt?: number;
  };
  captureMode?: "auto-vtt" | "manual-range" | "dom-fallback";
  currentVideoTime?: number;
  cardState?: "capturing" | "review" | "created";
  captureStep?: "idle" | "screenshot" | "rewinding" | "waiting-subtitle" | "recording-audio" | "stopping" | "review-ready" | "sending-anki" | "created" | "failed" | "cancelled";
  captureEvents?: Array<{
    at: number;
    level: "info" | "success" | "warning" | "error";
    message: string;
    step: string;
  }>;
  error?: string;
  noteId?: number;
  createdAt?: number;
};

export type SubtitleCue = {
  end: number;
  index: number;
  start: number;
  text: string;
};

export type SentenceDraft = {
  expression: string;
  word: string;
  transcription: string;
  wordTypes: string;
  translation: string;
  definition: string;
  example: string;
  synonyms: string;
  antonyms: string;
  source: string;
  url: string;
};

export type CardHistoryItem = {
  noteId: number;
  subtitle: string;
  pageTitle: string;
  pageUrl: string;
  createdAt: number;
};

export type PopupContext = {
  capture?: CaptureData;
  sentenceDraft?: SentenceDraft;
  settings: AnkiSettings;
  choices: {
    deckNames?: string[];
    modelNames?: string[];
    modelFieldNames?: string[];
  };
  cardHistory?: CardHistoryItem[];
  isRecording: boolean;
  sessionMode: string | null;
};

export type RuntimeResponse<T> = {
  ok?: boolean;
  error?: string;
  result?: T;
  context?: PopupContext;
  settings?: AnkiSettings;
};
