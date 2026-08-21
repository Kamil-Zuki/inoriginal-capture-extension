export type StudioStep = "capture" | "edit" | "send";

export type FlowStatus =
  | "Idle"
  | "Rewinding"
  | "Recording subtitle audio"
  | "Ready to review"
  | "Sending to Anki"
  | "Created"
  | "Failed"
  | "Cancelled";

export type SmartAction =
  | "capture"
  | "stop-recording"
  | "pick-word"
  | "define-word"
  | "translate"
  | "fix-audio"
  | "open-settings"
  | "send";

export type QualityTone = "required" | "recommended" | "risk";

export type QualityItem = {
  action?: SmartAction;
  actionLabel?: string;
  label: string;
  done: boolean;
  detail: string;
  tone: QualityTone;
};

export type CardQuality = {
  cta: string;
  disabled: boolean;
  footerCopy: string;
  items: QualityItem[];
  nextAction: SmartAction;
  score: number;
  status: "Blocked" | "Needs review" | "Ready";
};

