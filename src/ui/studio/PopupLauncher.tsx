import type { CaptureData } from "../../shared/types";
import type { CardQuality, FlowStatus } from "./types";

type PopupLauncherProps = {
  capture?: CaptureData;
  flowStatus: FlowStatus;
  isRecording: boolean;
  message: string;
  onCapture: () => void;
  onOpenWorkspace: () => void;
  onStopRecording: () => void;
  onCancelCapture: () => void;
};

export function PopupLauncher({
  capture,
  flowStatus,
  isRecording,
  message,
  onCapture,
  onOpenWorkspace,
  onStopRecording,
  onCancelCapture
}: PopupLauncherProps) {
  return (
    <main className="quick-panel quick-panel--launcher">
      <header className="quick-header">
        <div>
          <p className="eyebrow">InOriginal</p>
          <h1>Capture</h1>
        </div>
        <StatusPill status={flowStatus} />
      </header>

      <p className="subtitle subtitle--current quick-subtitle">
        {capture?.subtitle || "Pause on a subtitle in the video, then capture."}
      </p>
      <p className="muted quick-hint">{message}</p>

      <div className="quick-actions">
        <button className="primary-action" disabled={isRecording} onClick={onCapture} type="button">
          Capture subtitle
        </button>
        <button className="secondary" onClick={onOpenWorkspace} type="button">
          Open workspace
        </button>
        {isRecording && (
          <button className="secondary" onClick={onCancelCapture} type="button">
            Cancel
          </button>
        )}
      </div>
    </main>
  );
}

function StatusPill({ status }: { status: FlowStatus }) {
  return (
    <span className={`status-pill status-pill--${status.toLowerCase().replaceAll(" ", "-")}`}>
      {status}
    </span>
  );
}
