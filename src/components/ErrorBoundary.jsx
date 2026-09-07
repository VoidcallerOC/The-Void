import { Component } from "react";

// Top-level safety net. A thrown render error anywhere below this boundary
// would otherwise white-screen the whole site; here we catch it and show a
// recoverable fallback in the band aesthetic instead.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surface for debugging; a real deployment can wire this to a reporter.
    console.error("Uncaught render error:", error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          padding: 32,
          textAlign: "center",
          background: "var(--vc-void)",
          color: "var(--vc-bone)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--vc-crimson)",
          }}
        >
          † THE SIGNAL BROKE
        </div>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: "clamp(28px, 8vw, 44px)",
            textTransform: "uppercase",
            lineHeight: 1,
          }}
        >
          Something bled through
        </div>
        <p style={{ margin: 0, maxWidth: 420, color: "var(--vc-bone-dim)", fontSize: 14, lineHeight: 1.6 }}>
          An unexpected error interrupted the broadcast. The chain still
          remembers — try again.
        </p>
        <button
          onClick={this.handleReset}
          style={{
            fontFamily: "var(--font-body)",
            fontWeight: 700,
            fontSize: 12,
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            padding: "14px 22px",
            border: "1px solid var(--vc-crimson)",
            background: "var(--vc-crimson)",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Try Again
        </button>
      </div>
    );
  }
}
