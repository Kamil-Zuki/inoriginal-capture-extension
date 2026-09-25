import { useEffect, useState, useRef } from "react";
import { sendRuntimeMessage } from "../../shared/chromeApi";
import type { PracticeState } from "../../shared/types";

type PracticeMode = "read" | "output" | "blind";

export function PracticePanel({ onSwitchToStudio }: { onSwitchToStudio: () => void }) {
  const [state, setState] = useState<PracticeState>({
    status: "idle",
    cues: [],
    activeCueIndex: -1,
    sourceLabel: "",
    error: "",
    autoPause: true,
    revealMode: "hide-during-playback"
  });

  const [mode, setMode] = useState<PracticeMode>("output");

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchState();
    const interval = setInterval(fetchState, 1500);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Avoid triggering when user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      switch (e.key) {
        case " ":
          e.preventDefault();
          void togglePlayPause();
          break;
        case "ArrowRight":
          e.preventDefault();
          void navigateCue(1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          void navigateCue(-1);
          break;
        case "ArrowUp":
        case "r":
        case "R":
          e.preventDefault();
          void replayCurrentCue();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [state.cues, state.activeCueIndex]);

  useEffect(() => {
    // Notify content script about auto-pause and reveal mode whenever they change or cue changes
    if (state.status === "ready" && state.cues[state.activeCueIndex]) {
      void sendRuntimeMessage({
        type: "control-video-playback",
        action: "set-auto-pause",
        payload: {
          enabled: state.autoPause,
          endTimestamp: state.cues[state.activeCueIndex].end
        }
      });
    }

    void sendRuntimeMessage({
      type: "control-video-playback",
      action: "set-reveal-mode",
      payload: { mode: state.revealMode }
    });
  }, [state.autoPause, state.revealMode, state.activeCueIndex, state.status]);

  async function fetchState() {
    const res = await sendRuntimeMessage<{ state: PracticeState }>({ type: "get-practice-state" });
    if (res.ok && res.state) {
      setState(res.state);
    }
  }

  async function syncCues() {
    setState((s) => ({ ...s, status: "loading" }));
    const res = await sendRuntimeMessage<{ state: PracticeState }>({ type: "sync-practice-cues" });
    if (res.ok && res.state) {
      setState(res.state);
      if (res.state.cues.length > 0 && res.state.activeCueIndex === -1) {
         void updateState({ activeCueIndex: 0 });
      }
    } else {
      setState((s) => ({ ...s, status: "error", error: res.error || "Failed to load subtitles." }));
    }
  }

  async function updateState(updates: Partial<PracticeState>) {
    const res = await sendRuntimeMessage<{ state: PracticeState }>({
      type: "set-practice-state",
      state: updates
    });
    if (res.ok && res.state) {
      setState(res.state);
    }
  }

  async function controlPlayback(action: string, payload: any = {}) {
    await sendRuntimeMessage({
      type: "control-video-playback",
      action,
      payload
    });
  }

  async function togglePlayPause() {
    await controlPlayback("play"); 
  }

  async function replayCurrentCue() {
    if (state.activeCueIndex >= 0 && state.cues[state.activeCueIndex]) {
      const cue = state.cues[state.activeCueIndex];
      await controlPlayback("seek", { time: cue.start });
      await controlPlayback("play");
    }
  }

  async function navigateCue(direction: number) {
    const nextIndex = state.activeCueIndex + direction;
    if (nextIndex >= 0 && nextIndex < state.cues.length) {
      await updateState({ activeCueIndex: nextIndex });
      const cue = state.cues[nextIndex];
      await controlPlayback("seek", { time: cue.start });
      await controlPlayback("play");
    }
  }

  return (
    <div className="practice-panel" ref={panelRef} tabIndex={-1}>
      <header className="quick-header" style={{ marginBottom: "1rem" }}>
        <div>
          <p className="eyebrow">Comprehensible Output</p>
          <h1>Practice Mode</h1>
        </div>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <span className={`status-pill status-pill--${state.status}`}>
            {state.status}
          </span>
          <button className="secondary" onClick={onSwitchToStudio} type="button">
            Back to Studio
          </button>
        </div>
      </header>

      {state.status === "idle" || state.status === "error" ? (
        <div className="practice-setup">
          <p className="muted">{state.error || "Connect to a video to start practicing."}</p>
          <button className="primary-action" onClick={() => void syncCues()} type="button">
            Load Subtitles from Video
          </button>
        </div>
      ) : (
        <div className="script-section">
          <div className="script-header">
            <h3>Script</h3>
            <div className="mode-selector">
              <button className={mode === "read" ? "active" : ""} onClick={() => setMode("read")}>Read</button>
              <button className={mode === "output" ? "active" : ""} onClick={() => setMode("output")}>Output</button>
              <button className={mode === "blind" ? "active" : ""} onClick={() => setMode("blind")}>Blind</button>
            </div>
          </div>

          <div className="chat-container">
            {state.cues.map((cue, i) => {
              // Show a limited window of cues to prevent massive DOM overhead for long scripts
              if (i < state.activeCueIndex - 3 || i > state.activeCueIndex + 20) return null;
              
              const isActive = i === state.activeCueIndex;
              const isPast = i < state.activeCueIndex;
              const isFuture = i > state.activeCueIndex;
              
              if (isFuture && mode === "blind") return null;

              // Alternating roles for demo purposes (even vs odd)
              const isUserRole = i % 2 === 1;
              const messageClass = `message ${isUserRole ? "user" : "actor"} ${isActive && mode === "output" && isUserRole ? "active-turn" : ""}`;

              return (
                <div 
                  key={cue.index} 
                  className={messageClass}
                  onClick={() => {
                    void updateState({ activeCueIndex: i });
                    void controlPlayback("seek", { time: cue.start });
                  }}
                  style={{ cursor: "pointer", opacity: isFuture ? 0.5 : 1 }}
                >
                  <div className="sender-name">{isUserRole ? "You" : "Actor"} <span style={{opacity: 0.5}}>{formatSrtTime(cue.start)}</span></div>
                  <div className="bubble">
                    {isActive && mode === "output" && isUserRole ? (
                      <>
                        <div className="hint">Translate to target language:</div>
                        <div style={{ color: "var(--text)", fontSize: "1.1rem", margin: "0.5rem 0" }}>
                          {cue.text}
                        </div>
                      </>
                    ) : (
                      <>
                        {mode === "blind" && isUserRole && !isPast ? "..." : cue.text}
                        {isPast && isUserRole && mode === "output" && (
                          <div className="feedback-pill">✓ Completed</div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {state.activeCueIndex >= 0 && state.activeCueIndex % 2 === 1 && mode === "output" ? (
            <div className="mic-container">
              <div className="status-text">Your turn to speak</div>
              <button className="mic-btn" onClick={() => void navigateCue(1)}>
                🎙️
              </button>
            </div>
          ) : (
            <div className="practice-controls" style={{ display: "flex", gap: "0.5rem", marginTop: "1.5rem" }}>
              <button className="secondary" onClick={() => void navigateCue(-1)} disabled={state.activeCueIndex <= 0}>
                &larr;
              </button>
              <button className="primary-action" onClick={() => void replayCurrentCue()}>
                Replay
              </button>
              <button className="primary-action" onClick={() => void togglePlayPause()}>
                Play / Pause
              </button>
              <button className="secondary" onClick={() => void navigateCue(1)} disabled={state.activeCueIndex >= state.cues.length - 1}>
                &rarr;
              </button>
            </div>
          )}

          <div className="practice-settings" style={{ borderTop: "1px solid var(--border)", paddingTop: "1rem", marginTop: "1rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <input 
                type="checkbox" 
                checked={state.autoPause} 
                onChange={(e) => void updateState({ autoPause: e.target.checked })} 
              />
              Auto-pause after cue
            </label>
            <p className="muted" style={{ fontSize: "0.85em" }}>
              Hotkeys: Space (Play/Pause), Arrows L/R (Prev/Next), R/Up (Replay)
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSrtTime(totalSeconds: number) {
  const totalMs = totalSeconds * 1000;
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);

  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}
