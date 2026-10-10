import { useEffect, useState, useMemo } from "react";
import { sendRuntimeMessage } from "../../shared/chromeApi";
import type { PracticeState, SubtitleCue } from "../../shared/types";

type AIPhrase = {
  phrase: string;
  rank: number;
};

type AnalyzedPhrase = AIPhrase & {
  cues: SubtitleCue[];
  countInVideo: number;
};

const ANIMATION_STYLES = `
@keyframes progress-indeterminate {
  0% { transform: translateX(-100%) scaleX(0.2); }
  50% { transform: translateX(0%) scaleX(0.5); }
  100% { transform: translateX(100%) scaleX(0.2); }
}
`;

export function AnalyzerPanel({ onSwitchToStudio }: { onSwitchToStudio: () => void }) {
  const [state, setState] = useState<PracticeState>({
    status: "idle",
    cues: [],
    activeCueIndex: -1,
    sourceLabel: "",
    error: "",
    autoPause: true,
    revealMode: "hide-during-playback"
  });

  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    void loadSubtitles();
  }, []);

  async function loadSubtitles() {
    setState((s) => ({ ...s, status: "loading" }));
    const res = await sendRuntimeMessage<{ state: PracticeState }>({ type: "sync-practice-cues" });
    if (res.ok && res.state) {
      setState(res.state);
    } else {
      setState((s) => ({ ...s, status: "error", error: res.error || "Failed to load subtitles." }));
    }
  }

  const [analyzedPhrases, setAnalyzedPhrases] = useState<AnalyzedPhrase[]>([]);
  const [loadingStep, setLoadingStep] = useState<string>("");

  useEffect(() => {
    if (!analyzing) return;
    
    const steps = [
      "Extracting subtitle data...",
      "Connecting to OpenRouter AI...",
      "Analyzing vocabulary and idioms...",
      "Ranking by real-life usefulness...",
      "Finalizing results..."
    ];
    let i = 0;
    setLoadingStep(steps[0]);
    
    const interval = setInterval(() => {
      i = Math.min(i + 1, steps.length - 1);
      setLoadingStep(steps[i]);
    }, 2500);
    
    return () => clearInterval(interval);
  }, [analyzing]);

  async function runAIAnalysis() {
    if (!state.cues || state.cues.length === 0) return;
    setAnalyzing(true);
    setState(s => ({ ...s, error: "" }));
    
    // Combine all subtitle text
    const fullText = state.cues.map(c => c.text).join(" ");
    
    const res = await sendRuntimeMessage<{ result: AIPhrase[] }>({ 
      type: "analyze-phrases", 
      text: fullText 
    });
    
    if (res.ok && res.result) {
      // Map AI phrases back to cues in the video
      const phrasesWithContext: AnalyzedPhrase[] = res.result.map(aiItem => {
        const matchingCues = state.cues.filter(c => 
          c.text.toLowerCase().includes(aiItem.phrase.toLowerCase())
        );
        return {
          ...aiItem,
          cues: matchingCues.slice(0, 3), // keep up to 3 examples
          countInVideo: matchingCues.length
        };
      });
      
      // Filter out phrases that somehow didn't match any cues just in case, though AI should extract from text
      const valid = phrasesWithContext.filter(p => p.countInVideo > 0);
      valid.sort((a, b) => a.rank - b.rank); // Sort by AI rank (most used = 1)
      
      setAnalyzedPhrases(valid);
    } else {
      setState(s => ({ ...s, error: res.error || "AI Analysis failed." }));
    }
    
    setAnalyzing(false);
  }

  async function handleSendToAnki(word: string, cue: SubtitleCue) {
    // 1. Jump video to the phrase
    await sendRuntimeMessage({
      type: "control-video-playback",
      action: "seek",
      payload: { time: cue.start }
    });

    // 2. Select the cue to prepare for capture
    await sendRuntimeMessage({ type: "select-subtitle-cue", index: cue.index });

    // 3. Set the target word in the draft
    await sendRuntimeMessage({
      type: "save-sentence-draft",
      draft: { word }
    });

    // 4. Return to Studio to finish the card
    onSwitchToStudio();
  }

  return (
    <main className="studio-shell studio-shell--workspace">
      <style>{ANIMATION_STYLES}</style>
      <header className="studio-topbar studio-topbar--sticky">
        <div className="studio-topbar__brand">
          <p className="eyebrow">Subtitle Studio</p>
          <h1>Frequency Analyzer</h1>
        </div>
        <div className="studio-topbar__actions">
          <button className="secondary" onClick={onSwitchToStudio} type="button">
            Back to Studio
          </button>
        </div>
      </header>
      
      <div className="panel-content" style={{ overflowY: "auto", height: "calc(100vh - 61px)", paddingBottom: "24px" }}>
        <div className="container">
          {state.status === "loading" && <p className="muted">Loading subtitles from page...</p>}
          {state.status === "error" && <p className="error">{state.error}</p>}
          
          {state.status !== "loading" && state.cues.length === 0 && (
            <div className="empty-state">
              <h2>No Subtitles Found</h2>
              <p className="muted">Make sure a video is playing with subtitles enabled.</p>
              <button className="primary" onClick={loadSubtitles}>Reload Subtitles</button>
            </div>
          )}

          {state.status !== "loading" && state.cues.length > 0 && analyzedPhrases.length === 0 && (
            <div className="empty-state" style={{ padding: "40px 20px", textAlign: "center", background: "var(--surface-sunken)", borderRadius: "12px", border: "1px dashed var(--border)" }}>
              <div style={{ fontSize: "32px", marginBottom: "16px" }}>✨</div>
              <h2 style={{ marginBottom: "8px" }}>Ready to Analyze</h2>
              <p className="muted" style={{ marginBottom: "24px", maxWidth: "300px", margin: "0 auto 24px" }}>
                Found {state.cues.length} subtitle lines. Let AI extract the most useful real-life conversational phrases and idioms for you.
              </p>
              
              {analyzing ? (
                <div style={{ marginTop: '20px', maxWidth: '300px', margin: '0 auto' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px' }}>
                    <span className="muted" style={{ fontWeight: '500' }}>{loadingStep}</span>
                  </div>
                  <div style={{ width: '100%', height: '6px', background: 'var(--surface)', borderRadius: '3px', overflow: 'hidden', position: 'relative' }}>
                    <div 
                      style={{ 
                        position: 'absolute',
                        top: 0, bottom: 0, left: 0, right: 0,
                        background: 'var(--accent)', 
                        borderRadius: '3px',
                        animation: 'progress-indeterminate 1.5s infinite linear',
                        transformOrigin: '0% 50%'
                      }} 
                    />
                  </div>
                </div>
              ) : (
                <button className="primary-action" onClick={runAIAnalysis} disabled={analyzing} style={{ padding: "10px 24px", fontSize: "14px", borderRadius: "20px" }}>
                  Analyze Phrases with AI
                </button>
              )}
            </div>
          )}

          {analyzedPhrases.length > 0 && (
            <div className="analyzer-results">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid var(--border)', paddingBottom: '16px', marginBottom: '24px' }}>
                <div>
                  <h2 style={{ fontSize: '20px', marginBottom: '4px' }}>Top {analyzedPhrases.length} Phrases</h2>
                  <p className="muted" style={{ margin: 0, fontSize: '13px' }}>Ranked by real-life usefulness</p>
                </div>
                <button className="secondary small" onClick={runAIAnalysis} disabled={analyzing} style={{ padding: "6px 12px" }}>
                  {analyzing ? "..." : "Re-Analyze"}
                </button>
              </div>
              
              <div className="card-list" style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
                {analyzedPhrases.map((item, idx) => (
                  <div key={item.phrase + idx} style={{ 
                    background: 'var(--surface)', 
                    borderRadius: '12px', 
                    border: '1px solid var(--border)',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.05)',
                    overflow: 'hidden'
                  }}>
                    <div style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      alignItems: 'center', 
                      padding: '16px 20px',
                      background: 'var(--surface-sunken)',
                      borderBottom: '1px solid var(--border)'
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{ 
                          width: '28px', height: '28px', 
                          borderRadius: '50%', background: 'var(--accent)', color: 'var(--bg)', 
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontWeight: 'bold', fontSize: '12px'
                        }}>
                          {item.rank}
                        </div>
                        <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '600' }}>{item.phrase}</h3>
                      </div>
                      <span className="badge" style={{ background: 'var(--bg)', color: 'var(--text-muted)', padding: '4px 10px', borderRadius: '12px', fontSize: '12px', border: '1px solid var(--border)' }}>
                        Used {item.countInVideo}x
                      </span>
                    </div>
                    
                    <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {item.cues.map((cue, i) => (
                        <div key={i} style={{ 
                          display: 'flex', flexDirection: 'column', gap: '12px',
                          background: 'var(--bg)', padding: '16px', borderRadius: '8px', 
                          border: '1px solid var(--border-light)' 
                        }}>
                          <span style={{ fontSize: '14px', lineHeight: '1.5', fontStyle: 'italic', color: 'var(--text)' }}>"{cue.text}"</span>
                          <button 
                            className="secondary small" 
                            style={{ 
                              alignSelf: 'flex-start', padding: '6px 14px', fontSize: '12px', 
                              borderRadius: '16px', background: 'var(--surface-sunken)', border: '1px solid var(--border)',
                              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
                            }}
                            onClick={() => handleSendToAnki(item.phrase, cue)}
                          >
                            <span>⚡</span> Jump & Create Card
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
