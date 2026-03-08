import React from "react";

export type LinkSafetyModalProps = {
  url: string;
  isOpen: boolean;
  isChecking?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onCopy: () => void;
};

export const DefaultLinkSafetyModal: React.FC<LinkSafetyModalProps> = ({ url, isOpen, isChecking, onClose, onConfirm, onCopy }) => {
  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="stream-mdx-link-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Link safety confirmation"
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.4)",
        zIndex: 9999,
        padding: "24px",
      }}
      onClick={onClose}
    >
      <div
        className="stream-mdx-link-modal"
        style={{
          width: "min(520px, 100%)",
          borderRadius: 12,
          background: "var(--background, #fff)",
          color: "var(--foreground, #111)",
          border: "1px solid var(--border, rgba(0, 0, 0, 0.1))",
          boxShadow: "0 20px 60px rgba(0, 0, 0, 0.25)",
          padding: 20,
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Open external link?</div>
        <div style={{ fontSize: 13, opacity: 0.8, wordBreak: "break-all", marginBottom: 16 }}>{url}</div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCopy} disabled={isChecking} style={buttonStyle}>
            Copy link
          </button>
          <button type="button" onClick={onConfirm} disabled={isChecking} style={primaryButtonStyle}>
            Open link
          </button>
          <button type="button" onClick={onClose} style={buttonStyle}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

const buttonStyle: React.CSSProperties = {
  borderRadius: 8,
  border: "1px solid var(--border, rgba(0, 0, 0, 0.1))",
  padding: "6px 12px",
  background: "var(--background, #fff)",
  color: "inherit",
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "var(--foreground, #111)",
  color: "var(--background, #fff)",
  borderColor: "var(--foreground, #111)",
};
