import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const CHANNEL = "grok-preview-bridge";

export function PreviewHostBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return undefined;
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.channel !== CHANNEL) return;
      if (data.type === "navigate" && typeof data.path === "string" && data.path.startsWith("/") && !data.path.startsWith("//")) {
        navigate(data.path);
      }
      if (data.type === "history" && (data.delta === -1 || data.delta === 1)) {
        window.history.go(data.delta);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate]);
  return null;
}
